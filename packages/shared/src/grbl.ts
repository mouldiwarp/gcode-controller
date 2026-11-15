// GRBL 1.1 serial protocol: realtime bytes, response classification, status
// report parsing and the error / alarm / setting reference tables.

import type { Vec3 } from './gcode.ts';

export const RT = {
  STATUS: '?',
  FEED_HOLD: '!',
  CYCLE_START: '~',
  SOFT_RESET: '\x18',
  SAFETY_DOOR: '\x84',
  JOG_CANCEL: '\x85',
  FEED_OV_RESET: '\x90',
  FEED_OV_PLUS_10: '\x91',
  FEED_OV_MINUS_10: '\x92',
  FEED_OV_PLUS_1: '\x93',
  FEED_OV_MINUS_1: '\x94',
  RAPID_OV_100: '\x95',
  RAPID_OV_50: '\x96',
  RAPID_OV_25: '\x97',
  SPINDLE_OV_RESET: '\x99',
  SPINDLE_OV_PLUS_10: '\x9a',
  SPINDLE_OV_MINUS_10: '\x9b',
  SPINDLE_OV_PLUS_1: '\x9c',
  SPINDLE_OV_MINUS_1: '\x9d',
  SPINDLE_STOP: '\x9e',
  FLOOD_TOGGLE: '\xa0',
  MIST_TOGGLE: '\xa1',
} as const;

/** Bytes GRBL handles immediately instead of putting them in the line buffer. */
export function isRealtimeByte(code: number): boolean {
  return code === 0x3f || code === 0x21 || code === 0x7e || code === 0x18 || code >= 0x80;
}

export type GrblState = 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep' | 'Unknown';

export interface StatusReport {
  state: GrblState;
  subState?: number;
  mpos?: Vec3;
  wpos?: Vec3;
  wco?: Vec3;
  feed?: number;
  spindle?: number;
  /** Planner blocks available, RX bytes available. */
  buffer?: { planner: number; rx: number };
  overrides?: { feed: number; rapid: number; spindle: number };
  lineNumber?: number;
  pins?: string;
  accessories?: string;
}

function vec(s: string): Vec3 {
  const p = s.split(',').map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

const STATES: GrblState[] = ['Idle', 'Run', 'Hold', 'Jog', 'Alarm', 'Door', 'Check', 'Home', 'Sleep'];

/** Parse `<Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0,0,0>`. Returns null if not a status report. */
export function parseStatus(line: string): StatusReport | null {
  if (!line.startsWith('<') || !line.endsWith('>')) return null;
  const fields = line.slice(1, -1).split('|');
  const [stateName, sub] = fields[0].split(':');
  const state = (STATES as string[]).includes(stateName) ? (stateName as GrblState) : 'Unknown';
  const r: StatusReport = { state };
  if (sub !== undefined) r.subState = Number(sub);
  for (const f of fields.slice(1)) {
    const idx = f.indexOf(':');
    if (idx < 0) continue;
    const key = f.slice(0, idx);
    const val = f.slice(idx + 1);
    switch (key) {
      case 'MPos':
        r.mpos = vec(val);
        break;
      case 'WPos':
        r.wpos = vec(val);
        break;
      case 'WCO':
        r.wco = vec(val);
        break;
      case 'FS': {
        const [f1, s1] = val.split(',').map(Number);
        r.feed = f1;
        r.spindle = s1;
        break;
      }
      case 'F':
        r.feed = Number(val);
        break;
      case 'Bf': {
        const [p, rx] = val.split(',').map(Number);
        r.buffer = { planner: p, rx };
        break;
      }
      case 'Ov': {
        const [fo, ro, so] = val.split(',').map(Number);
        r.overrides = { feed: fo, rapid: ro, spindle: so };
        break;
      }
      case 'Ln':
        r.lineNumber = Number(val);
        break;
      case 'Pn':
        r.pins = val;
        break;
      case 'A':
        r.accessories = val;
        break;
    }
  }
  return r;
}

export type ResponseKind = 'ok' | 'error' | 'alarm' | 'status' | 'welcome' | 'msg' | 'feedback' | 'setting' | 'other';

export interface Response {
  kind: ResponseKind;
  raw: string;
  code?: number;
  status?: StatusReport;
}

export function classifyResponse(raw: string): Response {
  const line = raw.trim();
  if (line === 'ok') return { kind: 'ok', raw: line };
  if (line.startsWith('error:')) return { kind: 'error', raw: line, code: Number(line.slice(6)) };
  if (line.startsWith('ALARM:')) return { kind: 'alarm', raw: line, code: Number(line.slice(6)) };
  if (line.startsWith('<')) {
    const status = parseStatus(line);
    if (status) return { kind: 'status', raw: line, status };
  }
  if (/^Grbl(HAL)?\s/i.test(line)) return { kind: 'welcome', raw: line };
  if (line.startsWith('[MSG:')) return { kind: 'msg', raw: line };
  if (line.startsWith('[')) return { kind: 'feedback', raw: line };
  if (/^\$\d+=/.test(line)) return { kind: 'setting', raw: line };
  return { kind: 'other', raw: line };
}

export const GRBL_ERRORS: Record<number, string> = {
  1: 'G-code words consist of a letter and a value. Letter was not found.',
  2: 'Numeric value format is not valid or missing an expected value.',
  3: "Grbl '$' system command was not recognized or supported.",
  4: 'Negative value received for an expected positive value.',
  5: 'Homing cycle is not enabled via settings.',
  6: 'Minimum step pulse time must be greater than 3usec.',
  7: 'EEPROM read failed. Reset and restored to default values.',
  8: "Grbl '$' command cannot be used unless Grbl is IDLE.",
  9: 'G-code locked out during alarm or jog state.',
  10: 'Soft limits cannot be enabled without homing also enabled.',
  11: 'Max characters per line exceeded. Line was not processed and executed.',
  12: "Grbl '$' setting value exceeds the maximum step rate supported.",
  13: 'Safety door detected as opened and door state initiated.',
  14: 'Build info or startup line exceeded EEPROM line length limit.',
  15: 'Jog target exceeds machine travel. Command ignored.',
  16: "Jog command with no '=' or contains prohibited g-code.",
  17: 'Laser mode requires PWM output.',
  20: 'Unsupported or invalid g-code command found in block.',
  21: 'More than one g-code command from same modal group found in block.',
  22: 'Feed rate has not yet been set or is undefined.',
  23: 'G-code command in block requires an integer value.',
  24: 'Two G-code commands that both require the use of the XYZ axis words were detected in the block.',
  25: 'A G-code word was repeated in the block.',
  26: 'A G-code command implicitly or explicitly requires XYZ axis words in the block, but none were detected.',
  27: 'N line number value is not within the valid range of 1 - 9,999,999.',
  28: 'A G-code command was sent, but is missing some required P or L value words in the line.',
  29: 'Grbl supports six work coordinate systems G54-G59. G59.1, G59.2, and G59.3 are not supported.',
  30: 'The G53 G-code command requires either a G0 seek or G1 feed motion mode to be active.',
  31: 'There are unused axis words in the block and G80 motion mode cancel is active.',
  32: 'A G2 or G3 arc was commanded but there are no XYZ axis words in the selected plane to trace the arc.',
  33: 'The motion command has an invalid target. G2, G3, and G38.2 generates this error.',
  34: 'A G2 or G3 arc, traced with the radius definition, had a mathematical error when computing the arc geometry.',
  35: 'A G2 or G3 arc, traced with the offset definition, is missing the IJK offset word in the selected plane.',
  36: 'There are unused, leftover G-code words that aren\'t used by any command in the block.',
  37: 'The G43.1 dynamic tool length offset command cannot apply an offset to an axis other than its configured axis.',
  38: 'Tool number greater than max supported value.',
};

export const GRBL_ALARMS: Record<number, string> = {
  1: 'Hard limit triggered. Machine position is likely lost due to sudden and immediate halt. Re-homing is highly recommended.',
  2: 'G-code motion target exceeds machine travel. Machine position safely retained. Alarm may be unlocked.',
  3: 'Reset while in motion. Grbl cannot guarantee position. Lost steps are likely. Re-homing is highly recommended.',
  4: 'Probe fail. The probe is not in the expected initial state before starting probe cycle.',
  5: 'Probe fail. Probe did not contact the workpiece within the programmed travel.',
  6: 'Homing fail. Reset during active homing cycle.',
  7: 'Homing fail. Safety door was opened during active homing cycle.',
  8: 'Homing fail. Cycle failed to clear limit switch when pulling off. Try increasing pull-off setting or check wiring.',
  9: 'Homing fail. Could not find limit switch within search distance.',
  10: 'Homing fail. On dual axis machines, could not find the second limit switch for self-squaring.',
};

export const GRBL_SETTINGS: Record<number, { name: string; unit?: string }> = {
  0: { name: 'Step pulse time', unit: 'µs' },
  1: { name: 'Step idle delay', unit: 'ms' },
  2: { name: 'Step pulse invert', unit: 'mask' },
  3: { name: 'Step direction invert', unit: 'mask' },
  4: { name: 'Invert step enable pin', unit: 'bool' },
  5: { name: 'Invert limit pins', unit: 'bool' },
  6: { name: 'Invert probe pin', unit: 'bool' },
  10: { name: 'Status report options', unit: 'mask' },
  11: { name: 'Junction deviation', unit: 'mm' },
  12: { name: 'Arc tolerance', unit: 'mm' },
  13: { name: 'Report in inches', unit: 'bool' },
  20: { name: 'Soft limits enable', unit: 'bool' },
  21: { name: 'Hard limits enable', unit: 'bool' },
  22: { name: 'Homing cycle enable', unit: 'bool' },
  23: { name: 'Homing direction invert', unit: 'mask' },
  24: { name: 'Homing locate feed rate', unit: 'mm/min' },
  25: { name: 'Homing search seek rate', unit: 'mm/min' },
  26: { name: 'Homing switch debounce delay', unit: 'ms' },
  27: { name: 'Homing switch pull-off distance', unit: 'mm' },
  30: { name: 'Maximum spindle speed', unit: 'RPM' },
  31: { name: 'Minimum spindle speed', unit: 'RPM' },
  32: { name: 'Laser-mode enable', unit: 'bool' },
  100: { name: 'X-axis travel resolution', unit: 'step/mm' },
  101: { name: 'Y-axis travel resolution', unit: 'step/mm' },
  102: { name: 'Z-axis travel resolution', unit: 'step/mm' },
  110: { name: 'X-axis maximum rate', unit: 'mm/min' },
  111: { name: 'Y-axis maximum rate', unit: 'mm/min' },
  112: { name: 'Z-axis maximum rate', unit: 'mm/min' },
  120: { name: 'X-axis acceleration', unit: 'mm/s²' },
  121: { name: 'Y-axis acceleration', unit: 'mm/s²' },
  122: { name: 'Z-axis acceleration', unit: 'mm/s²' },
  130: { name: 'X-axis maximum travel', unit: 'mm' },
  131: { name: 'Y-axis maximum travel', unit: 'mm' },
  132: { name: 'Z-axis maximum travel', unit: 'mm' },
};

export function describeError(code: number): string {
  return GRBL_ERRORS[code] ?? `Unknown error ${code}`;
}

export function describeAlarm(code: number): string {
  return GRBL_ALARMS[code] ?? `Unknown alarm ${code}`;
}
