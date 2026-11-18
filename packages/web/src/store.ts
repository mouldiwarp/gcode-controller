// One WebSocket to whichever server served this page (hub or agent), holding
// the synced AppState. Every component reads from here and sends commands
// through `run`.

import { create } from 'zustand';
import { applyPatch, randomId, type AppState, type Command, type ServerMessage } from '@gcc/shared';

export interface Toast {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
}

interface Store {
  state?: AppState;
  socket: 'connecting' | 'open' | 'closed';
  clientName: string;
  toasts: Toast[];
  /** Library file shown in the visualizer when no job is loaded. */
  previewId?: string;
  /** File waiting for the start confirmation. */
  confirmStartId?: string;
  settingsOpen: boolean;
  probeOpen: boolean;
  managerOpen: boolean;
  surfacingOpen: boolean;
  resumeOpen: boolean;
  /** The start confirmation is for the next file of a group. */
  confirmNext: boolean;
  version: number;
  run: (cmd: Command) => Promise<boolean>;
  setClientName: (name: string) => void;
  toast: (level: Toast['level'], text: string) => void;
  dismiss: (id: string) => void;
  setPreview: (id?: string) => void;
  askStart: (id?: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setProbeOpen: (open: boolean) => void;
  setManagerOpen: (open: boolean) => void;
  setSurfacingOpen: (open: boolean) => void;
  setResumeOpen: (open: boolean) => void;
  askStartNext: (open: boolean) => void;
}

const NAME_KEY = 'gcc.clientName';

function storedName(): string | undefined {
  try {
    return localStorage.getItem(NAME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

let ws: WebSocket | undefined;
const pending = new Map<string, (r: { ok: boolean; error?: string }) => void>();

export const useStore = create<Store>((set, get) => ({
  socket: 'connecting',
  clientName: storedName() ?? '',
  toasts: [],
  settingsOpen: false,
  probeOpen: false,
  managerOpen: false,
  surfacingOpen: false,
  resumeOpen: false,
  confirmNext: false,
  version: 0,

  run: async (cmd) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      get().toast('error', 'Not connected to the server');
      return false;
    }
    const reqId = randomId();
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      pending.set(reqId, resolve);
      ws!.send(JSON.stringify({ t: 'cmd', reqId, cmd }));
      setTimeout(() => {
        if (pending.delete(reqId)) resolve({ ok: false, error: 'No answer from the server' });
      }, 35000);
    });
    if (!result.ok) get().toast('error', result.error ?? 'Command failed');
    return result.ok;
  },

  setClientName: (name) => {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // private mode: keep it for this session only
    }
    set({ clientName: name });
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'hello', name }));
  },

  toast: (level, text) => {
    const id = randomId();
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, text }] }));
    setTimeout(() => get().dismiss(id), level === 'error' ? 9000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setPreview: (id) => set({ previewId: id }),
  askStart: (id) => set({ confirmStartId: id, confirmNext: false }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setProbeOpen: (open) => set({ probeOpen: open }),
  setManagerOpen: (open) => set({ managerOpen: open }),
  setSurfacingOpen: (open) => set({ surfacingOpen: open }),
  setResumeOpen: (open) => set({ resumeOpen: open }),
  askStartNext: (open) => {
    const s = get().state;
    const g = s?.job.group;
    if (!open || !g || s?.job.status !== 'toolchange') return set({ confirmStartId: undefined, confirmNext: false });
    set({ confirmStartId: g.files[g.index + 1]?.id, confirmNext: true });
  },
}));

function onMessage(msg: ServerMessage): void {
  const { state } = useStore.getState();
  switch (msg.t) {
    case 'snapshot': {
      if (reloadForNewCode(msg.state)) return;
      let name = useStore.getState().clientName;
      if (!name) {
        name = msg.state.link.via === 'agent' ? 'Garage' : 'Studio';
        useStore.setState({ clientName: name });
      }
      ws?.send(JSON.stringify({ t: 'hello', name }));
      useStore.setState((s) => ({ state: msg.state, version: s.version + 1 }));
      return;
    }
    case 'patch':
      if (!state) return;
      // Replace the touched top-level slices so React sees new references.
      useStore.setState((s) => ({ state: applyPatch({ ...state } as Omit<AppState, 'console'>, msg.patch) as AppState, version: s.version + 1 }));
      return;
    case 'console':
      if (!state) return;
      useStore.setState({ state: { ...state, console: [...state.console, ...msg.lines].slice(-500) } });
      return;
    case 'result':
      pending.get(msg.reqId)?.(msg);
      pending.delete(msg.reqId);
      return;
    case 'toast':
      useStore.getState().toast(msg.level, msg.text);
      return;
  }
}

let retry = 500;
export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  useStore.setState({ socket: 'connecting' });
  sock.onopen = () => {
    retry = 500;
    useStore.setState({ socket: 'open' });
  };
  sock.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    useStore.setState({ socket: 'closed' });
    for (const [, resolve] of pending) resolve({ ok: false, error: 'Connection lost' });
    pending.clear();
    setTimeout(connect, retry);
    retry = Math.min(retry * 1.6, 5000);
  };
}

/** Commands that move or control the machine are only possible when the agent is reachable. */
export function machineReady(s?: AppState): boolean {
  return !!s && s.link.agentConnected && s.machine.connection === 'connected';
}

/** The next file of a group waiting for a bit change, if any. */
export function nextGroupFile(s?: AppState): { id: string; name: string; index: number; total: number } | undefined {
  const g = s?.job.group;
  if (!g || s?.job.status !== 'toolchange') return undefined;
  const f = g.files[g.index + 1];
  return f && { ...f, index: g.index + 1, total: g.files.length };
}

export function jobActive(s?: AppState): boolean {
  return !!s && ['loading', 'running', 'paused', 'stopping'].includes(s.job.status);
}

/**
 * After an update the server runs newer code than this page. Reload once to pick up the new UI
 * (once per commit, so a checkout with an unbuilt commit can't loop).
 */
function reloadForNewCode(state: AppState): boolean {
  const served = state.code?.[state.link.via]?.commit;
  if (!served || !__GCC_COMMIT__ || served === __GCC_COMMIT__) return false;
  try {
    if (sessionStorage.getItem('gcc.reloadedFor') === served) return false;
    sessionStorage.setItem('gcc.reloadedFor', served);
  } catch {
    return false;
  }
  location.reload();
  return true;
}
