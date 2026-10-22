// Business logic: clients, products, quotations (with approval), invoices, payments, expenses, finance report.
import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { tx, COST_TYPES } from './db.js';
import { round2, dateKey, parseDateKey } from './time.js';
import { clampStr, isEmail } from './util.js';
import { quotationPdf, invoicePdf, creditNotePdf } from './docs.js';

const STATUSES = ['draft', 'pending', 'approved', 'rejected', 'sent', 'accepted', 'declined'];
const EDITABLE = new Set(['draft', 'rejected']);
const num = (v, d = 0) => { if (v === null || v === undefined || String(v).trim() === '') return d; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : d; };
const isoDate = (v, fallback) => { const s = String(v || '').slice(0, 10); return parseDateKey(s) !== null ? s : fallback; };
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const bad = (msg) => { throw new HttpError(400, msg); };

export function createService(ctx) {
  const { db } = ctx;
  const S = () => ctx.settings();
  const today = () => dateKey(ctx.now());
  const event = (qid, user, action, note = '') => {
    db.prepare('INSERT INTO quote_events(quotation_id,ts,user_id,action,note) VALUES(?,?,?,?,?)').run(qid, ctx.now(), user?.id || null, action, note);
    const n = db.prepare('SELECT number FROM quotations WHERE id=?').get(qid)?.number || '';
    audit(user, `quotation ${action}`, 'quotation', qid, [n, note].filter(Boolean).join(' - '));
  };
  const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
  const isAdmin = (u) => u && u.role === 'admin';

  // ---------- clients & products ----------
  function upsertClient(c, { update = true } = {}) {
    const name = clampStr(c?.name, 160);
    if (c?.id) {
      const row = db.prepare('SELECT * FROM clients WHERE id=?').get(Number(c.id));
      if (!row) bad('Client not found.');
      if (update) updateClient(row.id, { ...row, ...pickClient(c), name: name || row.name });
      return row.id;
    }
    if (!name) bad('Enter the customer name.');
    const row = db.prepare('SELECT * FROM clients WHERE name=?').get(name);
    if (row) {
      if (update) { const f = pickClient(c); for (const k of Object.keys(f)) if (!f[k]) delete f[k]; updateClient(row.id, { ...row, ...f }); }
      return row.id;
    }
    const f = pickClient(c);
    return Number(db.prepare('INSERT INTO clients(name,contact,email,phone,address,trn,notes,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(name, f.contact, f.email, f.phone, f.address, f.trn, f.notes, ctx.now()).lastInsertRowid);
  }
  function pickClient(c = {}) {
    const email = clampStr(c.email, 200).toLowerCase();
    if (email && !isEmail(email)) bad('The customer email address is not valid.');
    return { contact: clampStr(c.contact, 120), email, phone: clampStr(c.phone, 40), address: clampStr(c.address, 400), trn: clampStr(c.trn, 30), notes: clampStr(c.notes, 1000) };
  }
  function updateClient(id, c) {
    const f = pickClient(c);
    const name = clampStr(c.name, 160);
    if (!name) bad('Enter the customer name.');
    const dup = db.prepare('SELECT id FROM clients WHERE name=? AND id<>?').get(name, id);
    if (dup) bad('Another customer already has this name.');
    db.prepare('UPDATE clients SET name=?,contact=?,email=?,phone=?,address=?,trn=?,notes=? WHERE id=?').run(name, f.contact, f.email, f.phone, f.address, f.trn, f.notes, id);
  }
  // ---------- activity log ----------
  const audit = (user, action, entity = '', entityId = null, summary = '') =>
    db.prepare('INSERT INTO activity(ts,user_id,action,entity,entity_id,summary) VALUES(?,?,?,?,?,?)').run(ctx.now(), user?.id || null, action, entity, entityId, clampStr(summary, 500));

  // ---------- deleting (owner only): records go to the Trash for 30 days ----------
  const rowsOf = (table, where, ...args) => db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args);
  const add = (b, table, rows) => { if (rows.length) (b[table] ||= []).push(...rows); return b; };
  /** An invoice that was emailed, paid or credited is a final tax document: cancel it with a credit note instead. */
  const invoiceLocked = (inv) => !!(inv.sent_at || inv.status === 'paid' || db.prepare('SELECT 1 FROM credit_notes WHERE invoice_id=?').get(inv.id));
  function bundleInvoice(inv, b) {
    if (invoiceLocked(inv)) bad(`Invoice ${inv.number} was ${inv.status === 'paid' ? 'paid' : inv.sent_at ? 'emailed to the customer' : 'credited'}, so it cannot be deleted. Issue a credit note instead (UAE VAT rules).`);
    add(b, 'invoices', [inv]);
    add(b, 'invoice_lines', rowsOf('invoice_lines', 'invoice_id=?', inv.id));
    add(b, 'payment_sessions', rowsOf('payment_sessions', 'invoice_id=?', inv.id));
    add(b, 'attachments', rowsOf('attachments', "entity='invoice' AND entity_id=?", inv.id));
    return b;
  }
  function bundleExpense(e, b) {
    add(b, 'expenses', [e]);
    add(b, 'attachments', rowsOf('attachments', "entity='expense' AND entity_id=?", e.id));
    return b;
  }
  function bundleQuote(q, b) {
    for (const inv of rowsOf('invoices', 'quotation_id=?', q.id)) {
      if (inv.status === 'cancelled' && db.prepare('SELECT 1 FROM credit_notes WHERE invoice_id=?').get(inv.id)) bad(`Quotation ${q.number} has a credited invoice (${inv.number}); it is kept for the VAT records and cannot be deleted.`);
      bundleInvoice(inv, b);
    }
    add(b, 'quotations', [q]);
    add(b, 'quote_lines', rowsOf('quote_lines', 'quotation_id=?', q.id));
    add(b, 'quote_events', rowsOf('quote_events', 'quotation_id=?', q.id));
    add(b, 'attachments', rowsOf('attachments', "entity='quotation' AND entity_id=?", q.id));
    for (const e of rowsOf('expenses', 'quotation_id=?', q.id)) bundleExpense(e, b);
    return b;
  }
  // delete children before parents; restore in the opposite order
  const ORDER = ['attachments', 'expenses', 'payment_sessions', 'invoice_lines', 'invoices', 'quote_events', 'quote_lines', 'quotations', 'clients', 'products', 'partner_payments', 'partner_loans'];
  function toTrash(user, kind, label, b) {
    tx(db, () => {
      db.prepare('INSERT INTO trash(ts,user_id,kind,label,data) VALUES(?,?,?,?,?)').run(ctx.now(), user?.id || null, kind, label, JSON.stringify(b));
      for (const t of ORDER) for (const r of b[t] || []) db.prepare(`DELETE FROM ${t} WHERE id=?`).run(r.id);
      audit(user, 'deleted', kind, null, label);
    });
  }
  function listTrash() {
    return db.prepare('SELECT t.id,t.ts,t.kind,t.label,u.name user_name FROM trash t LEFT JOIN users u ON u.id=t.user_id ORDER BY t.ts DESC').all();
  }
  function restoreTrash(user, id) {
    const t = db.prepare('SELECT * FROM trash WHERE id=?').get(Number(id));
    if (!t) throw new HttpError(404, 'Not in the Trash any more.');
    const b = JSON.parse(t.data);
    tx(db, () => {
      for (const table of [...ORDER].reverse()) {
        for (const r of b[table] || []) {
          const row = { ...r };
          if (table === 'quotations' && !db.prepare('SELECT 1 FROM clients WHERE id=?').get(row.client_id)) bad(`The customer of ${row.number} was deleted too. Restore the customer first.`);
          if (table === 'invoices' && !db.prepare('SELECT 1 FROM clients WHERE id=?').get(row.client_id)) bad(`The customer of invoice ${row.number} was deleted too. Restore the customer first.`);
          if (table === 'quote_lines' && row.product_id && !db.prepare('SELECT 1 FROM products WHERE id=?').get(row.product_id)) row.product_id = null;
          if ((table === 'expenses' || table === 'invoices') && row.quotation_id && !db.prepare('SELECT 1 FROM quotations WHERE id=?').get(row.quotation_id)) row.quotation_id = null;
          if (table === 'quotations' && db.prepare('SELECT 1 FROM quotations WHERE number=?').get(row.number)) bad(`Another quotation already uses number ${row.number}.`);
          const cols = Object.keys(row).filter((c) => db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(c));
          db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
        }
      }
      db.prepare('DELETE FROM trash WHERE id=?').run(t.id);
      audit(user, 'restored', t.kind, null, t.label);
    });
    return t;
  }
  /** Removes Trash entries older than 30 days for good (including their files). */
  async function purgeTrash(days = 30) {
    const old = db.prepare('SELECT * FROM trash WHERE ts<?').all(ctx.now() - days * 24 * 3600 * 1000);
    for (const t of old) {
      for (const a of JSON.parse(t.data).attachments || []) if (a.storage !== 'link') await ctx.storage.remove(a);
      db.prepare('DELETE FROM trash WHERE id=?').run(t.id);
    }
    return old.length;
  }

  function deleteInvoice(user, id) {
    const inv = getInvoice(id);
    toTrash(user, 'invoice', `Invoice ${inv.number} - ${inv.client_name} - AED ${inv.total}`, bundleInvoice(db.prepare('SELECT * FROM invoices WHERE id=?').get(inv.id), {}));
  }
  function deleteProduct(user, id) {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(id));
    if (!p) throw new HttpError(404, 'Product not found.');
    db.prepare('UPDATE quote_lines SET product_id=NULL WHERE product_id=?').run(p.id); // quotation lines keep their text and prices
    toTrash(user, 'product', `Product ${p.name}`, { products: [p] });
  }
  function clientUsage(id) {
    return db.prepare('SELECT (SELECT COUNT(*) FROM quotations WHERE client_id=?) quotations, (SELECT COUNT(*) FROM invoices WHERE client_id=?) invoices').get(id, id);
  }
  /** Without force, a customer with quotations or invoices is not deleted; with force, they go to the Trash with it. */
  function deleteClient(user, id, { force = false } = {}) {
    const c = db.prepare('SELECT * FROM clients WHERE id=?').get(Number(id));
    if (!c) throw new HttpError(404, 'Customer not found.');
    const u = clientUsage(c.id);
    if ((u.quotations || u.invoices) && !force) throw new HttpError(409, `This customer has ${u.quotations} quotation(s) and ${u.invoices} invoice(s).`);
    const b = {};
    for (const q of rowsOf('quotations', 'client_id=?', c.id)) bundleQuote(q, b);
    for (const inv of rowsOf('invoices', 'client_id=? AND (quotation_id IS NULL OR quotation_id NOT IN (SELECT id FROM quotations WHERE client_id=?))', c.id, c.id)) bundleInvoice(inv, b);
    add(b, 'clients', [c]);
    toTrash(user, 'customer', `Customer ${c.name}${u.quotations ? ` with ${u.quotations} quotation(s)` : ''}`, b);
  }
  function deleteExpense(user, id) {
    const e = db.prepare('SELECT * FROM expenses WHERE id=?').get(Number(id));
    if (!e) throw new HttpError(404, 'Expense not found.');
    toTrash(user, 'expense', `Expense ${e.paid_on} - ${e.cost_type} - AED ${e.total}${e.description ? ' - ' + e.description : ''}`, bundleExpense(e, {}));
  }
  function saveProduct(p, id) {
    const name = clampStr(p.name, 200);
    if (!name) bad('Enter the product or service name.');
    const vals = [name, clampStr(p.unit || 'Each', 30), round2(num(p.price)), round2(num(p.cost)), clampStr(p.category, 60), p.active === false || p.active === 0 ? 0 : 1];
    const dup = db.prepare('SELECT id FROM products WHERE name=? AND id<>?').get(name, id || 0);
    if (dup) bad('A product with this name already exists.');
    if (id) { db.prepare('UPDATE products SET name=?,unit=?,price=?,cost=?,category=?,active=? WHERE id=?').run(...vals, id); return id; }
    return Number(db.prepare('INSERT INTO products(name,unit,price,cost,category,active,created_at) VALUES(?,?,?,?,?,?,?)').run(...vals, ctx.now()).lastInsertRowid);
  }

  // ---------- quotations ----------
  function getQuote(id) {
    const q = db.prepare(`SELECT q.*, c.name client_name, u.name created_by_name, d.name decided_by_name FROM quotations q
      JOIN clients c ON c.id=q.client_id LEFT JOIN users u ON u.id=q.created_by LEFT JOIN users d ON d.id=q.decided_by WHERE q.id=?`).get(Number(id));
    if (!q) throw new HttpError(404, 'Quotation not found.');
    return q;
  }
  function quoteDetail(id, user) {
    const q = getQuote(id);
    const lines = db.prepare('SELECT * FROM quote_lines WHERE quotation_id=? ORDER BY pos').all(q.id);
    const client = db.prepare('SELECT * FROM clients WHERE id=?').get(q.client_id);
    const events = db.prepare('SELECT e.*, u.name user_name FROM quote_events e LEFT JOIN users u ON u.id=e.user_id WHERE quotation_id=? ORDER BY ts DESC, e.id DESC').all(q.id);
    const invoice = db.prepare("SELECT id,number,status,total FROM invoices WHERE quotation_id=? AND status<>'cancelled'").get(q.id) || null;
    const actual = db.prepare("SELECT COALESCE(SUM(total),0) s, COUNT(*) n FROM expenses WHERE quotation_id=? AND status='approved'").get(q.id);
    return { quotation: q, lines, client, events, invoice, actualCost: actual?.s ?? null, expenseCount: actual?.n ?? null, attachments: listAttachments('quotation', q.id) };
  }
  function listQuotes({ status, q: term, mine, user } = {}) {
    let sql = `SELECT q.id,q.number,q.subject,q.site,q.quote_date,q.status,q.net,q.total,q.cost_total,q.created_by,q.updated_at,q.lpo,c.name client_name,u.name created_by_name,
      (SELECT number FROM invoices i WHERE i.quotation_id=q.id AND i.status<>'cancelled') invoice_number,
      (SELECT COUNT(*) FROM attachments a WHERE a.entity='quotation' AND a.entity_id=q.id) attach_count
      FROM quotations q JOIN clients c ON c.id=q.client_id LEFT JOIN users u ON u.id=q.created_by WHERE 1=1`;
    const p = [];
    if (status && STATUSES.includes(status)) { sql += ' AND q.status=?'; p.push(status); }
    if (mine && user) { sql += ' AND q.created_by=?'; p.push(user.id); }
    if (term) { sql += ' AND (q.number LIKE ? OR q.subject LIKE ? OR c.name LIKE ? OR q.lpo LIKE ?)'; const t = `%${String(term).slice(0, 60)}%`; p.push(t, t, t, t); }
    sql += ' ORDER BY q.quote_date DESC, q.id DESC LIMIT 1000';
    return db.prepare(sql).all(...p);
  }
  function computeLines(rawLines) {
    if (!Array.isArray(rawLines)) bad('Add at least one item.');
    const lines = rawLines.filter((l) => clampStr(l?.description, 500)).map((l, i) => {
      const qty = num(l.qty, 1), price = num(l.unit_price), cost = num(l.unit_cost);
      if (qty <= 0) bad(`Item ${i + 1}: quantity must be more than 0.`);
      if (price < 0 || cost < 0) bad(`Item ${i + 1}: price and cost cannot be negative.`);
      return { product_id: l.product_id ? Number(l.product_id) : null, description: clampStr(l.description, 500), qty: round2(qty), unit: clampStr(l.unit || 'Each', 30), unit_price: round2(price), unit_cost: round2(cost), amount: round2(qty * price), cost: round2(qty * cost), save_product: l.save_product !== false };
    });
    if (lines.length > 200) bad('A quotation can have at most 200 items.');
    return lines;
  }
  function totals(lines, discountPct, vatRate) {
    const subtotal = round2(lines.reduce((a, l) => a + l.amount, 0));
    const discount = round2((subtotal * discountPct) / 100);
    const net = round2(subtotal - discount);
    const vat = round2((net * vatRate) / 100);
    return { subtotal, discount, net, vat, total: round2(net + vat), cost_total: round2(lines.reduce((a, l) => a + l.cost, 0)) };
  }

  /** Create or update a quotation, including its customer and new products, from one form. */
  function saveQuote(user, body, id) {
    const s = S();
    return tx(db, () => {
      let existing = null;
      if (id) {
        existing = getQuote(id);
        const adminEditable = isAdmin(user) && ['pending', 'approved'].includes(existing.status);
        if (!EDITABLE.has(existing.status) && !adminEditable) bad(`This quotation is ${existing.status} and can no longer be changed. An administrator can reopen it.`);
      }
      const clientId = upsertClient(body.client || {});
      const subject = clampStr(body.subject, 300);
      if (!subject) bad('Enter the subject of the quotation.');
      const lines = computeLines(body.lines || []);
      if (!lines.length) bad('Add at least one item.');
      for (const l of lines) {
        if (l.product_id) {
          if (!db.prepare('SELECT id FROM products WHERE id=?').get(l.product_id)) l.product_id = null;
        }
        if (!l.product_id && l.save_product) {
          const p = db.prepare('SELECT id FROM products WHERE name=?').get(l.description);
          l.product_id = p ? p.id : saveProduct({ name: l.description, unit: l.unit, price: l.unit_price, cost: l.unit_cost });
        }
      }
      const discountPct = Math.min(100, Math.max(0, num(body.discount_pct)));
      const vatRate = num(body.vat_rate, num(s.vat_rate, 5));
      const t = totals(lines, discountPct, vatRate);
      const qDate = isoDate(body.quote_date, existing?.quote_date || today());
      const valid = isoDate(body.valid_until, existing?.valid_until || addDays(qDate, num(s.quote_validity_days, 30)));
      const f = [clientId, subject, clampStr(body.site, 200), qDate, valid, discountPct, vatRate, t.subtotal, t.discount, t.net, t.vat, t.total, t.cost_total,
        clampStr(body.lpo, 120), clampStr(body.terms ?? s.quote_terms, 4000), clampStr(body.notes, 4000)];
      let qid;
      if (existing) {
        db.prepare(`UPDATE quotations SET client_id=?,subject=?,site=?,quote_date=?,valid_until=?,discount_pct=?,vat_rate=?,subtotal=?,discount=?,net=?,vat=?,total=?,cost_total=?,lpo=?,terms=?,notes=?,updated_at=? WHERE id=?`).run(...f, ctx.now(), existing.id);
        qid = existing.id;
        db.prepare('DELETE FROM quote_lines WHERE quotation_id=?').run(qid);
        event(qid, user, 'edited');
      } else {
        const n = num(s.next_quote_no, 1);
        let number = `${s.quote_prefix}${n}`;
        let k = n;
        while (db.prepare('SELECT 1 FROM quotations WHERE number=?').get(number)) number = `${s.quote_prefix}${++k}`;
        setSetting('next_quote_no', k + 1);
        qid = Number(db.prepare(`INSERT INTO quotations(client_id,subject,site,quote_date,valid_until,discount_pct,vat_rate,subtotal,discount,net,vat,total,cost_total,lpo,terms,notes,number,status,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?)`).run(...f, number, user.id, ctx.now(), ctx.now()).lastInsertRowid);
        event(qid, user, 'created');
      }
      const ins = db.prepare('INSERT INTO quote_lines(quotation_id,pos,product_id,description,qty,unit,unit_price,unit_cost,amount,cost) VALUES(?,?,?,?,?,?,?,?,?,?)');
      lines.forEach((l, i) => ins.run(qid, i + 1, l.product_id, l.description, l.qty, l.unit, l.unit_price, l.unit_cost, l.amount, l.cost));
      return qid;
    });
  }

  function setStatus(id, status, extra = {}) {
    const sets = Object.keys(extra).map((k) => `${k}=?`).join(',');
    db.prepare(`UPDATE quotations SET status=?,updated_at=?${sets ? ',' + sets : ''} WHERE id=?`).run(status, ctx.now(), ...Object.values(extra), id);
  }
  async function submitQuote(user, id) {
    const q = getQuote(id);
    if (!EDITABLE.has(q.status)) bad(`Only draft or returned quotations can be submitted (this one is ${q.status}).`);
    if (!db.prepare('SELECT COUNT(*) n FROM quote_lines WHERE quotation_id=?').get(q.id).n) bad('Add at least one item before submitting.');
    setStatus(q.id, 'pending', { submitted_at: ctx.now(), decision_note: '' });
    event(q.id, user, 'submitted for approval');
    ctx.background(ctx.notifier.approvalRequested(getQuote(q.id), user));
    return getQuote(q.id);
  }
  async function decideQuote(user, id, approve, note) {
    const q = getQuote(id);
    const allowed = approve ? ['pending', 'draft', 'rejected'] : ['pending'];
    if (!allowed.includes(q.status)) bad(`This quotation is ${q.status}; it cannot be ${approve ? 'approved' : 'returned'} now.`);
    if (!approve && !clampStr(note, 1000)) bad('Write a short comment so the creator knows what to change.');
    setStatus(q.id, approve ? 'approved' : 'rejected', { decided_by: user.id, decided_at: ctx.now(), decision_note: clampStr(note, 1000) });
    event(q.id, user, approve ? 'approved' : 'returned for changes', clampStr(note, 1000));
    if (q.created_by && q.created_by !== user.id) ctx.background(ctx.notifier.decision(getQuote(q.id), approve, clampStr(note, 1000), user));
    return getQuote(q.id);
  }
  function quotePdfBuffer(id) {
    const d = quoteDetail(id);
    return quotationPdf(d.quotation, d.lines, d.client, S());
  }
  async function sendQuote(user, id, { email = true, message = '', attachmentIds = [] } = {}) {
    const q = getQuote(id);
    if (!['approved', 'sent'].includes(q.status)) bad('Only approved quotations can be sent to the customer.');
    const client = db.prepare('SELECT * FROM clients WHERE id=?').get(q.client_id);
    let result = { status: 'not emailed' };
    if (email) {
      if (!client.email) bad('Add the customer email address first.');
      const extra = await attachmentsForEmail('quotation', q.id, attachmentIds);
      result = await ctx.notifier.quotationToClient(q, client, quotePdfBuffer(q.id), extra, clampStr(message, 2000));
      if (result.status === 'failed') bad(`Email failed: ${result.error}`);
    }
    if (q.status === 'approved') setStatus(q.id, 'sent', { sent_at: ctx.now() });
    event(q.id, user, email ? `sent to ${client.email} (${result.status})` : 'marked as sent');
    return getQuote(q.id);
  }
  function closeQuote(user, id, accepted, { lpo, date, note } = {}) {
    const q = getQuote(id);
    if (!['approved', 'sent', 'accepted', 'declined'].includes(q.status)) bad('Only approved or sent quotations can be marked accepted or declined.');
    if (!accepted && db.prepare("SELECT 1 FROM invoices WHERE quotation_id=? AND status<>'cancelled'").get(q.id)) bad('This quotation has an invoice. An administrator must cancel the invoice first.');
    setStatus(q.id, accepted ? 'accepted' : 'declined', { closed_at: isoDate(date, today()), ...(lpo !== undefined && accepted ? { lpo: clampStr(lpo, 120) } : {}) });
    event(q.id, user, accepted ? 'accepted by customer' : 'declined by customer', clampStr(note, 500));
    return getQuote(q.id);
  }
  function reopenQuote(user, id) {
    const q = getQuote(id);
    if (db.prepare("SELECT 1 FROM invoices WHERE quotation_id=? AND status<>'cancelled'").get(q.id)) bad('Cancel the invoice of this quotation first.');
    setStatus(q.id, 'draft', { decision_note: '' });
    event(q.id, user, 'reopened as draft');
    return getQuote(q.id);
  }
  /** Only the owner deletes quotations (any status); its invoice and expenses go to the Trash with it. */
  function deleteQuote(user, id) {
    const q = getQuote(id);
    if (!isAdmin(user)) throw new HttpError(403, 'Only the owner can delete quotations.');
    toTrash(user, 'quotation', `Quotation ${q.number} - ${q.client_name} - ${q.subject}`, bundleQuote(db.prepare('SELECT * FROM quotations WHERE id=?').get(q.id), {}));
  }
  function duplicateQuote(user, id) {
    const d = quoteDetail(id);
    return saveQuote(user, { ...d.quotation, quote_date: today(), valid_until: '', client: { id: d.client.id }, lines: d.lines.map((l) => ({ ...l, save_product: false })), lpo: '' });
  }

  // ---------- invoices ----------
  function getInvoice(id) {
    const inv = db.prepare(`SELECT i.*, c.name client_name, c.email client_email, q.number quote_number FROM invoices i JOIN clients c ON c.id=i.client_id LEFT JOIN quotations q ON q.id=i.quotation_id WHERE i.id=?`).get(Number(id));
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    return inv;
  }
  function createInvoice(user, quoteId, body = {}) {
    const s = S();
    return tx(db, () => {
      const q = getQuote(quoteId);
      if (!['accepted', 'sent', 'approved'].includes(q.status)) bad('Invoices can be raised for approved, sent or accepted quotations.');
      if (db.prepare("SELECT 1 FROM invoices WHERE quotation_id=? AND status<>'cancelled'").get(q.id)) bad('This quotation already has an invoice.');
      const issue = isoDate(body.issue_date, today());
      const due = isoDate(body.due_date, addDays(issue, num(s.payment_terms_days, 30)));
      const n = num(s.next_invoice_no, 1);
      let k = n, number = `${s.invoice_prefix}${k}${s.invoice_suffix}`;
      while (db.prepare('SELECT 1 FROM invoices WHERE number=?').get(number)) number = `${s.invoice_prefix}${++k}${s.invoice_suffix}`;
      setSetting('next_invoice_no', k + 1);
      const id = Number(db.prepare(`INSERT INTO invoices(number,quotation_id,client_id,subject,issue_date,due_date,lpo,net,vat_rate,vat,total,status,pay_token,notes,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'issued',?,?,?,?)`).run(number, q.id, q.client_id, q.subject, issue, due, clampStr(body.lpo ?? q.lpo, 120), q.net, q.vat_rate, q.vat, q.total,
        crypto.randomBytes(16).toString('base64url'), clampStr(body.notes ?? s.invoice_notes, 2000), user.id, ctx.now()).lastInsertRowid);
      const ins = db.prepare('INSERT INTO invoice_lines(invoice_id,pos,description,qty,unit,unit_price,amount) VALUES(?,?,?,?,?,?,?)');
      const lines = db.prepare('SELECT * FROM quote_lines WHERE quotation_id=? ORDER BY pos').all(q.id);
      lines.forEach((l, i) => ins.run(id, i + 1, l.description, l.qty, l.unit, l.unit_price, l.amount));
      if (q.discount > 0) ins.run(id, lines.length + 1, `Discount (${q.discount_pct}%)`, 1, '', -q.discount, -q.discount);
      if (q.status !== 'accepted') setStatus(q.id, 'accepted', { closed_at: issue });
      event(q.id, user, `invoice ${number} issued`);
      audit(user, 'invoice created', 'invoice', id, `${number} for ${q.number} - AED ${q.total}`);
      return id;
    });
  }
  function invoiceDetail(id) {
    const inv = getInvoice(id);
    return { invoice: inv, lines: db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY pos').all(inv.id), client: db.prepare('SELECT * FROM clients WHERE id=?').get(inv.client_id), attachments: listAttachments('invoice', inv.id), payUrl: ctx.payments.payUrl(inv),
      creditNote: db.prepare('SELECT * FROM credit_notes WHERE invoice_id=?').get(inv.id) || null, locked: invoiceLocked(inv) };
  }
  function invoicePdfBuffer(id) {
    const d = invoiceDetail(id);
    return invoicePdf(d.invoice, d.lines, d.client, S(), { payLink: ctx.payments.name !== 'mock' ? d.payUrl : null, generatedAt: ctx.now() });
  }
  async function sendInvoice(user, id, { attachmentIds = [] } = {}) {
    const d = invoiceDetail(id);
    if (d.invoice.status === 'cancelled') bad('This invoice is cancelled.');
    if (!d.client.email) bad('Add the customer email address first.');
    const extra = await attachmentsForEmail('invoice', d.invoice.id, attachmentIds);
    const live = ctx.payments.name !== 'mock';
    const r = await ctx.notifier.invoiceToClient(d.invoice, d.client, invoicePdfBuffer(id), live ? d.payUrl : null, extra);
    if (r.status === 'failed') bad(`Email failed: ${r.error}`);
    db.prepare('UPDATE invoices SET sent_at=? WHERE id=?').run(ctx.now(), d.invoice.id);
    audit(user, 'invoice emailed', 'invoice', d.invoice.id, `${d.invoice.number} to ${d.client.email}`);
    return r;
  }
  /** The customer paid: the invoice and its job are paid (the job's profit becomes payable to the partners). */
  function markPaid(id, { date, method = 'Bank transfer', ref = '' } = {}, user = null) {
    const inv = getInvoice(id);
    if (inv.status === 'cancelled') bad('This invoice is cancelled.');
    const d = isoDate(date, today());
    tx(db, () => {
      db.prepare("UPDATE invoices SET status='paid', paid_at=?, payment_method=?, payment_ref=? WHERE id=?").run(d, clampStr(method, 60), clampStr(ref, 120), inv.id);
      if (inv.quotation_id) db.prepare('UPDATE quotations SET paid_at=? WHERE id=?').run(d, inv.quotation_id);
      audit(user, 'invoice paid', 'invoice', inv.id, `${inv.number} - AED ${inv.total} - ${method}`);
    });
    return getInvoice(inv.id);
  }
  function setInvoiceStatus(user, id, status) {
    const inv = getInvoice(id);
    tx(db, () => {
      if (status === 'issued') {
        db.prepare("UPDATE invoices SET status='issued', paid_at=NULL, payment_method='', payment_ref='' WHERE id=?").run(inv.id);
        if (inv.quotation_id) db.prepare('UPDATE quotations SET paid_at=NULL WHERE id=?').run(inv.quotation_id);
        audit(user, 'invoice marked unpaid', 'invoice', inv.id, inv.number);
      } else if (status === 'cancelled') {
        if (invoiceLocked(inv)) bad('This invoice was emailed or paid: cancel it with a credit note.');
        db.prepare("UPDATE invoices SET status='cancelled' WHERE id=?").run(inv.id);
        audit(user, 'invoice cancelled', 'invoice', inv.id, inv.number);
      }
    });
    return getInvoice(inv.id);
  }
  /** For jobs paid without an invoice in the app (or to correct one): record the customer's payment on the job itself. */
  function setJobPaid(user, id, paid, date) {
    const q = getQuote(id);
    if (q.status !== 'accepted') bad('Only accepted jobs can be marked as paid.');
    const inv = db.prepare("SELECT * FROM invoices WHERE quotation_id=? AND status<>'cancelled'").get(q.id);
    if (inv) bad(`This job has invoice ${inv.number}: record the payment on the invoice.`);
    db.prepare('UPDATE quotations SET paid_at=? WHERE id=?').run(paid ? isoDate(date, today()) : null, q.id);
    event(q.id, user, paid ? 'customer payment received' : 'payment removed');
    audit(user, paid ? 'job paid' : 'job marked unpaid', 'quotation', q.id, q.number);
    return getQuote(q.id);
  }

  // ---------- credit notes (cancel a final tax invoice) ----------
  function creditDetail(id) {
    const cn = db.prepare('SELECT * FROM credit_notes WHERE id=?').get(Number(id));
    if (!cn) throw new HttpError(404, 'Credit note not found.');
    const inv = getInvoice(cn.invoice_id);
    return { creditNote: cn, invoice: inv, lines: db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY pos').all(inv.id), client: db.prepare('SELECT * FROM clients WHERE id=?').get(cn.client_id) };
  }
  function createCreditNote(user, invoiceId, { date, reason } = {}) {
    const s = S();
    const why = clampStr(reason, 500);
    if (!why) bad('Write the reason for the credit note (it is printed on it).');
    return tx(db, () => {
      const inv = getInvoice(invoiceId);
      if (inv.status === 'cancelled') bad('This invoice is already cancelled.');
      if (db.prepare('SELECT 1 FROM credit_notes WHERE invoice_id=?').get(inv.id)) bad('This invoice already has a credit note.');
      let k = num(s.next_credit_no, 1), number = `${s.credit_prefix}${k}${s.invoice_suffix}`;
      while (db.prepare('SELECT 1 FROM credit_notes WHERE number=?').get(number)) number = `${s.credit_prefix}${++k}${s.invoice_suffix}`;
      setSetting('next_credit_no', k + 1);
      const id = Number(db.prepare('INSERT INTO credit_notes(number,invoice_id,client_id,issue_date,reason,net,vat_rate,vat,total,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(number, inv.id, inv.client_id, isoDate(date, today()), why, inv.net, inv.vat_rate, inv.vat, inv.total, user?.id || null, ctx.now()).lastInsertRowid);
      db.prepare("UPDATE invoices SET status='cancelled' WHERE id=?").run(inv.id);
      // a credited invoice is no longer paid: the job waits for a new invoice and payment
      if (inv.quotation_id) { db.prepare('UPDATE quotations SET paid_at=NULL WHERE id=?').run(inv.quotation_id); event(inv.quotation_id, user, `credit note ${number} issued for invoice ${inv.number}`, why); }
      audit(user, 'credit note issued', 'invoice', inv.id, `${number} cancels ${inv.number} - AED ${inv.total} - ${why}`);
      return id;
    });
  }
  function creditPdfBuffer(id) {
    const d = creditDetail(id);
    return creditNotePdf(d.creditNote, d.invoice, d.lines, d.client, S(), { generatedAt: ctx.now() });
  }
  async function sendCreditNote(user, id) {
    const d = creditDetail(id);
    if (!d.client.email) bad('Add the customer email address first.');
    const r = await ctx.notifier.creditNoteToClient(d.creditNote, d.invoice, d.client, creditPdfBuffer(id));
    if (r.status === 'failed') bad(`Email failed: ${r.error}`);
    db.prepare('UPDATE credit_notes SET sent_at=? WHERE id=?').run(ctx.now(), d.creditNote.id);
    audit(user, 'credit note emailed', 'invoice', d.invoice.id, `${d.creditNote.number} to ${d.client.email}`);
    return r;
  }
  /** Called after an online payment succeeds (demo checkout or Stripe webhook). Idempotent. */
  async function onlinePaid(invoiceId, paymentRef) {
    const inv = getInvoice(invoiceId);
    if (inv.status !== 'issued') return inv;
    markPaid(inv.id, { method: ctx.payments.name === 'stripe' ? 'Card (Stripe)' : 'Card (demo)', ref: paymentRef }, null);
    const fresh = getInvoice(inv.id);
    ctx.background(ctx.notifier.paymentReceived(fresh, db.prepare('SELECT * FROM clients WHERE id=?').get(inv.client_id)));
    return fresh;
  }
  function publicInvoice(number, token) {
    const inv = db.prepare('SELECT i.*, c.name client_name, c.email client_email FROM invoices i JOIN clients c ON c.id=i.client_id WHERE i.number=?').get(String(number));
    if (!inv || !token || inv.pay_token.length !== String(token).length || !crypto.timingSafeEqual(Buffer.from(inv.pay_token), Buffer.from(String(token)))) throw new HttpError(404, 'Invoice not found.');
    return inv;
  }

  // ---------- expenses ----------
  // The owner's expenses count straight away; expenses entered by Operations wait for the owner's approval.
  function saveExpense(user, e, id) {
    const amount = num(e.amount), qty = num(e.qty, 1) || 1;
    if (amount <= 0) bad('Enter the cost (more than 0).');
    const qid = e.quotation_id ? Number(e.quotation_id) : null;
    if (qid && !db.prepare('SELECT 1 FROM quotations WHERE id=?').get(qid)) bad('Linked quotation not found.');
    if (/loan/i.test(String(e.cost_type || ''))) bad('Personal loans are recorded on the Partners page, not as an expense.');
    // the owner's (and the Excel import's) expenses count straight away; Operations' expenses wait for approval
    const approved = isAdmin(user) || !user?.role;
    const status = approved ? 'approved' : 'pending';
    const vals = [isoDate(e.paid_on, today()), qid, COST_TYPES.includes(e.cost_type) ? e.cost_type : clampStr(e.cost_type || 'Others', 60), clampStr(e.description, 300), round2(amount), round2(qty), round2(amount * qty),
      clampStr(e.paid_by || 'Pending', 60), clampStr(e.remarks, 2000), status, approved ? user?.id || null : null, approved ? ctx.now() : null];
    const label = `${vals[0]} - ${vals[2]} - AED ${vals[6]}${vals[3] ? ' - ' + vals[3] : ''}`;
    if (id) {
      if (!db.prepare('SELECT 1 FROM expenses WHERE id=?').get(Number(id))) throw new HttpError(404, 'Expense not found.');
      db.prepare("UPDATE expenses SET paid_on=?,quotation_id=?,cost_type=?,description=?,amount=?,qty=?,total=?,paid_by=?,remarks=?,status=?,approved_by=?,approved_at=?,review_note='' WHERE id=?").run(...vals, Number(id));
      audit(user, status === 'pending' ? 'expense edited (waiting for approval)' : 'expense edited', 'expense', Number(id), label);
      if (status === 'pending') ctx.background(ctx.notifier.expenseForApproval(getExpense(Number(id)), user));
      return Number(id);
    }
    const newId = Number(db.prepare('INSERT INTO expenses(paid_on,quotation_id,cost_type,description,amount,qty,total,paid_by,remarks,status,approved_by,approved_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, user?.id || null, ctx.now()).lastInsertRowid);
    audit(user, status === 'pending' ? 'expense added (waiting for approval)' : 'expense added', 'expense', newId, label);
    if (status === 'pending') ctx.background(ctx.notifier.expenseForApproval(getExpense(newId), user));
    return newId;
  }
  function getExpense(id) {
    const e = db.prepare(`SELECT e.*, q.number quote_number, q.subject quote_subject, c.name client_name, u.name created_by_name FROM expenses e
      LEFT JOIN quotations q ON q.id=e.quotation_id LEFT JOIN clients c ON c.id=q.client_id LEFT JOIN users u ON u.id=e.created_by WHERE e.id=?`).get(Number(id));
    if (!e) throw new HttpError(404, 'Expense not found.');
    return e;
  }
  function reviewExpense(user, id, approve, note) {
    const e = getExpense(id);
    if (e.status === 'approved' && approve) return e;
    if (!approve && !clampStr(note, 500)) bad('Write what should be corrected.');
    db.prepare('UPDATE expenses SET status=?, review_note=?, approved_by=?, approved_at=? WHERE id=?').run(approve ? 'approved' : 'returned', approve ? '' : clampStr(note, 500), user.id, ctx.now(), e.id);
    audit(user, approve ? 'expense approved' : 'expense returned', 'expense', e.id, `${e.paid_on} - ${e.cost_type} - AED ${e.total}${note ? ' - ' + note : ''}`);
    return getExpense(e.id);
  }
  function listExpenses({ from, to, type, q: term, status } = {}) {
    let sql = `SELECT e.*, q.number quote_number, q.subject quote_subject, q.status quote_status, q.paid_at quote_paid_at, c.name client_name, u.name created_by_name,
      (SELECT COUNT(*) FROM attachments a WHERE a.entity='expense' AND a.entity_id=e.id) attach_count FROM expenses e
      LEFT JOIN quotations q ON q.id=e.quotation_id LEFT JOIN clients c ON c.id=q.client_id LEFT JOIN users u ON u.id=e.created_by WHERE 1=1`;
    const p = [];
    if (from) { sql += ' AND e.paid_on>=?'; p.push(from); }
    if (to) { sql += ' AND e.paid_on<=?'; p.push(to); }
    if (type) { sql += ' AND e.cost_type=?'; p.push(type); }
    if (['pending', 'approved', 'returned'].includes(status)) { sql += ' AND e.status=?'; p.push(status); }
    if (term) { sql += ' AND (e.description LIKE ? OR e.remarks LIKE ? OR q.number LIKE ? OR q.subject LIKE ?)'; const t = `%${String(term).slice(0, 60)}%`; p.push(t, t, t, t); }
    return splitRows(db.prepare(sql + ' ORDER BY e.paid_on DESC, e.id DESC LIMIT 2000').all(...p));
  }

  // ---------- profit sharing rules (the partners' deal) ----------
  // 1. Costs (material for jobs and all other expenses) come off the revenue first and are paid back to Mohamed (partner A).
  // 2. The profit left is split 60% Mohamed / 40% Ramdas (partner shares in Settings).
  // 3. It becomes payable only when the customer has paid the job.
  // 4. Personal loans (Partners page) are deducted from Ramdas's share and paid back to Mohamed.
  // 5. Declined jobs: no revenue, and their costs are carried by Mohamed alone (not shared, not paid back).
  const kindOf = (e) => (e.status && e.status !== 'approved' ? 'pending' : e.quote_status === 'declined' ? 'declined' : e.quotation_id ? 'job' : 'overhead');
  /** Adds revenue, profit, the two partner shares and the amount to pay back to each expense row, like the old Expenses Report.
   *  A job's revenue is shown once, on its first expense row. */
  function splitRows(rows) {
    const s = S();
    const pa = num(s.partner_a_share, 60) / 100;
    const holder = new Map(db.prepare(`SELECT (SELECT e.id FROM expenses e WHERE e.quotation_id=q.id AND e.status='approved' ORDER BY e.paid_on, e.id LIMIT 1) eid, q.net
      FROM quotations q WHERE q.status='accepted'`).all().filter((r) => r.eid).map((r) => [r.eid, r.net]));
    return rows.map((e) => {
      const kind = kindOf(e);
      const revenue = kind === 'job' ? round2(holder.get(e.id) || 0) : 0;
      const shared = kind === 'job' || kind === 'overhead';
      const profit = shared ? round2(revenue - e.total) : 0;
      const a = round2(profit * pa);
      return { ...e, kind, revenue, profit, share_a: a, share_b: round2(profit - a), pay_back: shared ? e.total : 0 };
    });
  }

  // ---------- finance report ----------
  // Revenue = net (before VAT) of accepted jobs, dated by the invoice date (or the acceptance date when not invoiced yet).
  // Costs = approved expenses by paid date. "Payable" figures only use jobs the customer has paid.
  const REV_DATE = `COALESCE((SELECT i.issue_date FROM invoices i WHERE i.quotation_id=q.id AND i.status<>'cancelled' ORDER BY i.id DESC LIMIT 1), q.closed_at, q.quote_date)`;
  function finance({ from, to } = {}) {
    const s = S();
    const inRange = (d) => (!from || d >= from) && (!to || d <= to);
    const jobs = db.prepare(`SELECT q.id,q.number,q.subject,q.quote_date,q.closed_at,q.paid_at,q.net,q.cost_total,q.share_paid,q.status,c.name client_name, ${REV_DATE} rev_date,
      (SELECT COALESCE(SUM(total),0) FROM expenses e WHERE e.quotation_id=q.id AND e.status='approved') actual_cost,
      (SELECT number FROM invoices i WHERE i.quotation_id=q.id AND i.status<>'cancelled') invoice_number,
      (SELECT status FROM invoices i WHERE i.quotation_id=q.id AND i.status<>'cancelled') invoice_status
      FROM quotations q JOIN clients c ON c.id=q.client_id WHERE q.status='accepted' ORDER BY rev_date DESC, q.id DESC`).all().filter((j) => inRange(j.rev_date));
    const allExps = db.prepare("SELECT e.*, q.status quote_status, q.paid_at quote_paid_at FROM expenses e LEFT JOIN quotations q ON q.id=e.quotation_id WHERE e.status='approved'").all().filter((e) => inRange(e.paid_on));
    const declined = allExps.filter((e) => e.quote_status === 'declined');
    const exps = allExps.filter((e) => e.quote_status !== 'declined');
    const loanRows = db.prepare('SELECT * FROM partner_loans ORDER BY taken_on').all().filter((l) => inRange(l.taken_on));
    const pa = num(s.partner_a_share, 60) / 100;
    const sum = (list, k = 'total') => round2(list.reduce((a, e) => a + e[k], 0));
    const shareA = (p) => round2(p * pa);
    const revenue = sum(jobs, 'net');
    const jobCost = sum(exps.filter((e) => e.quotation_id));
    const overheads = sum(exps.filter((e) => !e.quotation_id));
    const cost = round2(jobCost + overheads);
    const profit = round2(revenue - cost);
    const loans = sum(loanRows, 'amount');
    // payable: only jobs the customer has paid (overheads always count)
    const paidJobs = jobs.filter((j) => j.paid_at);
    const revenuePaid = sum(paidJobs, 'net');
    const jobCostPaid = sum(exps.filter((e) => e.quotation_id && e.quote_paid_at));
    const payable = round2(revenuePaid - jobCostPaid - overheads);
    const a = shareA(payable), bGross = round2(payable - a), b = round2(bGross - loans);
    const costsBack = round2(jobCostPaid + overheads); // costs paid back to Mohamed now; costs of unpaid jobs wait for the customer's payment
    const months = {};
    const m = (d) => (months[d.slice(0, 7)] ||= { month: d.slice(0, 7), revenue: 0, revenuePaid: 0, cost: 0, jobCostPaid: 0, overheads: 0, loans: 0 });
    jobs.forEach((j) => { const x = m(j.rev_date); x.revenue += j.net; if (j.paid_at) x.revenuePaid += j.net; });
    exps.forEach((e) => { const x = m(e.paid_on); x.cost += e.total; if (!e.quotation_id) x.overheads += e.total; else if (e.quote_paid_at) x.jobCostPaid += e.total; });
    loanRows.forEach((l) => { m(l.taken_on).loans += l.amount; });
    const monthly = Object.values(months).sort((x, y) => y.month.localeCompare(x.month)).map((x) => {
      const p = round2(x.revenue - x.cost), pay = round2(x.revenuePaid - x.jobCostPaid - x.overheads), ma = shareA(pay), back = round2(x.jobCostPaid + x.overheads + x.loans);
      return { month: x.month, revenue: round2(x.revenue), cost: round2(x.cost), profit: p, payable: pay, a: ma, bGross: round2(pay - ma), loans: round2(x.loans), b: round2(pay - ma - x.loans), payBack: back, dueA: round2(ma + back) };
    });
    const byType = {};
    exps.forEach((e) => { byType[e.cost_type] = round2((byType[e.cost_type] || 0) + e.total); });
    const outstanding = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM invoices WHERE status='issued'").get();
    return {
      partners: { a: s.partner_a, b: s.partner_b, aShare: pa * 100, bShare: round2(100 - pa * 100) },
      totals: {
        revenue, cost, jobCost, overheads, profit, margin: revenue ? round2((profit / revenue) * 100) : 0, jobs: jobs.length,
        revenuePaid, jobCostPaid, payable, revenueWaiting: round2(revenue - revenuePaid), jobCostWaiting: round2(jobCost - jobCostPaid), profitWaiting: round2(profit - payable), jobsWaiting: jobs.length - paidJobs.length,
        loans, a, bGross, b, costsBack, payBackA: round2(costsBack + loans), loansBack: loans, dueA: round2(a + costsBack + loans), dueB: b,
        declinedCost: sum(declined), pending: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM expenses WHERE status<>'approved'").get(),
      },
      monthly,
      costTypes: Object.entries(byType).sort((x, y) => y[1] - x[1]).map(([type, total]) => ({ type, total })),
      jobs: jobs.map((j) => { const pr = round2(j.net - j.actual_cost); const ja = shareA(pr); return { ...j, actual_cost: round2(j.actual_cost), profit: pr, a: ja, b: round2(pr - ja), margin: j.net ? round2((pr / j.net) * 100) : 0 }; }),
      loans: loanRows,
      ledger: { outstanding: { count: outstanding.n, total: round2(outstanding.s) }, unbilled: jobs.filter((j) => !j.invoice_number).length },
    };
  }

  // ---------- partners: what each partner is owed, what was paid out, personal loans ----------
  function partners() {
    const f = finance({});
    const t = f.totals;
    const pays = db.prepare('SELECT p.*, u.name created_by_name FROM partner_payments p LEFT JOIN users u ON u.id=p.created_by ORDER BY p.paid_on DESC, p.id DESC').all();
    const loans = db.prepare('SELECT l.*, u.name created_by_name FROM partner_loans l LEFT JOIN users u ON u.id=l.created_by ORDER BY l.taken_on DESC, l.id DESC').all();
    const paidTo = (k) => round2(pays.filter((p) => p.partner === k).reduce((a, p) => a + p.amount, 0));
    const A_ = { share: t.a, costsBack: t.costsBack, loansBack: t.loans, entitled: t.dueA, paid: paidTo('a') };
    const B_ = { share: t.bGross, loans: t.loans, entitled: t.dueB, paid: paidTo('b') };
    A_.balance = round2(A_.entitled - A_.paid); B_.balance = round2(B_.entitled - B_.paid);
    return { partners: f.partners, a: A_, b: B_, waiting: { revenue: t.revenueWaiting, jobCost: t.jobCostWaiting, profit: t.profitWaiting, jobs: t.jobsWaiting }, declinedCost: t.declinedCost, payments: pays, loans };
  }
  function savePayment(user, b) {
    const amount = round2(num(b.amount));
    if (amount <= 0) bad('Enter the amount paid.');
    if (!['a', 'b'].includes(b.partner)) bad('Choose the partner.');
    const s = S();
    const id = Number(db.prepare('INSERT INTO partner_payments(paid_on,partner,amount,method,note,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(isoDate(b.paid_on, today()), b.partner, amount, clampStr(b.method, 40), clampStr(b.note, 300), user.id, ctx.now()).lastInsertRowid);
    audit(user, 'partner payment recorded', 'payment', id, `${b.partner === 'a' ? s.partner_a : s.partner_b} - AED ${amount}${b.note ? ' - ' + b.note : ''}`);
    return id;
  }
  function saveLoan(user, b) {
    const amount = round2(num(b.amount));
    if (amount <= 0) bad('Enter the loan amount.');
    const id = Number(db.prepare('INSERT INTO partner_loans(taken_on,amount,note,created_by,created_at) VALUES(?,?,?,?,?)').run(isoDate(b.taken_on, today()), amount, clampStr(b.note, 300) || 'Personal loan', user.id, ctx.now()).lastInsertRowid);
    audit(user, 'personal loan recorded', 'loan', id, `AED ${amount}${b.note ? ' - ' + b.note : ''}`);
    return id;
  }
  function deletePayment(user, id) {
    const p = db.prepare('SELECT * FROM partner_payments WHERE id=?').get(Number(id));
    if (!p) throw new HttpError(404, 'Payment not found.');
    const s = S();
    toTrash(user, 'partner payment', `Payment to ${p.partner === 'a' ? s.partner_a : s.partner_b} ${p.paid_on} - AED ${p.amount}`, { partner_payments: [p] });
  }
  function deleteLoan(user, id) {
    const l = db.prepare('SELECT * FROM partner_loans WHERE id=?').get(Number(id));
    if (!l) throw new HttpError(404, 'Loan not found.');
    toTrash(user, 'personal loan', `Personal loan ${l.taken_on} - AED ${l.amount} - ${l.note}`, { partner_loans: [l] });
  }

  function dashboard(user) {
    const counts = Object.fromEntries(STATUSES.map((st) => [st, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) n FROM quotations GROUP BY status').all()) counts[r.status] = r.n;
    const out = {
      counts,
      pending: listQuotes({ status: 'pending' }).slice(0, 10),
      mine: !isAdmin(user) ? listQuotes({ mine: true, user }).slice(0, 10) : [],
      recent: listQuotes({}).slice(0, 8),
      quoteMonths: db.prepare(`SELECT substr(quote_date,1,7) month, COUNT(*) n, ROUND(SUM(net),2) quoted,
          ROUND(SUM(CASE WHEN status='accepted' THEN net ELSE 0 END),2) accepted, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) won
        FROM quotations GROUP BY month ORDER BY month DESC LIMIT 12`).all().reverse(),
    };
    const year = today().slice(0, 4);
    out.finance = finance({ from: `${year}-01-01`, to: `${year}-12-31` });
    out.year = year;
    out.pendingExpenses = db.prepare("SELECT COUNT(*) n FROM expenses WHERE status='pending'").get().n;
    const p = partners();
    out.balances = { a: p.a.balance, b: p.b.balance };
    return out;
  }

  // ---------- attachments ----------
  function listAttachments(entity, id) {
    return db.prepare('SELECT a.id,a.name,a.mime,a.size,a.storage,a.link,a.created_at,u.name uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by WHERE entity=? AND entity_id=? ORDER BY a.id').all(entity, Number(id));
  }
  function entityExists(entity, id) {
    const table = { quotation: 'quotations', invoice: 'invoices', expense: 'expenses' }[entity];
    if (!table || !db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(Number(id))) throw new HttpError(404, 'Record not found.');
  }
  async function addAttachment(user, entity, id, { name, mime, data, link }) {
    entityExists(entity, id);
    const fname = clampStr(name, 200) || 'file';
    let stored;
    let size = 0;
    if (link) {
      if (!/^https:\/\/(drive|docs)\.google\.com\//.test(String(link))) bad('Paste a Google Drive link (https://drive.google.com/...).');
      stored = { storage: 'link', drive_id: null, link: clampStr(link, 600), local_path: null };
    } else {
      const buf = Buffer.from(String(data || ''), 'base64');
      if (!buf.length) bad('The file is empty.');
      if (buf.length > 5 * 1024 * 1024) bad('Files must be 5 MB or smaller.');
      size = buf.length;
      stored = await ctx.storage.save(fname, clampStr(mime, 100) || 'application/octet-stream', buf);
    }
    const r = db.prepare('INSERT INTO attachments(entity,entity_id,name,mime,size,storage,drive_id,link,local_path,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(entity, Number(id), fname, clampStr(mime, 100) || 'application/octet-stream', size, stored.storage, stored.drive_id, stored.link, stored.local_path, user.id, ctx.now());
    return Number(r.lastInsertRowid);
  }
  function getAttachment(id) {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(id));
    if (!a) throw new HttpError(404, 'Attachment not found.');
    return a;
  }
  async function removeAttachment(id) {
    const a = getAttachment(id);
    await ctx.storage.remove(a);
    db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  }
  async function attachmentsForEmail(entity, id, ids) {
    const out = [];
    for (const aid of [].concat(ids || []).slice(0, 5)) {
      const a = getAttachment(aid);
      if (a.entity !== entity || a.entity_id !== Number(id) || a.storage === 'link') continue;
      out.push({ filename: a.name, contentType: a.mime, content: await ctx.storage.read(a) });
    }
    return out;
  }

  return {
    audit, listTrash, restoreTrash, purgeTrash, getExpense, reviewExpense, setJobPaid, creditDetail, createCreditNote, creditPdfBuffer, sendCreditNote,
    partners, savePayment, saveLoan, deletePayment, deleteLoan,
    upsertClient, updateClient, deleteClient, saveProduct,
    getQuote, quoteDetail, listQuotes, saveQuote, submitQuote, decideQuote, sendQuote, closeQuote, reopenQuote, deleteQuote, deleteInvoice, deleteProduct, deleteExpense, clientUsage, duplicateQuote, quotePdfBuffer, totals,
    getInvoice, createInvoice, invoiceDetail, invoicePdfBuffer, sendInvoice, markPaid, setInvoiceStatus, onlinePaid, publicInvoice,
    saveExpense, listExpenses, finance, dashboard,
    listAttachments, addAttachment, getAttachment, removeAttachment, setSetting,
  };
}
