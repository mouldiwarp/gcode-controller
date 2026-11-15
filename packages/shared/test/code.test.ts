import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeState, compareCode, initialJob, outdatedRefusal, type ServerCode } from '../src/protocol.ts';
import { defaultSteps, readCode, Updater } from '../src/node/code.ts';

const at = (commit: string, time?: number): ServerCode => ({ version: '0.1.0', commit: commit.padEnd(40, '0'), time, canUpdate: true, supervised: false });

describe('comparing code', () => {
  it('orders commits by time', () => {
    expect(compareCode(at('a', 1), at('a', 1))).toBe('same');
    expect(compareCode(at('a', 1), at('b', 2))).toBe('behind');
    expect(compareCode(at('b', 2), at('a', 1))).toBe('ahead');
    expect(compareCode(at('a', 1), at('b', 1))).toBe('different');
    expect(compareCode(at('a'), at('b', 1))).toBe('different');
    expect(compareCode({ version: '1' }, at('b', 1))).toBe('unknown');
  });

  it('treats a connected agent with no version as behind, and nothing as behind while it is offline', () => {
    expect(codeState(at('b', 2), undefined, true)).toMatchObject({ agentBehind: true, hubBehind: false });
    expect(codeState(at('b', 2), undefined, false)).toMatchObject({ agentBehind: false, hubBehind: false });
    expect(codeState(at('a', 1), at('b', 2), true)).toMatchObject({ agentBehind: false, hubBehind: true });
    expect(codeState(undefined, at('b', 2), true)).toMatchObject({ agentBehind: false, hubBehind: false });
  });

  it('refuses motion when the agent is behind, but never strands a job or a group', () => {
    const behind = codeState(at('b', 2), at('a', 1), true);
    const idle = initialJob();
    expect(outdatedRefusal({ type: 'jog', x: 1, feed: 100 }, idle, behind)).toMatch(/older code/);
    expect(outdatedRefusal({ type: 'start', fileId: 'x' }, idle, behind)).toMatch(/older code/);
    for (const ok of [{ type: 'hold' }, { type: 'stop' }, { type: 'reset' }, { type: 'unlock' }, { type: 'update', target: 'agent' }] as const) {
      expect(outdatedRefusal(ok, idle, behind)).toBeUndefined();
    }
    expect(outdatedRefusal({ type: 'startNext' }, { ...idle, status: 'toolchange' }, behind)).toBeUndefined();
    expect(outdatedRefusal({ type: 'probeZ' }, { ...idle, status: 'toolchange' }, behind)).toBeUndefined();
    expect(outdatedRefusal({ type: 'jog', x: 1, feed: 100 }, idle, codeState(at('a', 1), at('a', 1), true))).toBeUndefined();
  });
});

describe('updating a git checkout', () => {
  // Isolated from the user's git config (signing, hooks), with fixed commit times so their order is clear.
  const git = (cwd: string, args: string[], date = '2026-01-02T00:00:00Z') =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });

  function repos() {
    const dir = mkdtempSync(join(tmpdir(), 'gcc-git-'));
    const origin = join(dir, 'origin');
    git(dir, ['init', '-q', origin]);
    writeFileSync(join(origin, 'package.json'), '{"version":"0.2.0"}');
    writeFileSync(join(origin, 'a.txt'), 'one\n');
    git(origin, ['add', '.']);
    git(origin, ['commit', '-qm', 'first'], '2026-01-01T00:00:00Z');
    git(dir, ['clone', '-q', origin, 'clone']);
    const clone = join(dir, 'clone');
    writeFileSync(join(origin, 'a.txt'), 'two\n');
    git(origin, ['commit', '-qam', 'second']);
    return { origin, clone };
  }

  it('reads the commit, then fast-forwards to the latest', async () => {
    const { origin, clone } = repos();
    const before = readCode(clone);
    expect(before).toMatchObject({ version: '0.2.0', canUpdate: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(compareCode(before, readCode(origin))).toBe('behind');
    const updater = new Updater(clone, defaultSteps(clone).slice(0, 1)); // just the pull
    await updater.run();
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('two\n');
    expect(readCode(clone).commit).toBe(readCode(origin).commit);
    expect(updater.progress).toMatchObject({ running: false, step: expect.stringMatching(/Restarting/) });
  });

  it("refuses to pull over local changes and leaves them alone", async () => {
    const { clone } = repos();
    writeFileSync(join(clone, 'a.txt'), 'my edit\n');
    const updater = new Updater(clone, defaultSteps(clone).slice(0, 1));
    await expect(updater.run()).rejects.toThrow(/git pull\) failed.*commit or stash them first/s);
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('my edit\n');
    expect(updater.progress?.error).toBeTruthy();
  });

  it('knows a folder that is not a checkout cannot update itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gcc-plain-'));
    const code = readCode(dir);
    expect(code.canUpdate).toBe(false);
    expect(code.commit).toBeUndefined();
  });
});
