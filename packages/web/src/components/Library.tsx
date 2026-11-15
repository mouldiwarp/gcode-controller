import { useRef, useState, type DragEvent } from 'react';
import { formatDuration, type LibraryItem } from '@gcc/shared';
import { jobActive, nextGroupFile, useStore } from '../store.ts';

async function uploadFiles(files: FileList | File[], toast: (l: 'info' | 'error', t: string) => void) {
  for (const f of Array.from(files)) {
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        body: await f.text(),
        headers: { 'X-Filename': encodeURIComponent(f.name), 'X-Source': 'Upload', 'Content-Type': 'text/plain' },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast('error', `${f.name}: ${body.error ?? res.statusText}`);
      }
    } catch (err) {
      toast('error', `${f.name}: ${(err as Error).message}`);
    }
  }
}

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

export function LibraryPanel() {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const toast = useStore((x) => x.toast);
  const previewId = useStore((x) => x.previewId);
  const setPreview = useStore((x) => x.setPreview);
  const askStart = useStore((x) => x.askStart);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const canUpload = s.link.hubConnected;
  const active = jobActive(s);
  const waitingForBit = !!nextGroupFile(s);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!canUpload) return toast('error', 'The hub is offline, so uploads are unavailable');
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files, toast);
  };

  // Show grouped jobs (e.g. Swarf side A / side B) together, in order.
  const groups: { group?: string; items: LibraryItem[] }[] = [];
  for (const f of s.library) {
    const g = f.group ? groups.find((x) => x.group === f.group) : undefined;
    if (g) g.items.push(f);
    else groups.push({ group: f.group, items: [f] });
  }
  for (const g of groups) g.items.sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0));

  return (
    <section
      className="panel"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <h3 className="panel-title">
        <span>Library</span>
        <button className="btn small outline-gold" disabled={!canUpload} onClick={() => input.current?.click()}>
          Upload
        </button>
      </h3>
      <input
        ref={input}
        type="file"
        multiple
        accept=".nc,.gcode,.ngc,.tap,.gc,.cnc,.txt,.g"
        hidden
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files, toast);
          e.target.value = '';
        }}
      />
      <div className={`dropzone ${over ? 'over' : ''}`}>
        {canUpload ? 'Drop G-code here · or send from Swarf / Fretboard Modeller' : 'Hub offline: showing cached files'}
      </div>
      <div className="files">
        {s.library.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 8 }}>No files yet.</div>}
        {groups.map((g, gi) => (
          <div key={g.group ?? `single-${gi}`} style={{ display: 'contents' }}>
            {g.group && <div className="group-label">{g.group}</div>}
            {g.items.map((f) => {
              const b = f.cutBounds ?? f.bounds;
              const dims = b ? `${(b.max[0] - b.min[0]).toFixed(0)}×${(b.max[1] - b.min[1]).toFixed(0)}×${(b.max[2] - b.min[2]).toFixed(1)}` : '';
              return (
                <div key={f.id} className={`file ${previewId === f.id ? 'selected' : ''}`} onClick={() => setPreview(f.id)}>
                  <div className="name" title={f.name}>
                    {f.name}
                  </div>
                  <div className="meta">
                    <span className={`badge ${f.source !== 'Upload' ? 'gold' : ''}`}>{f.source}</span>~{formatDuration(f.estSeconds)} · {dims} mm ·{' '}
                    {ago(f.addedAt)}
                  </div>
                  <div className="actions">
                    <button
                      className="btn small primary"
                      disabled={active || waitingForBit}
                      title={waitingForBit ? 'A group is waiting for a bit change: use Start next or End group' : 'Start this file'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreview(f.id);
                        askStart(f.id);
                      }}
                    >
                      ▶
                    </button>
                    <button
                      className="btn small ghost"
                      disabled={!canUpload}
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete ${f.name}?`)) {
                          if (previewId === f.id) setPreview(undefined);
                          void run({ type: 'deleteFile', fileId: f.id });
                        }
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
