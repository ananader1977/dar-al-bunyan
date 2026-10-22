// Minimal dependency-free HTTP framework: routing, JSON bodies, cookies, static files, rate limiting.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.httpOnly !== false) s += '; HttpOnly';
  s += `; SameSite=${opts.sameSite || 'Strict'}`;
  if (opts.secure) s += '; Secure';
  return s;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp({ publicDir, bodyLimit = 8 * 1024 * 1024, onError } = {}) {
  const routes = [];
  const middleware = [];

  function add(method, pattern, handlers) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '/?$',
    );
    routes.push({ method, re, keys, handlers: handlers.flat() });
  }

  const app = {
    use: (fn) => middleware.push(fn),
    get: (p, ...h) => add('GET', p, h),
    post: (p, ...h) => add('POST', p, h),
    put: (p, ...h) => add('PUT', p, h),
    patch: (p, ...h) => add('PATCH', p, h),
    delete: (p, ...h) => add('DELETE', p, h),
  };

  function decorate(req, res, url) {
    req.url_ = url;
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    req.cookies = parseCookies(req.headers.cookie);
    req.params = {};
    req.ip_ = req.socket.remoteAddress || '';
    req.rawBody = async () => (req._raw ??= await readBody(req, bodyLimit));
    req.json = async () => {
      if (req._json !== undefined) return req._json;
      const buf = await req.rawBody();
      if (buf.length === 0) return (req._json = {});
      try {
        const v = JSON.parse(buf.toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        return (req._json = v);
      } catch {
        throw new HttpError(400, 'Invalid JSON body');
      }
    };
    res.status = (code) => ((res.statusCode = code), res);
    res.json = (obj, code = 200) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    res.send = (body, type = 'text/plain; charset=utf-8', code = 200, headers = {}) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
      res.end(buf);
    };
    res.redirect = (location, code = 302) => {
      res.writeHead(code, { Location: location });
      res.end();
    };
    res.setCookie = (name, value, opts) => {
      const prev = res.getHeader('Set-Cookie');
      const c = serializeCookie(name, value, opts);
      res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
    };
  }

  function serveStatic(req, res) {
    if (!publicDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    let rel = decodeURIComponent(req.path);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(path.resolve(publicDir) + path.sep)) return false;
    let target = file;
    try {
      let st = fs.statSync(target);
      if (st.isDirectory()) {
        target = path.join(target, 'index.html');
        st = fs.statSync(target);
      }
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      const data = fs.readFileSync(target);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
      return true;
    } catch {
      return false;
    }
  }

  app.handle = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      return res.end();
    }
    decorate(req, res, url);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      for (const mw of middleware) await mw(req, res);
      if (res.writableEnded) return;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(req.path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        req.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        for (const h of r.handlers) {
          await h(req, res);
          if (res.writableEnded) return;
        }
        if (!res.writableEnded) res.json({ ok: true });
        return;
      }
      if (req.path.startsWith('/api/')) {
        throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
      }
      if (serveStatic(req, res)) return;
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) (onError || console.error)(err);
      const wantsJson = req.path.startsWith('/api/') || (req.headers.accept || '').includes('json');
      if (wantsJson) {
        res.json({ error: status === 500 ? 'Internal server error' : err.message, ...(err.extra || {}) }, status);
      } else {
        res.send(status === 404 ? 'Page not found' : err.message, 'text/plain; charset=utf-8', status);
      }
    }
  };

  app.server = () => http.createServer((req, res) => app.handle(req, res));
  return app;
}

/** Tiny in-memory sliding-window rate limiter. */
export function createRateLimiter(now = () => Date.now()) {
  const hits = new Map();
  return function limit(key, max, windowMs) {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) throw new HttpError(429, 'Too many requests. Please wait a moment and try again.');
    arr.push(t);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
  };
}
