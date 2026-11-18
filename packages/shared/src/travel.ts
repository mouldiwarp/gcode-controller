// Checking where a command would send the machine against its travel. With soft limits off
// ($20=0) GRBL happily drives past the end of travel into a limit switch, which stops it dead
// in ALARM with the position lost. These checks refuse such commands before they're sent.

import type { Bounds, Vec3 } from './gcode.ts';

export interface DistanceModes {
  absolute: boolean;
  inches: boolean;
}

/** The distance modes in GRBL's `$G` report (`G0 G54 G17 G21 G90 G94 …`). */
export function modesFromModal(modal?: string): DistanceModes {
  return { absolute: !/\bG91\b/.test(modal ?? ''), inches: /\bG20\b/.test(modal ?? '') };
}

const AXES = ['X', 'Y', 'Z'] as const;

/**
 * Where a command line sends the machine, in machine coordinates (null for an axis it doesn't
 * move), and the distance modes after it. `$J=` jogs don't change the modes. Returns no target
 * for lines that don't move to a stated position (settings, G10/G92 offsets, G28/G30, dwells).
 */
export function lineTarget(line: string, modes: DistanceModes, mpos: Vec3, wco: Vec3): { target?: (number | null)[]; modes: DistanceModes } {
  let text = line.toUpperCase().replace(/\s+/g, '').replace(/\(.*?\)|;.*$/g, '');
  const jog = text.startsWith('$J=');
  if (jog) text = text.slice(3);
  else if (text.startsWith('$')) return { modes };
  const m = { ...modes };
  const axis: Partial<Record<(typeof AXES)[number], number>> = {};
  let machine = false;
  let skip = false;
  const re = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/g;
  let w: RegExpExecArray | null;
  while ((w = re.exec(text))) {
    const letter = w[1];
    const v = Number(w[2]);
    if (letter === 'G') {
      if (v === 90) m.absolute = true;
      else if (v === 91) m.absolute = false;
      else if (v === 20) m.inches = true;
      else if (v === 21) m.inches = false;
      else if (v === 53) machine = true;
      else if ([4, 10, 28, 30, 92, 28.1, 30.1, 92.1].includes(v)) skip = true;
    } else if (letter === 'X' || letter === 'Y' || letter === 'Z') axis[letter] = v;
  }
  const after = jog ? modes : m;
  if (skip) return { modes: after };
  if (!AXES.some((a) => axis[a] !== undefined)) return { modes: after };
  const scale = m.inches ? 25.4 : 1;
  const target = AXES.map((a, i) => {
    const v = axis[a];
    if (v === undefined) return null;
    if (!m.absolute && !machine) return mpos[i] + v * scale;
    return (machine ? 0 : wco[i]) + v * scale;
  });
  return { target, modes: after };
}

/** What's wrong with a machine-coordinate target, or undefined if it's within travel. */
export function travelProblem(target: (number | null)[], env: Bounds): string | undefined {
  const out: string[] = [];
  target.forEach((t, i) => {
    if (t === null) return;
    const a = AXES[i];
    if (t > env.max[i] + 0.01) out.push(`${(t - env.max[i]).toFixed(1)} mm past the ${i === 2 ? 'top' : 'end'} of ${a}`);
    else if (t < env.min[i] - 0.01) out.push(`${(env.min[i] - t).toFixed(1)} mm past the ${i === 2 ? 'bottom' : 'start'} of ${a}`);
  });
  return out.length ? out.join(' and ') : undefined;
}
