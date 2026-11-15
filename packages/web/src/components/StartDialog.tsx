import { useEffect, useState } from 'react';
import { formatDuration } from '@gcc/shared';
import { useStore } from '../store.ts';

/** Starting a job moves a machine that may be in another room, so confirm first. */
export function StartDialog() {
  const s = useStore((x) => x.state)!;
  const id = useStore((x) => x.confirmStartId);
  const askStart = useStore((x) => x.askStart);
  const run = useStore((x) => x.run);
  const [busy, setBusy] = useState(false);
  const item = s.library.find((f) => f.id === id);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && askStart(undefined);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [askStart]);

  if (!item) return null;
  const m = s.machine;
  const remote = s.link.via === 'hub';
  const b = item.cutBounds ?? item.bounds;

  const start = async () => {
    setBusy(true);
    const ok = await run({ type: 'start', fileId: item.id });
    setBusy(false);
    if (ok) askStart(undefined);
  };

  return (
    <div className="backdrop" onClick={() => !busy && askStart(undefined)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow" style={{ color: 'var(--gold)' }}>
          Start job{remote ? ` on ${s.link.agentName ?? 'the machine'}` : ''}
        </div>
        <h2>{item.name}</h2>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Estimated time</dt>
          <dd>{formatDuration(item.estSeconds)}</dd>
          <dt>Lines</dt>
          <dd>{item.streamLines.toLocaleString()}</dd>
          {b && (
            <>
              <dt>Cut extents</dt>
              <dd className="mono">
                X {b.min[0].toFixed(1)} → {b.max[0].toFixed(1)} · Y {b.min[1].toFixed(1)} → {b.max[1].toFixed(1)} · Z {b.min[2].toFixed(1)} → {b.max[2].toFixed(1)}
              </dd>
            </>
          )}
          <dt>Work zero (machine)</dt>
          <dd className="mono">
            X {m.wco[0].toFixed(3)} · Y {m.wco[1].toFixed(3)} · Z {m.wco[2].toFixed(3)}
          </dd>
          <dt>Tool now at (work)</dt>
          <dd className="mono">
            X {m.wpos[0].toFixed(3)} · Y {m.wpos[1].toFixed(3)} · Z {m.wpos[2].toFixed(3)}
          </dd>
        </dl>
        <ul className="checklist">
          <li>Stock clamped and the right bit fitted and tight</li>
          <li>Work zero set for this file (X, Y and Z)</li>
          <li>Dust collection on, and nobody near the machine</li>
          {remote && <li>Someone can reach the machine's emergency stop</li>}
        </ul>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => askStart(undefined)}>
            Cancel
          </button>
          <button className="btn primary big" disabled={busy} onClick={start} autoFocus>
            {busy ? 'Starting…' : '▶ Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
