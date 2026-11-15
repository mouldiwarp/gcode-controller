// End-to-end: a hub, an agent on the simulator, one "browser" on each, and the
// file hand-off, job sync and hub-restart behaviour between them.

import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { applyPatch, randomId, type AppState, type Command, type ServerMessage } from '@gcc/shared';
import { Agent, type AgentOptions } from '../../agent/src/agent.ts';
import { Hub, type HubOptions } from '../src/hub.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 10000, what = 'condition') {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await wait(10);
  }
}

class Browser {
  state?: AppState;
  toasts: string[] = [];
  percents: number[] = [];
  private ws: WebSocket;
  private results = new Map<string, (r: { ok: boolean; error?: string }) => void>();
  constructor(url: string, name: string) {
    this.ws = new WebSocket(url);
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name })));
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'snapshot') this.state = m.state;
      else if (m.t === 'patch' && this.state) applyPatch(this.state, m.patch);
      else if (m.t === 'console' && this.state) this.state.console.push(...m.lines);
      else if (m.t === 'toast') this.toasts.push(m.text);
      else if (m.t === 'result') this.results.get(m.reqId)?.(m);
      if (this.state?.job.totalLines) this.percents.push(this.state.job.ackedLines / this.state.job.totalLines);
    });
  }
  cmd(cmd: Command): Promise<{ ok: boolean; error?: string }> {
    const reqId = randomId();
    return new Promise((resolve) => {
      this.results.set(reqId, resolve);
      this.ws.send(JSON.stringify({ t: 'cmd', reqId, cmd }));
    });
  }
  close() {
    this.ws.close();
  }
}

function program(passes = 200): string {
  const lines = ['G21 G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F600'];
  for (let i = 0; i < passes; i++) lines.push(`G1 X${(i % 2) * 30} Y${(i * 0.3).toFixed(1)} F3000`);
  lines.push('G0 Z5', 'M30');
  return lines.join('\n');
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups.length = 0;
});

async function setup(simSpeed = 50, extra: { hub?: Partial<HubOptions>; agent?: Partial<AgentOptions> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gcc-'));
  const hubOpts = { port: 0, host: '127.0.0.1', dataDir: join(dir, 'hub'), inboxDir: join(dir, 'inbox'), advertise: false, name: 'studio', ...extra.hub };
  let hub = new Hub(hubOpts);
  const hubPort = await hub.start();
  const agent = new Agent({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(dir, 'agent'),
    hubUrl: `http://127.0.0.1:${hubPort}`,
    discover: false,
    simulate: true,
    sim: { speed: simSpeed, homingRequired: false, bootDelayMs: 0 },
    name: 'garage',
    pollMs: 40,
    ...extra.agent,
  });
  const agentPort = await agent.start();
  const studio = new Browser(`ws://127.0.0.1:${hubPort}/ws`, 'Studio');
  const garage = new Browser(`ws://127.0.0.1:${agentPort}/ws`, 'Garage');
  cleanups.push(async () => {
    studio.close();
    garage.close();
    await agent.stop();
    await hub.stop();
  });
  await until(() => !!studio.state?.link.agentConnected && !!garage.state?.link.hubConnected, 5000, 'link');
  await until(() => studio.state!.machine.status === 'Idle' && garage.state!.machine.status === 'Idle', 5000, 'machine idle');
  const restartHub = async () => {
    await hub.stop();
    hub = new Hub({ ...hubOpts, port: hubPort });
    await hub.start();
    cleanups.push(() => hub.stop());
  };
  return { dir, hubPort, agentPort, agent, studio, garage, getHub: () => hub, stopHub: () => hub.stop(), restartHub };
}

async function upload(port: number, name: string, text: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
    method: 'POST',
    body: text,
    headers: { 'X-Filename': name, ...headers },
  });
  return { status: res.status, body: (await res.json()) as { id: string; error?: string } };
}

describe('hub ↔ agent sync', () => {
  it('shares uploads with both browsers and runs a job started from the studio', async () => {
    const { hubPort, studio, garage } = await setup();
    const { status, body } = await upload(hubPort, 'pocket.nc', program(), { 'X-Source': 'Swarf' });
    expect(status).toBe(201);
    await until(() => garage.state!.library.some((f) => f.id === body.id), 3000, 'library on garage');
    expect(studio.state!.library[0]).toMatchObject({ name: 'pocket.nc', source: 'Swarf' });

    const r = await studio.cmd({ type: 'start', fileId: body.id });
    expect(r).toMatchObject({ ok: true });
    await until(() => garage.state!.job.status === 'running', 3000, 'garage sees running');
    expect(garage.state!.job.startedBy).toBe('Studio');
    await until(() => studio.state!.job.status === 'done', 15000, 'job done');
    await until(() => garage.state!.job.status === 'done', 2000, 'garage done');

    // Both browsers watched progress climb, not just jump to the end.
    for (const b of [studio, garage]) {
      const mid = b.percents.filter((p) => p > 0.05 && p < 0.95);
      expect(mid.length).toBeGreaterThan(2);
    }
  });

  it('runs a Swarf group in order, waiting for a bit change between files', async () => {
    const { hubPort, agent, studio, garage } = await setup(400);
    const ids: string[] = [];
    for (const [i, name] of ['1-roughing.nc', '2-finishing.nc', '3-profile.nc'].entries()) {
      const { body } = await upload(hubPort, name, program(40), { 'X-Source': 'Swarf', 'X-Group': 'Body', 'X-Group-Index': String(i) });
      ids.push(body.id);
    }
    await until(() => garage.state!.library.length === 3, 3000, 'library');
    expect(await studio.cmd({ type: 'saveConfig', config: { probe: { ...studio.state!.config.probe, plateThickness: 15 } } })).toMatchObject({ ok: true });

    expect(await studio.cmd({ type: 'start', fileId: ids[0], group: true })).toMatchObject({ ok: true });
    await until(() => studio.state!.job.status === 'toolchange', 15000, 'first tool change');
    expect(studio.state!.job.group).toMatchObject({ name: 'Body', index: 0 });
    expect(studio.state!.job.group!.files.map((f) => f.name)).toEqual(['1-roughing.nc', '2-finishing.nc', '3-profile.nc']);
    await until(() => agent.sim!.received.at(-1) === 'M5', 2000, 'spindle off');

    // A different file can't start in the middle of a group.
    expect(await garage.cmd({ type: 'start', fileId: ids[0] })).toMatchObject({ ok: false, error: expect.stringMatching(/bit change/) });
    // Jogging and probing work during the change.
    expect(await garage.cmd({ type: 'jog', z: 5, feed: 1000 })).toMatchObject({ ok: true });
    await until(() => garage.state!.machine.status === 'Idle', 3000, 'jog done');
    agent.sim!.opts.probeSurfaceZ = garage.state!.machine.mpos[2] - 10;
    expect(await garage.cmd({ type: 'probeZ' })).toMatchObject({ ok: true });

    expect(await garage.cmd({ type: 'startNext' })).toMatchObject({ ok: true });
    await until(() => studio.state!.job.status === 'toolchange' && studio.state!.job.group!.index === 1, 15000, 'second tool change');
    expect(await studio.cmd({ type: 'startNext' })).toMatchObject({ ok: true });
    await until(() => studio.state!.job.status === 'done', 15000, 'group done');
    expect(studio.state!.job).toMatchObject({ fileName: '3-profile.nc', group: { index: 2 } });
    expect(await studio.cmd({ type: 'startNext' })).toMatchObject({ ok: false });
  });

  it('clears the probe pin on the studio browser once the plate is lifted away', async () => {
    const { agent, studio, garage } = await setup();
    const z = garage.state!.machine.mpos[2];
    agent.sim!.opts.probeSurfaceZ = z; // touching where the bit is now
    await until(() => !!studio.state!.machine.pins?.includes('P'), 3000, 'pin closed on the studio');
    agent.sim!.opts.probeSurfaceZ = z - 20; // plate taken away
    await until(() => !garage.state!.machine.pins, 3000, 'pin open in the garage');
    await until(() => !studio.state!.machine.pins, 3000, 'pin open on the studio');
  });

  it('ends a group early with clearJob', async () => {
    const { hubPort, studio } = await setup(400);
    const ids: string[] = [];
    for (const i of [0, 1]) ids.push((await upload(hubPort, `side-${i}.nc`, program(20), { 'X-Group': 'Sides', 'X-Group-Index': String(i) })).body.id);
    await until(() => studio.state!.library.length === 2, 3000, 'library');
    // Without group: true only the one file runs.
    expect(await studio.cmd({ type: 'start', fileId: ids[0] })).toMatchObject({ ok: true });
    await until(() => studio.state!.job.status === 'done', 15000, 'single done');
    expect(studio.state!.job.group).toBeUndefined();
    expect(await studio.cmd({ type: 'start', fileId: ids[0], group: true })).toMatchObject({ ok: true });
    await until(() => studio.state!.job.status === 'toolchange', 15000, 'tool change');
    expect(await studio.cmd({ type: 'clearJob' })).toMatchObject({ ok: true });
    await until(() => studio.state!.job.status === 'idle', 2000, 'cleared');
    expect(await studio.cmd({ type: 'start', fileId: ids[1] })).toMatchObject({ ok: true });
  });

  it('manages folders from the garage, and both browsers see the same tree', async () => {
    const { hubPort, studio, garage } = await setup();
    expect(await garage.cmd({ type: 'createFolder', path: 'Guitars/Strat' })).toMatchObject({ ok: true });
    await until(() => studio.state!.folders.includes('Guitars/Strat'), 3000, 'folder on studio');
    const { body } = await upload(hubPort, 'body.nc', program(10), { 'X-Folder': encodeURIComponent('Guitars/Strat') });
    await until(() => garage.state!.library.some((f) => f.id === body.id && f.folder === 'Guitars/Strat'), 3000, 'file in folder');
    expect(await garage.cmd({ type: 'renameFolder', path: 'Guitars', to: 'Instruments' })).toMatchObject({ ok: true });
    await until(() => studio.state!.library.find((f) => f.id === body.id)?.folder === 'Instruments/Strat', 3000, 'renamed');
    expect(await studio.cmd({ type: 'moveFile', fileId: body.id, folder: '' })).toMatchObject({ ok: true });
    await until(() => garage.state!.library.find((f) => f.id === body.id)?.folder === '', 3000, 'moved to top');
    // The file still runs after all that moving.
    expect(await garage.cmd({ type: 'start', fileId: body.id })).toMatchObject({ ok: true });
    await until(() => studio.state!.job.status === 'done', 15000, 'job done');
    expect(await studio.cmd({ type: 'deleteFolder', path: 'Instruments' })).toMatchObject({ ok: true });
    await until(() => garage.state!.folders.length === 0, 3000, 'folder gone');
    expect(await studio.cmd({ type: 'createFolder', path: '../escape' })).toMatchObject({ ok: false });
  });

  it('lets the garage start, the studio pause, and the garage resume', async () => {
    const { hubPort, studio, garage } = await setup(3);
    const { body } = await upload(hubPort, 'slow.nc', program(400));
    await until(() => garage.state!.library.some((f) => f.id === body.id));
    expect(await garage.cmd({ type: 'start', fileId: body.id })).toMatchObject({ ok: true });
    await until(() => studio.state!.machine.status === 'Run', 3000, 'running');
    expect(await studio.cmd({ type: 'hold' })).toMatchObject({ ok: true });
    await until(() => garage.state!.job.status === 'paused' && garage.state!.machine.status === 'Hold', 3000, 'paused');
    expect(garage.state!.machine.lastCommandBy).toBe('Studio');
    // Jogging is refused while a job is active, from either side.
    expect((await garage.cmd({ type: 'jog', x: 1, feed: 500 })).ok).toBe(false);
    expect(await garage.cmd({ type: 'resume' })).toMatchObject({ ok: true });
    await until(() => studio.state!.job.status === 'running');
    expect(await studio.cmd({ type: 'stop' })).toMatchObject({ ok: true });
    await until(() => garage.state!.job.status === 'stopped', 5000, 'stopped');
  });

  it('keeps the job running when the hub goes away, and resyncs when it returns', async () => {
    const { hubPort, garage, agent, stopHub, restartHub } = await setup(4);
    const { body } = await upload(hubPort, 'long.nc', program(300));
    await until(() => garage.state!.library.some((f) => f.id === body.id));
    expect(await garage.cmd({ type: 'start', fileId: body.id })).toMatchObject({ ok: true });
    await until(() => garage.state!.job.ackedLines > 20, 5000, 'progress');

    await stopHub();
    await until(() => garage.state!.link.hubConnected === false, 5000, 'garage notices hub down');
    const before = garage.state!.job.ackedLines;
    await wait(300);
    expect(garage.state!.job.status).toBe('running');
    expect(garage.state!.job.ackedLines).toBeGreaterThan(before);
    // The library is still visible from the agent's cache.
    expect(garage.state!.library.some((f) => f.id === body.id)).toBe(true);

    await restartHub();
    const studio2 = new Browser(`ws://127.0.0.1:${hubPort}/ws`, 'Studio');
    cleanups.push(() => studio2.close());
    await until(() => !!studio2.state?.link.agentConnected, 15000, 'agent reconnects');
    await until(() => studio2.state!.job.fileName === 'long.nc' && studio2.state!.job.ackedLines > 0, 5000, 'studio resynced');
    agent.sim!.opts.speed = 400; // fast-forward the rest of the job
    await until(() => studio2.state!.job.status === 'done', 10000, 'done after resync');
  });

  it('imports files dropped in the inbox and forwards library commands from the garage', async () => {
    const { dir, studio, garage } = await setup();
    writeFileSync(join(dir, 'inbox', 'dots.nc'), 'G0X0Y0\nG1X10F100\n');
    await until(() => studio.state!.library.some((f) => f.name === 'dots.nc'), 6000, 'inbox import');
    expect(existsSync(join(dir, 'inbox', 'imported', 'dots.nc'))).toBe(true);
    const id = studio.state!.library.find((f) => f.name === 'dots.nc')!.id;
    await until(() => garage.state!.library.some((f) => f.id === id));
    expect(await garage.cmd({ type: 'deleteFile', fileId: id })).toMatchObject({ ok: true });
    await until(() => !studio.state!.library.some((f) => f.id === id), 3000, 'deleted');
  });

  it('rejects empty or binary uploads and refuses to start in alarm', async () => {
    const { hubPort, garage, agent } = await setup();
    expect((await upload(hubPort, 'empty.nc', '')).status).toBe(400);
    expect((await upload(hubPort, 'bin.nc', 'G0\u0000X1')).status).toBe(400);
    const { body } = await upload(hubPort, 'ok.nc', program(5));
    await until(() => garage.state!.library.some((f) => f.id === body.id));
    agent.sim!.injectAlarm(1);
    await until(() => garage.state!.machine.status === 'Alarm');
    const r = await garage.cmd({ type: 'start', fileId: body.id });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ALARM/);
  });
});

describe('code versions', () => {
  const OLD = { version: '0.1.0', commit: 'a'.repeat(40), time: 1_000_000, canUpdate: true, supervised: true, repo: tmpdir() };
  const NEW = { ...OLD, commit: 'b'.repeat(40), time: 2_000_000 };
  const ok = (ms = 0) => ({ label: 'Step', cmd: process.execPath, args: ['-e', `setTimeout(() => {}, ${ms})`] });
  const fail = { label: 'Downloading the latest code (git pull)', cmd: process.execPath, args: ['-e', 'console.error("fatal: Not possible to fast-forward"); process.exit(1)'], hint: 'Nothing was changed.' };

  it('holds an agent that is behind the hub, but still lets it stop', async () => {
    const { hubPort, studio, garage } = await setup(50, { hub: { code: NEW }, agent: { code: OLD } });
    await until(() => !!studio.state!.code?.agentBehind && !!garage.state!.code?.agentBehind, 3000, 'both see the agent is behind');
    expect(studio.state!.code).toMatchObject({ hubBehind: false, hub: { commit: NEW.commit }, agent: { commit: OLD.commit } });

    const { body } = await upload(hubPort, 'part.nc', program(10));
    await until(() => garage.state!.library.length === 1, 3000, 'library');
    for (const b of [studio, garage]) {
      expect(await b.cmd({ type: 'start', fileId: body.id })).toMatchObject({ ok: false, error: expect.stringMatching(/older code/) });
      expect(await b.cmd({ type: 'jog', x: 5, feed: 1000 })).toMatchObject({ ok: false, error: expect.stringMatching(/older code/) });
    }
    // Safety and library commands still work.
    expect(await studio.cmd({ type: 'hold' })).toMatchObject({ ok: true });
    expect(await garage.cmd({ type: 'reset' })).toMatchObject({ ok: true });
    expect(await garage.cmd({ type: 'createFolder', path: 'Still works' })).toMatchObject({ ok: true });
  });

  it('only reminds about a hub that is behind', async () => {
    const { studio, garage } = await setup(50, { hub: { code: OLD }, agent: { code: NEW } });
    await until(() => !!studio.state!.code?.hubBehind && !!garage.state!.code?.hubBehind, 3000, 'hub behind');
    expect(studio.state!.code!.agentBehind).toBe(false);
    expect(await garage.cmd({ type: 'jog', x: 1, feed: 1000 })).toMatchObject({ ok: true });
  });

  it('holds an agent too old to say which code it runs', async () => {
    const { hubPort, studio, agent } = await setup(50, { hub: { code: NEW } });
    await agent.stop(); // replace the real agent with one that predates version checks
    const old = new WebSocket(`ws://127.0.0.1:${hubPort}/agent`);
    cleanups.push(() => old.close());
    await new Promise((r) => old.on('open', r));
    old.send(JSON.stringify({ t: 'hello', name: 'old agent', version: '1' }));
    await until(() => !!studio.state!.code?.agentBehind, 3000, 'old agent behind');
    expect(studio.state!.code!.agent).toBeUndefined();
    expect(await studio.cmd({ type: 'home' })).toMatchObject({ ok: false, error: expect.stringMatching(/older code/) });
  });

  it('updates the agent from the studio, then restarts it', async () => {
    let restarted = 0;
    const { studio } = await setup(50, { hub: { code: NEW }, agent: { code: OLD, updateSteps: [ok(50), ok()], onRestart: () => restarted++ } });
    await until(() => !!studio.state!.code?.agentBehind, 3000, 'behind');
    expect(await studio.cmd({ type: 'update', target: 'agent' })).toMatchObject({ ok: true });
    await until(() => !!studio.state!.code!.agent?.update?.running, 3000, 'progress reaches the studio');
    await until(() => restarted === 1, 5000, 'restart');
    expect(studio.state!.code!.agent!.update).toMatchObject({ running: false, step: expect.stringMatching(/Restarting/) });
    expect(studio.state!.console.some((l) => /Agent updated/.test(l.text))).toBe(true);
  });

  it('reports a failed update and changes nothing', async () => {
    let restarted = 0;
    const { studio, garage } = await setup(50, { hub: { code: NEW }, agent: { code: OLD, updateSteps: [fail, ok()], onRestart: () => restarted++ } });
    await until(() => !!garage.state!.code?.agentBehind, 3000, 'behind');
    expect(await garage.cmd({ type: 'update', target: 'agent' })).toMatchObject({ ok: true });
    await until(() => !!studio.state!.code!.agent?.update?.error, 5000, 'error reaches the studio');
    expect(studio.state!.code!.agent!.update!.error).toMatch(/git pull\) failed: fatal: Not possible to fast-forward\. Nothing was changed/);
    expect(restarted).toBe(0);
    expect(studio.toasts.some((t) => /Agent update failed/.test(t))).toBe(true);
  });

  it("won't update the agent in the middle of a job, and updates the hub from the garage", async () => {
    let hubRestarted = 0;
    const { hubPort, studio, garage } = await setup(5, { hub: { code: OLD, updateSteps: [ok()], onRestart: () => hubRestarted++ }, agent: { code: NEW, updateSteps: [ok()] } });
    const { body } = await upload(hubPort, 'long.nc', program(400));
    await until(() => garage.state!.library.length === 1, 3000, 'library');
    expect(await garage.cmd({ type: 'start', fileId: body.id })).toMatchObject({ ok: true });
    await until(() => garage.state!.job.status === 'running', 3000, 'running');
    expect(await studio.cmd({ type: 'update', target: 'agent' })).toMatchObject({ ok: false, error: expect.stringMatching(/Finish or end the job/) });
    // The hub can update mid-job: the agent streams the job itself.
    expect(await garage.cmd({ type: 'update', target: 'hub' })).toMatchObject({ ok: true });
    await until(() => hubRestarted === 1, 5000, 'hub restart');
    expect(garage.state!.job.status).toBe('running');
    await garage.cmd({ type: 'stop' });
  });
});
