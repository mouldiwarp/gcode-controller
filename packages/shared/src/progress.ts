// Job progress by estimated time rather than lines. GRBL's "ok" only means a line went into
// its planner queue (up to 35 moves ahead on some boards), and one surfacing pass can be a
// single line that takes a minute, so counting lines says little. This model gives each
// stream line its estimated start time and duration, so progress is the time the machine has
// actually reached: the line it's cutting, plus how far along that line the tool is.

import { cleanLine, Interpreter, splitLines, type InterpreterOptions, type Vec3 } from './gcode.ts';

export interface ProgressModel {
  /** Estimated seconds from the start of the program to the start of each stream line. */
  start: Float64Array;
  /** Estimated seconds each stream line takes. */
  dur: Float64Array;
  /** Where each stream line's motion starts and ends (work mm, xyz interleaved). NaN if it doesn't move. */
  from: Float64Array;
  to: Float64Array;
  /** Estimated seconds for the whole program. */
  total: number;
}

/** `from`: where the tool is when the program starts (work mm), so its first moves can be timed. */
export function progressModel(text: string, opts: InterpreterOptions & { from?: Vec3 } = {}): ProgressModel {
  const lines = splitLines(text);
  const clean: string[] = [];
  const src: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const c = cleanLine(lines[i]);
    if (c) {
      clean.push(c);
      src.push(i);
    }
  }
  const n = clean.length;
  const start = new Float64Array(n);
  const dur = new Float64Array(n);
  const from = new Float64Array(n * 3).fill(NaN);
  const to = new Float64Array(n * 3).fill(NaN);
  const interp = new Interpreter(opts);
  if (opts.from) interp.setPosition(opts.from);
  let t = 0;
  for (let k = 0; k < n; k++) {
    start[k] = t;
    const dwellBefore = interp.dwellSeconds;
    const segs = interp.step(clean[k], src[k]);
    let d = interp.dwellSeconds - dwellBefore;
    for (const s of segs) {
      const len = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]);
      const rate = s.type === 'rapid' ? interp.rapidRate : s.feed;
      if (rate > 0) d += (len / rate) * 60;
    }
    if (segs.length) {
      from.set(segs[0].from, k * 3);
      to.set(segs[segs.length - 1].to, k * 3);
    }
    dur[k] = d;
    t += d;
  }
  return { start, dur, from, to, total: t };
}

/**
 * Estimated seconds of the program done when the machine is working on stream line `line`
 * with the tool at `wpos`. Within a line it goes by how far the tool is from the line's start
 * towards its end (exact for straight moves, close enough for arcs).
 */
export function secondsDone(m: ProgressModel, line: number, wpos?: Vec3): number {
  const n = m.start.length;
  if (!n) return 0;
  if (line >= n) return m.total;
  const k = Math.max(0, line);
  let frac = 0;
  if (wpos && m.dur[k] > 0 && !Number.isNaN(m.from[k * 3])) {
    let dot = 0;
    let len2 = 0;
    for (let a = 0; a < 3; a++) {
      const d = m.to[k * 3 + a] - m.from[k * 3 + a];
      dot += (wpos[a] - m.from[k * 3 + a]) * d;
      len2 += d * d;
    }
    if (len2 > 1e-9) frac = Math.min(1, Math.max(0, dot / len2));
  }
  return m.start[k] + frac * m.dur[k];
}

/** How far the tool at `wpos` is from stream line `k`'s path (as a straight move), mm. Infinity if it doesn't move. */
export function distanceToLine(m: ProgressModel, k: number, wpos: Vec3): number {
  if (k < 0 || k >= m.start.length || Number.isNaN(m.from[k * 3])) return Infinity;
  let dot = 0;
  let len2 = 0;
  for (let a = 0; a < 3; a++) {
    const d = m.to[k * 3 + a] - m.from[k * 3 + a];
    dot += (wpos[a] - m.from[k * 3 + a]) * d;
    len2 += d * d;
  }
  const t = len2 > 1e-12 ? Math.min(1, Math.max(0, dot / len2)) : 0;
  let dist2 = 0;
  for (let a = 0; a < 3; a++) {
    const p = m.from[k * 3 + a] + t * (m.to[k * 3 + a] - m.from[k * 3 + a]);
    dist2 += (wpos[a] - p) ** 2;
  }
  return Math.sqrt(dist2);
}

/**
 * The line the tool is on: the first line from `lowest` (a safe lower bound, from counting
 * GRBL's queue) up to `highest` (the last line GRBL has taken) whose path passes through the
 * tool's position. Falls back to `lowest`.
 */
export function lineAtPosition(m: ProgressModel, lowest: number, highest: number, wpos: Vec3, tolerance = 0.05): number {
  const end = Math.min(highest, m.start.length - 1);
  for (let k = Math.max(0, lowest); k <= end; k++) {
    if (m.dur[k] > 0 && distanceToLine(m, k, wpos) <= tolerance) return k;
  }
  return lowest;
}
