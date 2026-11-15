// Writes demo G-code into samples/: a body-like outline with a pocket, drilled
// holes and a tabbed cutout, so the UI and simulator have something realistic.
//   npx tsx scripts/make-samples.ts

import { writeFileSync } from 'node:fs';

const f = (n: number) => n.toFixed(3);

function bodyOutline(scale: number, steps = 180): [number, number][] {
  // Two lobes (upper and lower bout) blended with a waist, centred on the origin.
  const pts: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = 200 * Math.cos(t);
    const lobe = 1 + 0.18 * Math.cos(t) - 0.22 * Math.cos(2 * t);
    const y = 130 * Math.sin(t) * lobe;
    pts.push([x * scale + 220, y * scale + 160]);
  }
  return pts;
}

function body(): string {
  const out = ['(GCode Controller demo: body pocket, holes and cutout)', '(Units mm, work zero front-left of stock, Z0 top of stock)', 'G21 G90 G17', 'G0 Z10', 'M3 S18000', 'G4 P2'];
  // Pocket: concentric offsets of a smaller outline, 2 depth passes.
  for (const depth of [-2, -4]) {
    for (let s = 0.12; s <= 0.55; s += 0.06) {
      const pts = bodyOutline(s, 120);
      out.push(`G0 X${f(pts[0][0])} Y${f(pts[0][1])}`, `G1 Z${f(depth)} F400`);
      for (const p of pts.slice(1)) out.push(`G1 X${f(p[0])} Y${f(p[1])} F2200`);
      out.push(`G1 X${f(pts[0][0])} Y${f(pts[0][1])}`, 'G0 Z2');
    }
  }
  out.push('G0 Z10');
  // Drill a row of holes with circular interpolation.
  for (let i = 0; i < 6; i++) {
    const x = 120 + i * 40;
    const y = 290;
    out.push(`G0 X${f(x + 4)} Y${f(y)}`, 'G1 Z-1 F300');
    for (let z = -2; z >= -6; z -= 2) out.push(`G2 X${f(x + 4)} Y${f(y)} I-4 J0 Z${z} F900`);
    out.push(`G2 X${f(x + 4)} Y${f(y)} I-4 J0 F900`, 'G0 Z5');
  }
  // Cutout: full outline in three passes, leaving four tabs on the last pass.
  const outline = bodyOutline(1, 240);
  for (const depth of [-6, -12, -18]) {
    out.push('G0 Z5', `G0 X${f(outline[0][0])} Y${f(outline[0][1])}`, `G1 Z${depth} F350`);
    outline.forEach((p, i) => {
      const tab = depth === -18 && i % 60 > 54;
      out.push(`G1 X${f(p[0])} Y${f(p[1])}${tab ? ' Z-15' : i % 60 === 0 ? ` Z${depth}` : ''} F2000`);
    });
    out.push(`G1 X${f(outline[0][0])} Y${f(outline[0][1])}`);
  }
  out.push('G0 Z15', 'M5', 'G0 X0 Y0', 'M30');
  return out.join('\n') + '\n';
}

function square(): string {
  const out = ['(Air-cut test square 100 x 60, 1 mm deep)', 'G21 G90', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300'];
  out.push('G1 X100 F1500', 'G1 Y60', 'G1 X0', 'G1 Y0', 'G0 Z5');
  out.push('G0 X70 Y30', 'G1 Z-0.5 F300', 'G2 X70 Y30 I-20 J0 F1200', 'G0 Z5', 'M30');
  return out.join('\n') + '\n';
}

writeFileSync('samples/demo-body.nc', body());
writeFileSync('samples/test-square.nc', square());
console.log('Wrote samples/demo-body.nc and samples/test-square.nc');
