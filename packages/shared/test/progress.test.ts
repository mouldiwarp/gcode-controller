import { describe, expect, it } from 'vitest';
import { lineAtPosition, progressModel, secondsDone } from '../src/index.ts';

const text = ['(t)', 'G21 G90', 'G0 X0 Y0 Z0', 'G1 X100 F600', 'G4 P2', 'G1 Y60 F1200'].join('\n');

describe('time-based progress', () => {
  it('times each line: moves by distance and feed, dwells by their length', () => {
    const m = progressModel(text, { rapidRate: 5000 });
    expect(Array.from(m.dur)).toEqual([0, 0, 10, 2, 3]);
    expect(Array.from(m.start)).toEqual([0, 0, 0, 10, 12]);
    expect(m.total).toBe(15);
  });

  it('counts how far along the current line the tool is', () => {
    const m = progressModel(text, { rapidRate: 5000 });
    expect(secondsDone(m, 2, [25, 0, 0])).toBeCloseTo(2.5);
    expect(secondsDone(m, 2, [100, 0, 0])).toBeCloseTo(10);
    expect(secondsDone(m, 4, [100, 30, 0])).toBeCloseTo(13.5);
    expect(secondsDone(m, 3, [100, 0, 0])).toBe(10); // dwelling: no position to go by
    expect(secondsDone(m, 5)).toBe(15);
  });
});

describe('finding the line the tool is on', () => {
  const zz = ['G21 G90', 'G0 X0 Y0 Z0', 'G0 X0 Y0', 'G1 X100 F600', 'G1 Y10', 'G1 X0'].join('\n');
  const m = progressModel(zz, { rapidRate: 5000 });
  it('skips moves that go nowhere and finds the path the tool is on', () => {
    expect(lineAtPosition(m, 1, 5, [40, 0, 0])).toBe(3);
    expect(lineAtPosition(m, 1, 5, [100, 4, 0])).toBe(4);
    expect(lineAtPosition(m, 4, 5, [60, 10, 0])).toBe(5);
    expect(lineAtPosition(m, 1, 2, [40, 0, 0])).toBe(1); // never past what GRBL has taken
    expect(lineAtPosition(m, 3, 5, [55, 3, 0])).toBe(3); // off every path: the lower bound
  });
});
