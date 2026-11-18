// The FoxAlien XE-Ultra 8080 this app drives: the GRBL settings it has been checked and set up
// with, and the hardware checks the software can't see. When the controller connects and its settings
// are read, they're compared against the profile so a reset board or a changed setting is
// caught before it causes trouble.

import type { Bounds } from './gcode.ts';

export interface ExpectedSetting {
  value: string;
  /** What it is, and why it has this value. */
  why: string;
}

export interface MachineProfile {
  name: string;
  settings: Record<string, ExpectedSetting>;
  /** Things to check by hand at start-up (switches and wiring the controller can't report). */
  hardware: string[];
  /** Shown before a job that runs the spindle. */
  spindleReminder?: string;
}

export const FOXALIEN: MachineProfile = {
  name: 'FoxAlien XE-Ultra 8080, 1.5 kW spindle',
  settings: {
    '20': { value: '1', why: 'Soft limits on: GRBL itself refuses moves past the travel instead of hitting a limit switch' },
    '21': { value: '1', why: 'Hard limits on: the limit switches stop the machine' },
    '22': { value: '1', why: 'Homing on' },
    '23': { value: '3', why: 'Homes to the front-left corner (X and Y count up from it)' },
    '27': { value: '3', why: 'Backs 3 mm off the switches after homing' },
    '30': { value: '24000', why: 'Spindle top speed: S24000 is full PWM for the 1.5 kW spindle' },
    '32': { value: '0', why: 'Laser mode off: the spindle keeps running between moves' },
    '130': { value: '800', why: 'X travel, mm' },
    '131': { value: '800', why: 'Y travel, mm' },
    '132': { value: '100', why: 'Z travel, mm' },
  },
  hardware: ["The controller's Laser/Spindle switch is set to LASER: the 1.5 kW spindle takes its PWM from the laser port"],
  spindleReminder: 'The Laser/Spindle switch on the controller must be on LASER for the 1.5 kW spindle.',
};

export interface SettingProblem {
  key: string;
  expected: string;
  /** Undefined if the controller didn't report it. */
  actual?: string;
  why: string;
}

const same = (a: string, b: string) => {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) < 1e-6 : a.trim() === b.trim();
};

/** Settings that differ from the profile's (numbers compared as numbers: 3 = 3.000). */
export function checkSettings(actual: Record<string, string>, profile: MachineProfile): SettingProblem[] {
  return Object.entries(profile.settings)
    .filter(([k, e]) => actual[k] === undefined || !same(actual[k], e.value))
    .map(([k, e]) => ({ key: k, expected: e.value, actual: actual[k], why: e.why }));
}

/** The travel envelope the controller's settings describe ($130-$132 and the homing corner, $23). */
export function envelopeFromSettings(st: Record<string, string>): Bounds | null {
  const t = [Number(st['130']), Number(st['131']), Number(st['132'])];
  if (!t.every((v) => v > 0)) return null;
  const dir = Number(st['23'] ?? 0) & 3;
  // Bits set: X and Y home towards their minimum, so machine coordinates count up from it.
  if (dir === 3) return { min: [0, 0, -t[2]], max: [t[0], t[1], 0] };
  if (dir === 0) return { min: [-t[0], -t[1], -t[2]], max: [0, 0, 0] };
  return null; // mixed corners: leave it to Settings
}

export function sameEnvelope(a: Bounds, b: Bounds): boolean {
  return [0, 1, 2].every((i) => Math.abs(a.min[i] - b.min[i]) < 0.01 && Math.abs(a.max[i] - b.max[i]) < 0.01);
}
