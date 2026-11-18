import { useEffect, useState } from 'react';
import { checkSettings, FOXALIEN, formatDuration } from '@gcc/shared';
import { useStore } from '../store.ts';

/** Starting a job moves a machine that may be in another room, so confirm first. */
export function StartDialog() {
  const s = useStore((x) => x.state)!;
  const id = useStore((x) => x.confirmStartId);
  const askStart = useStore((x) => x.askStart);
  const isNext = useStore((x) => x.confirmNext);
  const setProbeOpen = useStore((x) => x.setProbeOpen);
  const run = useStore((x) => x.run);
  const [busy, setBusy] = useState(false);
  const [wholeGroup, setWholeGroup] = useState(true);
  const item = s.library.find((f) => f.id === id);
  // The files that would follow this one if the rest of its group runs.
  const groupFiles = item?.group
    ? s.library.filter((f) => f.group === item.group).sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0))
    : [];
  const position = groupFiles.findIndex((f) => f.id === item?.id);
  const following = position >= 0 ? groupFiles.slice(position + 1) : [];
  const group = s.job.group;

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && askStart(undefined);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [askStart]);

  if (!item) return null;
  const m = s.machine;
  const remote = s.link.via === 'hub';
  const b = item.cutBounds ?? item.bounds;
  const profile = FOXALIEN;
  const settingProblems = m.settings && Object.keys(m.settings).length && !m.simulated ? checkSettings(m.settings, profile) : [];

  const start = async () => {
    setBusy(true);
    const ok = await run(isNext ? { type: 'startNext' } : { type: 'start', fileId: item.id, group: following.length > 0 && wholeGroup });
    setBusy(false);
    if (ok) askStart(undefined);
  };

  return (
    <div className="backdrop" onClick={() => !busy && askStart(undefined)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow" style={{ color: 'var(--gold)' }}>
          {isNext && group ? `Start file ${group.index + 2} of ${group.files.length}` : 'Start job'}
          {remote ? ` on ${s.link.agentName ?? 'the machine'}` : ''}
        </div>
        <h2>{item.name}</h2>
        {!isNext && following.length > 0 && (
          <label className="group-option">
            <input type="checkbox" checked={wholeGroup} onChange={(e) => setWholeGroup(e.target.checked)} />
            <span>
              Then run the rest of <b>{item.group}</b> in order, pausing for a bit change before each:
              <span className="muted"> {following.map((f) => f.name).join(' → ')}</span>
            </span>
          </label>
        )}
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
        {settingProblems.length > 0 && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            ⚠ {settingProblems.length === 1 ? 'A controller setting differs' : `${settingProblems.length} controller settings differ`} from {profile.name}:{' '}
            {settingProblems.map((p) => `$${p.key} is ${p.actual ?? '?'} (should be ${p.expected})`).join(', ')}. Fix them in the banner at the top first.
          </div>
        )}
        <ul className="checklist">
          <li>Stock clamped and the right bit fitted and tight</li>
          {isNext ? (
            <li>
              Z re-probed with the new bit{' '}
              {m.lastProbe?.ok && s.job.finishedAt && m.lastProbe.t > s.job.finishedAt ? (
                <span className="accent">(done)</span>
              ) : (
                <button className="btn small outline-gold" onClick={() => setProbeOpen(true)}>
                  Probe Z
                </button>
              )}
            </li>
          ) : (
            <li>Work zero set for this file (X, Y and Z)</li>
          )}
          {profile.spindleReminder && !m.simulated && <li>{profile.spindleReminder}</li>}
          <li>Dust collection on, and nobody near the machine</li>
          {remote && <li>Someone can reach the machine's emergency stop</li>}
        </ul>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => askStart(undefined)}>
            Cancel
          </button>
          <button className="btn primary big" disabled={busy} onClick={start} autoFocus>
            {busy ? 'Starting…' : isNext ? '▶ Start next' : '▶ Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
