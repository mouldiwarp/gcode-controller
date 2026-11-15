import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeProgram, formatDuration, streamableLines, type Bounds, type ProgramAnalysis } from '@gcc/shared';
import { useStore, nextGroupFile } from '../store.ts';
import { ToolpathScene, type ViewName } from '../viz/scene.ts';

interface Loaded {
  sha: string;
  analysis: ProgramAnalysis;
  /** Source line of each streamed line, to turn an ack count into a source line. */
  streamSources: Int32Array;
}

const cache = new Map<string, Loaded>();
const GRBL_PLANNER = 15;

async function loadProgram(id: string, sha: string, rapidRate: number): Promise<Loaded> {
  const hit = cache.get(sha);
  if (hit) return hit;
  const res = await fetch(`/api/files/${encodeURIComponent(id)}/content`);
  if (!res.ok) throw new Error(`Could not load the file (${res.status})`);
  const text = await res.text();
  const analysis = analyzeProgram(text, { rapidRate });
  const streamSources = Int32Array.from(streamableLines(text).map((l) => l.source));
  const loaded = { sha, analysis, streamSources };
  cache.clear(); // keep only one program in memory
  cache.set(sha, loaded);
  return loaded;
}

export function Visualizer() {
  const s = useStore((x) => x.state)!;
  const previewId = useStore((x) => x.previewId);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ToolpathScene>();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewName>('iso');

  const job = s.job;
  // Between the files of a group, show the next file waiting to run.
  const next = nextGroupFile(s);
  const showingJob = job.status !== 'idle' && !next && !!job.fileId;
  const fileId = next ? next.id : showingJob ? job.fileId : previewId;
  const item = s.library.find((f) => f.id === fileId);

  useEffect(() => {
    sceneRef.current = new ToolpathScene(hostRef.current!);
    return () => sceneRef.current?.dispose();
  }, []);

  // Load and draw the program.
  useEffect(() => {
    if (!item) {
      setLoaded(null);
      sceneRef.current?.setProgram(null, null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    loadProgram(item.id, item.sha256, s.config.rapidRate)
      .then((l) => {
        if (cancelled) return;
        setLoaded(l);
        sceneRef.current?.setProgram(l.analysis.segments, l.analysis.bounds);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.sha256]);

  // Colour what has been cut. GRBL acknowledges lines when they are planned,
  // not when they're cut, so step back by the blocks still in the planner.
  const doneLine = useMemo(() => {
    if (!loaded || !showingJob) return -1;
    if (job.status === 'done') return Number.MAX_SAFE_INTEGER;
    const inPlanner = s.machine.buffer ? Math.max(0, GRBL_PLANNER - s.machine.buffer.planner) : 0;
    const executed = Math.max(0, job.ackedLines - inPlanner);
    if (executed === 0) return -1;
    return loaded.streamSources[Math.min(executed, loaded.streamSources.length) - 1] ?? -1;
  }, [loaded, showingJob, job.status, job.ackedLines, s.machine.buffer]);

  useEffect(() => {
    sceneRef.current?.setProgress(doneLine);
  }, [doneLine, loaded]);

  // Tool marker follows the machine.
  const connected = s.machine.connection === 'connected' && s.link.agentConnected;
  const [wx, wy, wz] = s.machine.wpos;
  useEffect(() => {
    sceneRef.current?.setTool(connected ? [wx, wy, wz] : null);
  }, [connected, wx, wy, wz]);

  // Machine envelope, shifted into work coordinates.
  const env = s.config.envelope;
  const wco = s.machine.wco;
  const envKey = connected ? [...env.min, ...env.max, ...wco].join(',') : '';
  useEffect(() => {
    if (!connected) return sceneRef.current?.setEnvelope(null);
    const b: Bounds = {
      min: [env.min[0] - wco[0], env.min[1] - wco[1], env.min[2] - wco[2]],
      max: [env.max[0] - wco[0], env.max[1] - wco[1], env.max[2] - wco[2]],
    };
    sceneRef.current?.setEnvelope(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envKey]);

  const pickView = (v: ViewName) => {
    setView(v);
    sceneRef.current?.setView(v);
  };

  const b = item?.cutBounds ?? item?.bounds;
  const dims = b ? `${(b.max[0] - b.min[0]).toFixed(1)} × ${(b.max[1] - b.min[1]).toFixed(1)} × ${(b.max[2] - b.min[2]).toFixed(1)} mm` : '';
  const outside = useMemo(() => {
    if (!item?.bounds || !connected) return false;
    for (let i = 0; i < 3; i++) {
      if (item.bounds.min[i] + wco[i] < env.min[i] - 0.01 || item.bounds.max[i] + wco[i] > env.max[i] + 0.01) return true;
    }
    return false;
  }, [item, connected, wco, env]);

  return (
    <div className="viz">
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="viz-overlay">
        {item ? (
          <div className="viz-file">
            <div className="eyebrow">{showingJob ? 'Job' : 'Preview'}</div>
            <div className="name">{item.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {dims} · ~{formatDuration(item.estSeconds)} · {item.streamLines.toLocaleString()} lines
            </div>
            {outside && <div style={{ color: 'var(--warn)', fontSize: 12, marginTop: 4 }}>⚠ Toolpath goes outside the machine travel from this work zero</div>}
          </div>
        ) : (
          <span />
        )}
        <div className="viz-views">
          {(['iso', 'top', 'front', 'right'] as ViewName[]).map((v) => (
            <button key={v} className={`btn small ${view === v ? 'active' : 'ghost'}`} onClick={() => pickView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {!item && (
        <div className="viz-empty">
          <div className="big">No toolpath loaded</div>
          <div>Pick a file in the library, or send one from Swarf.</div>
        </div>
      )}
      {(loading || error) && (
        <div className="viz-empty">
          <div className="big">{error ? 'Could not load' : 'Loading toolpath…'}</div>
          {error && <div>{error}</div>}
        </div>
      )}
      <div className="viz-legend">
        <span>
          <span className="swatch" style={{ background: '#9a9a9a' }} />
          To cut
        </span>
        <span>
          <span className="swatch" style={{ background: '#c5a059' }} />
          Cut
        </span>
        <span>
          <span className="swatch" style={{ background: '#4a4a4a' }} />
          Rapid
        </span>
      </div>
    </div>
  );
}
