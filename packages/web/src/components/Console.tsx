import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Macro } from '@gcc/shared';
import { jobActive, machineReady, useStore } from '../store.ts';

export function ToolsPanel() {
  const [tab, setTab] = useState<'console' | 'macros'>('console');
  return (
    <section className="panel">
      <div className="tabs">
        <button className={`tab ${tab === 'console' ? 'active' : ''}`} onClick={() => setTab('console')}>
          Console
        </button>
        <button className={`tab ${tab === 'macros' ? 'active' : ''}`} onClick={() => setTab('macros')}>
          Macros
        </button>
      </div>
      {tab === 'console' ? <ConsoleView /> : <MacrosView />}
    </section>
  );
}

function ConsoleView() {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const [line, setLine] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const canSend = machineReady(s) && !jobActive(s);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.console.length]);

  const submit = () => {
    const l = line.trim();
    if (!l) return;
    setHistory((h) => [l, ...h.filter((x) => x !== l)].slice(0, 50));
    setHIdx(-1);
    setLine('');
    void run({ type: 'mdi', line: l });
  };

  return (
    <>
      <div
        className="console"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
        }}
      >
        {s.console.slice(-300).map((l, i) => (
          <div key={`${l.t}-${i}`} className={`l-${l.dir}`}>
            {l.dir === 'out' ? '› ' : ''}
            {l.text}
            {l.by && l.dir === 'out' && <span className="by">· {l.by}</span>}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input
          className="input mono"
          style={{ flex: 1 }}
          placeholder={canSend ? 'G-code or $ command…' : 'Unavailable while busy'}
          value={line}
          disabled={!canSend}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = Math.min(hIdx + 1, history.length - 1);
              setHIdx(i);
              setLine(history[i]);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const i = hIdx - 1;
              setHIdx(i);
              setLine(i >= 0 ? history[i] : '');
            }
          }}
        />
        <button className="btn outline-gold" disabled={!canSend || !line.trim()} onClick={submit}>
          Send
        </button>
      </div>
    </>
  );
}

function MacrosView() {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const [editing, setEditing] = useState<Macro | null>(null);
  const canRun = machineReady(s) && !jobActive(s) && s.machine.status === 'Idle';

  return (
    <>
      <div className="macros">
        {s.macros.map((m) => (
          <div className="macro" key={m.id}>
            <button className="btn" disabled={!canRun} onClick={() => run({ type: 'runMacro', id: m.id })} title={m.gcode}>
              {m.name}
            </button>
            <button className="btn icon ghost small" disabled={!s.link.hubConnected} onClick={() => setEditing(m)} title="Edit" aria-label={`Edit ${m.name}`}>
              ✎
            </button>
          </div>
        ))}
      </div>
      <button
        className="btn small outline-gold"
        style={{ marginTop: 10 }}
        disabled={!s.link.hubConnected}
        onClick={() => setEditing({ id: '', name: '', gcode: '' })}
      >
        + New macro
      </button>
      {editing && <MacroEditor macro={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function MacroEditor({ macro, onClose }: { macro: Macro; onClose: () => void }) {
  const run = useStore((x) => x.run);
  const [name, setName] = useState(macro.name);
  const [gcode, setGcode] = useState(macro.gcode);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">Macro</div>
        <h2>{macro.id ? 'Edit macro' : 'New macro'}</h2>
        <label className="field" style={{ marginTop: 12 }}>
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field" style={{ marginTop: 10 }}>
          G-code (one command per line)
          <textarea className="input" rows={7} value={gcode} onChange={(e) => setGcode(e.target.value)} />
        </label>
        <div className="actions">
          {macro.id && (
            <button
              className="btn ghost"
              style={{ marginRight: 'auto', color: 'var(--danger)' }}
              onClick={async () => {
                if (await run({ type: 'deleteMacro', id: macro.id })) onClose();
              }}
            >
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!name.trim() || !gcode.trim()}
            onClick={async () => {
              if (await run({ type: 'saveMacro', macro: { id: macro.id, name, gcode } })) onClose();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
