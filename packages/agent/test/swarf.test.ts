// Real Swarf output (FoxAlien XE-Pro Ultra post, cutout with arcs and tabs)
// must analyse to the extents and time Swarf printed in its header, and
// stream through the simulator line for line without overflowing GRBL's buffer.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeProgram, streamableLines } from '@gcc/shared';
import { GrblController } from '../src/controller.ts';
import { FakeGrbl } from '../src/sim/fakeGrbl.ts';

const text = readFileSync(new URL('./fixtures/swarf-dome-cutout.nc', import.meta.url), 'utf8');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ctl: GrblController | undefined;
afterEach(async () => ctl?.disconnect());

describe('Swarf output', () => {
  it('matches the extents and run time Swarf reports', () => {
    const a = analyzeProgram(text, { rapidRate: 5000 });
    // Header: (Extents X1.50..78.50 Y-38.50..38.50 Z-30.30..5.00). Swarf's extents leave out the
    // final G0 X0 Y0 park move, so compare XY against the cutting moves.
    expect(a.cutBounds!.min[0]).toBeCloseTo(1.5, 1);
    expect(a.cutBounds!.max[0]).toBeCloseTo(78.5, 1);
    expect(a.cutBounds!.min[1]).toBeCloseTo(-38.5, 1);
    expect(a.cutBounds!.max[1]).toBeCloseTo(38.5, 1);
    expect(a.cutBounds!.min[2]).toBeCloseTo(-30.3, 1);
    expect(a.bounds!.max[2]).toBeCloseTo(5, 1);
    // Header: (Estimated run time: 4 min 50 s). Ours ignores acceleration, so allow 10%.
    expect(a.estSeconds).toBeGreaterThan(290 * 0.9);
    expect(a.estSeconds).toBeLessThan(290 * 1.1);
  });

  it('streams through the simulator exactly', async () => {
    const sim = new FakeGrbl({ bootDelayMs: 0, homingRequired: false, speed: 2000 });
    ctl = new GrblController({ pollMs: 20, simulated: true });
    await ctl.connect(sim);
    while (ctl.machine.status !== 'Idle') await wait(5);
    ctl.startJob(text, { fileId: 'swarf', fileName: 'swarf-dome-cutout.nc' });
    const end = Date.now() + 15000;
    while (ctl.job.status !== 'done') {
      if (Date.now() > end || ctl.job.status === 'error' || ctl.job.status === 'paused') throw new Error(`job ${ctl.job.status}: ${ctl.job.error}`);
      await wait(10);
    }
    expect(sim.overflowed).toBe(false);
    const sent = streamableLines(text).map((l) => l.text);
    expect(sim.received.slice(-sent.length)).toEqual(sent);
  });
});
