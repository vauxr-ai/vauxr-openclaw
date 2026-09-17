import http from "node:http";
import https from "node:https";

export class VauxrError extends Error {
  constructor(public readonly code: string, public readonly status = 0) {
    super(`Vauxr: ${code}`);
    this.name = "VauxrError";
  }
}

/** Origins are configuration, never credential containers or redirect targets. */
export function validateOrigin(input: string, strictTls = false): string {
  try {
    const u = new URL(input);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password ||
        u.search || u.hash || u.pathname !== '/' || (strictTls && u.protocol !== 'https:')) throw 0;
    return u.origin;
  } catch { throw new VauxrError('invalid_server_origin'); }
}

export function endpoints(config: { url: string; httpUrl?: string; strictTls?: boolean }) {
  const socketOrigin = validateOrigin(config.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), config.strictTls);
  const socket = new URL(socketOrigin);
  const derived = new URL(socketOrigin);
  if (derived.port === '8765') derived.port = '8080';
  const origin = validateOrigin(config.httpUrl ?? derived.origin, config.strictTls);
  if (new URL(origin).protocol !== socket.protocol || new URL(origin).hostname !== socket.hostname)
    throw new VauxrError('mixed_server_transport');
  socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
  socket.pathname = '/agent';
  return { origin, wsUrl: socket.href };
}

/** Native transport: no cookies, redirects, URL credentials, TLS bypass or raw errors. */
export async function requestJson<T = Record<string, unknown>>(
  baseUrl: string, path: string, body?: unknown, token?: string, method = 'POST',
): Promise<T> {
  const origin = validateOrigin(baseUrl);
  if (!/^\/api\/[a-zA-Z0-9_/%.-]+$/.test(path) || path.includes('..')) throw new VauxrError('invalid_path');
  return new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const url = new URL(path, origin);
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method, rejectUnauthorized: true,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, res => {
      let data = ''; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1_048_576) { req.destroy(); reject(new VauxrError('response_too_large')); }
        else data += chunk.toString();
      });
      res.on('error', () => reject(new VauxrError('connection_interrupted')));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const code = status === 401 ? 're_pair_required' : status === 403 ? 'operation_denied' :
            status === 429 ? 'rate_limited' : status >= 300 && status < 400 ? 'redirect_refused' : `http_${status}`;
          reject(new VauxrError(code, status)); return;
        }
        try { resolve((data ? JSON.parse(data) : undefined) as T); }
        catch { reject(new VauxrError('invalid_response')); }
      });
    });
    const deadline = setTimeout(() => req.destroy(), 10_000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', () => reject(new VauxrError('connection_interrupted')));
    req.end(payload);
  });
}
