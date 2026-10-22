import crypto from 'node:crypto';
import { HttpError } from './http.js';

const SESSION_COOKIE = 'dab_session';
const SESSION_TTL_MS = 12 * 3600 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function signSession(secret, userId, now) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: now + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

function readSession(secret, token, now) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig, hmac(secret, payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > now ? data : null;
  } catch {
    return null;
  }
}

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Password must be at least 10 characters.');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new HttpError(400, 'Password must contain letters and numbers.');
}

export function createAuth(ctx) {
  const secret = () => ctx.db.prepare("SELECT value FROM settings WHERE key='_secret'").get().value;

  function startSession(res, userId) {
    res.setCookie(SESSION_COOKIE, signSession(secret(), userId, ctx.now()), { maxAge: SESSION_TTL_MS / 1000, secure: ctx.config.secureCookies });
  }
  function endSession(res) {
    res.setCookie(SESSION_COOKIE, '', { maxAge: 0, secure: ctx.config.secureCookies });
  }
  function currentUser(req) {
    const s = readSession(secret(), req.cookies[SESSION_COOKIE], ctx.now());
    if (!s) return null;
    return ctx.db.prepare('SELECT id,email,name,role FROM users WHERE id=? AND active=1').get(s.uid) || null;
  }
  /** Middleware: any signed-in user. Mutating requests also need the CSRF header. */
  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Please sign in.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'dab') throw new HttpError(403, 'Missing CSRF header.');
    req.user = user;
  }
  /** Middleware: administrators only (run after requireUser). */
  function requireAdmin(req) {
    if (!req.user || req.user.role !== 'admin') throw new HttpError(403, 'Only the owner can do this.');
  }
  return { startSession, endSession, currentUser, requireUser, requireAdmin };
}

/**
 * Makes sure the three starting accounts exist. When a *_PASSWORD variable is set, that account's
 * password is (re)set to it on every start, so passwords can be reset from the hosting dashboard.
 * Returns the generated passwords (first start only) so the server can print them once.
 */
export function ensureUsers(ctx) {
  const created = [];
  for (const u of ctx.config.seedUsers) {
    const row = ctx.db.prepare('SELECT id FROM users WHERE email=?').get(u.email);
    if (row) {
      if (u.password) ctx.db.prepare('UPDATE users SET password_hash=?, active=1 WHERE id=?').run(hashPassword(u.password), row.id);
      continue;
    }
    // Only create a seed account if it is the first start or a password was given for it.
    const count = ctx.db.prepare('SELECT COUNT(*) n FROM users').get().n;
    if (count >= 3 && !u.password) continue;
    const password = u.password || crypto.randomBytes(9).toString('base64url') + '7a';
    ctx.db.prepare('INSERT INTO users(email,name,role,password_hash,created_at) VALUES(?,?,?,?,?)').run(u.email, u.name, u.role, hashPassword(password), ctx.now());
    created.push({ email: u.email, role: u.role, password: u.password ? null : password });
  }
  return created;
}
