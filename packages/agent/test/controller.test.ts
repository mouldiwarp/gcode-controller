import { afterEach, describe, expect, it } from 'vitest';
import { cleanLine } from '@gcc/shared';
import { GrblController } from '../src/controller.ts';
import { FakeGrbl } from '../src/sim/fakeGrbl.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await wait(5);
  }
}

/** A pocket-like program: many short moves plus arcs, comments and blank lines. */
function program(): string {
  const out = ['(test pocket)', 'G21 G90', 'M3 S12000', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300'];
  for (let i = 0; i < 60; i++) {
    out.push(`G1 X${(i % 2) * 40} Y${i * 0.5} F2400 ; pass ${i}`);
    if (i % 10 === 0) out.push('', `G2 X${(i % 2) * 40} Y${i * 0.5 + 0.5} I0 J0.25`);
  }
  out.push('G0 Z5', 'M5', 'M30');
  return out.join('\n');
}

let ctl: GrblController;
let sim: FakeGrbl;
afterEach(async () => ctl?.disconnect());

async function setup(simOpts = {}) {
  sim = new FakeGrbl({ bootDelayMs: 0, homingRequired: false, speed: 200, ...simOpts });
  ctl = new GrblController({ pollMs: 20, simulated: true });
  await ctl.connect(sim);
  await until(() => ctl.machine.connection === 'connected' && ctl.machine.status === 'Idle');
  await until(() => !!ctl.machine.settings);
}

describe('GrblController', () => {
  it('streams a whole job without overflowing the RX buffer', async () => {
    await setup();
    const text = program();
    ctl.startJob(text, { fileId: 'f1', fileName: 'pocket.nc', by: 'test' });
    await until(() => ctl.job.status === 'done', 15000);
    expect(sim.overflowed).toBe(false);
    const sent = text.split('\n').map(cleanLine).filter(Boolean);
    const received = sim.received.slice(sim.received.indexOf(sent[0]));
    expect(received).toEqual(sent);
    expect(ctl.job.ackedLines).toBe(ctl.job.totalLines);
    expect(ctl.machine.firmware).toContain('1.1h');
  });

  it('refuses jog and MDI while a job runs, but always accepts hold', async () => {
    await setup({ speed: 5 });
    ctl.startJob(program(), { fileId: 'f1', fileName: 'pocket.nc' });
    await expect(ctl.command({ type: 'jog', x: 1, feed: 1000 })).rejects.toThrow(/job is running/);
    await expect(ctl.command({ type: 'mdi', line: 'G0X0' })).rejects.toThrow(/job is running/);
    await ctl.command({ type: 'hold' }, 'garage');
    expect(ctl.job.status).toBe('paused');
    await until(() => ctl.machine.status === 'Hold');
    await ctl.command({ type: 'resume' }, 'studio');
    expect(ctl.job.status).toBe('running');
    expect(ctl.machine.lastCommandBy).toBe('studio');
  });

  it('stops a job with hold then reset, without an alarm', async () => {
    await setup({ speed: 2 });
    ctl.startJob(program(), { fileId: 'f1', fileName: 'pocket.nc' });
    await until(() => ctl.machine.status === 'Run');
    await ctl.command({ type: 'stop' });
    await until(() => ctl.job.status === 'stopped');
    await until(() => ctl.machine.status === 'Idle');
    expect(ctl.machine.alarm).toBeUndefined();
  });

  it('pauses on a G-code error and can resume', async () => {
    await setup();
    ctl.startJob('G21\nG0X1\nG1X5\nG0X0\n', { fileId: 'f', fileName: 'bad.nc' });
    await until(() => ctl.job.status === 'paused');
    expect(ctl.job.error).toMatch(/error:22/);
    await ctl.command({ type: 'resume' });
    await until(() => ctl.job.status === 'done');
  });

  it('fails the job on an alarm', async () => {
    await setup({ speed: 1 });
    ctl.startJob(program(), { fileId: 'f1', fileName: 'pocket.nc' });
    await until(() => ctl.machine.status === 'Run');
    sim.injectAlarm(1);
    await until(() => ctl.job.status === 'error');
    expect(ctl.machine.alarm?.code).toBe(1);
  });

  it('sets work zero and jogs', async () => {
    await setup();
    await ctl.command({ type: 'jog', x: -10, y: -5, z: -20, feed: 3000 });
    await until(() => ctl.machine.mpos[0] === -10 && ctl.machine.status === 'Idle');
    await ctl.command({ type: 'zero', axes: ['X', 'Y', 'Z'] });
    await until(() => ctl.machine.wpos[0] === 0 && ctl.machine.wco[0] === -10);
    await ctl.command({ type: 'jog', x: 3, feed: 3000 });
    await until(() => Math.abs(ctl.machine.wpos[0] - 3) < 1e-6 && ctl.machine.status === 'Idle');
    await ctl.command({ type: 'goToZero', axes: ['X', 'Y'] });
    await until(() => Math.abs(ctl.machine.wpos[0]) < 1e-6 && ctl.machine.status === 'Idle');
    expect(ctl.machine.wpos[2]).toBeCloseTo(5);
  });

  it('marks the job failed when the USB link drops', async () => {
    await setup({ speed: 1 });
    ctl.startJob(program(), { fileId: 'f1', fileName: 'pocket.nc' });
    await until(() => ctl.machine.status === 'Run');
    sim.unplug();
    await until(() => ctl.job.status === 'error');
    expect(ctl.machine.connection).toBe('disconnected');
  });
});
