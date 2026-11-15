import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@gcc/shared';
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

let ctl: GrblController;
let sim: FakeGrbl;
afterEach(async () => ctl?.disconnect());

async function setup(probeSurfaceZ: number | null, plateThickness = 15) {
  sim = new FakeGrbl({ bootDelayMs: 0, homingRequired: false, speed: 100, probeSurfaceZ });
  ctl = new GrblController({ pollMs: 20, simulated: true });
  ctl.config = { ...DEFAULT_CONFIG, probe: { ...DEFAULT_CONFIG.probe, plateThickness } };
  await ctl.connect(sim);
  await until(() => ctl.machine.connection === 'connected' && ctl.machine.status === 'Idle');
}

describe('Z probe', () => {
  it('touches twice and sets work Z to the plate thickness', async () => {
    await setup(-20);
    await ctl.command({ type: 'probeZ' }, 'garage');
    const probes = sim.received.filter((l) => l.startsWith('G38.2'));
    expect(probes).toHaveLength(2);
    expect(probes[1]).toMatch(/F25$/); // slow second touch
    // Plate top at machine Z -20, 15 mm thick: the stock surface is machine Z -35.
    await until(() => Math.abs(ctl.machine.wpos[2] - 20) < 0.01); // lifted to thickness + retract
    expect(ctl.machine.wco[2]).toBeCloseTo(-35, 3);
    expect(ctl.machine.probing).toBe(false);
    expect(ctl.machine.lastProbe).toMatchObject({ ok: true, contactZ: -20 });
    expect(ctl.machine.status).toBe('Idle');
  });

  it('reports a miss when nothing is touched within the search distance', async () => {
    await setup(null);
    await expect(ctl.command({ type: 'probeZ' })).rejects.toThrow(/No contact within 25 mm/);
    expect(ctl.machine.status).toBe('Alarm');
    expect(ctl.machine.lastProbe?.ok).toBe(false);
    expect(ctl.machine.probing).toBe(false);
    await until(() => Math.abs(ctl.machine.mpos[2] + 25) < 0.001); // searched the full 25 mm
  });

  it('refuses to probe until the plate thickness is set', async () => {
    await setup(-20, 0);
    await expect(ctl.command({ type: 'probeZ' })).rejects.toThrow(/plate thickness/);
    expect(sim.received.some((l) => l.startsWith('G38'))).toBe(false);
  });

  it('refuses to probe when the probe input is already closed', async () => {
    await setup(0); // the bit already rests on the plate
    await until(() => !!ctl.machine.pins?.includes('P'));
    await expect(ctl.command({ type: 'probeZ' })).rejects.toThrow(/already closed/);
    expect(sim.received.some((l) => l.startsWith('G38'))).toBe(false);
  });

  it('blocks jogging while probing', async () => {
    sim = new FakeGrbl({ bootDelayMs: 0, homingRequired: false, speed: 2, probeSurfaceZ: -20 });
    ctl = new GrblController({ pollMs: 20, simulated: true });
    ctl.config = { ...DEFAULT_CONFIG, probe: { ...DEFAULT_CONFIG.probe, plateThickness: 15 } };
    await ctl.connect(sim);
    await until(() => ctl.machine.status === 'Idle');
    const probing = ctl.command({ type: 'probeZ' }).catch((e) => e);
    await until(() => !!ctl.machine.probing);
    await expect(ctl.command({ type: 'jog', z: 1, feed: 100 })).rejects.toThrow(/while probing/);
    await ctl.command({ type: 'reset' });
    expect(await probing).toBeInstanceOf(Error);
    expect(ctl.machine.probing).toBe(false);
  });
});
