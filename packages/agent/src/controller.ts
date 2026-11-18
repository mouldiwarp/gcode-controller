// GrblController: owns one Transport and turns it into machine state, job state
// and a console log. Lines are streamed with GRBL's character-counting protocol:
// the sum of unacknowledged line lengths never exceeds the controller's RX
// buffer, so GRBL always has the next lines queued without overflowing.

import { EventEmitter } from 'node:events';
import {
  RT,
  classifyResponse,
  describeAlarm,
  describeError,
  initialJob,
  initialMachine,
  streamableLines,
  type Command,
  type ConsoleLine,
  type JobGroup,
  type JobState,
  type MachineConfig,
  type MachineState,
  type Macro,
  type Vec3,
} from '@gcc/shared';
import type { Transport } from './transport.ts';

type LineKind = 'job' | 'user' | 'internal';

interface QueuedLine {
  text: string;
  kind: LineKind;
  source?: number;
  by?: string;
  /** Echo responses to the console (user commands). */
  echo: boolean;
  resolve?: (r: { ok: boolean; error?: string }) => void;
  /** When it was written to the controller. */
  sentAt?: number;
}

export interface ControllerEvents {
  machine: [MachineState];
  job: [JobState];
  console: [ConsoleLine[]];
  toast: [{ level: 'info' | 'warn' | 'error'; text: string }];
}

const CONSOLE_MAX = 500;
const ACTIVE: JobState['status'][] = ['loading', 'running', 'paused', 'stopping'];

export class GrblController extends EventEmitter<ControllerEvents> {
  machine: MachineState;
  job: JobState = initialJob();
  console: ConsoleLine[] = [];
  config?: MachineConfig;
  macros: Macro[] = [];

  private transport?: Transport;
  private rxText = '';
  private queue: QueuedLine[] = [];
  private inflight: QueuedLine[] = [];
  private inflightBytes = 0;
  private rxSize = 128;
  private jobLines: { text: string; source: number }[] = [];
  private jobCursor = 0;
  /** Stop feeding job lines (pause-on-error). Hold alone keeps the buffer topped up. */
  private jobSuspended = false;
  private pollTimer?: NodeJS.Timeout;
  private welcomeTimer?: NodeJS.Timeout;
  private jobEmitTimer?: NodeJS.Timeout;
  private settingsDraft: Record<string, string> | null = null;
  private lastWco: Vec3 = [0, 0, 0];
  private pendingConsole: ConsoleLine[] = [];
  /** Last `[PRB:x,y,z:ok]` report (machine coordinates). */
  private lastPrb?: { pos: Vec3; ok: boolean };
  private lastAlarmCode?: number;
  private consoleTimer?: NodeJS.Timeout;

  constructor(
    private readonly opts: { pollMs?: number; simulated?: boolean } = {},
  ) {
    super();
    this.machine = initialMachine(opts.simulated ?? false);
  }

  get isJobActive(): boolean {
    return ACTIVE.includes(this.job.status);
  }

  // ---------------- Connection ----------------

  async connect(transport: Transport): Promise<void> {
    if (this.transport) await this.disconnect();
    this.transport = transport;
    this.updateMachine({ connection: 'connecting', port: transport.name, simulated: transport.simulated, firmware: undefined });
    transport.onData((chunk) => this.onData(chunk));
    transport.onClose((err) => this.onTransportClosed(err));
    try {
      await transport.open();
    } catch (err) {
      this.transport = undefined;
      this.updateMachine({ connection: 'disconnected' });
      this.log('error', `Could not open ${transport.name}: ${(err as Error).message}`);
      throw err;
    }
    this.log('info', `Opened ${transport.simulated ? 'GRBL simulator' : transport.name}`);
    // An Arduino-based GRBL resets when the port opens and prints its banner.
    // grblHAL boards don't, so poke them with a soft reset if nothing arrives.
    this.welcomeTimer = setTimeout(() => {
      if (this.machine.connection === 'connecting') this.transport?.write(RT.SOFT_RESET);
    }, 2500);
    this.pollTimer = setInterval(() => {
      if (this.machine.connection === 'connected') this.transport?.write(RT.STATUS);
    }, this.opts.pollMs ?? 150);
  }

  async disconnect(): Promise<void> {
    const t = this.transport;
    this.teardown();
    if (t) await t.close().catch(() => undefined);
    this.updateMachine({ connection: 'disconnected', status: 'Unknown' });
  }

  private teardown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.pollTimer = undefined;
    this.welcomeTimer = undefined;
    this.transport = undefined;
    this.flushBuffers('Disconnected');
    if (this.isJobActive) this.failJob('Machine disconnected during the job');
  }

  private onTransportClosed(err?: Error): void {
    if (!this.transport) return;
    this.log('error', `Connection closed${err ? `: ${err.message}` : ''}`);
    this.teardown();
    this.updateMachine({ connection: 'disconnected', status: 'Unknown' });
  }

  // ---------------- Incoming data ----------------

  private onData(chunk: string): void {
    this.rxText += chunk;
    let nl: number;
    while ((nl = this.rxText.indexOf('\n')) >= 0) {
      const line = this.rxText.slice(0, nl).replace(/\r$/, '').trim();
      this.rxText = this.rxText.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const r = classifyResponse(line);
    switch (r.kind) {
      case 'status':
        return this.onStatus(r.status!);
      case 'ok':
      case 'error':
        return this.onAck(r.kind === 'ok', r.code, line);
      case 'alarm': {
        const message = describeAlarm(r.code!);
        this.lastAlarmCode = r.code;
        this.log('error', `${line} ${message}`);
        this.updateMachine({ status: 'Alarm', alarm: { code: r.code!, message } });
        this.flushBuffers('Alarm');
        if (this.isJobActive) this.failJob(`ALARM:${r.code} ${message}`);
        return;
      }
      case 'welcome':
        return this.onWelcome(line);
      case 'msg':
        this.log('in', line);
        return;
      case 'setting': {
        const m = /^\$(\d+)=(.*)$/.exec(line);
        if (m && this.settingsDraft) this.settingsDraft[m[1]] = m[2];
        // $$ typed in the console: keep the machine's settings up to date as well.
        else if (m) this.updateMachine({ settings: { ...(this.machine.settings ?? {}), [m[1]]: m[2] } });
        this.echoIfUser(line);
        return;
      }
      case 'feedback':
        if (line.startsWith('[GC:')) this.updateMachine({ modal: line.slice(4, -1) });
        if (line.startsWith('[PRB:')) {
          // X,Y,Z then any extra axes (FoxAlien's 4-axis GRBL adds A), then :1 for a contact.
          const m = /^\[PRB:([-\d.]+),([-\d.]+),([-\d.]+)(?:,[-\d.]+)*:(\d)\]$/.exec(line);
          if (m) this.lastPrb = { pos: [Number(m[1]), Number(m[2]), Number(m[3])], ok: m[4] === '1' };
          this.log('in', line);
          return;
        }
        if (line.startsWith('[VER:')) this.updateMachine({ firmware: `GRBL ${line.slice(5, -1).replace(/:$/, '')}` });
        if (line.startsWith('[OPT:')) {
          const parts = line.slice(5, -1).split(',');
          const rx = Number(parts[2]);
          if (rx > 0) this.rxSize = rx;
        }
        this.echoIfUser(line);
        return;
      default:
        this.echoIfUser(line);
    }
  }

  private echoIfUser(line: string): void {
    const head = this.inflight[0];
    if (!head || head.echo) this.log('in', line);
  }

  private onWelcome(line: string): void {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    const wasConnecting = this.machine.connection === 'connecting';
    this.log('in', line);
    // A banner means the controller reset: everything in flight is gone.
    this.flushBuffers('Controller reset');
    if (this.job.status === 'stopping') {
      this.finishJob('stopped');
    } else if (this.isJobActive) {
      this.failJob('The controller reset during the job');
    }
    this.updateMachine({ connection: 'connected', firmware: /grblhal/i.test(line) ? 'grblHAL' : this.machine.firmware ?? 'GRBL' });
    if (wasConnecting || !this.machine.settings || !Object.keys(this.machine.settings).length) {
      this.internal('$I');
      this.queryState();
    }
    this.transport?.write(RT.STATUS);
  }

  private queryState(): void {
    const draft = (this.settingsDraft = {});
    this.internal('$$', () => {
      // Interrupted (a reset) before any settings arrived: leave them unread so they're asked for again.
      if (Object.keys(draft).length) this.updateMachine({ settings: { ...(this.machine.settings ?? {}), ...draft } });
      if (this.settingsDraft === draft) this.settingsDraft = null;
    });
    this.internal('$G');
  }

  private onStatus(s: NonNullable<ReturnType<typeof classifyResponse>['status']>): void {
    const patch: Partial<MachineState> = { status: s.state, subState: s.subState };
    if (s.wco) this.lastWco = s.wco;
    if (s.mpos) {
      patch.mpos = s.mpos;
      patch.wpos = [s.mpos[0] - this.lastWco[0], s.mpos[1] - this.lastWco[1], s.mpos[2] - this.lastWco[2]];
    } else if (s.wpos) {
      patch.wpos = s.wpos;
      patch.mpos = [s.wpos[0] + this.lastWco[0], s.wpos[1] + this.lastWco[1], s.wpos[2] + this.lastWco[2]];
    }
    patch.wco = this.lastWco;
    if (s.feed !== undefined) patch.feed = s.feed;
    if (s.spindle !== undefined) patch.spindle = s.spindle;
    if (s.overrides) patch.overrides = s.overrides;
    if (s.buffer) {
      patch.buffer = s.buffer;
      this.checkForLostReplies(s.state, s.buffer);
    }
    patch.pins = s.pins;
    if (s.state !== 'Alarm' && this.machine.alarm) patch.alarm = undefined;
    if (this.machine.connection === 'connecting') {
      // Boards that don't reset when the port opens (no banner) come up through a status
      // report instead: ask for the build info and settings here too.
      patch.connection = 'connected';
      queueMicrotask(() => {
        this.internal('$I');
        this.queryState();
      });
    }
    this.updateMachine(patch);

    // GRBL ignores feed hold while Idle, so a hold pressed just before motion
    // starts can be lost. If we think the job is paused but GRBL is running,
    // hold again.
    if ((this.job.status === 'paused' || this.job.status === 'stopping') && s.state === 'Run') {
      this.realtime(RT.FEED_HOLD);
    }

    // A job is finished once every line is acknowledged and the machine is idle.
    if (
      this.job.status === 'running' &&
      this.jobCursor >= this.jobLines.length &&
      !this.inflight.some((l) => l.kind === 'job') &&
      s.state === 'Idle'
    ) {
      this.finishJob('done');
    }
  }

  private onAck(ok: boolean, code: number | undefined, raw: string): void {
    const item = this.inflight.shift();
    if (!item) {
      if (!ok) this.log('error', `${raw} ${describeError(code!)}`);
      return;
    }
    this.inflightBytes -= item.text.length + 1;
    const errorText = ok ? undefined : `${raw}: ${describeError(code!)}`;

    if (item.kind === 'job') {
      this.job.ackedLines++;
      this.job.sourceLine = item.source ?? this.job.sourceLine;
      if (!ok) {
        this.log('error', `Line ${(item.source ?? 0) + 1} "${item.text}" → ${errorText}`);
        this.pauseOnError(`Line ${(item.source ?? 0) + 1} (${item.text}) → ${errorText}`);
      }
      this.scheduleJobEmit();
    } else {
      if (item.echo) this.log(ok ? 'in' : 'error', ok ? 'ok' : errorText!);
      if (!ok && item.kind === 'user') {
        this.updateMachine({ lastError: { code: code!, message: describeError(code!), line: item.text } });
      }
    }
    item.resolve?.({ ok, error: errorText });
    this.pump();
  }

  // ---------------- Streaming ----------------

  private pump(): void {
    const t = this.transport;
    if (!t || this.machine.connection !== 'connected') return;
    for (;;) {
      let next: QueuedLine | undefined;
      let fromJob = false;
      if (this.queue.length) {
        next = this.queue[0];
      } else if (
        (this.job.status === 'running' || this.job.status === 'paused') &&
        !this.jobSuspended &&
        this.jobCursor < this.jobLines.length
      ) {
        const l = this.jobLines[this.jobCursor];
        next = { text: l.text, kind: 'job', source: l.source, echo: false };
        fromJob = true;
      }
      if (!next) return;
      const len = next.text.length + 1;
      if (this.inflight.length && this.inflightBytes + len > this.rxSize) return;
      if (fromJob) this.jobCursor++;
      else this.queue.shift();
      next.sentAt = Date.now();
      this.inflight.push(next);
      this.inflightBytes += len;
      t.write(next.text + '\n');
    }
  }

  private enqueue(line: QueuedLine): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      if (!this.transport || this.machine.connection !== 'connected') {
        resolve({ ok: false, error: 'The machine is not connected' });
        return;
      }
      this.queue.push({ ...line, resolve });
      this.pump();
    });
  }

  private internal(text: string, done?: () => void): void {
    void this.enqueue({ text, kind: 'internal', echo: false }).then(() => done?.());
  }

  private user(text: string, by?: string): Promise<{ ok: boolean; error?: string }> {
    this.log('out', text, by);
    return this.enqueue({ text, kind: 'user', by, echo: true });
  }

  private flushBuffers(reason: string): void {
    const pending = [...this.inflight, ...this.queue];
    this.inflight = [];
    this.queue = [];
    this.inflightBytes = 0;
    for (const p of pending) p.resolve?.({ ok: false, error: reason });
  }

  private maxRxFree = 0;
  private maxPlannerFree = 0;

  /**
   * GRBL answers every line with ok or error, so the lines waiting for a reply should be the
   * ones still in its buffer. If it reports an empty input buffer and planner while idle, yet
   * lines have waited over two seconds, a reply went missing and everything after it would be
   * answered one late (the last command never). Treat those lines as done instead of hanging.
   */
  private checkForLostReplies(state: string, buf: { planner: number; rx: number }): void {
    this.maxRxFree = Math.max(this.maxRxFree, buf.rx);
    this.maxPlannerFree = Math.max(this.maxPlannerFree, buf.planner);
    const oldest = this.inflight[0];
    if (!oldest || state !== 'Idle' || buf.rx < this.maxRxFree || buf.planner < this.maxPlannerFree) return;
    // A dwell reports Idle with empty buffers before it answers; job lines are left to the streamer.
    if (this.inflight.some((l) => l.kind === 'job' || /G0?4(?![\d.])/i.test(l.text))) return;
    if (Date.now() - (oldest.sentAt ?? Date.now()) < 2000) return;
    const lost = this.inflight;
    this.inflight = [];
    this.inflightBytes = 0;
    this.log('info', `No reply from the controller to ${lost.map((l) => `"${l.text}"`).join(', ')}, though it has finished with ${lost.length > 1 ? 'them' : 'it'}. Carrying on.`);
    for (const l of lost) l.resolve?.({ ok: true });
    this.pump();
  }

  private realtime(byte: string): void {
    this.transport?.write(byte);
  }

  // ---------------- Jobs ----------------

  startJob(text: string, meta: { fileId: string; fileName: string; by?: string; estSeconds?: number; group?: JobGroup }): void {
    const lines = streamableLines(text);
    this.jobLines = lines;
    this.jobCursor = 0;
    this.jobSuspended = false;
    this.job = {
      ...initialJob(),
      status: 'running',
      fileId: meta.fileId,
      fileName: meta.fileName,
      totalLines: lines.length,
      startedAt: Date.now(),
      startedBy: meta.by,
      estSeconds: meta.estSeconds,
      group: meta.group,
    };
    this.emit('job', this.job);
    const g = meta.group;
    const part = g ? ` [${g.name}: file ${g.index + 1} of ${g.files.length}]` : '';
    this.log('info', `Job started: ${meta.fileName} (${lines.length} lines)${part}${meta.by ? ` by ${meta.by}` : ''}`);
    this.pump();
  }

  private pauseOnError(message: string): void {
    this.jobSuspended = true;
    this.realtime(RT.FEED_HOLD);
    this.job.status = 'paused';
    this.job.pausedAt = Date.now();
    this.job.error = message;
    this.emit('job', this.job);
    this.emit('toast', { level: 'error', text: `Job paused: ${message}` });
  }

  private failJob(message: string): void {
    this.jobSuspended = true;
    this.job.status = 'error';
    this.job.error = message;
    this.job.finishedAt = Date.now();
    if (this.job.pausedAt) {
      this.job.pausedMs += this.job.finishedAt - this.job.pausedAt;
      this.job.pausedAt = undefined;
    }
    this.jobLines = [];
    this.emit('job', this.job);
    this.log('error', `Job failed: ${message}`);
    this.emit('toast', { level: 'error', text: `Job stopped: ${message}` });
  }

  private finishJob(status: 'done' | 'stopped'): void {
    const g = this.job.group;
    if (status === 'done' && g && g.index < g.files.length - 1) return this.awaitToolChange(g);
    this.job.status = status;
    this.job.finishedAt = Date.now();
    if (this.job.pausedAt) {
      this.job.pausedMs += this.job.finishedAt - this.job.pausedAt;
      this.job.pausedAt = undefined;
    }
    if (status === 'done') this.job.ackedLines = this.job.totalLines;
    this.jobLines = [];
    this.emit('job', this.job);
    this.log('info', status === 'done' ? `Job complete: ${this.job.fileName}` : `Job stopped: ${this.job.fileName}`);
    this.emit('toast', { level: 'info', text: status === 'done' ? `Job complete: ${this.job.fileName}` : 'Job stopped' });
  }

  /**
   * A file in a group finished and another follows. Turn the spindle off (the
   * file may not have) and wait for the bit change and Start next.
   */
  private awaitToolChange(g: JobGroup): void {
    this.job.status = 'toolchange';
    this.job.finishedAt = Date.now();
    this.job.ackedLines = this.job.totalLines;
    this.jobLines = [];
    this.internal('M5');
    this.emit('job', this.job);
    const next = g.files[g.index + 1];
    this.log('info', `File ${g.index + 1} of ${g.files.length} complete: ${this.job.fileName}. Next: ${next.name}. Change the bit, re-probe Z, then Start next.`);
    this.emit('toast', { level: 'info', text: `File ${g.index + 1} of ${g.files.length} done. Change the bit for ${next.name}` });
  }

  private scheduleJobEmit(): void {
    if (this.jobEmitTimer) return;
    this.jobEmitTimer = setTimeout(() => {
      this.jobEmitTimer = undefined;
      this.emit('job', this.job);
    }, 100);
  }

  // ---------------- Commands ----------------

  /** Validate and run a machine command. Throws with a user-facing message if refused. */
  async command(cmd: Command, by?: string): Promise<void> {
    if (cmd.type !== 'connect' && cmd.type !== 'disconnect') this.updateMachine({ lastCommandBy: by });
    const connected = this.machine.connection === 'connected';
    const need = () => {
      if (!connected) throw new Error('The machine is not connected');
    };
    const idle = (what: string) => {
      need();
      if (this.isJobActive) throw new Error(`Can't ${what} while a job is running`);
      if (this.machine.status === 'Alarm') throw new Error(`Can't ${what} in ALARM. Home or unlock first`);
      if (this.machine.probing) throw new Error(`Can't ${what} while probing`);
    };
    const run = async (text: string) => {
      const r = await this.user(text, by);
      if (!r.ok) throw new Error(r.error ?? 'Command failed');
    };

    switch (cmd.type) {
      case 'home':
        need();
        if (this.isJobActive) throw new Error("Can't home while a job is running");
        // GRBL may not answer status queries while homing, so the UI can look idle: ignore repeats.
        if ([...this.inflight, ...this.queue].some((l) => l.text === '$H') || this.machine.status === 'Home') {
          throw new Error('Already homing');
        }
        return run('$H');
      case 'unlock':
        need();
        return run('$X');
      case 'reset':
        need();
        this.log('out', '[soft reset]', by);
        if (this.isJobActive) this.job.status = 'stopping';
        this.realtime(RT.SOFT_RESET);
        return;
      case 'hold':
        need();
        this.log('out', '[feed hold]', by);
        this.realtime(RT.FEED_HOLD);
        if (this.job.status === 'running') {
          this.job.status = 'paused';
          this.job.pausedAt = Date.now();
          this.emit('job', this.job);
        }
        return;
      case 'resume':
        need();
        this.log('out', '[cycle start]', by);
        this.realtime(RT.CYCLE_START);
        if (this.job.status === 'paused') {
          this.job.status = 'running';
          if (this.job.pausedAt) this.job.pausedMs += Date.now() - this.job.pausedAt;
          this.job.pausedAt = undefined;
          this.job.error = undefined;
          this.jobSuspended = false;
          this.emit('job', this.job);
          this.pump();
        }
        return;
      case 'stop':
        return this.stopJob(by);
      case 'jog': {
        idle('jog');
        const parts = ['$J=G91G21'];
        if (cmd.x) parts.push(`X${fmt(cmd.x)}`);
        if (cmd.y) parts.push(`Y${fmt(cmd.y)}`);
        if (cmd.z) parts.push(`Z${fmt(cmd.z)}`);
        if (parts.length === 1) return;
        parts.push(`F${Math.round(cmd.feed)}`);
        return run(parts.join(''));
      }
      case 'jogCancel':
        need();
        this.realtime(RT.JOG_CANCEL);
        return;
      case 'zero': {
        idle('set zero');
        if (!cmd.axes.length) return;
        return run(`G10L20P0${cmd.axes.map((a) => `${a}0`).join('')}`);
      }
      case 'goToZero': {
        idle('move');
        const safeZ = this.config?.safeZ ?? 5;
        if (cmd.axes.includes('X') || cmd.axes.includes('Y')) {
          const liftTo = Math.max(this.machine.wpos[2], safeZ);
          await run(`G90G0Z${fmt(liftTo)}`);
          const xy = cmd.axes.filter((a) => a !== 'Z').map((a) => `${a}0`).join('');
          await run(`G90G0${xy}`);
        }
        if (cmd.axes.includes('Z')) await run('G90G0Z0');
        return;
      }
      case 'mdi': {
        idle('send commands');
        const lines = cmd.line.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const l of lines) await run(l);
        return;
      }
      case 'runMacro': {
        const macro = this.macros.find((m) => m.id === cmd.id);
        if (!macro) throw new Error('Macro not found');
        idle('run a macro');
        this.log('info', `Macro: ${macro.name}`, by);
        for (const l of macro.gcode.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) await run(l);
        return;
      }
      case 'override': {
        need();
        const map: Record<string, Record<string, string>> = {
          feed: { reset: RT.FEED_OV_RESET, plus10: RT.FEED_OV_PLUS_10, minus10: RT.FEED_OV_MINUS_10, plus1: RT.FEED_OV_PLUS_1, minus1: RT.FEED_OV_MINUS_1 },
          spindle: { reset: RT.SPINDLE_OV_RESET, plus10: RT.SPINDLE_OV_PLUS_10, minus10: RT.SPINDLE_OV_MINUS_10, plus1: RT.SPINDLE_OV_PLUS_1, minus1: RT.SPINDLE_OV_MINUS_1 },
          rapid: { reset: RT.RAPID_OV_100, r50: RT.RAPID_OV_50, r25: RT.RAPID_OV_25 },
        };
        const byte = map[cmd.kind]?.[cmd.action];
        if (!byte) throw new Error('Unknown override');
        this.realtime(byte);
        return;
      }
      case 'refreshSettings':
        idle('read settings');
        this.queryState();
        return;
      case 'clearJob':
        if (this.isJobActive) throw new Error('A job is still running');
        if (this.job.status === 'toolchange') this.log('info', `Group ${this.job.group?.name ?? ''} ended after file ${(this.job.group?.index ?? 0) + 1}`, by);
        this.job = initialJob();
        this.emit('job', this.job);
        return;
      case 'probeZ':
        idle('probe');
        return this.probeZ(by);
      case 'start':
      case 'startNext':
        throw new Error('start must go through the agent');
      default:
        throw new Error(`Unsupported command ${cmd.type}`);
    }
  }

  /**
   * Set work Z from a touch plate: a fast touch, lift 2 mm, a slow touch, then
   * set the contact point to the plate thickness and lift clear. Uses G38.2, so
   * GRBL raises ALARM:5 if nothing is touched within the search distance.
   */
  private async probeZ(by?: string): Promise<void> {
    const p = this.config?.probe;
    if (!p || !(p.plateThickness > 0)) throw new Error('Set the touch plate thickness in Settings first');
    if (this.machine.status !== 'Idle') throw new Error(`The machine is busy (${this.machine.status})`);
    if (this.machine.pins?.includes('P')) {
      throw new Error('The probe input is already closed. Check the plate is not touching the bit and the clip is not shorted');
    }
    this.updateMachine({ probing: true });
    this.log('info', `Probing Z (plate ${p.plateThickness} mm, searching ${p.maxTravel} mm down)`, by);
    const fail = (message: string): never => {
      this.updateMachine({ probing: false, lastProbe: { ok: false, message, t: Date.now() } });
      throw new Error(message);
    };
    const step = async (text: string) => {
      this.log('out', text, by);
      this.lastAlarmCode = undefined;
      const r = await this.enqueue({ text, kind: 'user', by, echo: true });
      if (r.ok) return;
      if (this.lastAlarmCode === 5) fail(`No contact within ${p.maxTravel} mm. Check the clip and plate, then unlock to continue`);
      if (this.lastAlarmCode === 4) fail('The probe input was already closed when probing started. Check the clip, then unlock');
      fail(`Probing stopped: ${r.error ?? 'command failed'}`);
    };
    const touch = async (text: string) => {
      this.lastPrb = undefined;
      await step(text);
      const prb = this.lastPrb as { pos: Vec3; ok: boolean } | undefined;
      if (!prb?.ok) return fail('The probe did not report a contact');
      return prb.pos;
    };

    const z0 = this.machine.wpos[2];
    await step('G21G90');
    const first = await touch(`G38.2Z${fmt(z0 - p.maxTravel)}F${Math.round(p.seekFeed)}`);
    const firstWorkZ = first[2] - this.machine.wco[2];
    await step(`G0Z${fmt(firstWorkZ + 2)}`);
    const second = await touch(`G38.2Z${fmt(firstWorkZ - 2)}F${Math.round(p.latchFeed)}`);
    // The tool now rests on the plate: that height is the plate thickness above the stock.
    await step(`G10L20P0Z${fmt(p.plateThickness)}`);
    await step(`G0Z${fmt(p.plateThickness + p.retract)}`);
    await step('G4P0.01'); // a dwell is answered only once motion has stopped
    await this.waitForIdle();
    const message = `Z zeroed on the stock surface (plate ${p.plateThickness} mm). Remove the plate and clip`;
    this.log('info', message, by);
    this.updateMachine({ probing: false, lastProbe: { ok: true, message, t: Date.now(), contactZ: second[2] } });
  }

  /** Wait for a fresh status report showing Idle (up to 2 s). */
  private async waitForIdle(): Promise<void> {
    const end = Date.now() + 2000;
    let seen = 0;
    const onMachine = () => seen++;
    this.on('machine', onMachine);
    try {
      while (Date.now() < end && !(seen > 0 && this.machine.status === 'Idle')) await new Promise((r) => setTimeout(r, 20));
    } finally {
      this.off('machine', onMachine);
    }
  }

  /** Refuse to start unless the machine is idle and nothing else is running. */
  checkCanStart(opts: { loading?: boolean } = {}): void {
    if (this.machine.connection !== 'connected') throw new Error('The machine is not connected');
    const busy = opts.loading ? this.isJobActive && this.job.status !== 'loading' : this.isJobActive;
    if (busy) throw new Error('A job is already running');
    if (this.machine.status === 'Alarm') throw new Error('The machine is in ALARM. Home or unlock first');
    if (this.machine.status !== 'Idle') throw new Error(`The machine is busy (${this.machine.status})`);
    if (this.machine.probing) throw new Error('Probing is in progress');
  }

  markLoading(fileId: string, fileName: string, by?: string): void {
    this.job = { ...initialJob(), status: 'loading', fileId, fileName, startedBy: by };
    this.emit('job', this.job);
  }

  /** Put back a job state saved before loading (a group waiting for its next file). */
  restoreJob(job: JobState): void {
    this.job = job;
    this.emit('job', this.job);
  }

  cancelLoading(error: string): void {
    if (this.job.status !== 'loading') return;
    this.job = { ...this.job, status: 'error', error };
    this.emit('job', this.job);
  }

  private async stopJob(by?: string): Promise<void> {
    if (this.machine.connection !== 'connected') throw new Error('The machine is not connected');
    this.log('out', '[stop]', by);
    this.jobSuspended = true;
    const wasActive = this.isJobActive;
    if (wasActive) {
      this.job.status = 'stopping';
      this.emit('job', this.job);
    }
    // Hold first so the reset doesn't happen mid-motion (which would raise ALARM:3).
    this.realtime(RT.FEED_HOLD);
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      const s = this.machine.status;
      if ((s === 'Hold' && this.machine.subState === 0) || s === 'Idle' || s === 'Alarm') break;
      await new Promise((r) => setTimeout(r, 30));
    }
    this.realtime(RT.SOFT_RESET);
    // onWelcome finishes the job as 'stopped' when the banner arrives.
    setTimeout(() => {
      if (this.job.status === 'stopping') this.finishJob('stopped');
    }, 3000);
  }

  // ---------------- State helpers ----------------

  private updateMachine(patch: Partial<MachineState>): void {
    Object.assign(this.machine, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (this.machine as unknown as Record<string, unknown>)[k];
    this.emit('machine', this.machine);
  }

  log(dir: ConsoleLine['dir'], text: string, by?: string): void {
    const line: ConsoleLine = { t: Date.now(), dir, text, by };
    this.console.push(line);
    if (this.console.length > CONSOLE_MAX) this.console.splice(0, this.console.length - CONSOLE_MAX);
    this.pendingConsole.push(line);
    if (!this.consoleTimer) {
      this.consoleTimer = setTimeout(() => {
        this.consoleTimer = undefined;
        const lines = this.pendingConsole;
        this.pendingConsole = [];
        this.emit('console', lines);
      }, 50);
    }
  }
}

function fmt(n: number): string {
  return Number(n.toFixed(4)).toString();
}
