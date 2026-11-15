// The agent runs on the Mac plugged into the machine. It owns the USB port,
// streams jobs locally, serves the UI to the browser next to the machine, and
// keeps the hub (and through it every other browser) in sync.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_CONFIG,
  isLibraryCommand,
  PROTOCOL_VERSION,
  type AppState,
  type ClientMessage,
  type Command,
  type LibraryItem,
  type MachineConfig,
  type Macro,
  type ServerMessage,
} from '@gcc/shared';
import { readBody, sendJson, serveStatic, sha256, WEB_DIST } from '@gcc/shared/node';
import { GrblController } from './controller.ts';
import { HubLink } from './hubLink.ts';
import { FakeGrbl, type FakeGrblOptions } from './sim/fakeGrbl.ts';
import { autoDetectPort, listPorts, SerialTransport, type Transport } from './transport.ts';

export interface AgentOptions {
  port: number;
  host?: string;
  dataDir: string;
  hubUrl?: string;
  discover: boolean;
  simulate: boolean;
  sim?: FakeGrblOptions;
  serialPath?: string;
  baudRate?: number;
  name?: string;
  webRoot?: string;
  pollMs?: number;
}

interface Client {
  ws: WebSocket;
  name: string;
}

export class Agent {
  readonly controller: GrblController;
  readonly hub: HubLink;
  readonly name: string;
  library: LibraryItem[] = [];
  macros: Macro[] = [];
  config: MachineConfig = DEFAULT_CONFIG;
  hubName?: string;
  sim?: FakeGrbl;

  private server?: Server;
  private wss?: WebSocketServer;
  private clients = new Set<Client>();
  private autoConnect = true;
  private reconnectTimer?: NodeJS.Timeout;
  private connecting = false;
  private readonly cacheDir: string;

  constructor(readonly opts: AgentOptions) {
    this.name = opts.name ?? `${hostname().replace(/\.local$/, '')} (machine)`;
    this.controller = new GrblController({ simulated: opts.simulate, pollMs: opts.pollMs });
    this.hub = new HubLink({ url: opts.hubUrl, discover: opts.discover });
    this.cacheDir = join(opts.dataDir, 'files');
    mkdirSync(this.cacheDir, { recursive: true });
    this.loadCachedLibrary();
    this.wire();
  }

  // ---------------- Lifecycle ----------------

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      this.http(req, res).catch((err) => sendJson(res, 500, { error: (err as Error).message }));
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return socket.destroy();
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onClient(ws));
    });
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, this.opts.host ?? '0.0.0.0', resolve));
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
    this.hub.start();
    void this.tryConnectMachine();
    return port;
  }

  async stop(): Promise<void> {
    this.autoConnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.hub.stop();
    await this.controller.disconnect();
    for (const c of this.clients) c.ws.terminate();
    this.wss?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async tryConnectMachine(port?: string): Promise<void> {
    if (this.connecting || this.controller.machine.connection !== 'disconnected') return;
    this.connecting = true;
    try {
      let transport: Transport;
      if (this.opts.simulate) {
        this.sim = new FakeGrbl({ speed: 1, ...this.opts.sim });
        transport = this.sim;
      } else {
        const path = port ?? this.opts.serialPath ?? (await autoDetectPort());
        if (!path) throw new Error('No USB GRBL controller found');
        transport = new SerialTransport(path, this.opts.baudRate ?? 115200);
      }
      await this.controller.connect(transport);
    } catch {
      // Logged by the controller; retried below.
    } finally {
      this.connecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.autoConnect && this.controller.machine.connection === 'disconnected') void this.tryConnectMachine();
      else this.scheduleReconnect();
    }, 3000);
  }

  // ---------------- State ----------------

  snapshot(): AppState {
    return {
      link: {
        hubConnected: this.hub.connected,
        agentConnected: true,
        via: 'agent',
        hubName: this.hubName,
        agentName: this.name,
      },
      machine: this.controller.machine,
      job: this.controller.job,
      library: this.library,
      macros: this.macros,
      config: this.config,
      console: this.controller.console,
    };
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(data);
  }

  private wire(): void {
    const c = this.controller;
    c.on('machine', (machine) => {
      this.broadcast({ t: 'patch', patch: { machine } });
      this.hub.send({ t: 'patch', machine });
    });
    c.on('job', (job) => {
      this.broadcast({ t: 'patch', patch: { job } });
      this.hub.send({ t: 'patch', job });
    });
    c.on('console', (lines) => {
      this.broadcast({ t: 'console', lines });
      this.hub.send({ t: 'console', lines });
    });
    c.on('toast', (toast) => {
      this.broadcast({ t: 'toast', ...toast });
      this.hub.send({ t: 'toast', ...toast });
    });

    this.hub.on('open', () => {
      this.hub.send({ t: 'hello', name: this.name, version: PROTOCOL_VERSION });
      this.hub.send({ t: 'state', machine: c.machine, job: c.job });
      this.hub.send({ t: 'console', lines: c.console.slice(-200) });
      this.controller.log('info', `Connected to hub at ${this.hub.url}`);
      this.broadcastLink();
    });
    this.hub.on('close', () => {
      this.controller.log('error', 'Lost connection to the hub (the job keeps running here)');
      this.broadcastLink();
    });
    this.hub.on('message', (msg) => {
      if (msg.t === 'library') {
        this.library = msg.library;
        this.macros = msg.macros;
        this.config = msg.config;
        this.hubName = msg.hubName;
        this.controller.macros = msg.macros;
        this.controller.config = msg.config;
        this.saveCachedLibrary();
        this.broadcast({ t: 'patch', patch: { library: this.library, macros: this.macros, config: this.config } });
        this.broadcastLink();
      } else if (msg.t === 'cmd') {
        void this.execute(msg.cmd, msg.by).then((r) => this.hub.send({ t: 'result', reqId: msg.reqId, ...r }));
      }
    });
  }

  private broadcastLink(): void {
    this.broadcast({ t: 'patch', patch: { link: this.snapshot().link } });
  }

  private loadCachedLibrary(): void {
    const file = join(this.opts.dataDir, 'library.json');
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      this.library = data.library ?? [];
      this.macros = data.macros ?? [];
      this.config = { ...DEFAULT_CONFIG, ...(data.config ?? {}) };
      this.hubName = data.hubName;
      this.controller.macros = this.macros;
      this.controller.config = this.config;
    } catch {
      // ignore a corrupt cache
    }
  }

  private saveCachedLibrary(): void {
    const file = join(this.opts.dataDir, 'library.json');
    writeFileSync(file, JSON.stringify({ library: this.library, macros: this.macros, config: this.config, hubName: this.hubName }));
  }

  // ---------------- Commands ----------------

  async execute(cmd: Command, by: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (isLibraryCommand(cmd)) return await this.hub.request(cmd, by);
      switch (cmd.type) {
        case 'start':
          await this.startJob(cmd.fileId, by);
          break;
        case 'connect':
          this.autoConnect = true;
          if (this.controller.machine.connection !== 'disconnected') await this.controller.disconnect();
          await this.tryConnectMachine(cmd.port);
          if (this.controller.machine.connection === 'disconnected') throw new Error('Could not connect to the machine');
          break;
        case 'disconnect':
          if (this.controller.isJobActive) throw new Error("Can't disconnect while a job is running");
          this.autoConnect = false;
          await this.controller.disconnect();
          break;
        default:
          await this.controller.command(cmd, by);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async startJob(fileId: string, by: string): Promise<void> {
    this.controller.checkCanStart();
    const item = this.library.find((f) => f.id === fileId);
    if (!item) throw new Error('That file is not in the library');
    this.controller.markLoading(item.id, item.name, by);
    let text: string;
    try {
      text = await this.fileContent(item);
    } catch (err) {
      this.controller.cancelLoading((err as Error).message);
      throw err;
    }
    // The machine could have changed state while the file downloaded.
    this.controller.job.status = 'idle';
    try {
      this.controller.checkCanStart();
    } catch (err) {
      this.controller.cancelLoading((err as Error).message);
      throw err;
    }
    this.controller.startJob(text, { fileId: item.id, fileName: item.name, by, estSeconds: item.estSeconds });
  }

  /** Read a file from the local cache, or download it from the hub and verify it. */
  async fileContent(item: LibraryItem): Promise<string> {
    const cached = join(this.cacheDir, `${item.sha256}.nc`);
    if (existsSync(cached)) return readFileSync(cached, 'utf8');
    if (!this.hub.connected || !this.hub.httpUrl) throw new Error('The hub is offline and this file is not cached here');
    const res = await fetch(`${this.hub.httpUrl}/api/files/${encodeURIComponent(item.id)}/content`);
    if (!res.ok) throw new Error(`The hub could not send the file (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== item.sha256) throw new Error('The file was corrupted in transfer (checksum mismatch)');
    writeFileSync(cached, buf);
    return buf.toString('utf8');
  }

  // ---------------- Browsers ----------------

  private onClient(ws: WebSocket): void {
    const client: Client = { ws, name: 'Machine browser' };
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
        ws.send(JSON.stringify({ t: 'result', reqId: msg.reqId, ...r } satisfies ServerMessage));
      }
    });
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => undefined);
  }

  // ---------------- HTTP ----------------

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;

    if (path === '/api/agent/state') return sendJson(res, 200, this.snapshot());
    if (path === '/api/agent/ports') return sendJson(res, 200, await listPorts().catch(() => []));
    if (path === '/api/health') {
      return sendJson(res, 200, { ok: true, role: 'agent', name: this.name, hub: this.hub.connected, machine: this.controller.machine.connection });
    }

    const content = /^\/api\/files\/([^/]+)\/content$/.exec(path);
    if (content && req.method === 'GET') {
      const item = this.library.find((f) => f.id === decodeURIComponent(content[1]));
      if (item) {
        try {
          const text = await this.fileContent(item);
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(text);
          return;
        } catch (err) {
          return sendJson(res, 503, { error: (err as Error).message });
        }
      }
    }

    if (path.startsWith('/api/')) return this.proxyToHub(req, res, url);
    serveStatic(req, res, this.opts.webRoot ?? WEB_DIST);
  }

  /** Uploads, deletes and the like go to the hub, which owns the library. */
  private async proxyToHub(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.hub.connected || !this.hub.httpUrl) return sendJson(res, 503, { error: 'The hub is offline' });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && (k.startsWith('x-') || k === 'content-type')) headers[k] = v;
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    const upstream = await fetch(`${this.hub.httpUrl}${url.pathname}${url.search}`, { method: req.method, headers, body });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
    res.end(buf);
  }
}
