import { jobActive, machineReady, useStore, nextGroupFile } from '../store.ts';

export function TopBar() {
  const s = useStore((x) => x.state)!;
  const socket = useStore((x) => x.socket);
  const run = useStore((x) => x.run);
  const clientName = useStore((x) => x.clientName);
  const openSettings = useStore((x) => x.setSettingsOpen);
  const ready = machineReady(s);
  const m = s.machine;
  const active = jobActive(s);
  // Probing counts as moving even between its moves, so Hold and Stop stay available.
  const moving = ['Run', 'Jog', 'Home'].includes(m.status) || !!m.probing;
  const held = m.status === 'Hold';

  const machineLabel =
    !s.link.agentConnected ? 'Agent offline' : m.connection === 'connected' ? m.status : m.connection === 'connecting' ? 'Connecting' : 'No machine';

  return (
    <header className="topbar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="6" fill="#1e1e1e" />
          <path d="M16 5 L16 19 M11 14 L16 19 L21 14" stroke="#c5a059" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 25 H24" stroke="#c5a059" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div>
          <div className="brand-name">GCode Controller</div>
          <div className="brand-sub">
            {clientName} · via {s.link.via === 'hub' ? 'hub' : 'machine agent'}
          </div>
        </div>
      </div>

      <div className="pills">
        <span className="pill" title={s.link.hubName ? `Hub on ${s.link.hubName}` : 'Hub'}>
          <span className={`dot ${socket === 'open' && s.link.hubConnected ? 'ok' : 'bad'}`} />
          Hub
        </span>
        <span className="pill" title={s.link.agentName ?? 'Machine agent'}>
          <span className={`dot ${socket === 'open' && s.link.agentConnected ? 'ok' : 'bad'}`} />
          Agent
        </span>
        <span className={`pill state-pill state-${ready ? m.status : 'off'}`} title={m.port}>
          {!ready && <span className="dot bad" />}
          {machineLabel}
          {m.simulated && ready ? ' · SIM' : ''}
        </span>
        {m.lastCommandBy && <span className="pill muted">Last: {m.lastCommandBy}</span>}
      </div>

      <div className="topbar-actions">
        <button className="btn" disabled={!ready || active || moving} onClick={() => run({ type: 'home' })} title="Run the homing cycle ($H)">
          Home
        </button>
        {m.status === 'Alarm' && (
          <button className="btn outline-gold" disabled={!ready} onClick={() => run({ type: 'unlock' })} title="Clear the alarm without homing ($X)">
            Unlock
          </button>
        )}
        <button className="btn ghost" disabled={!ready} onClick={() => run({ type: 'reset' })} title="Soft reset (Ctrl-X)">
          Reset
        </button>
        {held ? (
          <button className="btn big outline-gold" disabled={!ready} onClick={() => run({ type: 'resume' })}>
            Resume
          </button>
        ) : (
          <button className="btn big warn" disabled={!ready || (!moving && !active)} onClick={() => run({ type: 'hold' })} title="Feed hold (!)">
            Hold
          </button>
        )}
        <button className="btn big danger" disabled={!ready || (!active && !moving && !held)} onClick={() => run({ type: 'stop' })} title="Stop the job: hold, then reset">
          Stop
        </button>
        <button className="btn icon ghost" onClick={() => openSettings(true)} title="Settings" aria-label="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}

export function Banners() {
  const s = useStore((x) => x.state)!;
  const socket = useStore((x) => x.socket);
  const run = useStore((x) => x.run);
  const m = s.machine;

  if (socket !== 'open') {
    return (
      <div className="banner warn">
        <strong>Reconnecting</strong> Lost contact with the {s.link.via === 'hub' ? 'hub' : 'machine agent'}. The machine keeps running any job it has.
      </div>
    );
  }
  if (!s.link.agentConnected) {
    return (
      <div className="banner warn">
        <strong>Machine agent offline</strong> Start the agent on the Mac connected to the machine. Files can still be uploaded here.
      </div>
    );
  }
  if (s.link.via === 'agent' && !s.link.hubConnected) {
    return (
      <div className="banner warn">
        <strong>Hub offline</strong> Machine control works from here. Cached files can still run; uploads wait for the hub.
      </div>
    );
  }
  if (m.alarm) {
    return (
      <div className="banner">
        <strong>Alarm {m.alarm.code}</strong>
        <span>{m.alarm.message}</span>
        <span className="spacer" />
        <button className="btn small" onClick={() => run({ type: 'home' })}>
          Home
        </button>
        <button className="btn small outline-gold" onClick={() => run({ type: 'unlock' })}>
          Unlock
        </button>
      </div>
    );
  }
  if (m.status === 'Alarm' && m.connection === 'connected') {
    return (
      <div className="banner">
        <strong>Locked</strong> The controller needs homing ($H) or unlocking ($X) before it will move.
        <span className="spacer" />
        <button className="btn small" onClick={() => run({ type: 'home' })}>
          Home
        </button>
        <button className="btn small outline-gold" onClick={() => run({ type: 'unlock' })}>
          Unlock
        </button>
      </div>
    );
  }
  const next = nextGroupFile(s);
  if (next) {
    return (
      <div className="banner warn">
        <strong>Bit change</strong>
        <span>
          File {next.index} of {next.total} is done and the spindle is off. Fit the bit for <b>{next.name}</b>, re-probe Z, then start it.
        </span>
      </div>
    );
  }
  if (s.job.status === 'paused' && s.job.error) {
    return (
      <div className="banner warn">
        <strong>Paused on error</strong> {s.job.error}
      </div>
    );
  }
  return null;
}
