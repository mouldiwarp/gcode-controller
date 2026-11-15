// The agent's outbound WebSocket to the hub. Reconnects forever with backoff;
// the hub URL comes from --hub or from Bonjour discovery.

import { EventEmitter } from 'node:events';
import { Bonjour } from 'bonjour-service';
import WebSocket from 'ws';
import { HUB_SERVICE_TYPE, randomId, type AgentToHub, type Command, type HubToAgent } from '@gcc/shared';

interface Events {
  open: [];
  close: [];
  message: [HubToAgent];
  url: [string];
}

export class HubLink extends EventEmitter<Events> {
  private ws?: WebSocket;
  private retryTimer?: NodeJS.Timeout;
  private backoff = 1000;
  private stopped = false;
  private bonjour?: Bonjour;
  private pending = new Map<string, (r: { ok: boolean; error?: string }) => void>();
  connected = false;
  url?: string;

  constructor(opts: { url?: string; discover: boolean }) {
    super();
    this.url = opts.url?.replace(/\/$/, '');
    if (!this.url && opts.discover) this.discover();
  }

  get httpUrl(): string | undefined {
    return this.url;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.bonjour?.destroy();
  }

  private discover(): void {
    this.bonjour = new Bonjour();
    this.bonjour.find({ type: HUB_SERVICE_TYPE }, (svc) => {
      const v4 = svc.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
      const host = v4 ?? svc.host;
      const url = `http://${host}:${svc.port}`;
      if (url !== this.url) {
        this.url = url;
        this.emit('url', url);
        if (!this.connected) {
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.backoff = 1000;
          this.connect();
        }
      }
    });
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.url) {
      this.scheduleRetry();
      return;
    }
    const wsUrl = this.url.replace(/^http/, 'ws') + '/agent';
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 4000 });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoff = 1000;
      this.emit('open');
    });
    ws.on('message', (data) => {
      let msg: HubToAgent;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.t === 'result') {
        this.pending.get(msg.reqId)?.(msg);
        this.pending.delete(msg.reqId);
        return;
      }
      this.emit('message', msg);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      for (const [, resolve] of this.pending) resolve({ ok: false, error: 'Lost connection to the hub' });
      this.pending.clear();
      if (was) this.emit('close');
      this.scheduleRetry();
    });
    ws.on('error', () => undefined);
    // Detect half-open connections (Wi-Fi drop without a FIN).
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(ping);
      if (!alive) {
        ws.terminate();
        return clearInterval(ping);
      }
      alive = false;
      ws.ping();
    }, 5000);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.5, 10000);
  }

  send(msg: AgentToHub): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Forward a library command to the hub and wait for its result. */
  request(cmd: Command, by: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.connected) return Promise.resolve({ ok: false, error: 'The hub is offline' });
    const reqId = randomId();
    return new Promise((resolve) => {
      this.pending.set(reqId, resolve);
      this.send({ t: 'cmd', reqId, cmd, by });
      setTimeout(() => {
        if (this.pending.delete(reqId)) resolve({ ok: false, error: 'The hub did not answer' });
      }, 10000);
    });
  }
}
