// Background jobs: daily backup of the database, Trash clean-up and the Monday reminder email.
import fs from 'node:fs';
import path from 'node:path';
import { dateKey, parts } from './time.js';

const KEEP_LOCAL = 14; // daily copies kept on the server disk
const KEEP_DRIVE = 30; // daily copies kept in Google Drive

export function createJobs(ctx) {
  const { db, config } = ctx;
  const getFlag = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value || '';
  const setFlag = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const backupDir = config.backupDir || path.join(path.dirname(path.resolve(config.dbPath === ':memory:' ? (config.uploadDir || './data/uploads') : config.dbPath)), 'backups');

  /** Copies the whole database (VACUUM INTO gives a clean, consistent file) to the disk and, when connected, to Google Drive. */
  async function backup(user = null) {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date(ctx.now() + 4 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
    const name = `dar-al-bunyan-backup-${stamp}.sqlite`;
    const file = path.join(backupDir, name);
    fs.rmSync(file, { force: true });
    db.prepare('VACUUM INTO ?').run(file);
    const buf = fs.readFileSync(file);
    let row = { storage: 'local', drive_id: null, link: '', local_path: name, status: 'ok', error: null };
    if (ctx.storage.kind === 'drive') {
      try {
        const up = await ctx.storage.save(name, 'application/vnd.sqlite3', buf);
        row = { ...row, storage: 'drive', drive_id: up.drive_id, link: up.link };
      } catch (e) {
        row = { ...row, status: 'disk only', error: `Google Drive upload failed: ${e.message}` };
      }
    }
    const id = Number(db.prepare('INSERT INTO backups(ts,name,size,storage,drive_id,link,local_path,status,error) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(ctx.now(), name, buf.length, row.storage, row.drive_id, row.link, row.local_path, row.status, row.error).lastInsertRowid);
    setFlag('_last_backup_day', dateKey(ctx.now()));
    ctx.service.audit(user, 'backup made', 'backup', id, `${name} (${Math.round(buf.length / 1024)} KB, ${row.storage === 'drive' ? 'Google Drive + server' : 'server only'})${row.error ? ' - ' + row.error : ''}`);
    // keep the newest copies only
    const all = db.prepare('SELECT * FROM backups ORDER BY ts DESC').all();
    all.slice(KEEP_LOCAL).forEach((b) => { if (b.local_path) { fs.rmSync(path.join(backupDir, path.basename(b.local_path)), { force: true }); db.prepare('UPDATE backups SET local_path=NULL WHERE id=?').run(b.id); } });
    for (const b of all.slice(KEEP_DRIVE)) {
      if (b.drive_id) await ctx.storage.remove({ storage: 'drive', drive_id: b.drive_id });
      db.prepare('DELETE FROM backups WHERE id=?').run(b.id);
    }
    return db.prepare('SELECT * FROM backups WHERE id=?').get(id);
  }
  const listBackups = () => db.prepare('SELECT * FROM backups ORDER BY ts DESC LIMIT 40').all();
  const backupFile = (b) => (b.local_path ? path.join(backupDir, path.basename(b.local_path)) : null);

  /** What is waiting for someone to act (used by the Monday email). */
  function weeklySummary() {
    const today = dateKey(ctx.now());
    const svc = ctx.service;
    const pendingQuotes = svc.listQuotes({ status: 'pending' });
    const pendingExpenses = svc.listExpenses({ status: 'pending' });
    const awaiting = db.prepare("SELECT q.*, c.name client_name FROM quotations q JOIN clients c ON c.id=q.client_id WHERE q.status IN ('approved','sent') ORDER BY q.quote_date").all();
    const unbilled = db.prepare("SELECT q.*, c.name client_name FROM quotations q JOIN clients c ON c.id=q.client_id WHERE q.status='accepted' AND q.paid_at IS NULL AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.quotation_id=q.id AND i.status<>'cancelled') ORDER BY q.quote_date").all();
    const issued = db.prepare("SELECT i.*, c.name client_name FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.status='issued' ORDER BY i.due_date").all();
    const overdue = issued.filter((i) => i.due_date && i.due_date < today);
    const unpaid = issued.filter((i) => !(i.due_date && i.due_date < today));
    const p = svc.partners();
    return { today, pendingQuotes, pendingExpenses, awaiting, unbilled, overdue, unpaid, balances: { a: p.a.balance, b: p.b.balance },
      empty: !(pendingQuotes.length || pendingExpenses.length || awaiting.length || unbilled.length || overdue.length || unpaid.length) };
  }
  async function sendWeekly(user = null) {
    const to = db.prepare('SELECT email FROM users WHERE active=1').all().map((u) => u.email);
    const r = await ctx.notifier.weekly(to, weeklySummary());
    setFlag('_last_weekly_day', dateKey(ctx.now()));
    ctx.service.audit(user, 'weekly reminder sent', 'email', null, `${to.length} recipient(s): ${r.status}`);
    return r;
  }

  /** Runs every few minutes: backup once a day (after 2 am Dubai), Trash clean-up, Monday 8 am reminder. */
  async function tick() {
    const now = ctx.now(), p = parts(now), today = dateKey(now);
    if (p.hour >= 2 && getFlag('_last_backup_day') !== today) {
      try { await backup(); } catch (e) { console.error('[backup]', e.message); setFlag('_last_backup_day', today); }
      try { await ctx.service.purgeTrash(); } catch (e) { console.error('[trash]', e.message); }
    }
    if (ctx.settings().weekly_email !== 'off' && p.dow === 1 && p.hour >= 8 && getFlag('_last_weekly_day') !== today) {
      try { await sendWeekly(); } catch (e) { console.error('[weekly]', e.message); setFlag('_last_weekly_day', today); }
    }
  }
  function start(everyMs = 10 * 60 * 1000) {
    const run = () => tick().catch((e) => console.error('[jobs]', e));
    setTimeout(run, 30 * 1000).unref();
    setInterval(run, everyMs).unref();
  }

  return { backup, listBackups, backupFile, backupDir, weeklySummary, sendWeekly, tick, start };
}
