// Spoilboard surfacing: a zigzag raster over a rectangle that starts at work X0
// (the left edge of the board) and is centred on work Y0 (the board's centre line),
// taking the surface down from work Z0. The cutter never plunges: each depth level
// starts with a shallow ramp along the first line, then goes back over the ramp at
// full depth so no wedge is left behind.

export interface SurfacingParams {
  /** Length to surface along X, from X0 (the left edge) to the right, mm. */
  lengthX: number;
  /** Width to surface along Y, centred on Y0, mm. */
  widthY: number;
  /** Material to remove below Z0, mm. */
  totalDepth: number;
  /** Most to take in one pass, mm (no more than the cutter's cutting depth). */
  stepDown: number;
  toolDiameter: number;
  /** Cutting depth of the cutter (flute length), mm. */
  fluteLength: number;
  /** Distance between passes as a % of the diameter. */
  stepoverPct: number;
  /**
   * How far the cutter's edge goes past each edge of the area, mm. Raised if needed to
   * r × (1 − 1/√2) (3.5 mm for a 24 mm cutter) so the round cutter reaches the corners.
   */
  overhang: number;
  /** Ramp angle from horizontal, degrees. */
  rampAngle: number;
  feed: number;
  rampFeed: number;
  spindleRpm: number;
  /** Height above Z0 for moves between levels, mm. */
  safeZ: number;
}

export const DEFAULT_SURFACING: SurfacingParams = {
  lengthX: 0,
  widthY: 0,
  totalDepth: 0.5,
  stepDown: 1,
  toolDiameter: 24,
  fluteLength: 5,
  stepoverPct: 50,
  overhang: 4,
  rampAngle: 2,
  feed: 3000,
  rampFeed: 1000,
  spindleRpm: 18000,
  safeZ: 5,
};

export interface SurfacingPlan {
  gcode: string;
  /** Number of depth levels. */
  levels: number;
  /** Raster lines per level. */
  lines: number;
  /** Actual distance between lines, mm. */
  stepover: number;
  /** Ramp length at the first level, mm. */
  rampLength: number;
  /** Overhang used, mm (see effectiveOverhang). */
  overhang: number;
  name: string;
}

/** Problems that make the parameters unusable; empty when they're fine. */
export function checkSurfacing(p: SurfacingParams): string[] {
  const errs: string[] = [];
  const pos = (v: number, label: string) => {
    if (!(Number.isFinite(v) && v > 0)) errs.push(`${label} must be more than 0`);
  };
  pos(p.lengthX, 'Length (X)');
  pos(p.widthY, 'Width (Y)');
  pos(p.totalDepth, 'Depth to remove');
  pos(p.stepDown, 'Depth per pass');
  pos(p.toolDiameter, 'Cutter diameter');
  pos(p.fluteLength, 'Cutting depth');
  pos(p.feed, 'Feed');
  pos(p.rampFeed, 'Ramp feed');
  pos(p.spindleRpm, 'Spindle speed');
  pos(p.safeZ, 'Safe Z');
  if (!(p.stepoverPct >= 5 && p.stepoverPct <= 95)) errs.push('Stepover must be between 5% and 95% of the diameter');
  if (!(p.rampAngle > 0 && p.rampAngle <= 45)) errs.push('Ramp angle must be between 0 and 45°');
  if (!(p.overhang >= 0)) errs.push("Overhang can't be negative");
  if (p.stepDown > p.fluteLength) errs.push(`Depth per pass (${p.stepDown} mm) is more than the cutter's cutting depth (${p.fluteLength} mm)`);
  if (p.totalDepth > 10) errs.push('Depth to remove is over 10 mm: surfacing takes off a skim, not a pocket');
  if (errs.length) return errs;
  const r = p.toolDiameter / 2;
  const m = effectiveOverhang(p);
  if (p.lengthX - 2 * r + 2 * m < 1) errs.push(`Length (X) must be at least ${(2 * r - 2 * m + 1).toFixed(1)} mm to ramp in along it`);
  return errs;
}

/** The overhang actually used: at least enough for the cutter to reach the area's corners. */
export function effectiveOverhang(p: SurfacingParams): number {
  const r = p.toolDiameter / 2;
  return Math.max(p.overhang, Math.ceil(r * (1 - Math.SQRT1_2) * 10 + 0.5) / 10);
}

const f = (n: number) => {
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

export function planSurfacing(p: SurfacingParams): SurfacingPlan {
  const errs = checkSurfacing(p);
  if (errs.length) throw new Error(errs.join('; '));

  const r = p.toolDiameter / 2;
  const m = effectiveOverhang(p);
  const x0 = r - m;
  const x1 = p.lengthX - r + m;
  const lineLen = x1 - x0;

  const yHalf = p.widthY / 2 - r + m;
  const maxStep = (p.toolDiameter * p.stepoverPct) / 100;
  const ys: number[] = [];
  let stepover = 0;
  if (yHalf <= 0) ys.push(0);
  else {
    const n = Math.ceil((2 * yHalf) / maxStep) + 1;
    stepover = (2 * yHalf) / (n - 1);
    for (let i = 0; i < n; i++) ys.push(-yHalf + i * stepover);
  }

  const levels = Math.ceil(p.totalDepth / p.stepDown - 1e-9);
  const tan = Math.tan((p.rampAngle * Math.PI) / 180);
  const out: string[] = [];
  const name = `Surface ${f(p.lengthX)}x${f(p.widthY)} -${f(p.totalDepth)}mm.nc`;

  out.push(
    `(Spoilboard surfacing, made by GCode Controller)`,
    `(Area: X0 to X${f(p.lengthX)}, Y${f(-p.widthY / 2)} to Y${f(p.widthY / 2)}; Z0 is the surface)`,
    `(Removes ${f(p.totalDepth)} mm in ${levels} level${levels > 1 ? 's' : ''}; ${ys.length} lines per level)`,
    `(Cutter ${f(p.toolDiameter)} mm, stepover ${f(stepover || maxStep)} mm, ramp ${f(p.rampAngle)} deg, runs ${f(m)} mm past the edges)`,
    'G21 G90 G17 G94',
    `G0 Z${f(p.safeZ)}`,
    `M3 S${Math.round(p.spindleRpm)}`,
    'G4 P4',
  );

  let rampLength = 0;
  for (let level = 1; level <= levels; level++) {
    const top = level === 1 ? 0 : -Math.min((level - 1) * p.stepDown, p.totalDepth);
    const z = -Math.min(level * p.stepDown, p.totalDepth);
    out.push(`(Level ${level} of ${levels}: Z${f(z)})`, `G0 Z${f(p.safeZ)}`, `G0 X${f(x0)} Y${f(ys[0])}`, `G0 Z${f(top + 1)}`);
    out.push(`G1 Z${f(top)} F${Math.round(p.rampFeed)}`);

    // Ramp down along the first line, back and forth if the line is shorter than the ramp.
    const need = (top - z) / tan;
    if (level === 1) rampLength = need;
    // Coordinates are written to 0.001 mm, so round X first and round Z up (shallower):
    // the ramp is then never steeper than the angle asked for.
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    let x = x0;
    let zNow = top;
    let dir = 1;
    while (zNow > z + 1e-9) {
      const run = Math.min(lineLen, (zNow - z) / tan);
      const nx = r3(x + dir * run);
      const nz = Math.ceil((zNow - Math.abs(nx - x) * tan) * 1000 - 1e-6) / 1000;
      x = nx;
      zNow = Math.max(z, nz);
      out.push(`G1 X${f(x)} Z${f(zNow)}`);
      dir = -dir;
    }
    // Back over the ramp at full depth to the start of the line.
    if (Math.abs(x - x0) > 1e-9) out.push(`G1 X${f(x0)} F${Math.round(p.feed)}`);
    else out.push(`F${Math.round(p.feed)}`);

    // Zigzag raster, front to back.
    x = x0;
    ys.forEach((y, i) => {
      if (i > 0) out.push(`G1 Y${f(y)}`);
      x = x === x0 ? x1 : x0;
      out.push(`G1 X${f(x)}`);
    });
  }

  out.push(`G0 Z${f(p.safeZ)}`, 'M5', 'G0 X0 Y0', 'M30');
  return { gcode: out.join('\n') + '\n', overhang: m, levels, lines: ys.length, stepover: stepover || maxStep, rampLength, name };
}
