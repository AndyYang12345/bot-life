import WebSocket from 'ws';
import type { Api } from './types.js';
export class OneBotRejected extends Error {}

export class OneBotClient {
  private socket?: WebSocket;
  private retry?: NodeJS.Timeout;
  private closed = false;
  private failures = 0;
  constructor(private httpUrl: string, private wsUrl: string, private httpToken: string, private wsToken: string) {
    for (const input of [httpUrl, wsUrl]) {
      const url = new URL(input);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search) {
        throw new Error('OneBot endpoints must be local and must not contain credentials.');
      }
    }
    if (!httpToken || !wsToken) throw new Error('OneBot authentication is required.');
  }
  api: Api = async <T>(action: string, args = {}): Promise<T> => {
    const response = await fetch(new URL(action, this.httpUrl.endsWith('/') ? this.httpUrl : this.httpUrl + '/'), {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.httpToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`OneBot HTTP error ${response.status}`);
    const body = await response.json() as { retcode: number; data: T };
    if (body.retcode !== 0) throw new OneBotRejected(`OneBot ${action} rejected (${body.retcode})`);
    return body.data;
  };
  start(onEvent: (event: unknown) => void, onState: (state: string) => void): void {
    const connect = () => {
      if (this.closed) return;
      const socket = new WebSocket(this.wsUrl, { headers: { Authorization: 'Bearer ' + this.wsToken }, maxPayload: 8 * 1024 * 1024 });
      this.socket = socket;
      let alive = true;
      const ping = setInterval(() => { if (!alive) socket.terminate(); else { alive = false; socket.ping(); } }, 30000);
      socket.on('pong', () => { alive = true; });
      socket.on('open', () => { this.failures = 0; onState('connected'); });
      socket.on('message', raw => {
        try { onEvent(JSON.parse(raw.toString())); } catch { onState('invalid-event'); }
      });
      socket.on('error', () => { onState('connection-error'); });
      socket.on('close', () => {
        clearInterval(ping);
        onState('disconnected');
        if (!this.closed) this.retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5)));
      });
    };
    connect();
  }
  close(): void { this.closed = true; clearTimeout(this.retry); this.socket?.close(); }
}
