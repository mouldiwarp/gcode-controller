import { describe, expect, it } from 'vitest';
import { analyzeProgram, cleanLine, Interpreter, streamableLines } from '../src/index.ts';

describe('cleanLine', () => {
  it('strips comments and whitespace and upper-cases', () => {
    expect(cleanLine('g1 x10 (cut) y5 ; trailing')).toBe('G1X10Y5');
    expect(cleanLine('(header only)')).toBe('');
    expect(cleanLine('%')).toBe('');
    expect(cleanLine('  ')).toBe('');
  });
});

describe('Interpreter', () => {
  it('tracks modal motion, absolute and incremental moves', () => {
    const it = new Interpreter();
    expect(it.step('G0X10Y10')[0]).toMatchObject({ type: 'rapid', to: [10, 10, 0] });
    expect(it.step('G1Z-2F300')[0]).toMatchObject({ type: 'feed', to: [10, 10, -2], feed: 300 });
    expect(it.step('X20')[0]).toMatchObject({ type: 'feed', to: [20, 10, -2] });
    it.step('G91');
    expect(it.step('X5Y-5')[0]).toMatchObject({ to: [25, 5, -2] });
  });

  it('converts inches', () => {
    const it = new Interpreter();
    it.step('G20');
    expect(it.step('G1X1F10')[0]).toMatchObject({ to: [25.4, 0, 0], feed: 254 });
  });

  it('does not treat G10/G92/G28 axis words as motion', () => {
    const it = new Interpreter();
    expect(it.step('G10L20P0X0Y0')).toEqual([]);
    expect(it.step('G92X0')).toEqual([]);
    expect(it.step('G28X0Y0')).toEqual([]);
    expect(it.pos).toEqual([0, 0, 0]);
  });

  it('linearises a full IJK circle that returns to its start', () => {
    const it = new Interpreter({ arcTolerance: 0.01 });
    it.step('G0X10Y0');
    const segs = it.step('G2X10Y0I-10J0F500');
    expect(segs.length).toBeGreaterThan(20);
    const last = segs[segs.length - 1].to;
    expect(last[0]).toBeCloseTo(10);
    expect(last[1]).toBeCloseTo(0);
    // Every point sits on the radius-10 circle centred at the origin.
    for (const s of segs) expect(Math.hypot(s.to[0], s.to[1])).toBeCloseTo(10, 5);
    // Clockwise from +X goes through -Y first.
    expect(segs[1].to[1]).toBeLessThan(0);
  });

  it('computes R-form arc centres like GRBL', () => {
    const it = new Interpreter();
    // Quarter circle CCW from (10,0) to (0,10), radius 10 about the origin.
    const segs = it.step('G0X10Y0') && it.step('G3X0Y10R10F100');
    for (const s of segs) expect(Math.hypot(s.to[0], s.to[1])).toBeCloseTo(10, 5);
  });
});

describe('analyzeProgram', () => {
  const square = ['G21 G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F100', 'G1 X100 F1000', 'Y50', 'X0', 'Y0', 'G0 Z5', 'M30'].join('\n');

  it('reports bounds, distances and time', () => {
    const a = analyzeProgram(square);
    // The plunge from Z5 to Z-1 is a feed move, so it counts as cutting.
    expect(a.cutBounds).toEqual({ min: [0, 0, -1], max: [100, 50, 5] });
    expect(a.feedDistance).toBeCloseTo(6 + 300);
    // 300 mm at 1000 mm/min = 18 s, plus 6 mm at 100 mm/min = 3.6 s, plus a little rapid time.
    expect(a.estSeconds).toBeGreaterThan(21.6);
    expect(a.estSeconds).toBeLessThan(22);
    expect(a.streamLines).toBe(10);
  });

  it('maps stream lines to source lines', () => {
    const s = streamableLines('(comment)\nG0X1\n\nG1X2F10\n');
    expect(s).toEqual([
      { text: 'G0X1', source: 1 },
      { text: 'G1X2F10', source: 3 },
    ]);
  });
});
