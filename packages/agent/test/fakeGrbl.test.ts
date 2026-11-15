import { afterEach, describe, expect, it } from 'vitest';
import { FakeGrbl } from '../src/sim/fakeGrbl.ts';

function collect(sim: FakeGrbl) {
  const lines: string[] = [];
  let buf = '';
  sim.onData((d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) lines.push(l);
    }
  });
  return lines;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await wait(5);
  }
}

let sim: FakeGrbl;
afterEach(async () => sim?.close());

describe('FakeGrbl', () => {
  it('boots into alarm and unlocks with $X', async () => {
    sim = new FakeGrbl({ bootDelayMs: 0 });
    const out = collect(sim);
    await sim.open();
    await until(() => out.some((l) => l.startsWith('Grbl 1.1h')));
    expect(sim.state).toBe('Alarm');
    sim.write('G0X1\n');
    await until(() => out.includes('error:9'));
    sim.write('$X\n');
    await until(() => out.includes('[MSG:Caution: Unlocked]'));
    expect(sim.state).toBe('Idle');
  });

  it('moves, reports status and sets work zero', async () => {
    sim = new FakeGrbl({ bootDelayMs: 0, homingRequired: false, speed: 100 });
    const out = collect(sim);
    await sim.open();
    sim.write('G0X-10Y-20\n');
    await until(() => out.includes('ok'));
    await until(() => sim.state === 'Idle' && sim.mpos[0] === -10);
    sim.write('G10L20P0X0Y0Z0\n');
    await until(() => out.filter((l) => l === 'ok').length === 2);
    expect(sim.wco).toEqual([-10, -20, 0]);
    sim.write('?');
    await until(() => out.some((l) => l.startsWith('<Idle|MPos:-10.000,-20.000,0.000')));
    expect(out.find((l) => l.startsWith('<Idle'))).toContain('WCO:-10.000,-20.000,0.000');
  });

  it('flags RX overflow when the host ignores the buffer', async () => {
    sim = new FakeGrbl({ bootDelayMs: 0, homingRequired: false, speed: 0.001 });
    await sim.open();
    sim.write(Array.from({ length: 40 }, (_, i) => `G1X${i}F100`).join('\n') + '\n');
    expect(sim.overflowed).toBe(true);
  });

  it('holds, resumes, and soft reset in motion raises ALARM:3', async () => {
    sim = new FakeGrbl({ bootDelayMs: 0, homingRequired: false, speed: 1 });
    const out = collect(sim);
    await sim.open();
    sim.write('G1X-50F600\n');
    await until(() => sim.state === 'Run');
    sim.write('!');
    expect(sim.state).toBe('Hold');
    const x = sim.mpos[0];
    await wait(50);
    expect(sim.mpos[0]).toBe(x);
    sim.write('~');
    expect(sim.state).toBe('Run');
    sim.write('\x18');
    await until(() => out.includes('ALARM:3'));
    expect(sim.state).toBe('Alarm');
  });

  it('homes with $H and replies ok when done', async () => {
    sim = new FakeGrbl({ bootDelayMs: 0, speed: 20 });
    const out = collect(sim);
    await sim.open();
    await until(() => sim.state === 'Alarm');
    sim.write('$H\n');
    await until(() => sim.state === 'Home');
    await until(() => out.includes('ok'));
    expect(sim.state).toBe('Idle');
    expect(sim.mpos).toEqual([0, 0, 0]);
  });

  it('applies feed overrides from realtime bytes', async () => {
    sim = new FakeGrbl({ bootDelayMs: 0, homingRequired: false });
    const out = collect(sim);
    await sim.open();
    sim.write('\x91\x91\x93');
    for (let i = 0; i < 6; i++) sim.write('?');
    await until(() => out.some((l) => l.includes('Ov:121,100,100')));
  });
});
