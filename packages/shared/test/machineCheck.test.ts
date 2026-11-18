import { describe, expect, it } from 'vitest';
import { checkSettings, envelopeFromSettings, FOXALIEN, sameEnvelope } from '../src/index.ts';

const fox = FOXALIEN;
// The FoxAlien's settings as read on 2026-11-18 (before soft limits were turned on).
const now = { '20': '0', '21': '1', '22': '1', '23': '3', '27': '3.000', '30': '24000.000', '32': '0', '130': '800.000', '131': '800.000', '132': '100.000' };

describe('machine settings check', () => {
  it('compares numbers as numbers and reports only what differs', () => {
    expect(checkSettings(now, fox)).toEqual([{ key: '20', expected: '1', actual: '0', why: expect.stringContaining('Soft limits') }]);
    expect(checkSettings({ ...now, '20': '1' }, fox)).toEqual([]);
  });

  it('catches a controller that has lost its settings (back to GRBL defaults)', () => {
    const defaults = { ...now, '20': '0', '23': '0', '30': '1000', '130': '200', '131': '200', '132': '200' };
    expect(checkSettings(defaults, fox).map((p) => p.key)).toEqual(['20', '23', '30', '130', '131', '132']);
    const missing = checkSettings({}, fox);
    expect(missing).toHaveLength(Object.keys(fox.settings).length);
    expect(missing[0].actual).toBeUndefined();
  });

  it('works out the travel from $130-$132 and the homing corner', () => {
    const env = envelopeFromSettings(now)!;
    expect(env).toEqual({ min: [0, 0, -100], max: [800, 800, 0] });
    expect(sameEnvelope(env, { min: [0, 0, -100], max: [800, 800, 0] })).toBe(true);
    expect(envelopeFromSettings({ ...now, '23': '0' })).toEqual({ min: [-800, -800, -100], max: [0, 0, 0] });
    expect(envelopeFromSettings({ ...now, '23': '1' })).toBeNull();
  });

  it('reminds about the Laser/Spindle switch for the 1.5 kW spindle', () => {
    expect(fox.hardware.join(' ')).toMatch(/Laser\/Spindle switch is set to LASER/);
    expect(fox.spindleReminder).toMatch(/LASER/);
  });
});
