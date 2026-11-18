import { useEffect, useState } from 'react';
import { jobActive, machineReady, useStore } from '../store.ts';

const STEP_KEY = 'gcc.jogStep';

function loadStep(fallback: number): number {
  try {
    const v = Number(localStorage.getItem(STEP_KEY));
    return v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function JogPanel() {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const steps = s.config.jogSteps;
  const [step, setStepState] = useState(() => loadStep(steps[1] ?? 1));
  const [feedXY, setFeedXY] = useState(s.config.jogFeedXY);
  const [feedZ, setFeedZ] = useState(s.config.jogFeedZ);
  const ready = machineReady(s);
  const canJog = ready && !jobActive(s) && (s.machine.status === 'Idle' || s.machine.status === 'Jog');

  const setStep = (v: number) => {
    setStepState(v);
    try {
      localStorage.setItem(STEP_KEY, String(v));
    } catch {
      // ignore
    }
  };

  const jog = (x = 0, y = 0, z = 0) => {
    if (!canJog) return;
    void run({ type: 'jog', x: x * step, y: y * step, z: z * step, feed: z ? feedZ : feedXY });
  };

  // Arrow keys jog X/Y, Page Up/Down jog Z, Escape cancels a jog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.backdrop')) return;
      const map: Record<string, [number, number, number]> = {
        ArrowLeft: [-1, 0, 0],
        ArrowRight: [1, 0, 0],
        ArrowUp: [0, 1, 0],
        ArrowDown: [0, -1, 0],
        PageUp: [0, 0, 1],
        PageDown: [0, 0, -1],
      };
      if (e.key === 'Escape') {
        void run({ type: 'jogCancel' });
        return;
      }
      const d = map[e.key];
      if (!d || e.repeat) return;
      e.preventDefault();
      jog(...d);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <section className="panel">
      <h3 className="panel-title">
        <span>Jog</span>
        <span className="muted" style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 400 }}>
          ← → ↑ ↓ · PgUp/PgDn
        </span>
      </h3>
      {machineReady(s) && !s.machine.homed && (
        <div className="jog-note" title="Until the machine is homed its position isn't known, so jogs and typed commands can run into the limit switches (ALARM)">
          Not homed: moves aren't held within the machine's travel. Home first.
        </div>
      )}
      <div className="jog">
        <button className="btn" disabled={!canJog} onClick={() => jog(-1, 1)} aria-label="Jog X- Y+">
          ↖
        </button>
        <button className="btn" disabled={!canJog} onClick={() => jog(0, 1)}>
          Y+
        </button>
        <button className="btn" disabled={!canJog} onClick={() => jog(1, 1)} aria-label="Jog X+ Y+">
          ↗
        </button>
        <span />
        <button className="btn" disabled={!canJog} onClick={() => jog(0, 0, 1)}>
          Z+
        </button>

        <button className="btn" disabled={!canJog} onClick={() => jog(-1, 0)}>
          X-
        </button>
        <div className="center-cell">{step} mm</div>
        <button className="btn" disabled={!canJog} onClick={() => jog(1, 0)}>
          X+
        </button>
        <span />
        <button className="btn ghost" disabled={!ready} onClick={() => run({ type: 'jogCancel' })} title="Cancel jog (Esc)">
          ■
        </button>

        <button className="btn" disabled={!canJog} onClick={() => jog(-1, -1)} aria-label="Jog X- Y-">
          ↙
        </button>
        <button className="btn" disabled={!canJog} onClick={() => jog(0, -1)}>
          Y-
        </button>
        <button className="btn" disabled={!canJog} onClick={() => jog(1, -1)} aria-label="Jog X+ Y-">
          ↘
        </button>
        <span />
        <button className="btn" disabled={!canJog} onClick={() => jog(0, 0, -1)}>
          Z-
        </button>
      </div>

      <div className="eyebrow" style={{ margin: '14px 0 6px' }}>
        Step (mm)
      </div>
      <div className="chips">
        {steps.map((v) => (
          <button key={v} className={`btn small ${v === step ? 'active' : ''}`} onClick={() => setStep(v)}>
            {v}
          </button>
        ))}
      </div>
      <div className="grid-2" style={{ marginTop: 12 }}>
        <label className="field">
          XY feed (mm/min)
          <input className="input mono" type="number" min={10} step={100} value={feedXY} onChange={(e) => setFeedXY(Number(e.target.value) || 0)} />
        </label>
        <label className="field">
          Z feed (mm/min)
          <input className="input mono" type="number" min={10} step={100} value={feedZ} onChange={(e) => setFeedZ(Number(e.target.value) || 0)} />
        </label>
      </div>
    </section>
  );
}
