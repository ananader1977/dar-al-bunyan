import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSettings } from './db.js';
import { createApp, createRateLimiter } from './http.js';
import { createAuth, ensureUsers } from './auth.js';
import { createPayments } from './payments.js';
import { createNotifier } from './notify.js';
import { createService } from './service.js';
import { createStorage } from './storage.js';
import { importExpensesReport } from './importer.js';
import { registerRoutes } from './routes.js';
import { createJobs } from './jobs.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Builds all services around one SQLite database. `now` is injectable so tests can control time. */
export function createContext({ config, now = () => Date.now() }) {
  const db = openDb(config.dbPath);
  const ctx = { config, db, now };
  ctx.settings = () => getSettings(db);
  const pending = new Set();
  ctx.background = (p) => {
    const t = Promise.resolve(p).catch((e) => console.error('[background]', e)).finally(() => pending.delete(t));
    pending.add(t);
    return t;
  };
  ctx.flush = async () => { while (pending.size) await Promise.all([...pending]); };
  ctx.limit = createRateLimiter(() => now());
  ctx.storage = createStorage(ctx);
  ctx.payments = createPayments(ctx);
  ctx.notifier = createNotifier(ctx);
  ctx.service = createService(ctx);
  ctx.auth = createAuth(ctx);
  ctx.jobs = createJobs(ctx);
  ctx.createdUsers = ensureUsers(ctx);
  // First start: import the Excel file if it is present and the database has no quotations yet.
  ctx.firstImport = null;
  if (config.importFile && db.prepare('SELECT COUNT(*) n FROM quotations').get().n === 0 && fs.existsSync(config.importFile)) {
    try { ctx.firstImport = importExpensesReport(ctx, fs.readFileSync(config.importFile)); } catch (e) { console.error('[import]', e.message); }
  }
  return ctx;
}

export function createWebApp(ctx) {
  const app = createApp({ publicDir: path.join(here, '..', 'public') });
  app.get('/', (req, res) => res.redirect('/app/'));
  registerRoutes(app, ctx);
  return app;
}
