import { describe, expect, it } from 'vitest';
import { analyzeProgram, checkSurfacing, DEFAULT_SURFACING, planSurfacing, type SurfacingParams } from '../src/index.ts';

const board: SurfacingParams = { ...DEFAULT_SURFACING, lengthX: 600, widthY: 400 };

describe('spoilboard surfacing', () => {
  it('covers the whole area at depth, from the left edge and centred on Y0', () => {
    const plan = planSurfacing(board);
    const a = analyzeProgram(plan.gcode);
    const r = board.toolDiameter / 2;
    // Every point of the area (plus the overhang) is under the cutter at full depth somewhere.
    const atDepth = a.segments.filter((s) => s.type === 'feed' && Math.abs(s.from[2] + 0.5) < 1e-6 && Math.abs(s.to[2] + 0.5) < 1e-6);
    const covered = (x: number, y: number) =>
      atDepth.some((s) => {
        const [ax, ay] = s.from;
        const [bx, by] = s.to;
        const dx = bx - ax;
        const dy = by - ay;
        const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
        return Math.hypot(ax + t * dx - x, ay + t * dy - y) <= r + 1e-6;
      });
    for (let x = 0; x <= 600; x += 5) for (let y = -200; y <= 200; y += 5) expect(covered(x, y), `${x},${y}`).toBe(true);
    for (const [x, y] of [[0, -200], [0, 200], [600, -200], [600, 200]]) expect(covered(x, y), `corner ${x},${y}`).toBe(true);
    // The cutter stays within the area plus the overhang.
    expect(plan.overhang).toBe(4);
    expect(a.cutBounds!.min[0] - r).toBeCloseTo(-4, 6);
    expect(a.cutBounds!.max[0] + r).toBeCloseTo(604, 6);
    expect(a.cutBounds!.min[1] - r).toBeCloseTo(-204, 6);
    expect(a.cutBounds!.max[1] + r).toBeCloseTo(204, 6);
    expect(a.cutBounds!.min[2]).toBeCloseTo(-0.5, 6);
    expect(plan.levels).toBe(1);
    expect(plan.stepover).toBeLessThanOrEqual(12);
  });

  it('never plunges below the surface: every move down into the material ramps at the set angle or shallower', () => {
    for (const p of [board, { ...board, totalDepth: 2.5, stepDown: 1 }, { ...board, lengthX: 40, totalDepth: 1, rampAngle: 1 }]) {
      const a = analyzeProgram(planSurfacing(p).gcode);
      const tan = Math.tan((p.rampAngle * Math.PI) / 180);
      let ramps = 0;
      let floor = 0; // deepest Z already cut
      for (const s of a.segments) {
        const drop = s.from[2] - s.to[2];
        if (s.type === 'rapid') {
          if (drop > 0) expect(s.to[2]).toBeGreaterThan(floor);
          continue;
        }
        // A feed move down into material that hasn't been cut yet must be a ramp.
        if (drop > 1e-9 && s.to[2] < floor - 1e-9) {
          ramps++;
          const run = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]);
          expect(drop / run).toBeLessThanOrEqual(tan + 1e-6);
        }
        floor = Math.min(floor, s.to[2]);
      }
      expect(ramps).toBeGreaterThan(0);
      expect(a.cutBounds!.min[2]).toBeCloseTo(-p.totalDepth, 6);
    }
  });

  it('takes deeper cuts in levels no deeper than the step-down', () => {
    const plan = planSurfacing({ ...board, totalDepth: 2.5, stepDown: 1 });
    expect(plan.levels).toBe(3);
    expect(plan.gcode).toContain('(Level 3 of 3: Z-2.5)');
  });

  it('starts the spindle, and ends lifted with it off', () => {
    const lines = planSurfacing(board).gcode.trim().split('\n');
    expect(lines).toContain('M3 S18000');
    expect(lines.slice(-4)).toEqual(['G0 Z5', 'M5', 'G0 X0 Y0', 'M30']);
  });

  it('raises a small overhang so the round cutter still reaches the corners', () => {
    expect(planSurfacing({ ...board, overhang: 1 }).overhang).toBeCloseTo(3.6, 6);
    expect(planSurfacing({ ...board, overhang: 10 }).overhang).toBe(10);
  });

  it('refuses a pass deeper than the cutter can cut, and areas too short to ramp in', () => {
    expect(checkSurfacing({ ...board, stepDown: 6 })).toEqual([expect.stringContaining("cutter's cutting depth")]);
    expect(checkSurfacing({ ...board, lengthX: 10 })[0]).toMatch(/Length \(X\) must be at least/);
    expect(checkSurfacing({ ...board, lengthX: 0 })[0]).toMatch(/Length/);
    expect(() => planSurfacing({ ...board, widthY: -1 })).toThrow(/Width/);
  });
});
