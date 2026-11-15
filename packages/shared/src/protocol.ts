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
  feed: number;
  spindle: number;
  overrides: { feed: number; rapid: number; spindle: number };
  buffer?: { planner: number; rx: number };
  pins?: string;
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
}

export interface LibraryItem {
  id: string;
  name: string;
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
  macros: Macro[];
  config: MachineConfig;
  console: ConsoleLine[];
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
  | { type: 'start'; fileId: string; /** Run the rest of the file's group after it. */ group?: boolean }
  | { type: 'startNext' }
  | { type: 'probeZ' }
  | { type: 'stop' }
  | { type: 'override'; kind: OverrideKind; action: 'reset' | 'plus10' | 'minus10' | 'plus1' | 'minus1' | 'r50' | 'r25' }
  | { type: 'refreshSettings' }
  | { type: 'clearJob' }
  // Library (handled by the hub)
  | { type: 'deleteFile'; fileId: string }
  | { type: 'saveMacro'; macro: Macro }
  | { type: 'deleteMacro'; id: string }
  | { type: 'saveConfig'; config: Partial<MachineConfig> };

export const LIBRARY_COMMANDS = new Set<Command['type']>(['deleteFile', 'saveMacro', 'deleteMacro', 'saveConfig']);

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
  | { t: 'hello'; name: string; version: string }
  | { t: 'state'; machine: MachineState; job: JobState }
  | { t: 'patch'; machine?: Partial<MachineState>; job?: Partial<JobState> }
  | { t: 'console'; lines: ConsoleLine[] }
  | { t: 'result'; reqId: string; ok: boolean; error?: string }
  | { t: 'cmd'; reqId: string; cmd: Command; by: string }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

export type HubToAgent =
  | { t: 'library'; library: LibraryItem[]; macros: Macro[]; config: MachineConfig; hubName: string }
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
  return Math.min(100, (job.ackedLines / job.totalLines) * 100);
}
