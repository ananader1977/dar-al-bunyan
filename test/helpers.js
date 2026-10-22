import { loadConfig } from '../src/config.js';
import { createContext, createWebApp } from '../src/app.js';

// Fixed clock: 18 Oct 2026, 10:00 Dubai time.
export const START = Date.UTC(2026, 9, 18, 6, 0, 0);
export const PW = { admin: 'AdminPass12345', admin2: 'AdminPass67890', ops: 'OpsPass123456' };

export async function startTestApp(overrides = {}) {
  let t = START;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const base = loadConfig({ ADMIN1_EMAIL: 'admin@test.local', ADMIN1_PASSWORD: PW.admin, ADMIN2_EMAIL: 'admin2@test.local', ADMIN2_PASSWORD: PW.admin2, OPS_EMAIL: 'ops@test.local', OPS_PASSWORD: PW.ops, OPS_NAME: 'Ops User' });
  const config = { ...base, dbPath: ':memory:', importFile: '', paymentProvider: 'mock', disableRateLimit: true, uploadDir: `/tmp/dab-test-uploads-${process.pid}`, ...overrides };
  const ctx = createContext({ config, now: clock.now });
  const server = createWebApp(ctx).server();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = url;
  const jars = {};
  async function login(who) {
    const email = { admin: 'admin@test.local', admin2: 'admin2@test.local', ops: 'ops@test.local' }[who];
    const res = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW[who] }) });
    if (res.status === 200) jars[who] = res.headers.get('set-cookie').split(';')[0];
    return res;
  }
  /** call('ops', 'POST', '/api/app/quotations', body) */
  async function call(who, method, path, body, { csrf = true, raw = false } = {}) {
    const h = {};
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (who && jars[who]) h.Cookie = jars[who];
    if (csrf) h['X-Requested-With'] = 'dab';
    const res = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    if (raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }
  const quote = (extra = {}) => ({
    client: { name: 'Acme Towers', contact: 'Mr. Ali', email: 'ali@acme.example', phone: '+971501234567' },
    subject: 'Pump overhaul', site: 'Tower A',
    lines: [{ description: 'Pump overhauling 18.5 KW', qty: 2, unit: 'Each', unit_price: 2500, unit_cost: 1000 }, { description: 'Mechanical seal', qty: 1, unit: 'Each', unit_price: 500, unit_cost: 200 }],
    discount_pct: 10, ...extra,
  });
  const close = async () => { await ctx.flush(); await new Promise((r) => server.close(r)); };
  return { ctx, clock, url, login, call, quote, close };
}
