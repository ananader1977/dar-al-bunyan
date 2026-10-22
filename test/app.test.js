import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestApp } from './helpers.js';

const FIXTURE = new URL('./fixtures/sample-expenses.xlsx', import.meta.url);

test('three starting accounts, roles and sign-in', async () => {
  const t = await startTestApp();
  try {
    const users = t.ctx.db.prepare('SELECT email, role FROM users ORDER BY id').all().map((u) => `${u.email}:${u.role}`);
    assert.deepEqual(users, ['admin@test.local:admin', 'admin2@test.local:admin', 'ops@test.local:operations']);
    assert.equal((await t.call(null, 'GET', '/api/app/dashboard')).status, 401);
    const bad = await fetch(`${t.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ops@test.local', password: 'wrong' }) });
    assert.equal(bad.status, 401);
    assert.equal((await t.login('ops')).status, 200);
    assert.equal((await t.call('ops', 'GET', '/api/me')).body.user.role, 'operations');
    // operations works with everything except the owner's areas
    for (const p of ['/api/app/users', '/api/app/settings', '/api/app/trash', '/api/app/activity', '/api/app/backups']) {
      assert.equal((await t.call('ops', 'GET', p)).status, 403, p);
    }
    for (const p of ['/api/app/finance', '/api/app/expenses', '/api/app/invoices', '/api/app/messages', '/api/app/partners']) {
      assert.equal((await t.call('ops', 'GET', p)).status, 200, p);
    }
    // CSRF header is required for changes
    assert.equal((await t.call('ops', 'POST', '/api/app/quotations', t.quote(), { csrf: false })).status, 403);
  } finally { await t.close(); }
});

test('operations creates a quotation in one form (new customer + new products) and submits; admin approves', async () => {
  const t = await startTestApp();
  try {
    await t.login('ops'); await t.login('admin');
    const r = await t.call('ops', 'POST', '/api/app/quotations', t.quote());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const q = r.body.quotation;
    assert.equal(q.status, 'draft');
    assert.equal(q.number, 'DABTS/1');
    assert.equal(q.subtotal, 5500); assert.equal(q.discount, 550); assert.equal(q.net, 4950);
    assert.equal(q.vat_rate, 5); assert.equal(q.vat, 247.5); assert.equal(q.total, 5197.5);
    assert.equal(q.cost_total, 2200);
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) n FROM clients WHERE name='Acme Towers'").get().n, 1);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM products').get().n, 2);
    assert.equal(r.body.valid_until ?? q.valid_until, '2026-11-17');

    // operations cannot approve
    assert.equal((await t.call('ops', 'POST', `/api/app/quotations/${q.id}/approve`, {})).status, 403);
    // operations cannot send before approval
    assert.equal((await t.call('ops', 'POST', `/api/app/quotations/${q.id}/send`, {})).status, 400);
    const sub = await t.call('ops', 'POST', `/api/app/quotations/${q.id}/submit`, {});
    assert.equal(sub.body.quotation.status, 'pending');
    await t.ctx.flush();
    const mail = t.ctx.db.prepare("SELECT * FROM outbox WHERE subject LIKE 'Approval needed%'").get();
    assert.ok(mail && mail.to_addr.includes('admin@test.local') && mail.to_addr.includes('admin2@test.local'));
    // operations can no longer edit while pending
    assert.equal((await t.call('ops', 'PUT', `/api/app/quotations/${q.id}`, t.quote())).status, 400);

    // admin returns it with a comment, ops fixes and resubmits, admin approves
    assert.equal((await t.call('admin', 'POST', `/api/app/quotations/${q.id}/reject`, {})).status, 400, 'comment required');
    const rej = await t.call('admin', 'POST', `/api/app/quotations/${q.id}/reject`, { note: 'Raise the seal price' });
    assert.equal(rej.body.quotation.status, 'rejected');
    const edited = await t.call('ops', 'PUT', `/api/app/quotations/${q.id}`, t.quote({ lines: [{ description: 'Mechanical seal', qty: 1, unit_price: 600, unit_cost: 200 }] }));
    assert.equal(edited.body.quotation.subtotal, 600);
    await t.call('ops', 'POST', `/api/app/quotations/${q.id}/submit`, {});
    const ok = await t.call('admin', 'POST', `/api/app/quotations/${q.id}/approve`, { note: 'Fine' });
    assert.equal(ok.body.quotation.status, 'approved');
    await t.ctx.flush();
    assert.ok(t.ctx.db.prepare("SELECT 1 FROM outbox WHERE to_addr='ops@test.local' AND subject LIKE '%approved'").get());
    assert.ok(ok.body.events.some((e) => e.action === 'returned for changes' && e.note === 'Raise the seal price'));
    // operations records the customer's answer and can invoice, but cannot delete
    const acc = await t.call('ops', 'POST', `/api/app/quotations/${q.id}/accept`, { lpo: 'LPO-9' });
    assert.equal(acc.body.quotation.status, 'accepted');
    assert.equal(acc.body.quotation.lpo, 'LPO-9');
    assert.equal((await t.call('ops', 'POST', `/api/app/quotations/${q.id}/invoice`, {})).status, 200);
    assert.equal((await t.call('ops', 'GET', '/api/app/invoices')).body.rows.length, 1);
    assert.equal((await t.call('ops', 'DELETE', `/api/app/quotations/${q.id}`)).status, 403);
    const q2 = (await t.call('ops', 'POST', '/api/app/quotations', t.quote())).body.quotation;
    assert.equal((await t.call('ops', 'POST', `/api/app/quotations/${q2.id}/decline`, {})).status, 400, 'only approved quotations can be declined');
    await t.call('admin', 'POST', `/api/app/quotations/${q2.id}/approve`, {});
    assert.equal((await t.call('ops', 'POST', `/api/app/quotations/${q2.id}/decline`, { note: 'Client cancelled' })).body.quotation.status, 'declined');
  } finally { await t.close(); }
});

test('send to customer, accept, invoice, demo payment, and PDFs', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin');
    const q = (await t.call('admin', 'POST', '/api/app/quotations', t.quote())).body.quotation;
    await t.call('admin', 'POST', `/api/app/quotations/${q.id}/approve`, {});
    const sent = await t.call('admin', 'POST', `/api/app/quotations/${q.id}/send`, { message: 'Hello' });
    assert.equal(sent.body.quotation.status, 'sent');
    const mail = t.ctx.db.prepare("SELECT * FROM outbox WHERE to_addr='ali@acme.example'").get();
    assert.match(mail.attachment, /Quotation-DABTS_1\.pdf/);
    const pdf = await t.call('admin', 'GET', `/api/app/quotations/${q.id}/pdf`, undefined, { raw: true });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok((await pdf.arrayBuffer()).byteLength > 2000);

    const acc = await t.call('admin', 'POST', `/api/app/quotations/${q.id}/accept`, { lpo: 'LPO-1' });
    assert.equal(acc.body.quotation.status, 'accepted');
    t.ctx.service.setSetting('next_invoice_no', 82);
    const inv = (await t.call('admin', 'POST', `/api/app/quotations/${q.id}/invoice`, {})).body;
    assert.equal(inv.invoice.number, 'DABTS/82/26');
    assert.equal(inv.invoice.total, q.total);
    assert.equal(inv.lines.reduce((a, l) => a + l.amount, 0), q.net, 'discount line makes lines add up to net');
    assert.equal((await t.call('admin', 'POST', `/api/app/quotations/${q.id}/invoice`, {})).status, 400, 'one invoice per quotation');

    // customer email in demo mode: no payment link offered
    await t.call('admin', 'POST', `/api/app/invoices/${inv.invoice.id}/send`, {});
    const im = t.ctx.db.prepare("SELECT body FROM outbox WHERE subject LIKE 'Tax invoice%'").get();
    assert.doesNotMatch(im.body, /Pay online/);

    // demo checkout from the admin test link
    const u = new URL(inv.payUrl);
    const n = u.searchParams.get('inv'), tok = u.searchParams.get('t');
    assert.equal((await t.call(null, 'GET', `/api/pay/${encodeURIComponent(n)}?t=wrong`)).status, 404);
    const co = await t.call(null, 'POST', `/api/pay/${encodeURIComponent(n)}/checkout?t=${tok}`, {});
    const sid = new URL(co.body.url).searchParams.get('s');
    assert.equal((await t.call(null, 'POST', `/api/pay-demo/${sid}/complete`, {})).status, 200);
    await t.ctx.flush();
    const paid = (await t.call('admin', 'GET', `/api/app/invoices/${inv.invoice.id}`)).body.invoice;
    assert.equal(paid.status, 'paid');
    assert.equal(paid.payment_method, 'Card (demo)');
    assert.equal((await t.call(null, 'POST', `/api/pay/${encodeURIComponent(n)}/checkout?t=${tok}`, {})).status, 409);
  } finally { await t.close(); }
});

test('Excel import and financial report follow the Dar Al Bunyan rules (declined excluded, 60/40)', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin');
    const data = fs.readFileSync(FIXTURE).toString('base64');
    const r = await t.call('admin', 'POST', '/api/app/import', { data });
    assert.deepEqual(r.body, { quotations: 3, expenses: 4, invoices: 1, clients: 3, loans: 0, skipped: 0 });
    const again = await t.call('admin', 'POST', '/api/app/import', { data });
    assert.equal(again.body.quotations + again.body.expenses, 0, 'second import adds nothing');
    const db = t.ctx.db;
    assert.equal(db.prepare("SELECT COUNT(*) n FROM quotations WHERE status='accepted' AND paid_at IS NOT NULL").get().n, 2, 'imported jobs are paid');
    assert.equal(db.prepare("SELECT status FROM invoices").get().status, 'paid');
    const f = (await t.call('admin', 'GET', '/api/app/finance')).body;
    assert.equal(f.totals.revenue, 3000);
    assert.equal(f.totals.cost, 1200);
    assert.equal(f.totals.profit, 1800);
    // all costs (job 900 + other 300) come off first; the profit left (1800) is split 60/40
    assert.equal(f.totals.payable, 1800);
    assert.equal(f.totals.a, 1080);
    assert.equal(f.totals.bGross, 720);
    assert.equal(f.totals.costsBack, 1200);
    assert.equal(f.totals.dueA, 1080 + 1200);
    assert.equal(f.totals.declinedCost, 2000, 'declined job costs are carried by Mohamed');
    // a personal loan (Partners page) is deducted from Ramdas's share and paid back to Mohamed
    assert.equal((await t.call('admin', 'POST', '/api/app/expenses', { paid_on: '2026-06-15', cost_type: 'Personal Loan', amount: 500 })).status, 400, 'loans are not expenses');
    assert.equal((await t.call('admin', 'POST', '/api/app/partners/loans', { taken_on: '2026-06-15', amount: 500, note: 'personal loan' })).status, 200);
    const f2 = (await t.call('admin', 'GET', '/api/app/finance')).body;
    assert.equal(f2.totals.a, 1080); assert.equal(f2.totals.bGross, 720); assert.equal(f2.totals.b, 220);
    assert.equal(f2.totals.profit, 1800, 'personal loans are not a company cost'); assert.equal(f2.totals.loans, 500);
    assert.equal(f2.totals.payable - f2.totals.a - f2.totals.bGross, 0);
    assert.equal(f2.totals.payBackA, 1200 + 500);
    assert.equal(f2.totals.dueA + f2.totals.dueB, f2.totals.revenuePaid, 'everything paid out equals the revenue received');
    const ex = (await t.call('admin', 'GET', '/api/app/expenses')).body.rows;
    const byKind = (k) => ex.filter((e) => e.kind === k);
    assert.deepEqual(byKind('overhead').map((e) => [e.share_a, e.share_b]), [[-180, -120]]);
    assert.deepEqual(byKind('declined').map((e) => [e.profit, e.pay_back]), [[0, 0]]);
    assert.equal(ex.reduce((a, e) => a + e.revenue, 0), 3000, 'each job revenue shown once');
    assert.equal(ex.reduce((a, e) => a + e.share_a + e.share_b, 0), 1800, 'shares add up to the profit');
    // profit is payable only when the customer has paid: DABTS/14 (no invoice) marked unpaid
    const q14 = db.prepare("SELECT id FROM quotations WHERE number='DABTS/14'").get().id;
    await t.call('admin', 'POST', `/api/app/quotations/${q14}/paid`, { paid: false });
    const f3 = (await t.call('admin', 'GET', '/api/app/finance')).body.totals;
    assert.equal(f3.profit, 1800, 'earned profit unchanged');
    assert.equal(f3.revenueWaiting, 2000); assert.equal(f3.jobCostWaiting, 500);
    assert.equal(f3.payable, 1800 - 1500); assert.equal(f3.a, 180); assert.equal(f3.costsBack, 700);
    assert.equal(f3.dueA + f3.dueB, f3.revenuePaid);
    const q12 = db.prepare("SELECT id FROM quotations WHERE number='DABTS/12'").get().id;
    assert.equal((await t.call('admin', 'POST', `/api/app/quotations/${q12}/paid`, { paid: false })).status, 400, 'jobs with an invoice are paid on the invoice');
    await t.call('admin', 'POST', `/api/app/quotations/${q14}/paid`, { paid: true, date: '2026-10-20' });
    // partner ledger: payments reduce what is still owed
    await t.call('admin', 'POST', '/api/app/partners/payments', { partner: 'a', amount: 1000, paid_on: '2026-10-21' });
    const pl = (await t.call('admin', 'GET', '/api/app/partners')).body;
    assert.equal(pl.a.entitled, 1080 + 1200 + 500); assert.equal(pl.a.paid, 1000); assert.equal(pl.a.balance, 1780);
    assert.equal(pl.b.balance, 220);
    const clients = t.ctx.db.prepare('SELECT name FROM clients ORDER BY name').all().map((c) => c.name);
    assert.deepEqual(clients, ['Meydan', 'RTA', 'Seddiqi']);
    assert.equal(t.ctx.settings().next_quote_no, '15');
    assert.equal(t.ctx.settings().next_invoice_no, '11');
    assert.equal(t.ctx.db.prepare("SELECT lpo FROM quotations WHERE number='DABTS/12'").get().lpo, '202600001');
    // date filter
    const oct = (await t.call('admin', 'GET', '/api/app/finance?from=2026-10-01&to=2026-10-31')).body;
    assert.equal(oct.totals.revenue, 2000); assert.equal(oct.totals.cost, 500);
    // Excel export
    const x = await t.call('admin', 'GET', '/api/app/export.xlsx', undefined, { raw: true });
    assert.equal(x.status, 200);
    assert.equal(Buffer.from(await x.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  } finally { await t.close(); }
});

test('attachments: everyone, on all records; local storage round trip', async () => {
  const t = await startTestApp();
  try {
    await t.login('ops'); await t.login('admin');
    const q = (await t.call('ops', 'POST', '/api/app/quotations', t.quote())).body.quotation;
    const a = await t.call('ops', 'POST', '/api/app/attachments', { entity: 'quotation', id: q.id, name: 'lpo.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') });
    assert.equal(a.status, 200);
    const dl = await t.call('ops', 'GET', `/api/app/attachments/${a.body.id}?download=1`, undefined, { raw: true });
    assert.equal(await dl.text(), 'hello');
    const link = await t.call('ops', 'POST', '/api/app/attachments', { entity: 'quotation', id: q.id, name: 'Drawing', link: 'https://drive.google.com/file/d/abc/view' });
    assert.equal(link.body.attachments.length, 2);
    assert.equal((await t.call('ops', 'POST', '/api/app/attachments', { entity: 'quotation', id: q.id, name: 'x', link: 'https://evil.example/x' })).status, 400);
    const e = (await t.call('admin', 'POST', '/api/app/expenses', { amount: 50, cost_type: 'Parking' })).body;
    assert.equal((await t.call('ops', 'POST', '/api/app/attachments', { entity: 'expense', id: e.id, name: 'r.txt', data: 'aGk=' })).status, 200);
    assert.equal((await t.call('admin', 'POST', '/api/app/attachments', { entity: 'expense', id: e.id, name: 'r.txt', data: 'aGk=' })).status, 200);
  } finally { await t.close(); }
});

test('Google Drive storage uploads with the refresh token (mocked Google)', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u, opts = {}) => {
    const s = String(u);
    if (s.startsWith('https://oauth2.googleapis.com/token')) { seen.push('token'); return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }); }
    if (s.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      seen.push('upload'); assert.equal(opts.headers.Authorization, 'Bearer at');
      assert.match(Buffer.from(opts.body).toString(), /"parents":\["FOLDER"\]/);
      return new Response(JSON.stringify({ id: 'drv1', webViewLink: 'https://drive.google.com/file/d/drv1/view' }), { status: 200 });
    }
    return realFetch(u, opts);
  };
  const t = await startTestApp({ drive: { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', folderId: 'FOLDER' } });
  try {
    await t.login('ops');
    const q = (await t.call('ops', 'POST', '/api/app/quotations', t.quote())).body.quotation;
    const a = await t.call('ops', 'POST', '/api/app/attachments', { entity: 'quotation', id: q.id, name: 'photo.jpg', mime: 'image/jpeg', data: Buffer.from('jpg').toString('base64') });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.attachments[0].storage, 'drive');
    assert.equal(a.body.attachments[0].link, 'https://drive.google.com/file/d/drv1/view');
    assert.deepEqual(seen, ['token', 'upload']);
  } finally { await t.close(); globalThis.fetch = realFetch; }
});

test('users: admin can add users; the last admin cannot be removed', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin');
    assert.equal((await t.call('admin', 'POST', '/api/app/users', { email: 'new@test.local', name: 'New', role: 'operations', password: 'short' })).status, 400);
    assert.equal((await t.call('admin', 'POST', '/api/app/users', { email: 'new@test.local', name: 'New', role: 'operations', password: 'GoodPass12345' })).status, 200);
    const users = (await t.call('admin', 'GET', '/api/app/users')).body.rows;
    const a2 = users.find((u) => u.email === 'admin2@test.local');
    assert.equal((await t.call('admin', 'PUT', `/api/app/users/${a2.id}`, { active: false })).status, 200);
    const me = users.find((u) => u.email === 'admin@test.local');
    assert.equal((await t.call('admin', 'PUT', `/api/app/users/${me.id}`, { role: 'operations' })).status, 400);
  } finally { await t.close(); }
});

test('Excel export on every page, with role checks and filters', async () => {
  const t = await startTestApp();
  try {
    await t.login('ops'); await t.login('admin');
    await t.call('admin', 'POST', '/api/app/import', { data: fs.readFileSync(FIXTURE).toString('base64') });
    const xlsx = async (who, path) => { const r = await t.call(who, 'GET', path, undefined, { raw: true }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; };
    for (const k of ['quotations', 'customers', 'products']) {
      const r = await xlsx('ops', `/api/app/export/${k}.xlsx`);
      assert.equal(r.status, 200, k); assert.equal(r.buf.readUInt32LE(0), 0x04034b50, k);
    }
    for (const k of ['invoices', 'expenses', 'finance', 'messages']) {
      assert.equal((await xlsx('ops', `/api/app/export/${k}.xlsx`)).status, 200, k);
      assert.equal((await xlsx('admin', `/api/app/export/${k}.xlsx?from=2026-09-01&to=2026-09-30`)).status, 200, k);
    }
    assert.equal((await xlsx('ops', '/api/app/export/users.xlsx')).status, 403);
    assert.equal((await xlsx('admin', '/api/app/export/users.xlsx')).status, 200);
    const { readXlsx } = await import('../src/importer.js');
    const acc = readXlsx((await xlsx('ops', '/api/app/export/quotations.xlsx?status=accepted')).buf);
    assert.equal(acc.length, 3, 'header + 2 accepted quotations');
    const exp = readXlsx((await xlsx('admin', '/api/app/export/expenses.xlsx?type=Material')).buf);
    assert.equal(exp.length, 4, 'header + 3 material expenses');
  } finally { await t.close(); }
});

test('attachment counts in the lists and per-record attachment list', async () => {
  const t = await startTestApp();
  try {
    await t.login('ops'); await t.login('admin');
    const q = (await t.call('ops', 'POST', '/api/app/quotations', t.quote())).body.quotation;
    await t.call('ops', 'POST', '/api/app/attachments', { entity: 'quotation', id: q.id, name: 'a.txt', data: 'aGk=' });
    await t.call('ops', 'POST', '/api/app/attachments', { entity: 'quotation', id: q.id, name: 'b.txt', data: 'aGk=' });
    assert.equal((await t.call('ops', 'GET', '/api/app/quotations')).body.rows[0].attach_count, 2);
    assert.equal((await t.call('ops', 'GET', `/api/app/attachments?entity=quotation&id=${q.id}`)).body.attachments.length, 2);
    const e = (await t.call('admin', 'POST', '/api/app/expenses', { amount: 10, cost_type: 'Parking' })).body;
    await t.call('admin', 'POST', '/api/app/attachments', { entity: 'expense', id: e.id, name: 'receipt.txt', data: 'aGk=' });
    assert.equal((await t.call('admin', 'GET', '/api/app/expenses')).body.rows[0].attach_count, 1);
    assert.equal((await t.call('ops', 'GET', `/api/app/attachments?entity=expense&id=${e.id}`)).body.attachments.length, 1);
    const d = (await t.call('ops', 'GET', '/api/app/dashboard')).body;
    assert.equal(d.quoteMonths.length, 1); assert.equal(d.quoteMonths[0].n, 1);
  } finally { await t.close(); }
});

test('only the owner deletes; deleted records go to the Trash and can be restored; issued invoices are protected', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin'); await t.login('ops');
    await t.call('admin', 'POST', '/api/app/import', { data: fs.readFileSync(FIXTURE).toString('base64') });
    const db = t.ctx.db;
    const count = (tbl) => db.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n;
    const paidInv = db.prepare('SELECT * FROM invoices LIMIT 1').get();
    const q14 = db.prepare("SELECT * FROM quotations WHERE number='DABTS/14'").get();
    // operations cannot delete anything
    assert.equal((await t.call('ops', 'DELETE', `/api/app/invoices/${paidInv.id}`)).status, 403);
    assert.equal((await t.call('ops', 'DELETE', `/api/app/quotations/${q14.id}`)).status, 403);
    assert.equal((await t.call('ops', 'DELETE', `/api/app/expenses/1`)).status, 403);
    // a paid (or emailed) invoice cannot be deleted, nor its quotation
    assert.equal((await t.call('admin', 'DELETE', `/api/app/invoices/${paidInv.id}`)).status, 400);
    assert.equal((await t.call('admin', 'DELETE', `/api/app/quotations/${paidInv.quotation_id}`)).status, 400);
    // quotation of any status: it goes to the Trash with its expenses, and comes back
    const linked = db.prepare('SELECT COUNT(*) n FROM expenses WHERE quotation_id=?').get(q14.id).n;
    const expBefore = count('expenses');
    assert.equal((await t.call('admin', 'DELETE', `/api/app/quotations/${q14.id}`)).status, 200);
    assert.equal(count('expenses'), expBefore - linked);
    const trash = (await t.call('admin', 'GET', '/api/app/trash')).body.rows;
    assert.equal(trash.length, 1); assert.match(trash[0].label, /DABTS\/14/);
    assert.equal((await t.call('ops', 'POST', `/api/app/trash/${trash[0].id}/restore`, {})).status, 403);
    assert.equal((await t.call('admin', 'POST', `/api/app/trash/${trash[0].id}/restore`, {})).status, 200);
    assert.equal(db.prepare('SELECT status FROM quotations WHERE id=?').get(q14.id).status, 'accepted');
    assert.equal(count('expenses'), expBefore);
    assert.equal((await t.call('admin', 'GET', '/api/app/trash')).body.rows.length, 0);
    // an invoice that was never emailed or paid can be deleted
    const q = (await t.call('ops', 'POST', '/api/app/quotations', t.quote())).body.quotation;
    await t.call('admin', 'POST', `/api/app/quotations/${q.id}/approve`, {});
    const inv = (await t.call('ops', 'POST', `/api/app/quotations/${q.id}/invoice`, {})).body.invoice;
    assert.equal((await t.call('admin', 'DELETE', `/api/app/invoices/${inv.id}`)).status, 200);
    // expense
    const e = db.prepare('SELECT id FROM expenses LIMIT 1').get();
    assert.equal((await t.call('admin', 'DELETE', `/api/app/expenses/${e.id}`)).status, 200);
    // product used in a quotation: lines keep their text
    const pid = db.prepare('SELECT product_id FROM quote_lines WHERE quotation_id=? AND product_id IS NOT NULL').get(q.id).product_id;
    assert.equal((await t.call('admin', 'DELETE', `/api/app/products/${pid}`)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM quote_lines WHERE quotation_id=?').get(q.id).n, 2);
    // customer with quotations: refused without force, deleted with force, restored with everything
    const cid = q.client_id;
    assert.equal((await t.call('admin', 'DELETE', `/api/app/clients/${cid}`)).status, 409);
    assert.equal((await t.call('admin', 'DELETE', `/api/app/clients/${cid}?force=1`)).status, 200);
    assert.equal(db.prepare('SELECT 1 FROM quotations WHERE id=?').get(q.id), undefined);
    const ct = (await t.call('admin', 'GET', '/api/app/trash')).body.rows.find((x) => x.kind === 'customer');
    assert.equal((await t.call('admin', 'POST', `/api/app/trash/${ct.id}/restore`, {})).status, 200);
    assert.ok(db.prepare('SELECT 1 FROM quotations WHERE id=?').get(q.id));
    // users cannot be deleted
    const ops = db.prepare("SELECT id FROM users WHERE email='ops@test.local'").get().id;
    assert.equal((await t.call('admin', 'DELETE', `/api/app/users/${ops}`)).status, 405);
    // everything is in the activity log
    const log = (await t.call('admin', 'GET', '/api/app/activity')).body.rows.map((r) => r.action);
    for (const a of ['deleted', 'restored', 'invoice created', 'signed in']) assert.ok(log.includes(a), a);
  } finally { await t.close(); }
});

test('expenses by Operations wait for the owner\'s approval', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin'); await t.login('ops');
    const e = (await t.call('ops', 'POST', '/api/app/expenses', { paid_on: '2026-10-10', amount: 250, cost_type: 'Parking' })).body;
    const row = () => t.ctx.db.prepare('SELECT * FROM expenses WHERE id=?').get(e.id);
    assert.equal(row().status, 'pending');
    await t.ctx.flush();
    assert.ok(t.ctx.db.prepare("SELECT 1 FROM outbox WHERE subject LIKE 'Expense to approve%'").get());
    let f = (await t.call('admin', 'GET', '/api/app/finance')).body.totals;
    assert.equal(f.cost, 0, 'not counted before approval'); assert.equal(f.pending.n, 1);
    assert.equal((await t.call('ops', 'POST', `/api/app/expenses/${e.id}/approve`, {})).status, 403);
    assert.equal((await t.call('admin', 'POST', `/api/app/expenses/${e.id}/return`, {})).status, 400, 'a note is required');
    await t.call('admin', 'POST', `/api/app/expenses/${e.id}/return`, { note: 'Attach the receipt' });
    assert.equal(row().status, 'returned'); assert.equal(row().review_note, 'Attach the receipt');
    await t.call('ops', 'PUT', `/api/app/expenses/${e.id}`, { paid_on: '2026-10-10', amount: 250, cost_type: 'Parking' });
    assert.equal(row().status, 'pending');
    await t.call('admin', 'POST', `/api/app/expenses/${e.id}/approve`, {});
    f = (await t.call('admin', 'GET', '/api/app/finance')).body.totals;
    assert.equal(f.cost, 250); assert.equal(f.overheads, 250);
    const own = (await t.call('admin', 'POST', '/api/app/expenses', { amount: 10, cost_type: 'Parking' })).body;
    assert.equal(t.ctx.db.prepare('SELECT status FROM expenses WHERE id=?').get(own.id).status, 'approved', "the owner's expenses count straight away");
  } finally { await t.close(); }
});

test('credit notes cancel issued invoices; revenue is dated by the invoice', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin'); await t.login('ops');
    const q = (await t.call('ops', 'POST', '/api/app/quotations', t.quote({ quote_date: '2026-09-01' }))).body.quotation;
    await t.call('admin', 'POST', `/api/app/quotations/${q.id}/approve`, {});
    await t.call('ops', 'POST', `/api/app/quotations/${q.id}/accept`, { date: '2026-09-15' });
    const inv = (await t.call('ops', 'POST', `/api/app/quotations/${q.id}/invoice`, { issue_date: '2026-10-03' })).body.invoice;
    const fin = (await t.call('ops', 'GET', '/api/app/finance')).body;
    assert.equal(fin.monthly[0].month, '2026-10', 'revenue in the month of the invoice');
    assert.equal(fin.totals.revenueWaiting, q.net, 'not paid yet');
    await t.call('ops', 'POST', `/api/app/invoices/${inv.id}/send`, {});
    assert.equal((await t.call('ops', 'POST', `/api/app/invoices/${inv.id}/status`, { status: 'cancelled' })).status, 400, 'emailed: needs a credit note');
    assert.equal((await t.call('admin', 'DELETE', `/api/app/invoices/${inv.id}`)).status, 400);
    await t.call('ops', 'POST', `/api/app/invoices/${inv.id}/paid`, { date: '2026-10-05', method: 'Bank transfer' });
    assert.equal(t.ctx.db.prepare('SELECT paid_at FROM quotations WHERE id=?').get(q.id).paid_at, '2026-10-05');
    assert.equal((await t.call('ops', 'GET', '/api/app/finance')).body.totals.payable, round(q.net - 0));
    assert.equal((await t.call('ops', 'POST', `/api/app/invoices/${inv.id}/credit-note`, {})).status, 400, 'reason required');
    const cn = await t.call('ops', 'POST', `/api/app/invoices/${inv.id}/credit-note`, { reason: 'Job cancelled', date: '2026-10-20' });
    assert.equal(cn.status, 200);
    assert.equal(cn.body.creditNote.number, 'DABTS/CN/1/26');
    assert.equal(cn.body.creditNote.total, inv.total);
    assert.equal(cn.body.invoice.status, 'cancelled');
    assert.equal(t.ctx.db.prepare('SELECT paid_at FROM quotations WHERE id=?').get(q.id).paid_at, null);
    const pdf = await t.call('ops', 'GET', `/api/app/credit-notes/${cn.body.creditNote.id}/pdf`, undefined, { raw: true });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await pdf.arrayBuffer()).toString('latin1').includes('/Title (Tax Credit Note DABTS/CN/1/26)'));
    assert.equal((await t.call('ops', 'POST', `/api/app/invoices/${inv.id}/credit-note`, { reason: 'again' })).status, 400);
    // a new invoice can be issued for the job
    assert.equal((await t.call('ops', 'POST', `/api/app/quotations/${q.id}/invoice`, {})).status, 200);
  } finally { await t.close(); }
});

test('backups, weekly reminder email and the Monday schedule', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin');
    await t.call('admin', 'POST', '/api/app/import', { data: fs.readFileSync(FIXTURE).toString('base64') });
    const b = await t.call('admin', 'POST', '/api/app/backups', {});
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const dl = await t.call('admin', 'GET', `/api/app/backups/${b.body.id}/download`, undefined, { raw: true });
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
    // the backup is a working copy of the data
    const { DatabaseSync } = await import('node:sqlite');
    const tmp = `${t.ctx.jobs.backupDir}/check.sqlite`; fs.writeFileSync(tmp, buf);
    assert.equal(new DatabaseSync(tmp).prepare('SELECT COUNT(*) n FROM quotations').get().n, 3);
    const w = await t.call('admin', 'GET', '/api/app/weekly-email');
    assert.equal(w.body.unbilled.length, 0);
    assert.equal((await t.call('admin', 'POST', '/api/app/weekly-email', {})).body.status, 'logged');
    assert.ok(t.ctx.db.prepare("SELECT 1 FROM outbox WHERE subject LIKE 'Weekly reminder%' AND to_addr LIKE '%ops@test.local%'").get());
    // schedule: Monday 19 Oct 2026, 9:00 Dubai -> daily backup + weekly email, once
    const before = t.ctx.db.prepare("SELECT COUNT(*) n FROM outbox WHERE subject LIKE 'Weekly reminder%'").get().n;
    t.clock.advance(-(t.ctx.now() - Date.UTC(2026, 9, 19, 5, 0, 0)));
    await t.ctx.jobs.tick(); await t.ctx.jobs.tick();
    assert.equal(t.ctx.db.prepare("SELECT COUNT(*) n FROM outbox WHERE subject LIKE 'Weekly reminder%'").get().n, before + 1);
    assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM backups').get().n, 2);
  } finally { await t.close(); }
});

test('upgrading an older database: personal loan expenses move to the loans table', async () => {
  const { openDb } = await import('../src/db.js');
  const file = `/tmp/dab-mig-${process.pid}.sqlite`;
  fs.rmSync(file, { force: true });
  let db = openDb(file);
  db.prepare("INSERT INTO expenses(paid_on,cost_type,description,amount,qty,total,paid_by,created_at) VALUES('2026-07-05','Personal Loan','first loan',1500,1,1500,'Mohamed',1)").run();
  db.prepare("DELETE FROM settings WHERE key='_mig_loans'").run();
  db.close();
  db = openDb(file);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM expenses WHERE cost_type LIKE '%loan%'").get().n, 0);
  assert.deepEqual({ ...db.prepare('SELECT taken_on, amount FROM partner_loans').get() }, { taken_on: '2026-07-05', amount: 1500 });
  db.close();
  fs.rmSync(file, { force: true });
});

const round = (n) => Math.round(n * 100) / 100;
