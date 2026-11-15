import { useEffect, useState } from 'react';
import { machineReady, useStore } from '../store.ts';

/**
 * Z probe with a touch plate, as in WorkBee Control: place the plate on the
 * stock under the bit, clip the lead to the bit, and the controller touches
 * down twice and sets work Z0 to the stock surface.
 */
export function ProbeDialog() {
  const open = useStore((x) => x.probeOpen);
  const setOpen = useStore((x) => x.setProbeOpen);
  if (!open) return null;
  return <ProbeBody onClose={() => setOpen(false)} />;
}

function ProbeBody({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const setSettingsOpen = useStore((x) => x.setSettingsOpen);
  const [started, setStarted] = useState<number>();
  const m = s.machine;
  const p = s.config.probe;
  const ready = machineReady(s);
  const touching = !!m.pins?.includes('P');
  const result = started && m.lastProbe && m.lastProbe.t >= started ? m.lastProbe : undefined;
  const thicknessSet = p.plateThickness > 0;

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !m.probing && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, m.probing]);

  const probe = async () => {
    setStarted(Date.now());
    await run({ type: 'probeZ' });
  };

  const blocked = !ready
    ? 'The machine is not connected'
    : !thicknessSet
      ? 'Measure the touch plate and enter its thickness in Settings first'
      : m.status === 'Alarm'
        ? 'Unlock the machine first'
        : m.status !== 'Idle'
          ? `The machine is ${m.status}`
          : touching
            ? 'The probe input is closed. Move the plate away from the bit'
            : undefined;

  return (
    <div className="backdrop" onClick={() => !m.probing && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow" style={{ color: 'var(--gold)' }}>
          Probe Z
        </div>
        <h2>Touch plate</h2>

        <ol className="steps" style={{ marginTop: 12 }}>
          <li>Jog the bit over the stock, within {p.maxTravel} mm of the plate's top.</li>
          <li>Put the plate flat on the stock under the bit and clip the lead to the bit.</li>
          <li>
            Test the circuit: touch the plate to the bit. The light below should turn gold.{' '}
            <span className={`probe-pin ${touching ? 'on' : ''}`}>
              <span className="dot" /> {touching ? 'Touching' : 'Open'}
            </span>
          </li>
        </ol>

        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Plate thickness</dt>
          <dd>
            {thicknessSet ? `${p.plateThickness} mm` : <span style={{ color: 'var(--danger)' }}>not set</span>}{' '}
            <button
              className="btn small ghost"
              onClick={() => {
                onClose();
                setSettingsOpen(true);
              }}
            >
              Change
            </button>
          </dd>
          <dt>Sequence</dt>
          <dd>
            Down at {p.seekFeed} mm/min (up to {p.maxTravel} mm), lift 2 mm, touch again at {p.latchFeed} mm/min, set Z,
            then lift to Z{p.plateThickness + p.retract}
          </dd>
          <dt>Tool now at (work Z)</dt>
          <dd className="mono">{m.wpos[2].toFixed(3)}</dd>
        </dl>

        {m.probing && <div className="banner">Probing… Hold or Stop at the top of the page abort it.</div>}
        {result && (
          <div className={`banner ${result.ok ? '' : 'warn'}`} style={result.ok ? { borderColor: 'var(--gold)' } : undefined}>
            <strong>{result.ok ? 'Done' : 'Failed'}</strong> {result.message}
          </div>
        )}

        <div className="actions">
          <button className="btn" disabled={m.probing} onClick={onClose}>
            {result?.ok ? 'Close' : 'Cancel'}
          </button>
          <button className="btn primary big" disabled={!!blocked || m.probing} title={blocked} onClick={probe} autoFocus>
            {m.probing ? 'Probing…' : result?.ok ? 'Probe again' : '↧ Probe'}
          </button>
        </div>
        {blocked && !m.probing && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8, textAlign: 'right' }}>
            {blocked}
          </div>
        )}
      </div>
    </div>
  );
}
