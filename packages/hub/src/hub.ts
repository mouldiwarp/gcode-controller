// The hub runs on the design Mac. It owns the file library and macros, accepts
// G-code from apps and uploads, serves the UI, and mirrors the agent's machine
// and job state to every browser.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { Bonjour, type Service } from 'bonjour-service';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_HUB_PORT,
  HUB_SERVICE_TYPE,
  initialJob,
  initialMachine,
  isLibraryCommand,
  PROTOCOL_VERSION,
  randomId,
  type AgentToHub,
  type AppState,
  type ClientMessage,
  type Command,
  type ConsoleLine,
  type HubToAgent,
  type JobState,
  type MachineState,
  type ServerMessage,
} from '@gcc/shared';
import { readBody, sendJson, serveStatic, WEB_DIST } from '@gcc/shared/node';
import { InboxWatcher } from './inbox.ts';
import { LibraryStore } from './library.ts';

export interface HubOptions {
  port?: number;
  host?: string;
  dataDir: string;
  inboxDir?: string;
  advertise?: boolean;
  name?: string;
  webRoot?: string;
}

interface Client {
  ws: WebSocket;
  name: string;
}

const CONSOLE_MAX = 500;

export class Hub {
  readonly library: LibraryStore;
  readonly name: string;
  machine: MachineState = initialMachine();
  job: JobState = initialJob();
  console: ConsoleLine[] = [];
  agentName?: string;

  private server?: Server;
  private wss?: WebSocketServer;
  private agentWss?: WebSocketServer;
  private clients = new Set<Client>();
  private agent?: WebSocket;
  private pending = new Map<string, (r: { ok: boolean; error?: string }) => void>();
  private bonjour?: Bonjour;
  private service?: Service;
  private inbox?: InboxWatcher;
  port = 0;

  constructor(readonly opts: HubOptions) {
    this.library = new LibraryStore(opts.dataDir);
    this.name = opts.name ?? hostname().replace(/\.local$/, '');
  }

  // ---------------- Lifecycle ----------------

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      this.http(req, res).catch((err) => sendJson(res, 500, { error: (err as Error).message }));
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.agentWss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
    this.server.on('upgrade', (req, socket, head) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/ws') this.wss!.handleUpgrade(req, socket, head, (ws) => this.onClient(ws));
      else if (path === '/agent') this.agentWss!.handleUpgrade(req, socket, head, (ws) => this.onAgent(ws));
      else socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port ?? DEFAULT_HUB_PORT, this.opts.host ?? '0.0.0.0', resolve);
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;

    if (this.opts.advertise !== false) {
      this.bonjour = new Bonjour();
      this.service = this.bonjour.publish({
        name: `GCode Hub on ${this.name}`,
        type: HUB_SERVICE_TYPE,
        port: this.port,
        txt: { version: PROTOCOL_VERSION },
      });
    }
    if (this.opts.inboxDir) {
      this.inbox = new InboxWatcher(
        this.opts.inboxDir,
        (name, content) => {
          this.library.add(content, { name, source: 'Inbox' });
          this.libraryChanged();
          this.toast('info', `Imported ${name} from the inbox`);
        },
        (name, err) => this.toast('error', `Could not import ${name}: ${err.message}`),
      );
      this.inbox.start();
    }
    return this.port;
  }

  async stop(): Promise<void> {
    this.inbox?.stop();
    if (this.service) await new Promise<void>((r) => this.service!.stop?.(() => r()) ?? r());
    this.bonjour?.destroy();
    this.agent?.terminate();
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
    this.agentWss?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // ---------------- State ----------------

  get agentConnected(): boolean {
    return this.agent?.readyState === 1;
  }

  snapshot(): AppState {
    return {
      link: { hubConnected: true, agentConnected: this.agentConnected, via: 'hub', hubName: this.name, agentName: this.agentName },
      machine: this.machine,
      job: this.job,
      library: this.library.items,
      macros: this.library.macros,
      config: this.library.config,
      console: this.console,
    };
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(data);
  }

  private toast(level: 'info' | 'warn' | 'error', text: string): void {
    this.broadcast({ t: 'toast', level, text });
  }

  private sendAgent(msg: HubToAgent): void {
    if (this.agent?.readyState === 1) this.agent.send(JSON.stringify(msg));
  }

  private libraryChanged(): void {
    const s = this.snapshot();
    this.broadcast({ t: 'patch', patch: { library: s.library, macros: s.macros, config: s.config } });
    this.sendAgent({ t: 'library', library: s.library, macros: s.macros, config: s.config, hubName: this.name });
  }

  private addConsole(incoming: ConsoleLine[]): void {
    const recent = new Set(this.console.slice(-300).map((l) => `${l.t}|${l.dir}|${l.text}`));
    const lines = incoming.filter((l) => !recent.has(`${l.t}|${l.dir}|${l.text}`));
    if (!lines.length) return;
    this.console.push(...lines);
    if (this.console.length > CONSOLE_MAX) this.console.splice(0, this.console.length - CONSOLE_MAX);
    this.broadcast({ t: 'console', lines });
  }

  // ---------------- Agent link ----------------

  private onAgent(ws: WebSocket): void {
    if (this.agent && this.agent !== ws) this.agent.terminate();
    this.agent = ws;
    const s = this.snapshot();
    this.sendAgent({ t: 'library', library: s.library, macros: s.macros, config: s.config, hubName: this.name });

    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 5000);

    ws.on('message', (data) => {
      let msg: AgentToHub;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.onAgentMessage(msg);
    });
    ws.on('close', () => {
      clearInterval(ping);
      if (this.agent !== ws) return;
      this.agent = undefined;
      for (const [, resolve] of this.pending) resolve({ ok: false, error: 'Lost connection to the machine agent' });
      this.pending.clear();
      this.machine = { ...this.machine, connection: 'disconnected' };
      this.broadcast({ t: 'patch', patch: { link: this.snapshot().link, machine: this.machine } });
    });
    ws.on('error', () => undefined);
  }

  private onAgentMessage(msg: AgentToHub): void {
    switch (msg.t) {
      case 'hello':
        this.agentName = msg.name;
        this.console = [];
        this.broadcast({ t: 'patch', patch: { link: this.snapshot().link } });
        return;
      case 'state':
        this.machine = msg.machine;
        this.job = msg.job;
        this.broadcast({ t: 'patch', patch: { machine: this.machine, job: this.job, link: this.snapshot().link } });
        return;
      case 'patch':
        if (msg.machine) this.machine = { ...this.machine, ...msg.machine };
        if (msg.job) this.job = msg.job as JobState;
        this.broadcast({ t: 'patch', patch: { ...(msg.machine ? { machine: this.machine } : {}), ...(msg.job ? { job: this.job } : {}) } });
        return;
      case 'console':
        this.addConsole(msg.lines);
        return;
      case 'toast':
        this.toast(msg.level, msg.text);
        return;
      case 'result':
        this.pending.get(msg.reqId)?.({ ok: msg.ok, error: msg.error });
        this.pending.delete(msg.reqId);
        return;
      case 'cmd':
        // Library commands from the browser next to the machine.
        void this.execute(msg.cmd, msg.by).then((r) => this.sendAgent({ t: 'result', reqId: msg.reqId, ...r }));
        return;
    }
  }

  // ---------------- Commands ----------------

  async execute(cmd: Command, by: string): Promise<{ ok: boolean; error?: string }> {
    if (!isLibraryCommand(cmd)) return this.forwardToAgent(cmd, by);
    try {
      switch (cmd.type) {
        case 'deleteFile':
          if (this.job.fileId === cmd.fileId && ['loading', 'running', 'paused', 'stopping'].includes(this.job.status)) {
            throw new Error("Can't delete the file that is running");
          }
          this.library.delete(cmd.fileId);
          break;
        case 'saveMacro':
          this.library.saveMacro(cmd.macro);
          break;
        case 'deleteMacro':
          this.library.deleteMacro(cmd.id);
          break;
        case 'saveConfig':
          this.library.saveConfig(cmd.config);
          break;
      }
      this.libraryChanged();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private forwardToAgent(cmd: Command, by: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.agentConnected) return Promise.resolve({ ok: false, error: 'The machine agent is offline' });
    const reqId = randomId();
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.sendAgent({ t: 'cmd', reqId, cmd, by });
      // Starting a job can include a file download, so allow time.
      setTimeout(() => {
        if (this.pending.delete(reqId)) resolve({ ok: false, error: 'The machine agent did not answer' });
      }, 30000);
    });
  }

  // ---------------- Browsers ----------------

  private onClient(ws: WebSocket): void {
    const client: Client = { ws, name: 'Browser' };
    this.clients.add(client);
    ws.send(JSON.stringify({ t: 'snapshot', state: this.snapshot() } satisfies ServerMessage));
    ws.on('message', async (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        client.name = msg.name.slice(0, 40) || client.name;
      } else if (msg.t === 'cmd') {
        const r = await this.execute(msg.cmd, client.name);
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'result', reqId: msg.reqId, ...r } satisfies ServerMessage));
      }
    });
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => undefined);
  }

  // ---------------- HTTP ----------------

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,x-filename,x-source,x-group,x-group-index',
      });
      res.end();
      return;
    }

    if (path === '/api/health') {
      return sendJson(res, 200, { ok: true, role: 'hub', name: this.name, version: PROTOCOL_VERSION, agent: this.agentConnected });
    }
    if (path === '/api/state' && req.method === 'GET') return sendJson(res, 200, this.snapshot());
    if (path === '/api/library' && req.method === 'GET') return sendJson(res, 200, this.library.items);

    if ((path === '/api/jobs' || path === '/api/files') && req.method === 'POST') {
      const body = await readBody(req);
      const header = (k: string) => {
        const v = req.headers[k];
        if (typeof v !== 'string') return undefined;
        try {
          return decodeURIComponent(v);
        } catch {
          return v;
        }
      };
      try {
        const item = this.library.add(body, {
          name: header('x-filename') ?? url.searchParams.get('name') ?? '',
          source: header('x-source') ?? url.searchParams.get('source') ?? 'Upload',
          group: header('x-group') ?? url.searchParams.get('group') ?? undefined,
          groupIndex: Number(header('x-group-index') ?? url.searchParams.get('groupIndex')) || undefined,
        });
        this.libraryChanged();
        this.toast('info', `Received ${item.name}${item.source !== 'Upload' ? ` from ${item.source}` : ''}`);
        return sendJson(res, 201, { id: item.id, item });
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
    }

    const fileMatch = /^\/api\/files\/([^/]+)(\/content)?$/.exec(path);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]);
      if (req.method === 'GET' && fileMatch[2]) {
        const content = this.library.content(id);
        if (!content) return sendJson(res, 404, { error: 'File not found' });
        const item = this.library.get(id)!;
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `inline; filename="${item.name.replace(/"/g, '')}"`,
          'access-control-allow-origin': '*',
        });
        res.end(content);
        return;
      }
      if (req.method === 'GET') {
        const item = this.library.get(id);
        return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: 'File not found' });
      }
      if (req.method === 'DELETE') {
        const r = await this.execute({ type: 'deleteFile', fileId: id }, 'API');
        return sendJson(res, r.ok ? 200 : 400, r);
      }
    }

    if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    serveStatic(req, res, this.opts.webRoot ?? WEB_DIST);
  }
}
