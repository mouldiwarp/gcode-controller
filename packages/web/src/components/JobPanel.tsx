import type { OverrideKind } from '@gcc/shared';
import { jobActive, machineReady, useStore } from '../store.ts';

export function JobPanel() {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const previewId = useStore((x) => x.previewId);
  const askStart = useStore((x) => x.askStart);
  const ready = machineReady(s);
  const job = s.job;
  const active = jobActive(s);
  const selected = s.library.find((f) => f.id === previewId);
  const ov = s.machine.overrides;

  const canStart = ready && !active && s.machine.status === 'Idle' && !!selected;
  const startHint = !ready
    ? 'Machine not connected'
    : active
      ? 'A job is running'
      : s.machine.status !== 'Idle'
        ? `Machine is ${s.machine.status}`
        : !selected
          ? 'Select a file in the library'
          : undefined;

  return (
    <section className="panel">
      <h3 className="panel-title">
        <span>Job</span>
        {(job.status === 'done' || job.status === 'stopped' || job.status === 'error') && (
          <button className="btn small ghost" onClick={() => run({ type: 'clearJob' })}>
            Clear
          </button>
        )}
      </h3>

      <div className="job-file">
        <div className="eyebrow">{active ? 'Running' : 'Selected'}</div>
        <div className="name">{active ? job.fileName : (selected?.name ?? '—')}</div>
      </div>

      {!active ? (
        <button className="btn primary big" style={{ width: '100%' }} disabled={!canStart} onClick={() => askStart(selected!.id)} title={startHint}>
          ▶ Start job
        </button>
      ) : (
        <div className="grid-2">
          {job.status === 'paused' ? (
            <button className="btn primary big" disabled={!ready} onClick={() => run({ type: 'resume' })}>
              Resume
            </button>
          ) : (
            <button className="btn warn big" disabled={!ready || job.status !== 'running'} onClick={() => run({ type: 'hold' })}>
              Pause
            </button>
          )}
          <button className="btn danger big" disabled={!ready || job.status === 'stopping'} onClick={() => run({ type: 'stop' })}>
            Stop
          </button>
        </div>
      )}
      {startHint && !active && <div className="muted" style={{ fontSize: 12, marginTop: 6, textAlign: 'center' }}>{startHint}</div>}

      <div className="eyebrow" style={{ marginTop: 16 }}>
        Overrides
      </div>
      <Override label="Feed" kind="feed" value={ov.feed} disabled={!ready} />
      <Override label="Spindle" kind="spindle" value={ov.spindle} disabled={!ready} />
      <div className="ov-row" style={{ gridTemplateColumns: '62px 1fr 1fr 1fr' }}>
        <span className="muted">Rapid</span>
        {([
          ['r25', 25],
          ['r50', 50],
          ['reset', 100],
        ] as const).map(([action, v]) => (
          <button key={v} className={`btn small ${ov.rapid === v ? 'active' : ''}`} disabled={!ready} onClick={() => run({ type: 'override', kind: 'rapid', action })}>
            {v}%
          </button>
        ))}
      </div>
    </section>
  );
}

function Override({ label, kind, value, disabled }: { label: string; kind: OverrideKind; value: number; disabled: boolean }) {
  const run = useStore((x) => x.run);
  const send = (action: 'reset' | 'plus10' | 'minus10' | 'plus1' | 'minus1') => run({ type: 'override', kind, action });
  return (
    <div className="ov-row">
      <span className="muted">{label}</span>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn small" disabled={disabled} onClick={() => send('minus10')}>
          −10
        </button>
        <button className="btn small" disabled={disabled} onClick={() => send('minus1')}>
          −1
        </button>
      </div>
      <button className="btn small ghost val" disabled={disabled} onClick={() => send('reset')} title="Reset to 100%">
        {value}%
      </button>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn small" disabled={disabled} onClick={() => send('plus1')}>
          +1
        </button>
        <button className="btn small" disabled={disabled} onClick={() => send('plus10')}>
          +10
        </button>
      </div>
    </div>
  );
}
