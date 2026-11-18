import { useEffect, useState } from 'react';
import { checkSettings, envelopeFromSettings, FOXALIEN, sameEnvelope } from '@gcc/shared';
import { machineReady, useStore } from '../store.ts';

/**
 * Each time the controller connects and its settings are read, compare them with the values
 * the FoxAlien was checked and set up with, and remind about the hardware the
 * controller can't report. Differences stay up until fixed; the all-clear can be dismissed.
 */
export function StartupCheck() {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const toast = useStore((x) => x.toast);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const m = s.machine;
  const profile = FOXALIEN;
  const connected = machineReady(s) && m.connection === 'connected';

  // A new connection (power on, USB replugged, agent restarted) gets a fresh check.
  useEffect(() => {
    if (!connected) setDismissed(false);
  }, [connected]);

  const settings = m.settings ?? {};
  if (!connected || m.simulated || !Object.keys(settings).length) return null;

  const problems = checkSettings(settings, profile);
  const fromController = envelopeFromSettings(settings);
  const envelopeOff = !!fromController && !sameEnvelope(fromController, s.config.envelope);
  if (!problems.length && !envelopeOff && dismissed) return null;

  const canWrite = m.status === 'Idle';
  const writeHint = canWrite ? undefined : m.status === 'Alarm' ? 'Home or unlock first' : `The machine is ${m.status}`;

  const set = async (keys: string[]) => {
    setBusy(true);
    try {
      const lines = keys.map((k) => `$${k}=${profile.settings[k].value}`).join('\n');
      if (await run({ type: 'mdi', line: lines })) {
        await run({ type: 'refreshSettings' });
        toast('info', `Set ${keys.map((k) => `$${k}`).join(', ')}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const useControllerTravel = async () => {
    if (fromController && (await run({ type: 'saveConfig', config: { envelope: fromController } }))) toast('info', "Machine travel updated from the controller's settings");
  };

  const ok = !problems.length && !envelopeOff;
  return (
    <div className={`banner startup ${ok ? 'info' : 'warn'}`}>
      <div className="update-row">
        <strong>{ok ? 'Machine settings checked' : 'Machine settings differ'}</strong>
        <span>
          {ok
            ? `All ${Object.keys(profile.settings).length} settings match ${profile.name}.`
            : `${problems.length ? `${problems.length} of the controller's settings differ from ${profile.name}.` : ''}${envelopeOff ? " The app's machine travel doesn't match the controller's." : ''}`}
        </span>
        <span className="spacer" />
        {problems.length > 1 && (
          <button className="btn small outline-gold" disabled={!canWrite || busy} title={writeHint} onClick={() => set(problems.map((p) => p.key))}>
            Set all
          </button>
        )}
        {ok && (
          <button className="btn small" onClick={() => setDismissed(true)}>
            OK
          </button>
        )}
      </div>
      {problems.length > 0 && (
        <table className="startup-table">
          <tbody>
            {problems.map((p) => (
              <tr key={p.key}>
                <td className="mono">${p.key}</td>
                <td className="mono">
                  is {p.actual ?? 'not reported'}, should be <b>{p.expected}</b>
                </td>
                <td className="muted">{p.why}</td>
                <td>
                  <button className="btn small" disabled={!canWrite || busy} title={writeHint} onClick={() => set([p.key])}>
                    Set ${p.key}={p.expected}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {envelopeOff && fromController && (
        <div className="startup-line">
          The controller's settings describe travel X {fromController.min[0]}…{fromController.max[0]}, Y {fromController.min[1]}…{fromController.max[1]}, Z{' '}
          {fromController.min[2]}…{fromController.max[2]}; the app uses X {s.config.envelope.min[0]}…{s.config.envelope.max[0]}, Y {s.config.envelope.min[1]}…
          {s.config.envelope.max[1]}, Z {s.config.envelope.min[2]}…{s.config.envelope.max[2]}.{' '}
          <button className="btn small" onClick={useControllerTravel}>
            Use the controller's
          </button>
        </div>
      )}
      {profile.hardware.map((h) => (
        <div key={h} className="startup-line">
          ☐ Check by hand: {h}.
        </div>
      ))}
    </div>
  );
}
