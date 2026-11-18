import { jobActive, machineReady, useStore } from '../store.ts';

const AXES = ['X', 'Y', 'Z'] as const;

export function DroPanel() {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const setProbeOpen = useStore((x) => x.setProbeOpen);
  const ready = machineReady(s);
  const locked = !ready || jobActive(s) || s.machine.status !== 'Idle';
  const m = s.machine;

  return (
    <section className="panel">
      <h3 className="panel-title">
        <span>
          Position <span className="accent">· Work</span>
        </span>
        <span className="muted mono" style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 400, fontSize: 11, whiteSpace: 'nowrap' }}>
          F {Math.round(m.feed)} · S {Math.round(m.spindle)}
        </span>
      </h3>
      {AXES.map((a, i) => (
        <div className="dro-row" key={a}>
          <span className={`axis ${a}`}>{a}</span>
          <div>
            <div className="dro-value">{m.wpos[i].toFixed(3)}</div>
            <div className="dro-mpos">MACH {m.mpos[i].toFixed(3)}</div>
          </div>
          <button className="btn small" disabled={locked} onClick={() => run({ type: 'zero', axes: [a] })} title={`Set work ${a} zero here`}>
            Zero
          </button>
          <button
            className="btn small ghost"
            disabled={locked}
            onClick={() => run({ type: 'goToZero', axes: [a] })}
            title={a === 'Z' ? 'Move down to Z0' : `Move to ${a}0 (lifting to safe Z first, never past the top of travel)`}
          >
            →0
          </button>
        </div>
      ))}
      <div className="grid-3" style={{ marginTop: 12 }}>
        <button className="btn outline-gold" disabled={locked} onClick={() => run({ type: 'zero', axes: ['X', 'Y'] })}>
          Zero XY
        </button>
        <button className="btn outline-gold" disabled={locked} onClick={() => run({ type: 'zero', axes: ['Z'] })}>
          Zero Z
        </button>
        <button className="btn outline-gold" disabled={locked} onClick={() => run({ type: 'zero', axes: ['X', 'Y', 'Z'] })}>
          Zero all
        </button>
      </div>
      <div className="grid-3" style={{ marginTop: 8 }}>
        <button
          className="btn"
          disabled={locked}
          onClick={() => run({ type: 'goToZero', axes: ['X', 'Y'] })}
          title={`Lift to Z${s.config.safeZ} (or stay higher, never past the top of travel), then move to X0 Y0`}
        >
          Go to XY0
        </button>
        <button
          className="btn"
          disabled={locked}
          onClick={() => run({ type: 'goToZero', axes: ['X', 'Y', 'Z'] })}
          title="Lift to safe Z, move to X0 Y0, then down to Z0"
        >
          Go to XYZ0
        </button>
        <button
          className="btn outline-gold"
          disabled={!ready || jobActive(s) || m.status === 'Alarm'}
          onClick={() => setProbeOpen(true)}
          title="Set work Z with the touch plate"
        >
          Probe Z
        </button>
      </div>
    </section>
  );
}
