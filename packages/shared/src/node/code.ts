// Which code this server runs, and updating it in place: pull, install, rebuild, restart.

import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerCode, UpdateProgress } from '../protocol.ts';

/** The repository root (packages/shared/src/node → ../../../..). */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

/** Exit code that asks the Mac app or launcher to start the server again (EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75;

/**
 * Read once at start-up: the code in memory is what was started, even if the checkout
 * is pulled later, so a pull without a restart still counts as behind.
 */
export function readCode(repo = REPO_ROOT): ServerCode {
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version ?? version;
  } catch {
    // not a checkout we recognise
  }
  const code: ServerCode = { version, repo, canUpdate: false, supervised: process.env.GCC_SUPERVISED === '1' };
  if (!existsSync(join(repo, '.git'))) return code;
  try {
    const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H %ct'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [commit, secs] = out.split(' ');
    code.commit = commit;
    code.time = Number(secs) * 1000;
    code.canUpdate = true;
  } catch {
    // git missing (no Xcode command line tools) or not a repository after all
  }
  return code;
}

export interface UpdateStep {
  label: string;
  cmd: string;
  args: string[];
  /** Shown with the step's output when it fails. */
  hint?: string;
  /** Checked just before the step (after the earlier ones): false skips it. */
  when?: () => boolean;
}

/** npm from the same Node install that runs this server (the Mac app's PATH may not have it). */
function npm(): string {
  const beside = join(dirname(process.execPath), 'npm');
  return existsSync(beside) ? beside : 'npm';
}

export function defaultSteps(repo: string): UpdateStep[] {
  return [
    {
      label: 'Downloading the latest code (git pull)',
      cmd: 'git',
      args: ['-C', repo, 'pull', '--ff-only'],
      hint: 'If you have changed files in this folder, commit or stash them first. Nothing was changed.',
    },
    { label: 'Installing packages (npm install)', cmd: npm(), args: ['install', '--no-audit', '--no-fund'] },
    { label: 'Building the web UI', cmd: npm(), args: ['run', 'build:web'] },
    ...macAppStep(repo),
  ];
}

/**
 * When the Mac app runs this server (it passes its own path in GCC_APP_PATH), rebuild and
 * reinstall the app too, so an update brings everything up to date. The app sees its newer
 * binary when this server exits for the restart, and relaunches itself to run it.
 */
function macAppStep(repo: string): UpdateStep[] {
  const app = process.env.GCC_APP_PATH;
  const script = join(repo, 'scripts/build-mac-app.sh');
  if (process.platform !== 'darwin' || !app || !existsSync(script)) return [];
  // The script builds in mac/build and installs a copy; an app run from mac/build is rebuilt in place.
  const dest = resolve(app, '..') === join(repo, 'mac/build') ? [] : [resolve(app, '..')];
  return [{ label: 'Rebuilding and reinstalling the Mac app', cmd: '/bin/zsh', args: [script, ...dest] }];
}

/**
 * Runs the update steps one after another, reporting progress. It never discards local
 * changes: `git pull --ff-only` refuses rather than merging or overwriting.
 */
export class Updater extends EventEmitter<{ progress: [UpdateProgress]; log: [string] }> {
  progress?: UpdateProgress;

  constructor(
    private readonly repo: string,
    private readonly steps: UpdateStep[] = defaultSteps(repo),
  ) {
    super();
  }

  get running(): boolean {
    return !!this.progress?.running;
  }

  /** Resolves when every step has succeeded; rejects with a readable message otherwise. */
  async run(): Promise<void> {
    if (this.running) throw new Error('An update is already running');
    try {
      for (const step of this.steps) {
        if (step.when && !step.when()) continue;
        this.set({ running: true, step: step.label });
        this.emit('log', `${step.label}…`);
        const { code, tail } = await this.exec(step);
        if (code !== 0) {
          throw new Error(`${step.label} failed${tail ? `: ${tail}` : ''}${step.hint ? `. ${step.hint}` : ''}`);
        }
      }
      this.set({ running: false, step: 'Updated. Restarting…' });
    } catch (err) {
      this.set({ running: false, error: (err as Error).message });
      throw err;
    }
  }

  private set(p: UpdateProgress): void {
    this.progress = p;
    this.emit('progress', p);
  }

  private exec(step: UpdateStep): Promise<{ code: number; tail: string }> {
    return new Promise((done) => {
      const nodeDir = dirname(process.execPath);
      const child = spawn(step.cmd, step.args, {
        cwd: this.repo,
        env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, FORCE_COLOR: '0', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lines: string[] = [];
      const take = (b: Buffer) => {
        for (const l of String(b).split('\n')) {
          // eslint-disable-next-line no-control-regex
          const t = l.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (!t) continue;
          lines.push(t);
          this.emit('log', t);
        }
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (err) => done({ code: -1, tail: err.message }));
      child.on('close', (code) => done({ code: code ?? -1, tail: lines.slice(-2).join(' ') }));
    });
  }
}

/** "4a90fc1, 15 Nov 2026" for logs. */
export function describeCode(c: ServerCode): string {
  if (!c.commit) return `${c.version} (not a git checkout, so it can't update itself)`;
  const when = c.time ? new Date(c.time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return `${c.commit.slice(0, 7)}${when ? `, ${when}` : ''}${c.supervised ? '' : ' (restart it by hand after an update)'}`;
}
