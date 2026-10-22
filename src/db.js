import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SETTING_DEFAULTS = {
  company_name: 'Dar Al Bunyan Technical Services L.L.C',
  company_tagline: 'Where Vision Becomes Reality',
  company_address: 'Office M-28 CBD Building, Al Khubaisi, Deira, Dubai, UAE',
  company_trn: '104488509100003',
  company_phone: '+971 55 302 3182',
  company_email: '',
  bank_name: 'ADCB (Abu Dhabi Commercial Bank)',
  bank_account_name: 'DAR AL BUNYAN TECHNICAL SERVICES LLC.',
  bank_account_number: '13662148920001',
  bank_iban: 'AE770030013662148920001',
  bank_swift: 'ADCBAEAA',
  vat_rate: '5',
  quote_validity_days: '30',
  payment_terms_days: '30',
  margin_target: '30',
  margin_floor: '20',
  quote_prefix: 'DABTS/',
  next_quote_no: '1',
  invoice_prefix: 'DABTS/',
  invoice_suffix: '/26',
  next_invoice_no: '1',
  credit_prefix: 'DABTS/CN/',
  next_credit_no: '1',
  weekly_email: 'on', // Monday-morning reminder email to all users
  partner_a: 'Mohamed',
  partner_a_share: '60',
  partner_b: 'Ramdas',
  partner_b_share: '40',
  notify_email: '', // extra address copied on approval requests (optional)
  quote_terms: 'Prices are in UAE Dirhams (AED) and exclude VAT unless stated.\nThis quotation is valid for 30 days from the date of issue.\nPayment within 30 days of invoice.\nWork starts after receipt of the client LPO or written approval.',
  invoice_notes: 'Thank you for your business. Please quote the invoice number with your payment.',
};

export const COST_TYPES = ['Material', 'Labour', 'Subcontract', 'Fuel and Salik', 'Parking', 'Accomodation', 'Shope Rental', 'Utilities', 'Mobile and internet', 'Others'];
export const UNITS = ['Each', 'Job', 'Lot', 'Hour(s)', 'Day', 'Visit', 'M', 'Square Feet', 'Pieces', 'Box', 'Set'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','operations')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  trn TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  unit TEXT NOT NULL DEFAULT 'Each',
  price REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  subject TEXT NOT NULL,
  site TEXT NOT NULL DEFAULT '',
  quote_date TEXT NOT NULL,
  valid_until TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending','approved','rejected','sent','accepted','declined')),
  discount_pct REAL NOT NULL DEFAULT 0,
  vat_rate REAL NOT NULL DEFAULT 5,
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  vat REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  lpo TEXT NOT NULL DEFAULT '',
  terms TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  share_paid INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  submitted_at INTEGER,
  decided_by INTEGER REFERENCES users(id),
  decided_at INTEGER,
  decision_note TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,
  closed_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_quotes_status ON quotations(status);

CREATE TABLE IF NOT EXISTS quote_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'Each',
  unit_price REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_lines_quote ON quote_lines(quotation_id);

CREATE TABLE IF NOT EXISTS quote_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  quotation_id INTEGER REFERENCES quotations(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  subject TEXT NOT NULL DEFAULT '',
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL DEFAULT '',
  lpo TEXT NOT NULL DEFAULT '',
  net REAL NOT NULL,
  vat_rate REAL NOT NULL,
  vat REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','cancelled')),
  paid_at TEXT,
  payment_method TEXT NOT NULL DEFAULT '',
  payment_ref TEXT NOT NULL DEFAULT '',
  pay_token TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  sent_at INTEGER,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_invoices_quote ON invoices(quotation_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'Each',
  unit_price REAL NOT NULL,
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_sessions (
  id TEXT PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','expired')),
  payment_ref TEXT,
  amount REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paid_on TEXT NOT NULL,
  quotation_id INTEGER REFERENCES quotations(id),
  cost_type TEXT NOT NULL DEFAULT 'Others',
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  total REAL NOT NULL,
  paid_by TEXT NOT NULL DEFAULT 'Pending',
  paid_back INTEGER NOT NULL DEFAULT 0,
  remarks TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_expenses_quote ON expenses(quotation_id);

-- Files (LPOs, receipts, photos) attached to a quotation, invoice or expense. Stored in Google Drive when
-- configured (drive_id + link), otherwise on the server disk under data/uploads (local_path).
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('quotation','invoice','expense')),
  entity_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  storage TEXT NOT NULL CHECK (storage IN ('drive','local','link')),
  drive_id TEXT,
  link TEXT NOT NULL DEFAULT '',
  local_path TEXT,
  uploaded_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attach_entity ON attachments(entity, entity_id);

-- Tax credit notes: cancel an issued (emailed or paid) tax invoice in full.
CREATE TABLE IF NOT EXISTS credit_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  client_id INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  net REAL NOT NULL,
  vat_rate REAL NOT NULL,
  vat REAL NOT NULL,
  total REAL NOT NULL,
  sent_at INTEGER,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

-- Money paid out to the partners (profit shares and costs paid back).
CREATE TABLE IF NOT EXISTS partner_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paid_on TEXT NOT NULL,
  partner TEXT NOT NULL CHECK (partner IN ('a','b')),
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

-- Personal loans taken by partner B (advanced by partner A); deducted from B's share and paid back to A.
CREATE TABLE IF NOT EXISTS partner_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_on TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

-- Deleted records, kept 30 days so they can be restored.
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  data TEXT NOT NULL
);

-- Who did what and when.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_activity_ts ON activity(ts);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  storage TEXT NOT NULL,
  drive_id TEXT,
  link TEXT NOT NULL DEFAULT '',
  local_path TEXT,
  status TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  error TEXT,
  attachment TEXT,
  ref TEXT
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) ins.run(k, v);
  ins.run('_secret', crypto.randomBytes(32).toString('base64url'));
  // Fill company TRN and bank details on databases created before they were known (an empty value only; never overwrites one set in Settings).
  // the old placeholder address is replaced too
  db.prepare("UPDATE settings SET value=? WHERE key='company_address' AND value IN ('', 'Dubai, United Arab Emirates')").run(SETTING_DEFAULTS.company_address);
  for (const k of ['company_trn', 'company_phone', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_iban', 'bank_swift']) {
    db.prepare("UPDATE settings SET value=? WHERE key=? AND value=''").run(SETTING_DEFAULTS[k], k);
  }
  migrate(db);
  // Quotation numbers moved from "Q-41" to "DABTS/41": rename existing ones once, while the prefix is still the old default.
  if (db.prepare("SELECT value FROM settings WHERE key='quote_prefix'").get()?.value === 'Q-') {
    const pre = SETTING_DEFAULTS.quote_prefix;
    db.exec('BEGIN');
    try {
      for (const q of db.prepare("SELECT id, number FROM quotations WHERE number LIKE 'Q-%'").all()) {
        const nn = pre + q.number.slice(2);
        if (!db.prepare('SELECT 1 FROM quotations WHERE number=?').get(nn)) db.prepare('UPDATE quotations SET number=? WHERE id=?').run(nn, q.id);
      }
      db.prepare("UPDATE settings SET value=? WHERE key='quote_prefix'").run(pre);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

const hasCol = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const addCol = (db, table, col, def) => { if (!hasCol(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
const flag = (db, key) => { if (db.prepare('SELECT 1 FROM settings WHERE key=?').get(key)) return false; db.prepare("INSERT INTO settings(key,value) VALUES(?, '1')").run(key); return true; };

/** One-time changes to databases created by earlier versions. */
function migrate(db) {
  addCol(db, 'quotations', 'paid_at', 'TEXT'); // date the customer paid (set by the invoice, or by hand for jobs without one)
  addCol(db, 'expenses', 'status', "TEXT NOT NULL DEFAULT 'approved'"); // pending / approved / returned
  addCol(db, 'expenses', 'review_note', "TEXT NOT NULL DEFAULT ''");
  addCol(db, 'expenses', 'approved_by', 'INTEGER');
  addCol(db, 'expenses', 'approved_at', 'INTEGER');
  db.exec('BEGIN');
  try {
    // Personal loans used to be an expense type: move them to their own table.
    if (flag(db, '_mig_loans')) {
      const loans = db.prepare("SELECT * FROM expenses WHERE cost_type LIKE '%loan%'").all();
      const ins = db.prepare('INSERT INTO partner_loans(taken_on,amount,note,created_by,created_at) VALUES(?,?,?,?,?)');
      for (const e of loans) {
        ins.run(e.paid_on, e.total, [e.description, e.remarks].filter(Boolean).join(' - ') || 'Personal loan', e.created_by, e.created_at);
        db.prepare("DELETE FROM attachments WHERE entity='expense' AND entity_id=?").run(e.id);
        db.prepare('DELETE FROM expenses WHERE id=?').run(e.id);
      }
    }
    // Jobs imported from the Excel sheet were all paid by the customers: record that (and pay their invoices).
    if (flag(db, '_mig_imported_paid')) {
      const imported = db.prepare("SELECT DISTINCT q.id, q.closed_at, q.quote_date FROM quotations q JOIN quote_events e ON e.quotation_id=q.id WHERE e.action='imported from Excel' AND q.status='accepted' AND q.paid_at IS NULL").all();
      for (const q of imported) {
        const inv = db.prepare("SELECT * FROM invoices WHERE quotation_id=? AND status<>'cancelled'").get(q.id);
        if (inv && inv.status === 'issued') db.prepare("UPDATE invoices SET status='paid', paid_at=?, payment_method='Bank transfer', payment_ref='Imported as paid' WHERE id=?").run(inv.issue_date, inv.id);
        db.prepare('UPDATE quotations SET paid_at=? WHERE id=?').run(inv?.paid_at || inv?.issue_date || q.closed_at || q.quote_date, q.id);
      }
    }
    // Invoices marked paid before this version: their job is paid.
    db.exec("UPDATE quotations SET paid_at=(SELECT i.paid_at FROM invoices i WHERE i.quotation_id=quotations.id AND i.status='paid' LIMIT 1) WHERE paid_at IS NULL AND EXISTS (SELECT 1 FROM invoices i WHERE i.quotation_id=quotations.id AND i.status='paid')");
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function getSettings(db) {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.prepare('SELECT key,value FROM settings').all()) if (!r.key.startsWith('_')) out[r.key] = r.value;
  return out;
}

/** Runs fn inside a transaction (rolls back on error). */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
