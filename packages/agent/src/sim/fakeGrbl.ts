// An in-process GRBL 1.1 simulator that stands in for the USB machine.
//
// It models what a sender has to get right: a 128-byte serial RX buffer that
// overflows if the host over-sends, a 15-block planner, `ok` sent when a line
// is planned (not finished), realtime bytes that bypass the buffer, alarms on
// boot / reset-in-motion / soft limits, homing, jogging, work offsets, feed
// hold and overrides. Motion runs in simulated time (speed multiplier) so jobs
// can be watched live or fast-forwarded in tests.

import { Interpreter, cleanLine, parseWords, type Vec3 } from '@gcc/shared';
import type { Transport } from '../transport.ts';

export interface FakeGrblOptions {
  /** Simulated seconds per real second. */
  speed?: number;
  rxSize?: number;
  plannerSize?: number;
  /** Boot into ALARM until $H or $X, as GRBL does with homing enabled. */
  homingRequired?: boolean;
  /** Raise ALARM:2 for moves outside the envelope. */
  softLimits?: boolean;
  /** Travel per axis (machine coords run from -travel to 0). */
  travel?: Vec3;
  rapidRate?: number;
  tickMs?: number;
  /** Delay before the welcome banner, ms (real time). */
  bootDelayMs?: number;
}

interface Block {
  /** Machine-coordinate polyline still to travel. */
  points: Vec3[];
  feed: number;
  rapid: boolean;
  jog: boolean;
}

type SimState = 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Home' | 'Check';

const VERSION = '1.1h.20190825';

export class FakeGrbl implements Transport {
  readonly name = 'simulator';
  readonly simulated = true;

  readonly opts: Required<FakeGrblOptions>;
  private dataCbs: ((chunk: string) => void)[] = [];
  private closeCbs: ((err?: Error) => void)[] = [];
  private timer?: NodeJS.Timeout;
  private isOpen = false;

  // Serial
  private rx = '';
  /** Set if the host ever sent more than the RX buffer holds. */
  overflowed = false;
  /** Every line GRBL processed, in order (for tests). */
  readonly received: string[] = [];

  // Machine
  state: SimState = 'Idle';
  private holdComplete = false;
  mpos: Vec3 = [0, 0, 0];
  wco: Vec3 = [0, 0, 0];
  private planner: Block[] = [];
  private interp: Interpreter;
  private spindleOn = false;
  private spindleSpeed = 0;
  private feedOv = 100;
  private rapidOv = 100;
  private spindleOv = 100;
  private reportCount = 0;
  private lastWco = '';
  private lastOv = '';
  private homingRemaining = 0;
  private pendingOkAfterHome = false;
  readonly settings: Record<number, number>;

  constructor(opts: FakeGrblOptions = {}) {
    this.opts = {
      speed: opts.speed ?? 1,
      rxSize: opts.rxSize ?? 128,
      plannerSize: opts.plannerSize ?? 15,
      homingRequired: opts.homingRequired ?? true,
      softLimits: opts.softLimits ?? false,
      travel: opts.travel ?? [800, 800, 120],
      rapidRate: opts.rapidRate ?? 5000,
      tickMs: opts.tickMs ?? 10,
      bootDelayMs: opts.bootDelayMs ?? 50,
    };
    this.interp = new Interpreter({ rapidRate: this.opts.rapidRate });
    this.settings = {
      0: 10, 1: 25, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 10: 3, 11: 0.01, 12: 0.002, 13: 0,
      20: this.opts.softLimits ? 1 : 0, 21: 0, 22: 1, 23: 0, 24: 100, 25: 1000, 26: 250, 27: 2,
      30: 1000, 31: 0, 32: 0, 100: 400, 101: 400, 102: 400, 110: 5000, 111: 5000, 112: 2000,
      120: 500, 121: 500, 122: 200,
      130: this.opts.travel[0], 131: this.opts.travel[1], 132: this.opts.travel[2],
    };
  }

  // ---- Transport ----

  async open(): Promise<void> {
    this.isOpen = true;
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
    setTimeout(() => this.boot(), this.opts.bootDelayMs);
  }

  async close(): Promise<void> {
    this.isOpen = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const cb of this.closeCbs) cb();
  }

  write(data: string): void {
    if (!this.isOpen) return;
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (this.handleRealtime(code)) continue;
      if (this.rx.length >= this.opts.rxSize) {
        this.overflowed = true; // real GRBL silently drops the byte
        continue;
      }
      this.rx += ch;
    }
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCbs.push(cb);
  }

  // ---- Fault injection ----

  /** Simulate a USB unplug. */
  unplug(): void {
    this.isOpen = false;
    if (this.timer) clearInterval(this.timer);
    for (const cb of this.closeCbs) cb(new Error('Simulated USB disconnect'));
  }

  /** Raise an alarm as if a limit switch tripped. */
  injectAlarm(code = 1): void {
    this.planner = [];
    this.state = 'Alarm';
    this.send(`ALARM:${code}`);
  }

  // ---- Internals ----

  private send(line: string): void {
    const s = line + '\r\n';
    for (const cb of this.dataCbs) cb(s);
  }

  private boot(): void {
    if (!this.isOpen) return;
    this.send('');
    this.send(`Grbl 1.1h ['$' for help]`);
    if (this.opts.homingRequired) {
      this.state = 'Alarm';
      this.send(`[MSG:'$H'|'$X' to unlock]`);
    } else {
      this.state = 'Idle';
    }
  }

  private wpos(): Vec3 {
    return [this.mpos[0] - this.wco[0], this.mpos[1] - this.wco[1], this.mpos[2] - this.wco[2]];
  }

  private plannedEnd(): Vec3 {
    const last = this.planner[this.planner.length - 1];
    if (!last) return [...this.mpos] as Vec3;
    return [...last.points[last.points.length - 1]] as Vec3;
  }

  private handleRealtime(code: number): boolean {
    switch (code) {
      case 0x3f: // ?
        this.report();
        return true;
      case 0x21: // ! feed hold
        if (this.state === 'Run' || this.state === 'Jog') {
          if (this.state === 'Jog') {
            this.planner = [];
            this.state = 'Idle';
          } else {
            this.state = 'Hold';
            this.holdComplete = true;
          }
        }
        return true;
      case 0x7e: // ~ cycle start
        if (this.state === 'Hold') {
          this.state = this.planner.length ? 'Run' : 'Idle';
          this.holdComplete = false;
        }
        return true;
      case 0x18: // soft reset
        this.softReset();
        return true;
      case 0x85: // jog cancel
        if (this.state === 'Jog') {
          this.planner = this.planner.filter((b) => !b.jog);
          this.rx = this.rx
            .split('\n')
            .filter((l) => !l.startsWith('$J='))
            .join('\n');
          this.state = 'Idle';
        }
        return true;
      default:
        if (code >= 0x80) {
          this.override(code);
          return true;
        }
        return false;
    }
  }

  private override(code: number): void {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    switch (code) {
      case 0x90: this.feedOv = 100; break;
      case 0x91: this.feedOv = clamp(this.feedOv + 10, 10, 200); break;
      case 0x92: this.feedOv = clamp(this.feedOv - 10, 10, 200); break;
      case 0x93: this.feedOv = clamp(this.feedOv + 1, 10, 200); break;
      case 0x94: this.feedOv = clamp(this.feedOv - 1, 10, 200); break;
      case 0x95: this.rapidOv = 100; break;
      case 0x96: this.rapidOv = 50; break;
      case 0x97: this.rapidOv = 25; break;
      case 0x99: this.spindleOv = 100; break;
      case 0x9a: this.spindleOv = clamp(this.spindleOv + 10, 10, 200); break;
      case 0x9b: this.spindleOv = clamp(this.spindleOv - 10, 10, 200); break;
      case 0x9c: this.spindleOv = clamp(this.spindleOv + 1, 10, 200); break;
      case 0x9d: this.spindleOv = clamp(this.spindleOv - 1, 10, 200); break;
    }
  }

  private softReset(): void {
    const moving = (this.state === 'Run' || this.state === 'Jog' || this.state === 'Home') && !this.holdComplete;
    this.rx = '';
    this.planner = [];
    this.interp.reset();
    this.spindleOn = false;
    this.holdComplete = false;
    this.pendingOkAfterHome = false;
    this.homingRemaining = 0;
    if (moving) {
      this.state = 'Alarm';
      this.send('ALARM:3');
    } else if (this.state !== 'Alarm') {
      this.state = 'Idle';
    }
    this.send('');
    this.send(`Grbl 1.1h ['$' for help]`);
    if (this.state === 'Alarm') this.send(`[MSG:'$H'|'$X' to unlock]`);
  }

  private report(): void {
    const f = (v: number) => v.toFixed(3);
    const p = this.mpos.map(f).join(',');
    let state: string = this.state;
    if (this.state === 'Hold') state = this.holdComplete ? 'Hold:0' : 'Hold:1';
    const block = this.planner[0];
    const feed = block && (this.state === 'Run' || this.state === 'Jog') ? this.effectiveFeed(block) : 0;
    const speed = this.spindleOn ? Math.round((this.spindleSpeed * this.spindleOv) / 100) : 0;
    let s = `<${state}|MPos:${p}|Bf:${this.opts.plannerSize - this.planner.length},${this.opts.rxSize - this.rx.length}|FS:${Math.round(feed)},${speed}`;
    const wco = this.wco.map(f).join(',');
    const ov = `${this.feedOv},${this.rapidOv},${this.spindleOv}`;
    this.reportCount++;
    if (wco !== this.lastWco || this.reportCount % 10 === 0) {
      s += `|WCO:${wco}`;
      this.lastWco = wco;
    } else if (ov !== this.lastOv || this.reportCount % 10 === 5) {
      s += `|Ov:${ov}`;
      this.lastOv = ov;
    }
    this.send(s + '>');
  }

  private effectiveFeed(b: Block): number {
    if (b.rapid) return (this.opts.rapidRate * this.rapidOv) / 100;
    if (b.jog) return b.feed;
    return (b.feed * this.feedOv) / 100;
  }

  private tick(): void {
    if (!this.isOpen) return;
    this.processRx();
    this.move((this.opts.tickMs / 1000) * this.opts.speed);
  }

  private move(dt: number): void {
    if (this.state === 'Home') {
      this.homingRemaining -= dt;
      // Travel toward the homing corner while homing.
      for (let i = 0; i < 3; i++) this.mpos[i] += (0 - this.mpos[i]) * Math.min(1, dt * 2);
      if (this.homingRemaining <= 0) {
        this.mpos = [0, 0, 0];
        this.state = 'Idle';
        if (this.pendingOkAfterHome) this.send('ok');
        this.pendingOkAfterHome = false;
      }
      return;
    }
    if (this.state !== 'Run' && this.state !== 'Jog') return;
    let remaining = dt;
    while (remaining > 0 && this.planner.length) {
      const b = this.planner[0];
      const mmPerSec = Math.max(this.effectiveFeed(b), 1) / 60;
      let travel = mmPerSec * remaining;
      while (travel > 0 && b.points.length) {
        const target = b.points[0];
        const d = Math.hypot(target[0] - this.mpos[0], target[1] - this.mpos[1], target[2] - this.mpos[2]);
        if (d <= travel) {
          this.mpos = [...target] as Vec3;
          b.points.shift();
          travel -= d;
        } else {
          const k = travel / d;
          for (let i = 0; i < 3; i++) this.mpos[i] += (target[i] - this.mpos[i]) * k;
          travel = 0;
        }
      }
      remaining = travel / mmPerSec;
      if (!b.points.length) this.planner.shift();
      if (travel <= 0) break;
    }
    if (!this.planner.length) this.state = 'Idle';
  }

  private processRx(): void {
    while (this.isOpen) {
      const nl = this.rx.indexOf('\n');
      if (nl < 0) return;
      const raw = this.rx.slice(0, nl).replace(/\r$/, '');
      const line = cleanLine(raw);
      // Lines that need the planner empty first wait (GRBL syncs these).
      if (this.needsSync(line) && (this.planner.length || this.state === 'Home')) return;
      if (this.isMotion(line) && this.planner.length >= this.opts.plannerSize) return;
      if (this.state === 'Home') return;
      this.rx = this.rx.slice(nl + 1);
      this.received.push(line);
      this.execute(line);
    }
  }

  private isMotion(line: string): boolean {
    return line.startsWith('$J=') || (!line.startsWith('$') && /[XYZ]/.test(line));
  }

  private needsSync(line: string): boolean {
    if (line.startsWith('$J=')) return false;
    if (line.startsWith('$')) return true;
    return /G10|G92|G28|G30|M0?[0125](?!\d)|M30/.test(line);
  }

  private execute(line: string): void {
    if (!line) return this.send('ok');
    if (line.startsWith('$')) return this.system(line);
    if (this.state === 'Alarm') return this.send('error:9');
    if (this.state === 'Jog') return this.send('error:9');
    this.gcode(line);
  }

  private system(line: string): void {
    if (line === '$$') {
      for (const [k, v] of Object.entries(this.settings)) this.send(`$${k}=${v}`);
      return this.send('ok');
    }
    if (line === '$#') {
      const w = this.wco.map((v) => v.toFixed(3)).join(',');
      this.send(`[G54:${w}]`);
      for (const g of ['G55', 'G56', 'G57', 'G58', 'G59']) this.send(`[${g}:0.000,0.000,0.000]`);
      this.send('[G28:0.000,0.000,0.000]');
      this.send('[G30:0.000,0.000,0.000]');
      this.send('[G92:0.000,0.000,0.000]');
      this.send('[TLO:0.000]');
      this.send('[PRB:0.000,0.000,0.000:0]');
      return this.send('ok');
    }
    if (line === '$G') {
      const i = this.interp;
      this.send(
        `[GC:G${i.motion} G54 G${17 + i.plane} G${i.inches ? 20 : 21} G${i.absolute ? 90 : 91} G94 M${this.spindleOn ? 3 : 5} M9 T0 F${i.feed} S${this.spindleSpeed}]`,
      );
      return this.send('ok');
    }
    if (line === '$I') {
      this.send(`[VER:${VERSION}:]`);
      this.send(`[OPT:V,${this.opts.plannerSize},${this.opts.rxSize}]`);
      return this.send('ok');
    }
    if (line === '$X') {
      if (this.state === 'Alarm') {
        this.state = 'Idle';
        this.send('[MSG:Caution: Unlocked]');
      }
      return this.send('ok');
    }
    if (line === '$H') {
      if (this.state !== 'Idle' && this.state !== 'Alarm') return this.send('error:8');
      this.state = 'Home';
      this.homingRemaining = 2; // simulated seconds
      this.pendingOkAfterHome = true;
      return;
    }
    if (line.startsWith('$J=')) return this.jog(line.slice(3));
    const set = /^\$(\d+)=(-?[\d.]+)$/.exec(line);
    if (set) {
      if (this.state !== 'Idle' && this.state !== 'Alarm') return this.send('error:8');
      this.settings[Number(set[1])] = Number(set[2]);
      if (Number(set[1]) === 20) this.opts.softLimits = Number(set[2]) === 1;
      return this.send('ok');
    }
    if (line === '$C' || line === '$SLP' || line === '$N' || line === '$RST=*' || line === '$RST=$' || line === '$RST=#') return this.send('ok');
    this.send('error:3');
  }

  private jog(body: string): void {
    if (this.state !== 'Idle' && this.state !== 'Jog') return this.send('error:8');
    const words = parseWords(body);
    const g = words.filter((w) => w.letter === 'G').map((w) => w.value);
    if (!words.some((w) => w.letter === 'F')) return this.send('error:22');
    const incremental = g.includes(91);
    const machine = g.includes(53);
    const scale = g.includes(20) ? 25.4 : 1;
    const start = this.plannedEnd();
    const target: Vec3 = [...start] as Vec3;
    let feed = 0;
    const axes = ['X', 'Y', 'Z'];
    for (const w of words) {
      const i = axes.indexOf(w.letter);
      if (w.letter === 'F') feed = w.value * scale;
      if (i < 0) continue;
      const v = w.value * scale;
      if (incremental) target[i] = start[i] + v;
      else if (machine) target[i] = v;
      else target[i] = v + this.wco[i];
    }
    if (this.opts.softLimits && !this.inEnvelope(target)) return this.send('error:15');
    this.planner.push({ points: [target], feed, rapid: false, jog: true });
    this.state = 'Jog';
    this.send('ok');
  }

  private inEnvelope(p: Vec3): boolean {
    for (let i = 0; i < 3; i++) if (p[i] > 0.001 || p[i] < -this.opts.travel[i] - 0.001) return false;
    return true;
  }

  private gcode(line: string): void {
    const words = parseWords(line);
    const gs = words.filter((w) => w.letter === 'G').map((w) => w.value);
    const axisWords = words.filter((w) => w.letter === 'X' || w.letter === 'Y' || w.letter === 'Z');

    // Spindle
    for (const w of words) {
      if (w.letter === 'S') this.spindleSpeed = w.value;
      if (w.letter === 'M') {
        if (w.value === 3 || w.value === 4) this.spindleOn = true;
        if (w.value === 5 || w.value === 2 || w.value === 30) this.spindleOn = false;
      }
    }

    // Work offsets
    if (gs.includes(10)) {
      const l = words.find((w) => w.letter === 'L')?.value;
      const scale = this.interp.inches ? 25.4 : 1;
      for (const w of axisWords) {
        const i = 'XYZ'.indexOf(w.letter);
        if (l === 20) this.wco[i] = this.mpos[i] - w.value * scale;
        else if (l === 2) this.wco[i] = w.value * scale;
      }
      return this.send('ok');
    }
    if (gs.includes(92) || gs.includes(28) || gs.includes(30)) return this.send('ok');

    // Machine-coordinate move
    if (gs.includes(53)) {
      const start = this.plannedEnd();
      const target: Vec3 = [...start] as Vec3;
      for (const w of axisWords) target['XYZ'.indexOf(w.letter)] = w.value;
      return this.plan([target], gs.includes(1) ? this.interp.feed : 0, !gs.includes(1));
    }

    // Normal motion, interpreted in work coordinates.
    const end = this.plannedEnd();
    this.interp.setPosition([end[0] - this.wco[0], end[1] - this.wco[1], end[2] - this.wco[2]]);
    const motionBefore = this.interp.motion;
    const segs = this.interp.step(line);
    if (!segs.length) return this.send('ok');
    const feedMove = segs[0].type === 'feed';
    if (feedMove && !(segs[0].feed > 0)) {
      this.interp.motion = motionBefore;
      return this.send('error:22');
    }
    const points = segs.map((s) => [s.to[0] + this.wco[0], s.to[1] + this.wco[1], s.to[2] + this.wco[2]] as Vec3);
    this.plan(points, segs[0].feed, !feedMove);
  }

  private plan(points: Vec3[], feed: number, rapid: boolean): void {
    if (this.opts.softLimits && !points.every((p) => this.inEnvelope(p))) {
      this.planner = [];
      this.state = 'Alarm';
      this.send('ALARM:2');
      return;
    }
    this.planner.push({ points, feed, rapid, jog: false });
    if (this.state === 'Idle') this.state = 'Run';
    this.send('ok');
  }
}
