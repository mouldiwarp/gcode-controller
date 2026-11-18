import { describe, expect, it } from 'vitest';
import { lineTarget, modesFromModal, travelProblem } from '../src/index.ts';

const abs = { absolute: true, inches: false };
const mpos: [number, number, number] = [100, 200, -50];
const wco: [number, number, number] = [10, 20, -80];
const env = { min: [0, 0, -100] as [number, number, number], max: [800, 800, 0] as [number, number, number] };

describe('where commands send the machine', () => {
  it('follows absolute, relative, inches and machine coordinates', () => {
    expect(lineTarget('G0 Z10', abs, mpos, wco).target).toEqual([null, null, -70]);
    expect(lineTarget('G91 G0 Z60', abs, mpos, wco)).toEqual({ target: [null, null, 10], modes: { absolute: false, inches: false } });
    expect(lineTarget('G20 G0 X1', abs, mpos, wco).target).toEqual([35.4, null, null]);
    expect(lineTarget('G53 G0 Z-1', abs, mpos, wco).target).toEqual([null, null, -1]);
    expect(lineTarget('G1 X5 Y5 F100 (comment Z99)', abs, mpos, wco).target).toEqual([15, 25, null]);
  });

  it("treats jogs as one-offs that don't change the modes", () => {
    expect(lineTarget('$J=G91G21Z60F1000', abs, mpos, wco)).toEqual({ target: [null, null, 10], modes: abs });
  });

  it('ignores lines that set offsets or go to stored positions', () => {
    expect(lineTarget('G10 L20 P0 Z0', abs, mpos, wco).target).toBeUndefined();
    expect(lineTarget('G28 Z0', abs, mpos, wco).target).toBeUndefined();
    expect(lineTarget('$H', abs, mpos, wco).target).toBeUndefined();
    expect(lineTarget('M3 S1000', abs, mpos, wco).target).toBeUndefined();
  });

  it('reads the modes from $G and describes how far past the travel a target goes', () => {
    expect(modesFromModal('[GC:G0 G54 G17 G20 G91 G94 M5 M9 T0 F0 S0]')).toEqual({ absolute: false, inches: true });
    expect(travelProblem([null, null, 10], env)).toBe('10.0 mm past the top of Z');
    expect(travelProblem([-5, 900, null], env)).toBe('5.0 mm past the start of X and 100.0 mm past the end of Y');
    expect(travelProblem([400, 400, -50], env)).toBeUndefined();
  });
});
