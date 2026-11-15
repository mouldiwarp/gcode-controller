import { useEffect, useState } from 'react';
import { formatDuration, jobElapsedSeconds, jobPercent } from '@gcc/shared';
import { useStore } from '../store.ts';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Ready',
  loading: 'Sending file to the machine',
  running: 'Running',
  paused: 'Paused',
  stopping: 'Stopping',
  done: 'Complete',
  stopped: 'Stopped',
  error: 'Failed',
};

export function ProgressPanel() {
  const job = useStore((x) => x.state!.job);
  const [, tick] = useState(0);

  // Elapsed time keeps counting between updates.
  useEffect(() => {
    if (job.status !== 'running' && job.status !== 'paused') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.status]);

  const pct = jobPercent(job);
  const elapsed = jobElapsedSeconds(job);
  // Blend the CAM estimate with the observed rate once there's enough progress to trust it.
  let remaining: number | undefined;
  if (job.status === 'running' || job.status === 'paused') {
    const byRate = pct > 3 ? (elapsed / pct) * (100 - pct) : undefined;
    const byEst = job.estSeconds ? Math.max(job.estSeconds - elapsed, 0) : undefined;
    remaining = byRate !== undefined && byEst !== undefined ? (pct < 20 ? (byRate + byEst) / 2 : byRate) : (byRate ?? byEst);
  }

  const fillClass = job.status === 'paused' ? 'paused' : job.status === 'error' ? 'error' : '';

  return (
    <section className="panel">
      <div className="progress-card">
        <div className="progress-pct">{pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}%</div>
        <div className="progress-main">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="eyebrow" style={{ color: job.status === 'error' ? 'var(--danger)' : job.status === 'paused' ? 'var(--warn)' : 'var(--gold)' }}>
              {STATUS_LABEL[job.status]}
            </span>
            <span className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {job.fileName ?? 'No job'}
              {job.startedBy ? ` · started by ${job.startedBy}` : ''}
            </span>
          </div>
          <div className="progress-track" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={`progress-fill ${fillClass}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="progress-meta">
            <span>
              Line <b>{job.ackedLines.toLocaleString()}</b> / {job.totalLines.toLocaleString()}
            </span>
            {job.error && <span style={{ color: 'var(--danger)' }}>{job.error}</span>}
          </div>
        </div>
        <div className="row" style={{ gap: 22 }}>
          <div className="stat">
            <div className="eyebrow">Elapsed</div>
            <div className="v">{job.startedAt ? formatDuration(elapsed) : '--:--'}</div>
          </div>
          <div className="stat">
            <div className="eyebrow">Remaining</div>
            <div className="v">{remaining !== undefined ? formatDuration(remaining) : '--:--'}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
