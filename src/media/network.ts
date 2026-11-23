import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Outcome } from '../common.js';

export class Network {
  constructor(
    readonly origins: ReadonlySet<string>,
    readonly signal: AbortSignal,
    readonly headers: (url: string) => Promise<Record<string, string>> = async () => ({}),
  ) {}
  check(raw: string) {
    const u = new URL(raw);
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      !this.origins.has(u.origin)
    )
      throw new Outcome('DESTINATION_DENIED');
    return u;
  }
  async get(
    raw: string,
    headers: Record<string, string> = {},
  ): Promise<{ body: http.IncomingMessage; url: string }> {
    let u = this.check(raw);
    for (let hop = 0; hop < 6; hop++) {
      const transport = u.protocol === 'https:' ? https : http;
      const options = {
        headers: { ...(await this.headers(u.href)), ...headers },
        signal: this.signal,
        timeout: 30000,
      };
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = transport.get(u, options, resolve);
        req.on('timeout', () => req.destroy(new Error('UPSTREAM_TIMEOUT'))).on('error', reject);
      });
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
        res.destroy();
        u = this.check(new URL(res.headers.location, u).href);
        continue;
      }
      if (res.statusCode !== 200 && !(headers.Range && res.statusCode === 206)) {
        res.destroy();
        if ([401, 403, 451].includes(res.statusCode ?? 0)) throw new Outcome('UNSUPPORTED_PLAYBACK');
        throw new Outcome(
          'MEDIA_UNAVAILABLE',
          {},
          (res.statusCode ?? 0) >= 500 || [408, 429].includes(res.statusCode ?? 0),
        );
      }
      return { body: res, url: u.href };
    }
    throw new Outcome('REDIRECT_LIMIT');
  }
  async text(url: string, max = 8 * 1024 * 1024) {
    const response = await this.get(url);
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const p of response.body) {
      bytes += p.length;
      if (bytes > max) throw new Outcome('RESOURCE_TOO_LARGE');
      parts.push(p);
    }
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
      url: response.url,
    };
  }
}
// Chromium sends each HTTP request or HTTPS CONNECT through this per-attempt
// proxy, including redirect hops which Playwright request routing can miss.
export async function browserProxy(origins: ReadonlySet<string>) {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let u: URL;
    try {
      u = new URL(req.url!);
      if (u.protocol !== 'http:' || !origins.has(u.origin) || u.username || u.password)
        throw new Error();
    } catch {
      res.writeHead(403).end();
      return;
    }
    const upstream = http.request(
      u,
      { method: req.method, headers: { ...req.headers, host: u.host } },
      (r) => {
        res.writeHead(r.statusCode!, r.headers);
        r.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connect', (req, client, head) => {
    let u: URL;
    try {
      u = new URL('https://' + req.url);
      if (!origins.has(u.origin) || u.username || u.password || u.host !== req.url?.replace(/:443$/, ''))
        throw new Error();
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(Number(u.port || 443), u.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    close() {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
