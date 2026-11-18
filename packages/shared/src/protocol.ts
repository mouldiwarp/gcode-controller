// The state every UI renders and the messages that keep hub, agent and
// browsers in step. The agent is the authority on machine and job state; the
// hub is the authority on the library and macros.

import type { Bounds, Vec3 } from './gcode.ts';
import type { GrblState } from './grbl.ts';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface MachineState {
  connection: ConnectionState;
  port?: string;
  simulated: boolean;
  firmware?: string;
  status: GrblState;
  subState?: number;
  mpos: Vec3;
  wpos: Vec3;
  wco: Vec3;
  /** Homed since the last alarm or connect, so the machine position (and the travel limits) can be trusted. */
  homed?: boolean;
  feed: number;
  spindle: number;
  overrides: { feed: number; rapid: number; spindle: number };
  buffer?: { planner: number; rx: number };
  pins?: string;
  /** Spindle/coolant state from the status report's A: field ('S' clockwise, 'C' counter, 'F' flood, 'M' mist). */
  accessories?: string;
  alarm?: { code: number; message: string };
  /** Last `error:N` received outside a job, for the toast. */
  lastError?: { code: number; message: string; line?: string };
  /** Name of the client that sent the most recent command. */
  lastCommandBy?: string;
  /** Raw `[GC:...]` modal state. */
  modal?: string;
  settings?: Record<string, string>;
  /** A Z probe cycle is running. */
  probing?: boolean;
  /** Result of the most recent Z probe. */
  lastProbe?: ProbeResult;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  t: number;
  /** Machine Z where the bit touched the plate. */
  contactZ?: number;
}

/** `toolchange`: one file of a group has finished and the next is waiting for a bit change. */
export type JobStatus = 'idle' | 'loading' | 'running' | 'paused' | 'stopping' | 'toolchange' | 'done' | 'stopped' | 'error';

/** A run of several library files in order (one per tool, or side A / side B). */
export interface JobGroup {
  name: string;
  files: { id: string; name: string }[];
  /** Index in `files` of the file this job state is about. */
  index: number;
}

export interface JobState {
  status: JobStatus;
  fileId?: string;
  fileName?: string;
  /** Lines that will be streamed. */
  totalLines: number;
  /** Lines GRBL has acknowledged with ok (planned or executed). */
  ackedLines: number;
  /** Source line index (0-based) of the last acknowledged line, for the visualizer. */
  sourceLine: number;
  startedAt?: number;
  finishedAt?: number;
  /** Milliseconds spent paused so far. */
  pausedMs: number;
  pausedAt?: number;
  startedBy?: string;
  estSeconds?: number;
  error?: string;
  group?: JobGroup;
  /** Stream line this run started from (0 unless resumed part way). */
  firstLine?: number;
  /** After a stop or failure: the stream line the cutter was on, to resume from. */
  resumeLine?: number;
  /** Stream line the machine is executing now (behind ackedLines by what GRBL has queued). */
  cuttingLine?: number;
  /** Estimated seconds of the whole program, and how many of them the machine has done. */
  totalSeconds?: number;
  doneSeconds?: number;
  /** doneSeconds when this run started (non-zero for a resume). */
  startSeconds?: number;
}

export interface LibraryItem {
  id: string;
  /** File name on disk, including the extension. */
  name: string;
  /** Folder inside the library, '/'-separated; '' for the top level. */
  folder: string;
  source: string;
  size: number;
  sha256: string;
  addedAt: number;
  sourceLines: number;
  streamLines: number;
  bounds: Bounds | null;
  cutBounds: Bounds | null;
  estSeconds: number;
  group?: string;
  groupIndex?: number;
}

export interface Macro {
  id: string;
  name: string;
  gcode: string;
}

export interface MachineConfig {
  /** Machine-coordinate travel envelope (from $130-$132 and the homing corner). */
  envelope: Bounds;
  /** Height above work zero to lift to before moving XY to zero, mm. */
  safeZ: number;
  jogSteps: number[];
  jogFeedXY: number;
  jogFeedZ: number;
  rapidRate: number;
  probe: ProbeConfig;
}

export interface ProbeConfig {
  /** Touch plate thickness, mm. 0 means not set yet: probing is refused until it is measured. */
  plateThickness: number;
  /** How far down to search before giving up, mm. */
  maxTravel: number;
  /** First, fast touch, mm/min. */
  seekFeed: number;
  /** Second, slow touch that sets zero, mm/min. */
  latchFeed: number;
  /** Lift above the plate when done, mm. */
  retract: number;
}

export interface LinkState {
  hubConnected: boolean;
  agentConnected: boolean;
  /** Which server this browser is talking to. */
  via: 'hub' | 'agent';
  hubName?: string;
  agentName?: string;
}

export interface ConsoleLine {
  t: number;
  dir: 'in' | 'out' | 'info' | 'error';
  text: string;
  by?: string;
}

export interface AppState {
  link: LinkState;
  machine: MachineState;
  job: JobState;
  library: LibraryItem[];
  /** Every folder in the library, empty ones included, '/'-separated. */
  folders: string[];
  /** Where the library lives on the hub's Mac, for display. */
  libraryRoot?: string;
  macros: Macro[];
  config: MachineConfig;
  console: ConsoleLine[];
  /** Which code the hub and agent are running, and whether either is behind. */
  code?: CodeState;
}

// ---- Code versions and updates ----

/** The code a server is running: the git commit it started from and when that commit was made. */
export interface CodeVersion {
  /** package.json version. */
  version: string;
  /** Full git commit hash, when running from a git checkout. */
  commit?: string;
  /** Commit time (ms since 1970). */
  time?: number;
}

export interface UpdateProgress {
  running: boolean;
  /** What it's doing now, e.g. "Downloading the latest code (git pull)". */
  step?: string;
  error?: string;
}

/** One server's code, and what it can do about updating itself. */
export interface ServerCode extends CodeVersion {
  /** The checkout it runs from, for the manual instructions. */
  repo?: string;
  /** A git checkout that can pull and rebuild itself. */
  canUpdate: boolean;
  /** Started by the Mac app or a double-click launcher, which restart it after an update. */
  supervised: boolean;
  update?: UpdateProgress;
}

export interface CodeState {
  hub?: ServerCode;
  agent?: ServerCode;
  /**
   * The agent runs older code than the hub (or predates version checks). It won't move the machine
   * until it's updated, though a job or group already under way can finish.
   */
  agentBehind: boolean;
  /** The hub runs older code than the agent. Everything still works; update the hub when you can. */
  hubBehind: boolean;
}

export type CodeComparison = 'same' | 'behind' | 'ahead' | 'different' | 'unknown';

/** How `mine` compares with `theirs`, by commit and commit time. */
export function compareCode(mine?: CodeVersion, theirs?: CodeVersion): CodeComparison {
  if (!mine?.commit || !theirs?.commit) return 'unknown';
  if (mine.commit === theirs.commit) return 'same';
  if (mine.time === undefined || theirs.time === undefined) return 'different';
  if (mine.time < theirs.time) return 'behind';
  if (mine.time > theirs.time) return 'ahead';
  return 'different';
}

/**
 * Work out the code state from what each side reports. `agentKnown` is false for an agent
 * that connected without saying which code it runs: it predates version checks, so it's behind.
 */
export function codeState(hub: ServerCode | undefined, agent: ServerCode | undefined, agentConnected: boolean): CodeState {
  const agentBehind = agentConnected && !!hub && (agent ? compareCode(agent, hub) === 'behind' : true);
  const hubBehind = agentConnected && !!agent && !!hub && compareCode(hub, agent) === 'behind';
  return { hub, agent, agentBehind, hubBehind };
}

/** Commands an out-of-date agent refuses once it's idle: anything that moves the machine. */
const MOVES_MACHINE = new Set<Command['type']>(['start', 'startNext', 'jog', 'home', 'goToZero', 'mdi', 'runMacro', 'probeZ']);

/** Why an out-of-date agent won't run this command, or undefined if it may. */
export function outdatedRefusal(cmd: Command, job: JobState, code: CodeState | undefined): string | undefined {
  if (!code?.agentBehind || !MOVES_MACHINE.has(cmd.type)) return undefined;
  // Never strand work in progress: a running job, or a group waiting for its next file, carries on.
  if (['loading', 'running', 'paused', 'stopping', 'toolchange'].includes(job.status)) return undefined;
  return "The machine Mac (agent) is running older code than the hub, so it won't move the machine until it's updated. Use Update now in the banner, or see How to update.";
}

export function shortCommit(c?: CodeVersion): string {
  return c?.commit ? c.commit.slice(0, 7) : 'unknown';
}

export type OverrideKind = 'feed' | 'rapid' | 'spindle';

export type Command =
  // Machine (handled by the agent)
  | { type: 'connect'; port?: string }
  | { type: 'disconnect' }
  | { type: 'home' }
  | { type: 'unlock' }
  | { type: 'reset' }
  | { type: 'hold' }
  | { type: 'resume' }
  | { type: 'jog'; x?: number; y?: number; z?: number; feed: number }
  | { type: 'jogCancel' }
  | { type: 'zero'; axes: ('X' | 'Y' | 'Z')[] }
  | { type: 'goToZero'; axes: ('X' | 'Y' | 'Z')[] }
  | { type: 'mdi'; line: string }
  | { type: 'runMacro'; id: string }
  | {
      type: 'start';
      fileId: string;
      /** Run the rest of the file's group after it. */
      group?: boolean;
      /** Resume from this stream line (0-based): restore the modes, move over the start point and carry on. */
      fromLine?: number;
    }
  | { type: 'spindleStop' }
  | { type: 'startNext' }
  | { type: 'probeZ' }
  | { type: 'stop' }
  | { type: 'override'; kind: OverrideKind; action: 'reset' | 'plus10' | 'minus10' | 'plus1' | 'minus1' | 'r50' | 'r25' }
  | { type: 'refreshSettings' }
  | { type: 'clearJob' }
  // Library (handled by the hub)
  | { type: 'deleteFile'; fileId: string }
  | { type: 'renameFile'; fileId: string; name: string }
  | { type: 'moveFile'; fileId: string; folder: string }
  | { type: 'createFolder'; path: string }
  | { type: 'renameFolder'; path: string; to: string }
  | { type: 'deleteFolder'; path: string }
  | { type: 'saveMacro'; macro: Macro }
  | { type: 'deleteMacro'; id: string }
  | { type: 'saveConfig'; config: Partial<MachineConfig> }
  /** Pull the latest code, rebuild and restart that server. */
  | { type: 'update'; target: 'hub' | 'agent' };

export const LIBRARY_COMMANDS = new Set<Command['type']>([
  'deleteFile',
  'renameFile',
  'moveFile',
  'createFolder',
  'renameFolder',
  'deleteFolder',
  'saveMacro',
  'deleteMacro',
  'saveConfig',
]);

export function isLibraryCommand(cmd: Command): boolean {
  return LIBRARY_COMMANDS.has(cmd.type);
}

// ---- Browser <-> server (hub or agent) ----

export type ServerMessage =
  | { t: 'snapshot'; state: AppState }
  | { t: 'patch'; patch: Partial<Omit<AppState, 'console'>> }
  | { t: 'console'; lines: ConsoleLine[] }
  | { t: 'result'; reqId: string; ok: boolean; error?: string }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

export type ClientMessage = { t: 'hello'; name: string } | { t: 'cmd'; reqId: string; cmd: Command };

// ---- Agent <-> hub ----

export type AgentToHub =
  | { t: 'hello'; name: string; version: string; code?: ServerCode }
  /** The agent's code changed state (an update started, failed or finished). */
  | { t: 'code'; code: ServerCode }
  | { t: 'state'; machine: MachineState; job: JobState }
  /** Whole objects, not partial: a field the agent drops (pins, alarm, probing) must clear on the hub too. */
  | { t: 'patch'; machine?: MachineState; job?: JobState }
  | { t: 'console'; lines: ConsoleLine[] }
  | { t: 'result'; reqId: string; ok: boolean; error?: string }
  | { t: 'cmd'; reqId: string; cmd: Command; by: string }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

export type HubToAgent =
  /** Sent in answer to hello, and again whenever the hub's update state changes. */
  | { t: 'code'; code: ServerCode }
  | { t: 'library'; library: LibraryItem[]; folders: string[]; libraryRoot?: string; macros: Macro[]; config: MachineConfig; hubName: string }
  | { t: 'cmd'; reqId: string; cmd: Command; by: string }
  | { t: 'result'; reqId: string; ok: boolean; error?: string };

export const DEFAULT_CONFIG: MachineConfig = {
  // FoxAlien XE-Pro Ultra (as in Swarf's machine profile): 800 x 800 mm, about 120 mm of Z,
  // homing to the positive corner (GRBL default). Adjust in Settings or read $130-$132.
  envelope: { min: [-800, -800, -120], max: [0, 0, 0] },
  safeZ: 5,
  jogSteps: [0.1, 1, 10, 50],
  jogFeedXY: 3000,
  jogFeedZ: 1000,
  rapidRate: 5000,
  probe: { plateThickness: 0, maxTravel: 25, seekFeed: 150, latchFeed: 25, retract: 5 },
};

export function initialMachine(simulated = false): MachineState {
  return {
    connection: 'disconnected',
    simulated,
    status: 'Unknown',
    mpos: [0, 0, 0],
    wpos: [0, 0, 0],
    wco: [0, 0, 0],
    feed: 0,
    spindle: 0,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
  };
}

export function initialJob(): JobState {
  return { status: 'idle', totalLines: 0, ackedLines: 0, sourceLine: -1, pausedMs: 0 };
}

export const HUB_SERVICE_TYPE = 'gcodehub';
export const DEFAULT_HUB_PORT = 8080;
export const DEFAULT_AGENT_PORT = 8081;
export const PROTOCOL_VERSION = '1';

/** Seconds the job has actually been running (excluding pauses). */
export function jobElapsedSeconds(job: JobState, now = Date.now()): number {
  if (!job.startedAt) return 0;
  const end = job.finishedAt ?? now;
  const paused = job.pausedMs + (job.pausedAt ? end - job.pausedAt : 0);
  return Math.max(0, (end - job.startedAt - paused) / 1000);
}

export function jobPercent(job: JobState): number {
  if (!job.totalLines) return 0;
  if (job.status === 'done') return 100;
  if (job.status === 'toolchange') return 100;
  // By estimated machine time when known: lines say little (GRBL acknowledges queued moves, and
  // one line can take a minute while hundreds of others take a second between them).
  if (job.totalSeconds && job.doneSeconds !== undefined) return Math.min(100, (job.doneSeconds / job.totalSeconds) * 100);
  return Math.min(100, (job.ackedLines / job.totalLines) * 100);
}
