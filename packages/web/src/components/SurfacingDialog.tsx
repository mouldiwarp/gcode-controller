import { useEffect, useMemo, useState } from 'react';
import {
  analyzeProgram,
  checkSurfacing,
  DEFAULT_SURFACING,
  effectiveOverhang,
  formatDuration,
  planSurfacing,
  type SurfacingParams,
} from '@gcc/shared';
import { jobActive, machineReady, useStore } from '../store.ts';

const KEY = 'gcc.surfacing';

function load(): SurfacingParams {
  try {
    return { ...DEFAULT_SURFACING, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SURFACING };
  }
}

function save(p: SurfacingParams): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // not remembered in a private window
  }
}

/** Flatten the spoilboard: zero at the left edge on its centre line, then skim the area. */
export function SurfacingDialog() {
  const open = useStore((x) => x.surfacingOpen);
  const setOpen = useStore((x) => x.setSurfacingOpen);
  if (!open) return null;
  return <SurfacingBody onClose={() => setOpen(false)} />;
}

type Field = { key: keyof SurfacingParams; label: string; unit: string; step?: number; hint?: string };

const AREA: Field[] = [
  { key: 'lengthX', label: 'Length (X)', unit: 'mm', step: 1, hint: 'From X0 at the left edge, to the right' },
  { key: 'widthY', label: 'Width (Y)', unit: 'mm', step: 1, hint: 'Front to back, centred on Y0' },
  { key: 'totalDepth', label: 'Depth to remove', unit: 'mm', step: 0.1 },
];

const CUTTER: Field[] = [
  { key: 'toolDiameter', label: 'Cutter diameter', unit: 'mm', step: 0.5 },
  { key: 'fluteLength', label: 'Cutting depth', unit: 'mm', step: 0.5 },
  { key: 'stepDown', label: 'Most per pass', unit: 'mm', step: 0.1 },
  { key: 'stepoverPct', label: 'Stepover', unit: '% of dia', step: 5 },
  { key: 'rampAngle', label: 'Ramp angle', unit: '°', step: 0.5, hint: 'Enters the cut at this angle, never plunging' },
  { key: 'overhang', label: 'Past the edges', unit: 'mm', step: 0.5 },
  { key: 'feed', label: 'Feed', unit: 'mm/min', step: 100 },
  { key: 'rampFeed', label: 'Ramp feed', unit: 'mm/min', step: 100 },
  { key: 'spindleRpm', label: 'Spindle', unit: 'rpm', step: 1000 },
  { key: 'safeZ', label: 'Safe Z', unit: 'mm', step: 1 },
];

function SurfacingBody({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const toast = useStore((x) => x.toast);
  const setPreview = useStore((x) => x.setPreview);
  const setProbeOpen = useStore((x) => x.setProbeOpen);
  const [p, setP] = useState<SurfacingParams>(load);
  const [busy, setBusy] = useState(false);
  const m = s.machine;
  const locked = !machineReady(s) || jobActive(s) || m.status !== 'Idle';

  useEffect(() => save(p), [p]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const errors = useMemo(() => checkSurfacing(p), [p]);
  const plan = useMemo(() => (errors.length ? null : planSurfacing(p)), [p, errors]);
  const analysis = useMemo(() => (plan ? analyzeProgram(plan.gcode, { rapidRate: s.config.rapidRate, keepSegments: false }) : null), [plan, s.config.rapidRate]);

  // Would it fit from the current work zero?
  const outside = useMemo(() => {
    if (!analysis?.bounds || !machineReady(s)) return [];
    const env = s.config.envelope;
    const names = ['X', 'Y', 'Z'];
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (analysis.bounds.min[i] + m.wco[i] < env.min[i] - 0.01 || analysis.bounds.max[i] + m.wco[i] > env.max[i] + 0.01) out.push(names[i]);
    }
    return out;
  }, [analysis, s, m.wco]);

  const num = (f: Field) => (
    <label className="field" key={f.key} title={f.hint}>
      <span>
        {f.label} <span className="muted">({f.unit})</span>
      </span>
      <input
        className="input mono"
        type="number"
        step={f.step}
        min={0}
        value={(f.key === 'lengthX' || f.key === 'widthY') && p[f.key] === 0 ? '' : p[f.key]}
        placeholder={f.key === 'lengthX' || f.key === 'widthY' ? 'measure it' : undefined}
        onChange={(e) => setP({ ...p, [f.key]: e.target.value === '' ? 0 : Number(e.target.value) })}
      />
    </label>
  );

  const add = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        body: plan.gcode,
        headers: { 'X-Filename': encodeURIComponent(plan.name), 'X-Source': 'Surfacing', 'Content-Type': 'text/plain' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setPreview(body.id);
      onClose();
    } catch (err) {
      toast('error', `Could not add the surfacing program: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow" style={{ color: 'var(--gold)' }}>
          Surface spoilboard
        </div>
        <h2>Flatten the spoilboard</h2>

        <ol className="steps" style={{ marginTop: 12 }}>
          <li>Fit the surfacing cutter.</li>
          <li>
            Jog the centre of the bit to the <b>left edge</b> of the spoilboard, on its <b>centre line</b> (front to back), and set XY zero.{' '}
            <button className="btn small outline-gold" disabled={locked} onClick={() => run({ type: 'zero', axes: ['X', 'Y'] })}>
              Zero XY here
            </button>
          </li>
          <li>
            Set Z zero on the surface, at its highest point if you know it.{' '}
            <button className="btn small" disabled={locked} onClick={() => run({ type: 'zero', axes: ['Z'] })} title="The bit is touching the surface now">
              Zero Z here
            </button>{' '}
            <button className="btn small outline-gold" disabled={locked || m.status === 'Alarm'} onClick={() => setProbeOpen(true)}>
              Probe Z…
            </button>
          </li>
          <li>Measure the area to flatten and fill it in below.</li>
        </ol>
        <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
          Work position now: X {m.wpos[0].toFixed(2)} · Y {m.wpos[1].toFixed(2)} · Z {m.wpos[2].toFixed(2)}
        </div>

        <div className="eyebrow" style={{ marginTop: 16 }}>
          Area
        </div>
        <div className="surf-grid">{AREA.map(num)}</div>
        <div className="eyebrow" style={{ marginTop: 16 }}>
          Cutter and cutting
        </div>
        <div className="surf-grid">{CUTTER.map(num)}</div>

        {errors.length > 0 && p.lengthX > 0 && p.widthY > 0 && (
          <div className="banner" style={{ marginTop: 12 }}>
            {errors.join('. ')}
          </div>
        )}
        {plan && analysis && (
          <div className="surf-summary">
            {plan.levels} pass{plan.levels > 1 ? 'es' : ''} of {plan.lines} lines, {plan.stepover.toFixed(1)} mm apart · ramps in over{' '}
            {plan.rampLength.toFixed(0)} mm at {p.rampAngle}° · about {formatDuration(analysis.estSeconds)}
            {effectiveOverhang(p) > p.overhang && (
              <div className="muted" style={{ marginTop: 4 }}>
                Runs {plan.overhang} mm past the edges (not {p.overhang}) so the round cutter reaches the corners.
              </div>
            )}
            <div className="muted" style={{ marginTop: 4 }}>
              The cutter's edge reaches X{(-plan.overhang).toFixed(1)} to X{(p.lengthX + plan.overhang).toFixed(1)} and Y±
              {(p.widthY / 2 + plan.overhang).toFixed(1)}. Clear any clamps out of the way.
            </div>
            {outside.length > 0 && (
              <div style={{ color: 'var(--warn)', marginTop: 4 }}>
                ⚠ From the current work zero this goes outside the machine's travel in {outside.join(', ')}. Check the zero and the area.
              </div>
            )}
          </div>
        )}

        <div className="actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn small ghost" onClick={() => setP({ ...DEFAULT_SURFACING, lengthX: p.lengthX, widthY: p.widthY })}>
            Reset cutter settings
          </button>
          <button className="btn primary big" disabled={!plan || busy} onClick={add} title="Adds the program to the library and shows it in the 3D view. Start it from the Job panel.">
            {busy ? 'Adding…' : 'Add to library'}
          </button>
        </div>
      </div>
    </div>
  );
}
