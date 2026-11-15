import { describe, expect, it } from 'vitest';
import { classifyResponse, parseStatus } from '../src/index.ts';

describe('parseStatus', () => {
  it('parses a full GRBL 1.1 report', () => {
    const s = parseStatus('<Hold:0|MPos:-10.000,-20.500,-3.000|Bf:15,128|FS:1200,18000|WCO:-100.000,-200.000,-50.000|Pn:XZ>');
    expect(s).toEqual({
      state: 'Hold',
      subState: 0,
      mpos: [-10, -20.5, -3],
      buffer: { planner: 15, rx: 128 },
      feed: 1200,
      spindle: 18000,
      wco: [-100, -200, -50],
      pins: 'XZ',
    });
  });

  it('parses overrides and WPos', () => {
    expect(parseStatus('<Idle|WPos:1.000,2.000,3.000|FS:0,0|Ov:120,50,90>')).toMatchObject({
      state: 'Idle',
      wpos: [1, 2, 3],
      overrides: { feed: 120, rapid: 50, spindle: 90 },
    });
  });

  it('rejects non-status lines', () => {
    expect(parseStatus('ok')).toBeNull();
  });
});

describe('classifyResponse', () => {
  it('classifies every response kind', () => {
    expect(classifyResponse('ok').kind).toBe('ok');
    expect(classifyResponse('error:22')).toMatchObject({ kind: 'error', code: 22 });
    expect(classifyResponse('ALARM:2')).toMatchObject({ kind: 'alarm', code: 2 });
    expect(classifyResponse("Grbl 1.1h ['$' for help]").kind).toBe('welcome');
    expect(classifyResponse('GrblHAL 1.1f [\'$\' or \'$HELP\' for help]').kind).toBe('welcome');
    expect(classifyResponse('[MSG:Caution: Unlocked]').kind).toBe('msg');
    expect(classifyResponse('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]').kind).toBe('feedback');
    expect(classifyResponse('$110=5000.000').kind).toBe('setting');
  });
});
