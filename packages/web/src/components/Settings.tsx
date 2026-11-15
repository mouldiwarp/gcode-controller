import { useEffect, useState } from 'react';
import { GRBL_SETTINGS, type MachineConfig } from '@gcc/shared';
import { jobActive, machineReady, useStore } from '../store.ts';

export function SettingsDialog() {
  const open = useStore((x) => x.settingsOpen);
  const setOpen = useStore((x) => x.setSettingsOpen);
  if (!open) return null;
  return <SettingsBody onClose={() => setOpen(false)} />;
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const clientName = useStore((x) => x.clientName);
  const setClientName = useStore((x) => x.setClientName);
  const toast = useStore((x) => x.toast);
  const [name, setName] = useState(clientName);
  const c = s.config;
  const [travel, setTravel] = useState(c.envelope.max.map((mx, i) => mx - c.envelope.min[i]));
  const [safeZ, setSafeZ] = useState(c.safeZ);
  const [jogXY, setJogXY] = useState(c.jogFeedXY);
  const [jogZ, setJogZ] = useState(c.jogFeedZ);
  const [rapid, setRapid] = useState(c.rapidRate);
  const [steps, setSteps] = useState(c.jogSteps.join(', '));
  const m = s.machine;
  const ready = machineReady(s);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = async () => {
    if (name.trim() && name !== clientName) setClientName(name.trim());
    const jogSteps = steps
      .split(/[,\s]+/)
      .map(Number)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const config: Partial<MachineConfig> = {
      envelope: { min: [-travel[0], -travel[1], -travel[2]], max: [0, 0, 0] },
      safeZ,
      jogFeedXY: jogXY,
      jogFeedZ: jogZ,
      rapidRate: rapid,
      jogSteps: jogSteps.length ? jogSteps : c.jogSteps,
    };
    if (await run({ type: 'saveConfig', config })) {
      toast('info', 'Settings saved');
      onClose();
    }
  };

  const fromGrbl = () => {
    const st = m.settings;
    if (!st) return;
    setTravel([Number(st['130'] ?? travel[0]), Number(st['131'] ?? travel[1]), Number(st['132'] ?? travel[2])]);
  };

  const num = (v: number, set: (n: number) => void) => ({
    value: v,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(Number(e.target.value) || 0),
  });

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow">Settings</div>
        <h2>Controller</h2>

        <div className="section">
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            This browser
          </div>
          <label className="field">
            Name shown to the other computer (e.g. Studio, Garage)
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>

        <div className="section">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="eyebrow">Machine connection</span>
            <span className="spacer" />
            <span className="muted" style={{ fontSize: 12 }}>
              {m.connection === 'connected' ? `${m.simulated ? 'Simulator' : m.port} · ${m.firmware ?? 'GRBL'}` : m.connection}
            </span>
          </div>
          <div className="row">
            <button className="btn" disabled={!s.link.agentConnected || jobActive(s)} onClick={() => run({ type: 'connect' })}>
              {m.connection === 'connected' ? 'Reconnect' : 'Connect'}
            </button>
            <button className="btn ghost" disabled={!ready || jobActive(s)} onClick={() => run({ type: 'disconnect' })}>
              Disconnect
            </button>
          </div>
        </div>

        <div className="section">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="eyebrow">Machine travel (mm)</span>
            <span className="spacer" />
            <button className="btn small ghost" disabled={!m.settings} onClick={fromGrbl} title="Use $130, $131 and $132 from the controller">
              Read from GRBL
            </button>
          </div>
          <div className="grid-3">
            {(['X', 'Y', 'Z'] as const).map((a, i) => (
              <label className="field" key={a}>
                {a}
                <input
                  className="input mono"
                  type="number"
                  value={travel[i]}
                  onChange={(e) => setTravel(travel.map((v, j) => (j === i ? Number(e.target.value) || 0 : v)))}
                />
              </label>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Drawn as the machine envelope, assuming GRBL's default of homing to the back-right-top corner (machine 0,0,0).
          </div>
        </div>

        <div className="section grid-3">
          <label className="field">
            Safe Z for Go to XY0
            <input className="input mono" type="number" {...num(safeZ, setSafeZ)} />
          </label>
          <label className="field">
            Jog XY feed
            <input className="input mono" type="number" {...num(jogXY, setJogXY)} />
          </label>
          <label className="field">
            Jog Z feed
            <input className="input mono" type="number" {...num(jogZ, setJogZ)} />
          </label>
          <label className="field">
            Rapid rate (for estimates)
            <input className="input mono" type="number" {...num(rapid, setRapid)} />
          </label>
          <label className="field" style={{ gridColumn: 'span 2' }}>
            Jog steps (mm)
            <input className="input mono" value={steps} onChange={(e) => setSteps(e.target.value)} />
          </label>
        </div>

        {m.settings && (
          <div className="section">
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="eyebrow">GRBL settings ($$)</span>
              <span className="spacer" />
              <button className="btn small ghost" disabled={!ready || jobActive(s)} onClick={() => run({ type: 'refreshSettings' })}>
                Refresh
              </button>
            </div>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table className="settings-table">
                <tbody>
                  {Object.entries(m.settings)
                    .sort((a, b) => Number(a[0]) - Number(b[0]))
                    .map(([k, v]) => (
                      <tr key={k}>
                        <td>${k}</td>
                        <td>{GRBL_SETTINGS[Number(k)]?.name ?? ''}</td>
                        <td>
                          {v} <span className="muted">{GRBL_SETTINGS[Number(k)]?.unit ?? ''}</span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Change a setting from the console, e.g. <span className="mono">$110=5000</span>.
            </div>
          </div>
        )}

        <div className="actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!s.link.hubConnected} onClick={save} title={s.link.hubConnected ? '' : 'Settings are stored on the hub'}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
