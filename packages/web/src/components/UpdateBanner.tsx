import { useState } from 'react';
import { shortCommit, type ServerCode } from '@gcc/shared';
import { useStore } from '../store.ts';

function when(c?: ServerCode): string {
  return c?.time ? new Date(c.time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

function describe(c?: ServerCode): string {
  if (!c) return 'a version from before version checks';
  return `${shortCommit(c)}${c.time ? `, ${when(c)}` : ''}`;
}

/**
 * Shown when the hub and agent run different code. An agent that's behind won't move the
 * machine until it's updated (the agent and hub both enforce that); a hub that's behind only
 * gets a reminder.
 */
export function UpdateBanner() {
  const s = useStore((x) => x.state)!;
  const run = useStore((x) => x.run);
  const [help, setHelp] = useState(false);
  const code = s.code;
  if (!code || (!code.agentBehind && !code.hubBehind)) return null;

  const target = code.agentBehind ? 'agent' : 'hub';
  const behind = code.agentBehind ? code.agent : code.hub;
  const ahead = code.agentBehind ? code.hub : code.agent;
  const update = behind?.update;
  const jobUnderWay = ['loading', 'running', 'paused', 'stopping', 'toolchange'].includes(s.job.status);
  const mac = target === 'agent' ? 'machine Mac' : 'design Mac';
  const other = target === 'agent' ? 'design Mac (hub)' : 'machine Mac (agent)';
  const canUpdate = !!behind?.canUpdate;
  const blockedBy = !canUpdate
    ? "It can't update itself: follow How to update"
    : update?.running
      ? 'Updating…'
      : target === 'agent' && jobUnderWay
        ? 'Finish or end the job first'
        : undefined;

  return (
    <div className={`banner update ${code.agentBehind ? '' : 'info'}`}>
      <div className="update-row">
        <strong>{target === 'agent' ? 'Agent out of date' : 'Hub out of date'}</strong>
        <span>
          {update?.running ? (
            <>
              Updating the {target}: {update.step}…
            </>
          ) : update?.error ? (
            <>Update failed: {update.error}</>
          ) : update?.step ? (
            <>{update.step}</>
          ) : (
            <>
              The {mac} runs older code ({describe(behind)}) than the {other} ({describe(ahead)}).{' '}
              {target === 'agent'
                ? jobUnderWay
                  ? 'The job under way can finish, then it must be updated before the machine moves again.'
                  : "It won't move the machine until it's updated."
                : 'Everything still works. Update it when you can.'}
            </>
          )}
        </span>
        <span className="spacer" />
        {canUpdate && (
          <button
            className="btn small primary"
            disabled={!!blockedBy}
            title={blockedBy ?? `Download the latest code, rebuild and restart the ${target}`}
            onClick={() => void run({ type: 'update', target })}
          >
            {update?.running ? 'Updating…' : update?.error ? 'Try again' : 'Update now'}
          </button>
        )}
        <button className="btn small ghost" onClick={() => setHelp(!help)}>
          {help ? 'Hide' : 'How to update'}
        </button>
      </div>
      {help && (
        <ol className="update-help">
          {target === 'agent' && <li>Let any job finish. Hold and Stop work as normal.</li>}
          <li>
            {canUpdate ? (
              <>
                Press <b>Update now</b>. It downloads the latest code, installs packages, rebuilds the UI and restarts the {target}
                {behind?.supervised ? '.' : ': it was started from Terminal, so start it again there afterwards.'} This page reloads when
                it's back.
              </>
            ) : (
              <>This {target} is too old to update itself, so update it by hand on the {mac}.</>
            )}
          </li>
          <li>
            Or by hand, on the {mac}, in Terminal:
            <pre>
              cd {behind?.repo ? `"${behind.repo}"` : 'path/to/gcode-controller'}
              {'\n'}git pull{'\n'}npm install
            </pre>
            then restart the {target}: press <b>Restart</b> in the GCode Controller app, or close its Terminal window and double-click{' '}
            <b>{target === 'agent' ? 'Start Agent.command' : 'Start Hub.command'}</b> again.
          </li>
          {!canUpdate && behind && <li>If git pull says files have changed locally, commit or stash those changes first.</li>}
        </ol>
      )}
    </div>
  );
}
