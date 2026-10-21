import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { OneBotClient } from '../src/client.js';

describe('wire client', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; });
  it('authenticates HTTP actions and checks protocol-level failures', async () => {
    let authorization: string | undefined;
    const server = createServer((req, res) => {
      authorization = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/get_status' ? { retcode: 0, data: { online: true } } : { retcode: 1404, data: null }));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>(r => server.close(() => r())));
    const address = server.address(); if (!address || typeof address === 'string') throw Error();
    const client = new OneBotClient(`http://127.0.0.1:${address.port}/`, 'ws://127.0.0.1:1/', 'http-secret', 'ws-secret');
    expect(await client.api('get_status')).toEqual({ online: true }); expect(authorization).toBe('Bearer http-secret');
    await expect(client.api('missing')).rejects.toThrow('1404');
  });
  it('reconnects after disconnection and delivers events from the new socket', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(r => server.once('listening', r));
    const address = server.address(); if (typeof address === 'string') throw Error();
    cleanup.push(() => new Promise<void>(r => { for (const c of server.clients) c.terminate(); server.close(() => r()); }));
    const client = new OneBotClient('http://127.0.0.1:1/', `ws://127.0.0.1:${address.port}/`, 'a', 'ws-secret');
    cleanup.push(() => client.close());
    let connections = 0;
    server.on('connection', (socket, req) => {
      expect(req.headers.authorization).toBe('Bearer ws-secret');
      if (++connections === 1) socket.close(); else socket.send(JSON.stringify({ post_type: 'meta_event' }));
    });
    const event = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('reconnect timeout')), 5000);
      client.start(data => { clearTimeout(timer); resolve(data); }, () => {});
    });
    expect(event).toEqual({ post_type: 'meta_event' }); expect(connections).toBe(2);
  });
});
