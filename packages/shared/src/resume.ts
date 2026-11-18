// Resuming a program part way through: work out the modal state at a line (units,
// distance mode, plane, work offset, spindle, coolant, feed) and where the tool is
// when that line starts, so a preamble can put the machine back in that state.

import { cleanLine, splitLines, streamableLines, type Vec3 } from './gcode.ts';

export interface ProgramState {
  inches: boolean;
  absolute: boolean;
  /** 17, 18 or 19. */
  plane: number;
  /** 0-3 (G0-G3), or -1 after G80. */
  motion: number;
  /** 54-59. */
  wcs: number;
  /** 93 or 94. */
  feedMode: number;
  /** Feed in program units per minute (or inverse time). */
  feed: number;
  spindle: 'M3' | 'M4' | 'M5';
  speed: number;
  mist: boolean;
  flood: boolean;
  /** Where the tool is (work coordinates, mm); null for an axis no line has set yet. */
  pos: [number | null, number | null, number | null];
  /** Things the preamble can't restore. */
  warnings: string[];
}

interface Word {
  letter: string;
  value: number;
}

function words(clean: string): Word[] {
  const out: Word[] = [];
  const re = /([A-Z])([-+]?(?:\d+\.?\d*|\.\d+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) out.push({ letter: m[1].toUpperCase(), value: Number(m[2]) });
  return out;
}

/** The program's state just before stream line `index` (0-based, as streamableLines numbers them). */
export function stateAt(text: string, index: number): ProgramState {
  const st: ProgramState = {
    inches: false,
    absolute: true,
    plane: 17,
    motion: 0,
    wcs: 54,
    feedMode: 94,
    feed: 0,
    spindle: 'M5',
    speed: 0,
    mist: false,
    flood: false,
    pos: [null, null, null],
    warnings: [],
  };
  const lines = streamableLines(text).slice(0, index);
  const warned = new Set<string>();
  const warn = (w: string) => {
    if (!warned.has(w)) {
      warned.add(w);
      st.warnings.push(w);
    }
  };
  for (const { text: line } of lines) {
    if (line[0] === '$' || line[0] === '[') continue;
    const ws = words(line);
    let nonModal: number | null = null;
    let motionWord: number | null = null;
    const axis: Partial<Record<'X' | 'Y' | 'Z', number>> = {};
    for (const w of ws) {
      if (w.letter === 'G') {
        const g = w.value;
        if ([0, 1, 2, 3].includes(g)) motionWord = g;
        else if (g === 80) motionWord = -1;
        else if (g === 38.2 || g === 38.3 || g === 38.4 || g === 38.5) {
          motionWord = null;
          nonModal = 38;
          warn('The program probes before this line; the resume uses the work offset as it is now');
        } else if (g === 17 || g === 18 || g === 19) st.plane = g;
        else if (g === 20) st.inches = true;
        else if (g === 21) st.inches = false;
        else if (g === 90) st.absolute = true;
        else if (g === 91) st.absolute = false;
        else if (g === 93 || g === 94) st.feedMode = g;
        else if (g >= 54 && g <= 59) st.wcs = Math.round(g);
        else if (g === 92) {
          nonModal = 92;
          warn('The program sets G92 offsets before this line, which a resume cannot restore');
        } else if (g === 10 || g === 28 || g === 30 || g === 53 || g === 4 || g === 28.1 || g === 30.1 || g === 92.1) nonModal = g;
      } else if (w.letter === 'M') {
        const m = w.value;
        if (m === 3) st.spindle = 'M3';
        else if (m === 4) st.spindle = 'M4';
        else if (m === 5) st.spindle = 'M5';
        else if (m === 7) st.mist = true;
        else if (m === 8) st.flood = true;
        else if (m === 9) st.mist = st.flood = false;
        else if (m === 6) warn('The program changes tools (M6) before this line: check the right bit is fitted');
      } else if (w.letter === 'S') st.speed = w.value;
      else if (w.letter === 'F') st.feed = w.value;
      else if (w.letter === 'X' || w.letter === 'Y' || w.letter === 'Z') axis[w.letter] = w.value;
    }
    if (motionWord !== null) st.motion = motionWord;
    if (nonModal === 28 || nonModal === 30) {
      warn('The program returns to G28/G30 before this line; the start position may be unknown');
      st.pos = [null, null, null];
      continue;
    }
    if (nonModal === 53 && (axis.X !== undefined || axis.Y !== undefined || axis.Z !== undefined)) {
      warn('The program makes machine-coordinate (G53) moves before this line');
      st.pos = [null, null, null];
      continue;
    }
    if (nonModal !== null) continue;
    if (st.motion < 0) continue;
    const scale = st.inches ? 25.4 : 1;
    (['X', 'Y', 'Z'] as const).forEach((a, i) => {
      const v = axis[a];
      if (v === undefined) return;
      if (st.absolute) st.pos[i] = v * scale;
      else if (st.pos[i] !== null) st.pos[i] = st.pos[i]! + v * scale;
    });
  }
  return st;
}

const fmt = (n: number) => {
  const s = n.toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

export interface ResumeOptions {
  /** Work Z to travel at (already limited to the machine's travel by the caller), mm. */
  travelZ: number;
  /** Seconds to let the spindle reach speed. */
  spinup: number;
  /** Feed for lowering onto the resume point, mm/min. */
  plungeFeed: number;
}

export interface ResumePlan {
  /** Lines to send before the program's own lines. */
  preamble: string[];
  state: ProgramState;
  /** Where the program resumes (work coordinates, mm). */
  start: Vec3;
}

/**
 * Lines that put the machine where line `index` expects it: restore the modes, lift
 * to the travel height, move over the start point, start the spindle and let it reach
 * speed, lower onto the start point, then restore units, distance mode and feed.
 * Throws if the start point isn't known.
 */
export function planResume(text: string, index: number, opts: ResumeOptions): ResumePlan {
  const state = stateAt(text, index);
  const [x, y, z] = state.pos;
  if (x === null || y === null || z === null) {
    throw new Error("The tool's position before that line isn't known (the program hasn't set X, Y and Z yet). Pick a later line");
  }
  const plane = `G${state.plane}`;
  // Preamble moves in mm, absolute, units-per-minute feed; the program's own modes come back after.
  const pre: string[] = [`G21G90${plane}G94G${state.wcs}`];
  pre.push(`G0Z${fmt(Math.max(opts.travelZ, z))}`);
  pre.push(`G0X${fmt(x)}Y${fmt(y)}`);
  if (state.spindle !== 'M5') {
    pre.push(`${state.spindle}S${fmt(state.speed)}`);
    if (opts.spinup > 0) pre.push(`G4P${fmt(opts.spinup)}`);
  }
  if (state.mist) pre.push('M7');
  if (state.flood) pre.push('M8');
  if (z < Math.max(opts.travelZ, z)) pre.push(`G1Z${fmt(z)}F${fmt(opts.plungeFeed)}`);
  // Back to the program's own modes for the lines that follow.
  const modes = [state.inches ? 'G20' : 'G21', state.absolute ? 'G90' : 'G91'];
  if (state.feedMode === 93) modes.push('G93');
  if (state.motion === 0 || state.motion === 1) modes.push(`G${state.motion}`);
  else if (state.motion === -1) modes.push('G80');
  pre.push(modes.join(''));
  if (state.feed > 0 && state.feedMode === 94) pre.push(`F${fmt(state.feed)}`);
  if (state.motion === 2 || state.motion === 3) {
    state.warnings.push('The program is mid-arc at this line; arcs restart from the resume point, so check the preview');
  }
  return { preamble: pre, state, start: [x, y, z] };
}

/** Whether a streamed line makes the machine move (and so takes a planner block). */
export function isMotionLine(clean: string): boolean {
  if (!/[XYZ]/i.test(clean)) return false;
  return !/G0?4(?![\d.])|G10(?![\d.])|G92/i.test(clean);
}

/** The source text of a stream line, for showing the user where a resume starts. */
export function sourceLineText(text: string, index: number): { source: number; text: string } | null {
  const sl = streamableLines(text)[index];
  if (!sl) return null;
  return { source: sl.source, text: cleanLine(splitLines(text)[sl.source]) ? splitLines(text)[sl.source].trim() : sl.text };
}
