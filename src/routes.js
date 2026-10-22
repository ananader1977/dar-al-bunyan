import { HttpError } from './http.js';
import { verifyPassword, hashPassword, validatePasswordStrength } from './auth.js';
import { SETTING_DEFAULTS, COST_TYPES, UNITS, tx } from './db.js';
import { buildXlsx } from './xlsx.js';
import { importExpensesReport } from './importer.js';
import { clampStr, isEmail } from './util.js';
import { money, dateKey } from './time.js';
import fs from 'node:fs';

const pdfHeaders = (name, download) => ({ 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\w.-]/g, '_')}"` });

export function registerRoutes(app, ctx) {
  const { db, service: svc, auth, config } = ctx;
  // Two roles: the owner ("admin") can do everything; Operations can do everything except approving quotations and
  // expenses, deleting, and managing users, settings, the Trash and backups.
  const U = auth.requireUser;
  const A = [auth.requireUser, auth.requireAdmin];
  const limit = (req, key, max, ms) => { if (!config.disableRateLimit) ctx.limit(`${key}:${config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip_ : req.ip_}`, max, ms); };
  const id = (req) => Number(req.params.id);

  // ---------- public ----------
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => {
    const s = ctx.settings();
    res.json({ company: s.company_name, tagline: s.company_tagline, payments: ctx.payments.name, email: !!config.smtp.host, storage: ctx.storage.kind });
  });
  app.post('/api/login', async (req, res) => {
    limit(req, 'login', 10, 10 * 60 * 1000);
    const { email, password } = await req.json();
    const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(email || '').trim().toLowerCase());
    if (!u || !verifyPassword(String(password || ''), u.password_hash)) throw new HttpError(401, 'Wrong email or password.');
    auth.startSession(res, u.id);
    svc.audit(u, 'signed in', 'user', u.id, u.email);
    res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  });
  app.post('/api/logout', (req, res) => { auth.endSession(res); res.json({ ok: true }); });
  app.get('/api/me', U, (req, res) => res.json({ user: req.user }));
  app.post('/api/me/password', U, async (req, res) => {
    const { current, password } = await req.json();
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!verifyPassword(String(current || ''), u.password_hash)) throw new HttpError(400, 'Your current password is wrong.');
    validatePasswordStrength(password);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), u.id);
    res.json({ ok: true });
  });

  // online payment of an invoice (link in the invoice email)
  const publicInv = (inv) => ({ number: inv.number, client: inv.client_name, subject: inv.subject, issue_date: inv.issue_date, due_date: inv.due_date, total: inv.total, vat: inv.vat, net: inv.net, status: inv.status, company: ctx.settings().company_name, provider: ctx.payments.name });
  app.get('/api/pay/:number', async (req, res) => {
    const inv = svc.publicInvoice(req.params.number, req.query.t);
    if (inv.status === 'issued' && req.query.check === '1') {
      for (const s of db.prepare("SELECT id FROM payment_sessions WHERE invoice_id=? AND status='open' ORDER BY created_at DESC LIMIT 3").all(inv.id)) {
        const r = await ctx.payments.retrieve(s.id).catch(() => ({ paid: false }));
        if (r.paid) { db.prepare("UPDATE payment_sessions SET status='paid', payment_ref=? WHERE id=?").run(r.paymentRef, s.id); await svc.onlinePaid(inv.id, r.paymentRef); break; }
      }
    }
    res.json(publicInv(svc.publicInvoice(req.params.number, req.query.t)));
  });
  app.get('/api/pay/:number/pdf', (req, res) => {
    const inv = svc.publicInvoice(req.params.number, req.query.t);
    res.send(svc.invoicePdfBuffer(inv.id), 'application/pdf', 200, pdfHeaders(`Invoice-${inv.number}.pdf`));
  });
  app.post('/api/pay/:number/checkout', async (req, res) => {
    limit(req, 'checkout', 20, 10 * 60 * 1000);
    const inv = svc.publicInvoice(req.params.number, req.query.t);
    if (inv.status !== 'issued') throw new HttpError(409, inv.status === 'paid' ? 'This invoice is already paid.' : 'This invoice is cancelled.');
    const s = await ctx.payments.createCheckout(inv);
    res.json({ url: s.url });
  });
  app.get('/api/pay-demo/:sid', (req, res) => {
    const s = db.prepare("SELECT p.*, i.number, i.total, c.name client FROM payment_sessions p JOIN invoices i ON i.id=p.invoice_id JOIN clients c ON c.id=i.client_id WHERE p.id=? AND p.provider='mock'").get(req.params.sid);
    if (!s) throw new HttpError(404, 'Payment session not found');
    res.json({ status: s.status, amount: s.amount, number: s.number, client: s.client });
  });
  app.post('/api/pay-demo/:sid/complete', async (req, res) => {
    if (ctx.payments.name !== 'mock') throw new HttpError(404, 'Not found');
    const r = ctx.payments.completeMock(req.params.sid);
    await svc.onlinePaid(r.invoiceId, r.paymentRef);
    res.json({ ok: true });
  });
  app.post('/api/webhooks/stripe', async (req, res) => {
    if (ctx.payments.name !== 'stripe') throw new HttpError(404, 'Not found');
    const evt = ctx.payments.verifyWebhook(await req.rawBody(), req.headers['stripe-signature']);
    if (evt.type === 'checkout.session.completed' && evt.data?.object?.payment_status === 'paid') {
      const o = evt.data.object;
      db.prepare("UPDATE payment_sessions SET status='paid', payment_ref=? WHERE id=?").run(o.payment_intent || o.id, o.id);
      const invId = Number(o.metadata?.invoice_id || o.client_reference_id);
      if (invId) await svc.onlinePaid(invId, o.payment_intent || o.id);
    }
    res.json({ received: true });
  });

  // ---------- signed in (admin + operations) ----------
  app.get('/api/app/dashboard', U, (req, res) => res.json(svc.dashboard(req.user)));
  app.get('/api/app/lookups', U, (req, res) => {
    const s = ctx.settings();
    res.json({
      clients: db.prepare('SELECT * FROM clients ORDER BY name').all(),
      products: db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all(),
      units: UNITS, costTypes: COST_TYPES,
      settings: { vat_rate: Number(s.vat_rate), quote_terms: s.quote_terms, quote_validity_days: Number(s.quote_validity_days), margin_target: Number(s.margin_target), margin_floor: Number(s.margin_floor), partner_a: s.partner_a, partner_b: s.partner_b, partner_a_share: Number(s.partner_a_share), partner_b_share: Number(s.partner_b_share) },
      storage: ctx.storage.kind,
    });
  });
  app.get('/api/app/quotations', U, (req, res) => res.json({ rows: svc.listQuotes({ status: req.query.status, q: req.query.q, mine: req.query.mine === '1', user: req.user }) }));
  app.post('/api/app/quotations', U, async (req, res) => res.json(svc.quoteDetail(svc.saveQuote(req.user, await req.json()), req.user)));
  app.get('/api/app/quotations/:id', U, (req, res) => res.json(svc.quoteDetail(id(req), req.user)));
  app.put('/api/app/quotations/:id', U, async (req, res) => res.json(svc.quoteDetail(svc.saveQuote(req.user, await req.json(), id(req)), req.user)));
  app.delete('/api/app/quotations/:id', ...A, (req, res) => { svc.deleteQuote(req.user, id(req)); res.json({ ok: true }); });
  app.post('/api/app/quotations/:id/paid', U, async (req, res) => { const b = await req.json(); svc.setJobPaid(req.user, id(req), b.paid !== false, b.date); res.json(svc.quoteDetail(id(req), req.user)); });
  app.post('/api/app/quotations/:id/duplicate', U, (req, res) => res.json({ id: svc.duplicateQuote(req.user, id(req)) }));
  app.post('/api/app/quotations/:id/submit', U, async (req, res) => { await svc.submitQuote(req.user, id(req)); res.json(svc.quoteDetail(id(req), req.user)); });
  app.post('/api/app/quotations/:id/send', U, async (req, res) => {
    const b = await req.json();
    await svc.sendQuote(req.user, id(req), { email: b.email !== false, message: b.message, attachmentIds: b.attachmentIds });
    res.json(svc.quoteDetail(id(req), req.user));
  });
  app.get('/api/app/quotations/:id/pdf', U, (req, res) => {
    const q = svc.getQuote(id(req));
    res.send(svc.quotePdfBuffer(q.id), 'application/pdf', 200, pdfHeaders(`Quotation-${q.number}.pdf`, req.query.download === '1'));
  });
  for (const [path, fn] of [
    ['approve', (u, i, b) => svc.decideQuote(u, i, true, b.note)],
    ['reject', (u, i, b) => svc.decideQuote(u, i, false, b.note)],
    ['reopen', (u, i) => svc.reopenQuote(u, i)],
  ]) {
    app.post(`/api/app/quotations/:id/${path}`, ...A, async (req, res) => { await fn(req.user, id(req), await req.json()); res.json(svc.quoteDetail(id(req), req.user)); });
  }
  // Operations and administrators can record the customer's answer (accepted / declined-cancelled).
  app.post('/api/app/quotations/:id/accept', U, async (req, res) => { await svc.closeQuote(req.user, id(req), true, await req.json()); res.json(svc.quoteDetail(id(req), req.user)); });
  app.post('/api/app/quotations/:id/decline', U, async (req, res) => { await svc.closeQuote(req.user, id(req), false, await req.json()); res.json(svc.quoteDetail(id(req), req.user)); });
  app.post('/api/app/quotations/:id/share-paid', U, async (req, res) => {
    const b = await req.json();
    db.prepare('UPDATE quotations SET share_paid=? WHERE id=?').run(b.paid ? 1 : 0, id(req));
    res.json({ ok: true });
  });

  app.post('/api/app/clients', U, async (req, res) => res.json({ id: svc.upsertClient(await req.json()) }));
  app.put('/api/app/clients/:id', U, async (req, res) => { svc.updateClient(id(req), await req.json()); res.json({ ok: true }); });
  app.get('/api/app/clients/:id/usage', ...A, (req, res) => res.json(svc.clientUsage(id(req))));
  app.delete('/api/app/clients/:id', ...A, (req, res) => { svc.deleteClient(req.user, id(req), { force: req.query.force === '1' }); res.json({ ok: true }); });
  app.delete('/api/app/products/:id', ...A, (req, res) => { svc.deleteProduct(req.user, id(req)); res.json({ ok: true }); });
  app.get('/api/app/products', U, (req, res) => res.json({ rows: db.prepare('SELECT p.*, (SELECT COUNT(*) FROM quote_lines l WHERE l.product_id=p.id) uses FROM products p ORDER BY active DESC, name').all() }));
  app.post('/api/app/products', U, async (req, res) => res.json({ id: svc.saveProduct(await req.json()) }));
  app.put('/api/app/products/:id', U, async (req, res) => res.json({ id: svc.saveProduct(await req.json(), id(req)) }));

  // attachments (everyone signed in)
  const canTouch = () => true;
  app.post('/api/app/attachments', U, async (req, res) => {
    const b = await req.json();
    if (!canTouch(req.user, b.entity)) throw new HttpError(403, 'Only an administrator can attach files here.');
    const aid = await svc.addAttachment(req.user, b.entity, b.id, b);
    res.json({ id: aid, attachments: svc.listAttachments(b.entity, b.id) });
  });
  app.get('/api/app/attachments', U, (req, res) => {
    if (!canTouch(req.user, req.query.entity)) throw new HttpError(403, 'Not allowed.');
    res.json({ attachments: svc.listAttachments(String(req.query.entity), Number(req.query.id)) });
  });
  app.get('/api/app/attachments/:id', U, async (req, res) => {
    const a = svc.getAttachment(id(req));
    if (!canTouch(req.user, a.entity)) throw new HttpError(403, 'Not allowed.');
    if (a.storage !== 'local' && req.query.download !== '1') return res.redirect(a.link);
    if (a.storage === 'link') return res.redirect(a.link);
    res.send(await ctx.storage.read(a), a.mime, 200, { 'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${a.name.replace(/[^\w.-]/g, '_')}"` });
  });
  app.delete('/api/app/attachments/:id', U, async (req, res) => {
    const a = svc.getAttachment(id(req));
    if (req.user.role !== 'admin' && a.uploaded_by !== req.user.id) throw new HttpError(403, 'You can only remove files you added.');
    await svc.removeAttachment(a.id);
    res.json({ attachments: svc.listAttachments(a.entity, a.entity_id) });
  });

  // ---------- invoices and credit notes ----------
  app.get('/api/app/invoices', U, (req, res) => {
    const st = ['issued', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    res.json({ rows: db.prepare(`SELECT i.id,i.number,i.issue_date,i.due_date,i.total,i.net,i.vat,i.status,i.paid_at,i.sent_at,i.subject,c.name client_name,q.number quote_number,q.id quotation_id,
      cn.id credit_id, cn.number credit_number
      FROM invoices i JOIN clients c ON c.id=i.client_id LEFT JOIN quotations q ON q.id=i.quotation_id LEFT JOIN credit_notes cn ON cn.invoice_id=i.id ${st ? 'WHERE i.status=?' : ''} ORDER BY i.issue_date DESC, i.id DESC`).all(...(st ? [st] : []) ) });
  });
  app.post('/api/app/quotations/:id/invoice', U, async (req, res) => res.json(svc.invoiceDetail(svc.createInvoice(req.user, id(req), await req.json()))));
  app.get('/api/app/invoices/:id', U, (req, res) => res.json(svc.invoiceDetail(id(req))));
  app.get('/api/app/invoices/:id/pdf', U, (req, res) => {
    const inv = svc.getInvoice(id(req));
    res.send(svc.invoicePdfBuffer(inv.id), 'application/pdf', 200, pdfHeaders(`Invoice-${inv.number}.pdf`, req.query.download === '1'));
  });
  app.post('/api/app/invoices/:id/send', U, async (req, res) => { const b = await req.json(); res.json(await svc.sendInvoice(req.user, id(req), { attachmentIds: b.attachmentIds })); });
  app.post('/api/app/invoices/:id/paid', U, async (req, res) => { svc.markPaid(id(req), await req.json(), req.user); res.json(svc.invoiceDetail(id(req))); });
  app.post('/api/app/invoices/:id/status', U, async (req, res) => {
    const b = await req.json();
    if (!['issued', 'cancelled'].includes(b.status)) throw new HttpError(400, 'Invalid status');
    svc.setInvoiceStatus(req.user, id(req), b.status);
    res.json(svc.invoiceDetail(id(req)));
  });
  app.delete('/api/app/invoices/:id', ...A, (req, res) => { svc.deleteInvoice(req.user, id(req)); res.json({ ok: true }); });
  app.post('/api/app/invoices/:id/credit-note', U, async (req, res) => { const cid = svc.createCreditNote(req.user, id(req), await req.json()); res.json({ id: cid, ...svc.invoiceDetail(id(req)) }); });
  app.get('/api/app/credit-notes/:id/pdf', U, (req, res) => {
    const d = svc.creditDetail(id(req));
    res.send(svc.creditPdfBuffer(d.creditNote.id), 'application/pdf', 200, pdfHeaders(`Credit-note-${d.creditNote.number}.pdf`, req.query.download === '1'));
  });
  app.post('/api/app/credit-notes/:id/send', U, async (req, res) => res.json(await svc.sendCreditNote(req.user, id(req))));

  // ---------- expenses (Operations' expenses wait for the owner's approval) ----------
  app.get('/api/app/expenses', U, (req, res) => res.json({ rows: svc.listExpenses(req.query) }));
  app.post('/api/app/expenses', U, async (req, res) => res.json({ id: svc.saveExpense(req.user, await req.json()) }));
  app.put('/api/app/expenses/:id', U, async (req, res) => res.json({ id: svc.saveExpense(req.user, await req.json(), id(req)) }));
  app.delete('/api/app/expenses/:id', ...A, (req, res) => { svc.deleteExpense(req.user, id(req)); res.json({ ok: true }); });
  app.post('/api/app/expenses/:id/approve', ...A, (req, res) => res.json(svc.reviewExpense(req.user, id(req), true)));
  app.post('/api/app/expenses/:id/return', ...A, async (req, res) => res.json(svc.reviewExpense(req.user, id(req), false, (await req.json()).note)));
  app.get('/api/app/expenses/:id/attachments', U, (req, res) => res.json({ attachments: svc.listAttachments('expense', id(req)) }));

  app.get('/api/app/finance', U, (req, res) => res.json(svc.finance({ from: req.query.from || null, to: req.query.to || null })));

  // ---------- partners: payouts and personal loans ----------
  app.get('/api/app/partners', U, (req, res) => res.json(svc.partners()));
  app.post('/api/app/partners/payments', U, async (req, res) => res.json({ id: svc.savePayment(req.user, await req.json()) }));
  app.delete('/api/app/partners/payments/:id', ...A, (req, res) => { svc.deletePayment(req.user, id(req)); res.json({ ok: true }); });
  app.post('/api/app/partners/loans', U, async (req, res) => res.json({ id: svc.saveLoan(req.user, await req.json()) }));
  app.delete('/api/app/partners/loans/:id', ...A, (req, res) => { svc.deleteLoan(req.user, id(req)); res.json({ ok: true }); });

  // ---------- owner: Trash, activity log, backups, weekly email ----------
  app.get('/api/app/trash', ...A, (req, res) => res.json({ rows: svc.listTrash() }));
  app.post('/api/app/trash/:id/restore', ...A, (req, res) => { const t = svc.restoreTrash(req.user, id(req)); res.json({ ok: true, label: t.label }); });
  app.get('/api/app/activity', ...A, (req, res) => {
    const term = String(req.query.q || '').slice(0, 60);
    res.json({ rows: db.prepare(`SELECT a.*, u.name user_name FROM activity a LEFT JOIN users u ON u.id=a.user_id ${term ? 'WHERE a.action LIKE ? OR a.summary LIKE ?' : ''} ORDER BY a.ts DESC, a.id DESC LIMIT 500`).all(...(term ? [`%${term}%`, `%${term}%`] : [])) });
  });
  app.get('/api/app/backups', ...A, (req, res) => res.json({ rows: ctx.jobs.listBackups(), storage: ctx.storage.kind }));
  app.post('/api/app/backups', ...A, async (req, res) => res.json(await ctx.jobs.backup(req.user)));
  app.get('/api/app/backups/:id/download', ...A, (req, res) => {
    const b = db.prepare('SELECT * FROM backups WHERE id=?').get(id(req));
    if (!b) throw new HttpError(404, 'Backup not found.');
    const file = ctx.jobs.backupFile(b);
    if (file && fs.existsSync(file)) return res.send(fs.readFileSync(file), 'application/vnd.sqlite3', 200, { 'Content-Disposition': `attachment; filename="${b.name}"` });
    if (b.link) return res.redirect(b.link);
    throw new HttpError(404, 'This backup is no longer on the server.');
  });
  app.get('/api/app/weekly-email', ...A, (req, res) => res.json(ctx.jobs.weeklySummary()));
  app.post('/api/app/weekly-email', ...A, async (req, res) => res.json(await ctx.jobs.sendWeekly(req.user)));

  // ---------- Excel export of each page (respects the page filters) ----------
  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const sendXlsx = (res, name, sheets) => res.send(buildXlsx(sheets), XLSX_TYPE, 200, { 'Content-Disposition': `attachment; filename="${name}-${dateKey(ctx.now())}.xlsx"` });
  const quoteCols = [
    { header: 'Number', key: 'number', width: 14 }, { header: 'Date', key: 'quote_date', width: 12 }, { header: 'Customer', key: 'client_name', width: 26 }, { header: 'Subject', key: 'subject', width: 50 },
    { header: 'Site', key: 'site', width: 20 }, { header: 'Status', key: 'status', width: 11 }, { header: 'Net (excl. VAT)', key: 'net', type: 'money' }, { header: 'VAT', value: (r) => Math.round((r.total - r.net) * 100) / 100, type: 'money' },
    { header: 'Total', key: 'total', type: 'money' }, { header: 'Estimated cost', key: 'cost_total', type: 'money' }, { header: 'Profit', value: (r) => Math.round((r.net - r.cost_total) * 100) / 100, type: 'money' },
    { header: 'Margin %', value: (r) => (r.net ? Math.round(((r.net - r.cost_total) / r.net) * 1000) / 10 : 0), type: 'number', width: 10 },
    { header: 'LPO', key: 'lpo', width: 16 }, { header: 'Invoice', key: 'invoice_number', width: 14 }, { header: 'Attachments', key: 'attach_count', type: 'number', width: 11 }, { header: 'Created by', key: 'created_by_name', width: 16 }];
  app.get('/api/app/export/quotations.xlsx', U, (req, res) => {
    const rows = svc.listQuotes({ status: req.query.status, q: req.query.q, user: req.user });
    const ids = rows.map((r) => r.id);
    const lines = ids.length ? db.prepare(`SELECT l.*, q.number FROM quote_lines l JOIN quotations q ON q.id=l.quotation_id WHERE l.quotation_id IN (${ids.map(() => '?').join(',')}) ORDER BY q.number, l.pos`).all(...ids) : [];
    sendXlsx(res, req.query.status === 'pending' ? 'Approvals' : 'Quotations', [
      { name: 'Quotations', columns: quoteCols, rows },
      { name: 'Items', columns: [{ header: 'Quotation', key: 'number', width: 10 }, { header: 'Description', key: 'description', width: 50 }, { header: 'Qty', key: 'qty', type: 'number', width: 8 }, { header: 'Unit', key: 'unit', width: 10 },
        { header: 'Unit price', key: 'unit_price', type: 'money' }, { header: 'Amount', key: 'amount', type: 'money' }, { header: 'Unit cost', key: 'unit_cost', type: 'money' }, { header: 'Cost', key: 'cost', type: 'money' }], rows: lines },
    ]);
  });
  app.get('/api/app/export/customers.xlsx', U, (req, res) => sendXlsx(res, 'Customers', [{ name: 'Customers', columns: [
    { header: 'Customer', key: 'name', width: 30 }, { header: 'Contact', key: 'contact', width: 20 }, { header: 'Email', key: 'email', width: 28 }, { header: 'Phone', key: 'phone', width: 16 }, { header: 'Address', key: 'address', width: 30 }, { header: 'TRN', key: 'trn', width: 18 },
    { header: 'Quotations', key: 'quotes', type: 'number', width: 11 }, { header: 'Accepted value (net)', key: 'accepted', type: 'money', width: 18 }, { header: 'Notes', key: 'notes', width: 30 }],
    rows: db.prepare("SELECT c.*, (SELECT COUNT(*) FROM quotations q WHERE q.client_id=c.id) quotes, (SELECT COALESCE(SUM(net),0) FROM quotations q WHERE q.client_id=c.id AND q.status='accepted') accepted FROM clients c ORDER BY name").all() }]));
  app.get('/api/app/export/products.xlsx', U, (req, res) => sendXlsx(res, 'Products', [{ name: 'Products', columns: [
    { header: 'Product / service', key: 'name', width: 45 }, { header: 'Unit', key: 'unit', width: 10 }, { header: 'Price', key: 'price', type: 'money' }, { header: 'Cost', key: 'cost', type: 'money' },
    { header: 'Margin %', value: (r) => (r.price ? Math.round(((r.price - r.cost) / r.price) * 1000) / 10 : 0), type: 'number', width: 10 }, { header: 'Category', key: 'category', width: 16 }, { header: 'Active', value: (r) => (r.active ? 'Yes' : 'No'), width: 8 }],
    rows: db.prepare('SELECT * FROM products ORDER BY name').all() }]));
  app.get('/api/app/export/invoices.xlsx', U, (req, res) => {
    const st = ['issued', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    sendXlsx(res, 'Invoices', [{ name: 'Invoices', columns: [
      { header: 'Invoice', key: 'number', width: 14 }, { header: 'Date', key: 'issue_date', width: 12 }, { header: 'Due', key: 'due_date', width: 12 }, { header: 'Customer', key: 'client_name', width: 26 }, { header: 'Subject', key: 'subject', width: 45 },
      { header: 'Quotation', key: 'quote_number', width: 10 }, { header: 'LPO', key: 'lpo', width: 14 }, { header: 'Net', key: 'net', type: 'money' }, { header: 'VAT', key: 'vat', type: 'money' }, { header: 'Total', key: 'total', type: 'money' },
      { header: 'Status', value: (r) => (r.status === 'issued' ? 'unpaid' : r.status), width: 10 }, { header: 'Paid on', key: 'paid_at', width: 12 }, { header: 'Method', key: 'payment_method', width: 14 }, { header: 'Reference', key: 'payment_ref', width: 16 }],
      rows: db.prepare(`SELECT i.*, c.name client_name, q.number quote_number FROM invoices i JOIN clients c ON c.id=i.client_id LEFT JOIN quotations q ON q.id=i.quotation_id ${st ? 'WHERE i.status=?' : ''} ORDER BY i.issue_date DESC`).all(...(st ? [st] : [])) },
    { name: 'Credit notes', columns: [{ header: 'Credit note', key: 'number', width: 16 }, { header: 'Date', key: 'issue_date', width: 12 }, { header: 'Cancels invoice', key: 'invoice_number', width: 14 }, { header: 'Customer', key: 'client_name', width: 26 },
      { header: 'Net', key: 'net', type: 'money' }, { header: 'VAT', key: 'vat', type: 'money' }, { header: 'Total', key: 'total', type: 'money' }, { header: 'Reason', key: 'reason', width: 40 }],
      rows: db.prepare('SELECT cn.*, i.number invoice_number, c.name client_name FROM credit_notes cn JOIN invoices i ON i.id=cn.invoice_id JOIN clients c ON c.id=cn.client_id ORDER BY cn.issue_date DESC').all() }]);
  });
  app.get('/api/app/export/expenses.xlsx', U, (req, res) => {
    const s = ctx.settings();
    let rows = svc.listExpenses(req.query);
    if (req.query.quotation) rows = rows.filter((e) => e.quotation_id === Number(req.query.quotation));
    sendXlsx(res, 'Expenses', [{ name: 'Expenses', columns: [
      { header: 'Paid On', key: 'paid_on', width: 12 }, { header: 'Quotation Number', key: 'quote_number', width: 12 }, { header: 'Customer', key: 'client_name', width: 20 }, { header: 'Subject / description', value: (r) => r.quote_subject || r.description, width: 48 },
      { header: 'Quotation Status', key: 'quote_status', width: 12 }, { header: 'Cost', key: 'amount', type: 'money' }, { header: 'Quantities', key: 'qty', type: 'number', width: 10 }, { header: 'Total Actual Costs', key: 'total', type: 'money' },
      { header: 'Revenue', key: 'revenue', type: 'money' }, { header: 'Profit', key: 'profit', type: 'money' },
      { header: `${s.partner_a} Profit ${s.partner_a_share}%`, key: 'share_a', type: 'money', width: 16 }, { header: `${s.partner_b} Profit ${s.partner_b_share}%`, key: 'share_b', type: 'money', width: 16 },
      { header: 'Cost Type', key: 'cost_type', width: 16 }, { header: 'Paid By', key: 'paid_by', width: 10 }, { header: `Cost to pay back to ${s.partner_a}`, key: 'pay_back', type: 'money', width: 14 },
      { header: 'Approval', key: 'status', width: 11 }, { header: 'Entered by', key: 'created_by_name', width: 16 },
      { header: 'Attachments', key: 'attach_count', type: 'number', width: 11 }, { header: 'Remarks', key: 'remarks', width: 40 }], rows }]);
  });
  app.get('/api/app/export/finance.xlsx', U, (req, res) => {
    const f = svc.finance({ from: req.query.from || null, to: req.query.to || null });
    const p = f.partners, t = f.totals;
    sendXlsx(res, 'Financial-report', [
      { name: 'Summary', columns: [{ header: 'Item', key: 'k', width: 46 }, { header: 'AED', key: 'v', type: 'money', width: 16 }], rows: [
        { k: `Period ${req.query.from || 'start'} to ${req.query.to || 'today'} (revenue by invoice date)`, v: '' },
        { k: `Revenue earned (${t.jobs} accepted jobs, excl. VAT)`, v: t.revenue }, { k: 'Material / job costs', v: t.jobCost }, { k: 'Other expenses', v: t.overheads },
        { k: 'Total costs', v: t.cost }, { k: 'Profit earned', v: t.profit }, { k: 'Margin %', v: t.margin },
        { k: `Waiting for customer payment (${t.jobsWaiting} jobs): revenue`, v: t.revenueWaiting }, { k: 'Waiting for customer payment: profit', v: t.profitWaiting },
        { k: 'Profit payable now (customers paid)', v: t.payable },
        { k: `${p.a} ${p.aShare}% of payable profit`, v: t.a }, { k: `${p.b} ${p.bShare}% of payable profit`, v: t.bGross }, { k: 'Left over (payable − both shares)', v: Math.round((t.payable - t.a - t.bGross) * 100) / 100 },
        { k: `Personal loans taken by ${p.b}`, v: t.loans },
        { k: `${p.a}: costs to pay back`, v: t.costsBack }, { k: `${p.a}: personal loans to pay back`, v: t.loans }, { k: `Total to ${p.a}`, v: t.dueA }, { k: `Total to ${p.b}`, v: t.dueB },
        { k: `Costs on declined jobs (carried by ${p.a}, not shared)`, v: t.declinedCost }, { k: 'Unpaid invoices', v: f.ledger.outstanding.total }] },
      { name: 'By month', columns: [{ header: 'Month', key: 'month' }, { header: 'Revenue', key: 'revenue', type: 'money' }, { header: 'Costs', key: 'cost', type: 'money' }, { header: 'Profit earned', key: 'profit', type: 'money' }, { header: 'Profit payable', key: 'payable', type: 'money' }, { header: `${p.a} ${p.aShare}%`, key: 'a', type: 'money' }, { header: `${p.b} ${p.bShare}%`, key: 'bGross', type: 'money' }, { header: 'Personal loans', key: 'loans', type: 'money' }, { header: `${p.b} to pay`, key: 'b', type: 'money' }, { header: `To pay back to ${p.a}`, key: 'payBack', type: 'money' }, { header: `Total to ${p.a}`, key: 'dueA', type: 'money' }], rows: f.monthly },
      { name: 'Personal loans', columns: [{ header: 'Date', key: 'taken_on', width: 12 }, { header: 'Amount', key: 'amount', type: 'money' }, { header: 'Note', key: 'note', width: 40 }], rows: f.loans },
      { name: 'Costs by type', columns: [{ header: 'Cost type', key: 'type', width: 20 }, { header: 'Total', key: 'total', type: 'money' }], rows: f.costTypes },
      { name: 'Accepted jobs', columns: [{ header: 'Job', key: 'number' }, { header: 'Revenue date', key: 'rev_date', width: 12 }, { header: 'Customer paid', key: 'paid_at', width: 12 }, { header: 'Customer', key: 'client_name', width: 22 }, { header: 'Subject', key: 'subject', width: 48 }, { header: 'Revenue', key: 'net', type: 'money' },
        { header: 'Estimated cost', key: 'cost_total', type: 'money' }, { header: 'Actual cost', key: 'actual_cost', type: 'money' }, { header: 'Profit', key: 'profit', type: 'money' }, { header: 'Margin %', key: 'margin', type: 'number', width: 10 },
        { header: `${p.a} ${p.aShare}%`, key: 'a', type: 'money' }, { header: `${p.b} ${p.bShare}%`, key: 'b', type: 'money' }, { header: 'Invoice', key: 'invoice_number', width: 14 }, { header: 'Share paid', value: (r) => (r.share_paid ? 'Yes' : 'No'), width: 10 }], rows: f.jobs },
    ]);
  });
  app.get('/api/app/export/messages.xlsx', U, (req, res) => sendXlsx(res, 'Messages', [{ name: 'Messages', columns: [{ header: 'Sent', value: (r) => r.ts, type: 'date', width: 18 }, { header: 'To', key: 'to_addr', width: 34 }, { header: 'Subject', key: 'subject', width: 50 }, { header: 'Status', key: 'status', width: 10 }, { header: 'Error', key: 'error', width: 30 }, { header: 'Attachment', key: 'attachment', width: 26 }],
    rows: db.prepare('SELECT * FROM outbox ORDER BY id DESC').all() }]));
  app.get('/api/app/export/users.xlsx', ...A, (req, res) => sendXlsx(res, 'Users', [{ name: 'Users', columns: [{ header: 'Name', key: 'name', width: 22 }, { header: 'Email', key: 'email', width: 30 }, { header: 'Role', key: 'role', width: 12 }, { header: 'Active', value: (r) => (r.active ? 'Yes' : 'No'), width: 8 }],
    rows: db.prepare('SELECT * FROM users ORDER BY role, name').all() }]));

  app.get('/api/app/export.xlsx', U, (req, res) => {
    const s = ctx.settings();
    const exps = svc.listExpenses({});
    const quotes = db.prepare('SELECT q.*, c.name client_name, u.name created_by_name FROM quotations q JOIN clients c ON c.id=q.client_id LEFT JOIN users u ON u.id=q.created_by ORDER BY q.quote_date DESC').all();
    const buf = buildXlsx([
      { name: 'Expenses_Report', columns: [
        { header: 'Paid On', key: 'paid_on', width: 12 }, { header: 'Quotation Number', key: 'quote_number', width: 12 }, { header: 'Subject', value: (r) => r.quote_subject || r.description, width: 48 },
        { header: 'Quotation Status', key: 'quote_status', width: 12 }, { header: 'Cost', key: 'amount', type: 'money' }, { header: 'Quantities', key: 'qty', type: 'number', width: 10 },
        { header: 'Total Actual Costs', key: 'total', type: 'money' }, { header: 'Revenue', key: 'revenue', type: 'money' }, { header: 'Profit', key: 'profit', type: 'money' },
        { header: `${s.partner_a} Profit ${s.partner_a_share}%`, key: 'share_a', type: 'money', width: 16 }, { header: `${s.partner_b} Profit ${s.partner_b_share}%`, key: 'share_b', type: 'money', width: 16 },
        { header: 'Cost Type', key: 'cost_type' }, { header: 'Paid By', key: 'paid_by', width: 10 }, { header: 'Approval', key: 'status', width: 11 }, { header: 'Remarks', key: 'remarks', width: 40 }], rows: exps },
      { name: 'Personal loans', columns: [{ header: 'Date', key: 'taken_on', width: 12 }, { header: 'Amount', key: 'amount', type: 'money' }, { header: 'Note', key: 'note', width: 40 }], rows: db.prepare('SELECT * FROM partner_loans ORDER BY taken_on').all() },
      { name: 'Partner payments', columns: [{ header: 'Date', key: 'paid_on', width: 12 }, { header: 'Partner', value: (r) => (r.partner === 'a' ? s.partner_a : s.partner_b), width: 14 }, { header: 'Amount', key: 'amount', type: 'money' }, { header: 'Method', key: 'method', width: 14 }, { header: 'Note', key: 'note', width: 40 }], rows: db.prepare('SELECT * FROM partner_payments ORDER BY paid_on').all() },
      { name: 'Credit notes', columns: [{ header: 'Number', key: 'number', width: 16 }, { header: 'Date', key: 'issue_date', width: 12 }, { header: 'Invoice', key: 'invoice_number', width: 14 }, { header: 'Net', key: 'net', type: 'money' }, { header: 'VAT', key: 'vat', type: 'money' }, { header: 'Total', key: 'total', type: 'money' }, { header: 'Reason', key: 'reason', width: 40 }],
        rows: db.prepare('SELECT cn.*, i.number invoice_number FROM credit_notes cn JOIN invoices i ON i.id=cn.invoice_id ORDER BY cn.issue_date').all() },
      { name: 'Quotations', columns: [
        { header: 'Number', key: 'number', width: 14 }, { header: 'Date', key: 'quote_date', width: 12 }, { header: 'Customer', key: 'client_name', width: 24 }, { header: 'Subject', key: 'subject', width: 48 },
        { header: 'Status', key: 'status' }, { header: 'Net (excl. VAT)', key: 'net', type: 'money' }, { header: 'VAT', key: 'vat', type: 'money' }, { header: 'Total', key: 'total', type: 'money' },
        { header: 'Estimated cost', key: 'cost_total', type: 'money' }, { header: 'LPO', key: 'lpo' }, { header: 'Created by', key: 'created_by_name' }], rows: quotes },
      { name: 'Invoices', columns: [{ header: 'Number', key: 'number' }, { header: 'Date', key: 'issue_date' }, { header: 'Due', key: 'due_date' }, { header: 'Customer', key: 'client_name', width: 24 }, { header: 'Subject', key: 'subject', width: 48 }, { header: 'Net', key: 'net', type: 'money' }, { header: 'VAT', key: 'vat', type: 'money' }, { header: 'Total', key: 'total', type: 'money' }, { header: 'Status', key: 'status' }, { header: 'Paid on', key: 'paid_at' }],
        rows: db.prepare('SELECT i.*, c.name client_name FROM invoices i JOIN clients c ON c.id=i.client_id ORDER BY issue_date DESC').all() },
      { name: 'Profit by month', columns: [{ header: 'Month', key: 'month' }, { header: 'Revenue', key: 'revenue', type: 'money' }, { header: 'Costs', key: 'cost', type: 'money' }, { header: 'Profit earned', key: 'profit', type: 'money' }, { header: 'Profit payable', key: 'payable', type: 'money' }, { header: `${s.partner_a} ${s.partner_a_share}%`, key: 'a', type: 'money' }, { header: `${s.partner_b} ${s.partner_b_share}%`, key: 'bGross', type: 'money' }],
        rows: svc.finance({}).monthly },
      { name: 'Customers', columns: ['name', 'contact', 'email', 'phone', 'address', 'trn', 'notes'].map((k) => ({ header: k[0].toUpperCase() + k.slice(1), key: k, width: 24 })), rows: db.prepare('SELECT * FROM clients ORDER BY name').all() },
      { name: 'Products', columns: [{ header: 'Name', key: 'name', width: 40 }, { header: 'Unit', key: 'unit' }, { header: 'Price', key: 'price', type: 'money' }, { header: 'Cost', key: 'cost', type: 'money' }, { header: 'Category', key: 'category' }], rows: db.prepare('SELECT * FROM products ORDER BY name').all() },
    ]);
    res.send(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 200, { 'Content-Disposition': `attachment; filename="DarAlBunyan-export-${new Date(ctx.now()).toISOString().slice(0, 10)}.xlsx"` });
  });
  app.post('/api/app/import', ...A, async (req, res) => {
    const b = await req.json();
    const buf = Buffer.from(String(b.data || ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'Choose the Excel file first.');
    const r = importExpensesReport(ctx, buf, req.user);
    svc.audit(req.user, 'Excel imported', 'import', null, JSON.stringify(r));
    res.json(r);
  });

  app.get('/api/app/users', ...A, (req, res) => res.json({ rows: db.prepare('SELECT id,email,name,role,active,created_at FROM users ORDER BY role, name').all() }));
  app.post('/api/app/users', ...A, async (req, res) => {
    const b = await req.json();
    const email = String(b.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (!['admin', 'operations'].includes(b.role)) throw new HttpError(400, 'Choose a role.');
    validatePasswordStrength(b.password);
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(400, 'A user with this email already exists.');
    db.prepare('INSERT INTO users(email,name,role,password_hash,created_at) VALUES(?,?,?,?,?)').run(email, clampStr(b.name, 80) || email, b.role, hashPassword(b.password), ctx.now());
    svc.audit(req.user, 'user added', 'user', null, `${email} (${b.role === 'admin' ? 'owner' : 'operations'})`);
    res.json({ ok: true });
  });
  app.put('/api/app/users/:id', ...A, async (req, res) => {
    const b = await req.json();
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id(req));
    if (!u) throw new HttpError(404, 'User not found.');
    const role = ['admin', 'operations'].includes(b.role) ? b.role : u.role;
    const active = b.active === undefined ? u.active : b.active ? 1 : 0;
    const email = b.email ? String(b.email).trim().toLowerCase() : u.email;
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    tx(db, () => {
      db.prepare('UPDATE users SET name=?,email=?,role=?,active=? WHERE id=?').run(clampStr(b.name ?? u.name, 80), email, role, active, u.id);
      if (!db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n) throw new HttpError(400, 'At least one active administrator is required.');
    });
    if (b.password) { validatePasswordStrength(b.password); db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.password), u.id); }
    svc.audit(req.user, 'user changed', 'user', u.id, `${email} - ${role === 'admin' ? 'owner' : 'operations'}${active ? '' : ' - disabled'}${b.password ? ' - new password' : ''}`);
    res.json({ ok: true });
  });

  app.get('/api/app/settings', ...A, (req, res) => res.json({ settings: ctx.settings(), email: { configured: !!config.smtp.host, user: config.smtp.user, from: config.smtp.from }, storage: ctx.storage.kind, payments: ctx.payments.name }));
  app.put('/api/app/settings', ...A, async (req, res) => {
    const b = await req.json();
    const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const before = ctx.settings();
    const changed = Object.keys(SETTING_DEFAULTS).filter((k) => b[k] !== undefined && String(b[k]) !== String(before[k]));
    for (const k of Object.keys(SETTING_DEFAULTS)) if (b[k] !== undefined) up.run(k, clampStr(b[k], 5000));
    if (changed.length) svc.audit(req.user, 'settings changed', 'settings', null, changed.join(', '));
    res.json({ settings: ctx.settings() });
  });
  app.post('/api/app/email-test', ...A, async (req, res) => {
    const r = await ctx.notifier.email({ to: req.user.email, subject: 'Test email from Dar Al Bunyan app', text: `Email is working. Sent at ${new Date(ctx.now()).toISOString()}.`, html: `<p>Email is working.</p><p>Total test: AED ${money(1234.5)}</p>` });
    res.json(r);
  });
  app.get('/api/app/messages', U, (req, res) => res.json({ rows: db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 300').all() }));
}
