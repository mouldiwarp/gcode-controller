// G-code interpretation shared by the simulator, the hub (file analysis) and the
// web visualizer. It follows GRBL 1.1's modal rules closely enough to draw and
// time hobby CAM output: G0/G1/G2/G3, G17-G19, G20/G21, G90/G91, G4 dwell, and it
// steps over G10/G28/G30/G92 so their axis words are not mistaken for motion.

export type Vec3 = [number, number, number];

export type SegmentType = 'rapid' | 'feed';

export interface Segment {
  /** 0-based index of the source line that produced this segment. */
  line: number;
  type: SegmentType;
  from: Vec3;
  to: Vec3;
  /** Feed rate in mm/min (rapids report the rapid rate used for timing). */
  feed: number;
  /** True when the segment is part of a linearised arc. */
  arc?: boolean;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Remove comments and whitespace and upper-case a line, the way it is sent to GRBL. */
export function cleanLine(raw: string): string {
  let out = '';
  let inParen = false;
  for (const ch of raw) {
    if (inParen) {
      if (ch === ')') inParen = false;
      continue;
    }
    if (ch === '(') {
      inParen = true;
      continue;
    }
    if (ch === ';') break;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
    out += ch;
  }
  out = out.toUpperCase();
  if (out === '%') return '';
  return out;
}

const WORD_RE = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/g;

export interface Word {
  letter: string;
  value: number;
}

export function parseWords(clean: string): Word[] {
  const words: Word[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(clean))) words.push({ letter: m[1], value: parseFloat(m[2]) });
  return words;
}

export interface InterpreterOptions {
  /** Rapid rate used for timing estimates, mm/min. */
  rapidRate?: number;
  /** Maximum chord error when linearising arcs, mm. */
  arcTolerance?: number;
}

type Plane = 0 | 1 | 2; // G17, G18, G19
const PLANE_AXES: Record<Plane, [number, number, number]> = {
  0: [0, 1, 2], // XY, linear Z
  1: [2, 0, 1], // ZX, linear Y
  2: [1, 2, 0], // YZ, linear X
};

/** Incremental modal interpreter: feed it lines, it returns the segments each one moves. */
export class Interpreter {
  pos: Vec3 = [0, 0, 0];
  /**
   * Which axes have a known position. A program doesn't say where the machine
   * starts, so moves are only drawn once every axis has been set; until then
   * they just establish the position (no bogus line from 0,0,0).
   */
  known: [boolean, boolean, boolean] = [false, false, false];
  motion = 0; // 0,1,2,3
  absolute = true;
  inches = false;
  plane: Plane = 0;
  feed = 0;
  /** Seconds of dwell (G4) accumulated. */
  dwellSeconds = 0;
  readonly rapidRate: number;
  readonly arcTolerance: number;

  constructor(opts: InterpreterOptions = {}) {
    this.rapidRate = opts.rapidRate ?? 5000;
    this.arcTolerance = opts.arcTolerance ?? 0.02;
  }

  /** Start from a known position (the simulator knows where the machine is). */
  setPosition(p: Vec3): void {
    this.pos = [...p] as Vec3;
    this.known = [true, true, true];
  }

  reset(): void {
    this.pos = [0, 0, 0];
    this.known = [false, false, false];
    this.motion = 0;
    this.absolute = true;
    this.inches = false;
    this.plane = 0;
    this.feed = 0;
    this.dwellSeconds = 0;
  }

  /** Interpret one already-cleaned line. Returns the motion segments it produces. */
  step(clean: string, lineIndex = 0): Segment[] {
    if (!clean || clean[0] === '$' || clean[0] === '[') return [];
    const words = parseWords(clean);
    if (words.length === 0) return [];

    let nonModal: number | null = null;
    let motionWord: number | null = null;
    const axis: Partial<Record<'X' | 'Y' | 'Z' | 'I' | 'J' | 'K' | 'R' | 'P', number>> = {};
    let dwell = false;

    for (const w of words) {
      switch (w.letter) {
        case 'G': {
          const g = w.value;
          if (g === 0 || g === 1 || g === 2 || g === 3) motionWord = g;
          else if (g === 38.2 || g === 38.3 || g === 38.4 || g === 38.5) motionWord = 1; // probe: draw as feed
          else if (g === 80) motionWord = -1;
          else if (g === 17) this.plane = 0;
          else if (g === 18) this.plane = 1;
          else if (g === 19) this.plane = 2;
          else if (g === 20) this.inches = true;
          else if (g === 21) this.inches = false;
          else if (g === 90) this.absolute = true;
          else if (g === 91) this.absolute = false;
          else if (g === 4) dwell = true;
          else if (g === 10 || g === 28 || g === 30 || g === 92 || g === 53 || g === 28.1 || g === 30.1 || g === 92.1)
            nonModal = g;
          break;
        }
        case 'F':
          this.feed = this.inches ? w.value * 25.4 : w.value;
          break;
        case 'X':
        case 'Y':
        case 'Z':
        case 'I':
        case 'J':
        case 'K':
        case 'R':
        case 'P':
          axis[w.letter] = w.value;
          break;
        default:
          break;
      }
    }

    if (dwell) {
      if (axis.P !== undefined) this.dwellSeconds += axis.P;
      return [];
    }
    if (motionWord !== null) this.motion = motionWord;
    // Axis words belong to the non-modal command (G10/G28/G30/G92/G53): no drawn motion.
    if (nonModal !== null) return [];
    const hasAxis = axis.X !== undefined || axis.Y !== undefined || axis.Z !== undefined;
    if (!hasAxis || this.motion < 0) return [];

    const scale = this.inches ? 25.4 : 1;
    const from: Vec3 = [...this.pos] as Vec3;
    const to: Vec3 = [...this.pos] as Vec3;
    const vals = [axis.X, axis.Y, axis.Z];
    const startKnown = this.known[0] && this.known[1] && this.known[2];
    for (let i = 0; i < 3; i++) {
      const v = vals[i];
      if (v === undefined) continue;
      to[i] = this.absolute ? v * scale : from[i] + v * scale;
      if (this.absolute) this.known[i] = true;
    }
    if (!startKnown) {
      this.pos = to;
      return [];
    }

    let segments: Segment[];
    if (this.motion === 0) {
      segments = [{ line: lineIndex, type: 'rapid', from, to, feed: this.rapidRate }];
    } else if (this.motion === 1) {
      segments = [{ line: lineIndex, type: 'feed', from, to, feed: this.feed }];
    } else {
      segments = this.arc(from, to, axis, scale, lineIndex);
    }
    this.pos = to;
    return segments;
  }

  private arc(
    from: Vec3,
    to: Vec3,
    w: Partial<Record<'I' | 'J' | 'K' | 'R', number>>,
    scale: number,
    lineIndex: number,
  ): Segment[] {
    const [a0, a1, lin] = PLANE_AXES[this.plane];
    const cw = this.motion === 2;
    const offsets: Vec3 = [(w.I ?? 0) * scale, (w.J ?? 0) * scale, (w.K ?? 0) * scale];
    let c0: number;
    let c1: number;

    if (w.R !== undefined) {
      let r = w.R * scale;
      const x = to[a0] - from[a0];
      const y = to[a1] - from[a1];
      const d2 = x * x + y * y;
      if (d2 < 1e-12) return [{ line: lineIndex, type: 'feed', from, to, feed: this.feed }];
      let disc = 4 * r * r - d2;
      if (disc < 0) disc = 0;
      let h = -Math.sqrt(disc) / Math.sqrt(d2);
      if (!cw) h = -h;
      if (r < 0) {
        h = -h;
        r = -r;
      }
      c0 = from[a0] + 0.5 * (x - y * h);
      c1 = from[a1] + 0.5 * (y + x * h);
    } else {
      c0 = from[a0] + offsets[a0];
      c1 = from[a1] + offsets[a1];
    }

    const radius = Math.hypot(from[a0] - c0, from[a1] - c1);
    const startAng = Math.atan2(from[a1] - c1, from[a0] - c0);
    const endAng = Math.atan2(to[a1] - c1, to[a0] - c0);
    let sweep = cw ? startAng - endAng : endAng - startAng;
    if (sweep <= 1e-9) sweep += Math.PI * 2;

    let steps = 1;
    if (radius > this.arcTolerance) {
      const maxStep = 2 * Math.acos(Math.max(-1, 1 - this.arcTolerance / radius));
      steps = Math.ceil(sweep / maxStep);
    }
    steps = Math.min(Math.max(steps, 2), 720);

    const out: Segment[] = [];
    let prev: Vec3 = from;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      let p: Vec3;
      if (i === steps) {
        p = [...to] as Vec3;
      } else {
        const ang = startAng + (cw ? -1 : 1) * sweep * t;
        p = [0, 0, 0];
        p[a0] = c0 + radius * Math.cos(ang);
        p[a1] = c1 + radius * Math.sin(ang);
        p[lin] = from[lin] + (to[lin] - from[lin]) * t;
      }
      out.push({ line: lineIndex, type: 'feed', from: prev, to: p, feed: this.feed, arc: true });
      prev = p;
    }
    return out;
  }
}

export interface ProgramAnalysis {
  /** Number of source lines in the file. */
  sourceLines: number;
  /** Number of lines that will actually be sent to the controller. */
  streamLines: number;
  segments: Segment[];
  /** Bounds of every move (rapids included). Null if the file has no motion. */
  bounds: Bounds | null;
  /** Bounds of feed moves only (what the cutter cuts). */
  cutBounds: Bounds | null;
  /** Rough run time in seconds (no acceleration). */
  estSeconds: number;
  /** Total cutting distance, mm. */
  feedDistance: number;
  /** Total rapid distance, mm. */
  rapidDistance: number;
  /** Lines containing an M3/M4 spindle start. */
  usesSpindle: boolean;
}

function grow(b: Bounds | null, p: Vec3): Bounds {
  if (!b) return { min: [...p] as Vec3, max: [...p] as Vec3 };
  for (let i = 0; i < 3; i++) {
    if (p[i] < b.min[i]) b.min[i] = p[i];
    if (p[i] > b.max[i]) b.max[i] = p[i];
  }
  return b;
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Interpret a whole program: segments, bounds and a time estimate. */
export function analyzeProgram(text: string, opts: InterpreterOptions & { keepSegments?: boolean } = {}): ProgramAnalysis {
  const lines = splitLines(text);
  const interp = new Interpreter(opts);
  const segments: Segment[] = [];
  let bounds: Bounds | null = null;
  let cutBounds: Bounds | null = null;
  let est = 0;
  let feedDistance = 0;
  let rapidDistance = 0;
  let streamLines = 0;
  let usesSpindle = false;
  const keep = opts.keepSegments !== false;

  for (let i = 0; i < lines.length; i++) {
    const clean = cleanLine(lines[i]);
    if (!clean) continue;
    streamLines++;
    if (!usesSpindle && /M0?[34](?!\d)/.test(clean)) usesSpindle = true;
    const segs = interp.step(clean, i);
    for (const s of segs) {
      const len = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]);
      if (s.type === 'rapid') {
        rapidDistance += len;
        est += (len / interp.rapidRate) * 60;
      } else {
        feedDistance += len;
        if (s.feed > 0) est += (len / s.feed) * 60;
        cutBounds = grow(grow(cutBounds, s.from), s.to);
      }
      bounds = grow(grow(bounds, s.from), s.to);
      if (keep) segments.push(s);
    }
  }
  est += interp.dwellSeconds;
  return {
    sourceLines: lines.length,
    streamLines,
    segments,
    bounds,
    cutBounds,
    estSeconds: est,
    feedDistance,
    rapidDistance,
    usesSpindle,
  };
}

/** The lines a sender actually streams, with the source line each came from. */
export function streamableLines(text: string): { text: string; source: number }[] {
  const out: { text: string; source: number }[] = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const clean = cleanLine(lines[i]);
    if (clean) out.push({ text: clean, source: i });
  }
  return out;
}
