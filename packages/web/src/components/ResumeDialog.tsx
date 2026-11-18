import { useEffect, useMemo, useState } from 'react';
import { planResume, streamableLines } from '@gcc/shared';
import { machineReady, useStore } from '../store.ts';

/** Restart a stopped job part way through, from the line it stopped on (or one you pick). */
export function ResumeDialog() {
  const open = useStore((x) => x.resumeOpen);
  const setOpen = useStore((x) => x.setResumeOpen);
  if (!open) return null;
  return <ResumeBody onClose={() => setOpen(false)} />;
}

function ResumeBody({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const job = s.job;
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [line, setLine] = useState((job.resumeLine ?? 0) + 1);
  const [busy, setBusy] = useState(false);
  const m = s.machine;

  useEffect(() => {
    if (!job.fileId) return;
    fetch(`/api/files/${encodeURIComponent(job.fileId)}/content`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Could not load the file (${r.status})`))))
      .then(setText)
      .catch((e: Error) => setError(e.message));
  }, [job.fileId]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const lines = useMemo(() => (text ? streamableLines(text) : []), [text]);
  const index = line - 1;
  const plan = useMemo(() => {
    if (!text || index < 1 || index >= lines.length) return null;
    try {
      return { ok: true as const, ...planResume(text, index, { travelZ: s.config.safeZ, spinup: 4, plungeFeed: 300 }) };
    } catch (e) {
      return { ok: false as const, message: (e as Error).message };
    }
  }, [text, index, lines.length, s.config.safeZ]);

  const blocked = !machineReady(s)
    ? 'The machine is not connected'
    : m.status === 'Alarm'
      ? 'Home or unlock the machine first'
      : m.status !== 'Idle'
        ? `The machine is ${m.status}`
        : !plan?.ok
          ? (plan?.message ?? 'Pick a line')
          : undefined;

  const start = async () => {
    setBusy(true);
    const ok = await run({ type: 'start', fileId: job.fileId!, fromLine: index });
    setBusy(false);
    if (ok) onClose();
  };

  const st = plan?.ok ? plan.state : undefined;
  const fmt = (n: number) => n.toFixed(2);

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow" style={{ color: 'var(--gold)' }}>
          Resume job
        </div>
        <h2>{job.fileName}</h2>
        {error && <div className="banner">{error}</div>}
        {!text && !error && <div className="muted">Loading the file…</div>}
        {text && (
          <>
            <div className="row" style={{ gap: 10, marginTop: 12, alignItems: 'end' }}>
              <label className="field" style={{ width: 160 }}>
                Resume from line
                <input
                  className="input mono"
                  type="number"
                  min={2}
                  max={lines.length}
                  value={line}
                  onChange={(e) => setLine(Math.max(1, Math.min(lines.length, Math.round(Number(e.target.value) || 1))))}
                />
              </label>
              <span className="muted" style={{ fontSize: 12, paddingBottom: 8 }}>
                of {lines.length.toLocaleString()}
                {job.resumeLine !== undefined && line !== job.resumeLine + 1 && (
                  <>
                    {' '}
                    ·{' '}
                    <button className="btn small ghost" onClick={() => setLine(job.resumeLine! + 1)}>
                      back to where it stopped ({job.resumeLine + 1})
                    </button>
                  </>
                )}
              </span>
            </div>
            <div className="resume-lines">
              {lines.slice(Math.max(0, index - 2), index + 3).map((l, i) => {
                const n = Math.max(0, index - 2) + i;
                return (
                  <div key={n} className={n === index ? 'here' : ''}>
                    {String(n + 1).padStart(6)} {n === index ? '▶' : ' '} {l.text}
                  </div>
                );
              })}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Going back a line or two is safe: it re-cuts a little of the same path.
            </div>
          </>
        )}

        {st && plan?.ok && (
          <ol className="steps" style={{ marginTop: 12 }}>
            <li>Lift to Z{fmt(Math.max(s.config.safeZ, plan.start[2]))} (never past the top of travel).</li>
            <li>
              Move to X{fmt(plan.start[0])} Y{fmt(plan.start[1])}, where line {line} starts.
            </li>
            {st.spindle !== 'M5' && (
              <li>
                Start the spindle ({st.spindle === 'M3' ? 'clockwise' : 'counter-clockwise'}, S{st.speed}) and wait 4 s for it to reach speed.
              </li>
            )}
            <li>
              {plan.start[2] < s.config.safeZ ? `Lower to Z${fmt(plan.start[2])} at 300 mm/min, then carry` : 'Carry'} on with the program.
            </li>
          </ol>
        )}
        {plan?.ok && plan.state.warnings.length > 0 && (
          <div className="banner warn" style={{ marginTop: 8 }}>
            {plan.state.warnings.join('. ')}.
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Before resuming: the same bit is fitted, nothing is in the way, and work zero hasn't changed. If the machine was
          switched off or raised an alarm, home it first (work zero is kept).
        </div>

        <div className="actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary big" disabled={!!blocked || busy} title={blocked} onClick={start}>
            {busy ? 'Starting…' : `▶ Resume from line ${line}`}
          </button>
        </div>
        {blocked && <div className="muted" style={{ fontSize: 12, marginTop: 8, textAlign: 'right' }}>{blocked}</div>}
      </div>
    </div>
  );
}
