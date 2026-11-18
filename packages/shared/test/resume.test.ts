import { describe, expect, it } from 'vitest';
import { isMotionLine, planResume, stateAt, streamableLines } from '../src/index.ts';

const program = [
  '(test)',
  'G21 G90 G17 G94',
  'G0 Z5',
  'M3 S12000',
  'G4 P2',
  'G0 X10 Y10',
  'G1 Z-1 F300',
  'G1 X50 F1000',
  'G1 Y40',
  'G20',
  'G1 X1',
  'M5',
].join('\n');
const index = (text: string) => streamableLines(program).findIndex((l) => l.text === text);

describe('resume', () => {
  it('knows the modes and the position before a line', () => {
    const st = stateAt(program, index('G1Y40'));
    expect(st).toMatchObject({ inches: false, absolute: true, plane: 17, motion: 1, feed: 1000, spindle: 'M3', speed: 12000, pos: [50, 10, -1] });
    expect(stateAt(program, index('G1X1'))).toMatchObject({ inches: true, pos: [50, 40, -1] });
  });

  it('lifts, moves over the start, spins up, lowers onto it and restores the modes', () => {
    const plan = planResume(program, index('G1Y40'), { travelZ: 5, spinup: 4, plungeFeed: 300 });
    expect(plan.preamble).toEqual(['G21G90G17G94G54', 'G0Z5', 'G0X50Y10', 'M3S12000', 'G4P4', 'G1Z-1F300', 'G21G90G1', 'F1000']);
    expect(plan.start).toEqual([50, 10, -1]);
  });

  it('restores inches after moving in mm', () => {
    const plan = planResume(program, index('G1X1'), { travelZ: 5, spinup: 0, plungeFeed: 300 });
    expect(plan.preamble.slice(-2)).toEqual(['G20G90G1', 'F1000']);
    expect(plan.preamble[2]).toBe('G0X50Y40');
  });

  it("refuses a line before the program has said where the tool is", () => {
    expect(() => planResume(program, index('G0Z5'), { travelZ: 5, spinup: 4, plungeFeed: 300 })).toThrow(/isn't known/);
  });

  it('tells moves from other lines', () => {
    expect(isMotionLine('G1X5')).toBe(true);
    expect(isMotionLine('X5Y2')).toBe(true);
    expect(isMotionLine('G4P2')).toBe(false);
    expect(isMotionLine('G10L20P0X0')).toBe(false);
    expect(isMotionLine('M3S1000')).toBe(false);
    expect(isMotionLine('G43Z5')).toBe(true);
  });
});
