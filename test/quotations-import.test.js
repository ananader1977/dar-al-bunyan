import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { buildXlsx } from '../src/xlsx.js';

const COLS = [['Number', 'number'], ['Date', 'date', 'date'], ['Customer', 'customer'], ['Subject', 'subject'], ['Site', 'site'], ['Status', 'status'], ['Net (excl. VAT)', 'net', 'money'], ['VAT', 'vat', 'money'],
  ['Total', 'total', 'money'], ['Estimated cost', 'cost', 'money'], ['LPO', 'lpo'], ['Invoice', 'invoice'], ['Created by', 'by'], ['Manual Quotation', 'manual'], ['Remarks', 'remarks']];
const day = (m, d) => Date.UTC(2026, m - 1, d);
const row = (o) => ({ status: 'Accepted', by: 'Anas', ...o, vat: o.vat ?? Math.round(o.net * 5) / 100, total: o.total ?? Math.round(o.net * 105) / 100 });
const sheet = (rows) => buildXlsx([{ name: 'Quotations', columns: COLS.map(([header, key, type]) => ({ header, key, type })), rows }]);

test('quotations sheet: update by Number, add new ones with generated numbers, fix invoice amounts, idempotent', async () => {
  const t = await startTestApp();
  try {
    const { ctx } = t;
    const svc = ctx.service, db = ctx.db;
    const admin = db.prepare("SELECT * FROM users WHERE role='admin' ORDER BY id").get();
    const mk = (subject, price, cost, extra = {}) => svc.saveQuote(admin, { client: { name: 'RTA' }, subject, site: 'Depot', quote_date: '2026-07-01', lines: [{ description: subject, qty: 1, unit_price: price, unit_cost: cost }, { description: 'Extra', qty: 1, unit_price: 0, unit_cost: 0 }], ...extra });
    const q1 = mk('Pump A', 1000, 400), q2 = mk('Pump B', 2000, 800);
    db.prepare("UPDATE quotations SET status='accepted' WHERE id IN (?,?)").run(q1, q2);
    const inv1 = svc.createInvoice(admin, q1), inv2 = svc.createInvoice(admin, q2);
    const n1 = db.prepare('SELECT number FROM quotations WHERE id=?').get(q1).number; // DABTS/1
    const n2 = db.prepare('SELECT number FROM quotations WHERE id=?').get(q2).number;
    const inv1No = db.prepare('SELECT number FROM invoices WHERE id=?').get(inv1).number;
    ctx.service.setSetting('next_quote_no', 3);

    const file = sheet([
      row({ number: n1, date: day(7, 1), customer: 'RTA', subject: 'Pump A', site: 'Depot', net: 1200, cost: 500, lpo: 202600001, invoice: inv1No }), // amounts changed -> invoice must follow
      row({ number: n2, date: day(7, 1), customer: 'RTA', subject: 'Pump B', site: 'Depot', net: 2000, cost: 800, manual: 'DABTS/7/25' }),            // only the manual number is new
      row({ number: 'DABTS/50', date: day(8, 1), customer: 'Seddiqi', subject: 'Old paper quote', site: 'Reem', net: 500, cost: 200 }),            // new number kept
      row({ date: day(10, 5), subject: '2hp pump', site: 'RTA bus depot', status: 'Waiting approval', net: 700, cost: 250 }),                     // manual, later date
      row({ date: day(9, 1), subject: '7.5 kw pump', site: 'Dp world', status: 'Declined', net: 1500, cost: 700, manual: 'DABTS/118/25', remarks: 'client went elsewhere' }), // manual, earlier date
      row({ date: day(9, 2), subject: '', site: 'Meydan grand stand', net: 100, cost: 40 }),                                                       // no subject
      row({ number: 'DABTS/60', date: 'bad', net: 5 }),                                                                                            // invalid date
    ]);

    // dry run changes nothing but reports everything
    const before = JSON.stringify(db.prepare('SELECT * FROM quotations ORDER BY id').all()) + db.prepare("SELECT value FROM settings WHERE key='next_quote_no'").get().value;
    const dry = (await import('../src/importer.js')).importQuotationsSheet(ctx, file, admin, { dry: true });
    assert.equal(dry.created, 4); assert.equal(dry.updated, 2); assert.equal(dry.unchanged, 0);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM quotations ORDER BY id').all()) + db.prepare("SELECT value FROM settings WHERE key='next_quote_no'").get().value, before, 'dry run leaves no trace');

    await t.login('admin');
    const res = await t.call('admin', 'POST', '/api/app/import', { data: file.toString('base64') });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.body;
    assert.equal(b.kind, 'quotations');
    assert.equal(b.created, 4); assert.equal(b.createdNumbered, 1); assert.equal(b.updated, 2); assert.equal(b.unchanged, 0);
    assert.ok(b.warnings.some((w) => /valid Date/.test(w)));
    // generated numbers continue from the counter, oldest date first
    assert.deepEqual(b.generated.map((g) => [g.number, g.subject]), [['DABTS/3', '7.5 kw pump'], ['DABTS/4', 'Job - Meydan grand stand'], ['DABTS/5', '2hp pump']]);
    const get = (no) => db.prepare('SELECT q.*, c.name client FROM quotations q JOIN clients c ON c.id=q.client_id WHERE number=?').get(no);
    assert.equal(get('DABTS/3').manual_quotation, 1); assert.equal(get('DABTS/3').manual_no, 'DABTS/118/25'); assert.equal(get('DABTS/4').manual_no, ''); assert.equal(get('DABTS/4').manual_quotation, 1); assert.equal(get(n2).manual_no, 'DABTS/7/25'); assert.equal(get(n2).manual_quotation, 1); assert.equal(get('DABTS/3').status, 'declined'); assert.equal(get('DABTS/3').remarks, 'client went elsewhere'); assert.equal(get('DABTS/3').client, 'Unassigned');
    assert.equal(get('DABTS/5').status, 'sent'); assert.equal(get('DABTS/5').client, 'RTA');
    assert.equal(get('DABTS/50').manual_quotation, 0); assert.equal(get('DABTS/50').client, 'Seddiqi');
    assert.equal(Number(db.prepare("SELECT value FROM settings WHERE key='next_quote_no'").get().value), 51, 'counter moved past the highest number');
    // updated quotation + its lines + its invoice
    const u = get(n1);
    assert.equal(u.net, 1200); assert.equal(u.total, 1260); assert.equal(u.cost_total, 500); assert.equal(u.lpo, '202600001'); assert.equal(u.manual_quotation, 0); assert.equal(u.po_no, '202600001');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM quote_lines WHERE quotation_id=?').get(u.id).n, 1, 'two lines collapsed into one');
    assert.match(db.prepare("SELECT note FROM quote_events WHERE quotation_id=? AND action='imported from Excel'").get(u.id).note, /previous lines/);
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(inv1);
    assert.deepEqual([inv.net, inv.vat, inv.total], [1200, 60, 1260]);
    assert.equal(db.prepare('SELECT SUM(amount) s FROM invoice_lines WHERE invoice_id=?').get(inv1).s, 1200);
    assert.equal(b.invoicesFixed.length, 1); assert.equal(b.invoicesFixed[0].old.total, 1050);
    assert.equal(db.prepare('SELECT total FROM invoices WHERE id=?').get(inv2).total, 2100, 'untouched invoice stays');

    // accepted jobs count as paid (partners' profit share); declined and sent ones do not
    assert.equal(b.markedPaid, 4);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM quotations WHERE status='accepted' AND paid_at IS NOT NULL").get().n, 4);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM quotations WHERE status<>'accepted' AND paid_at IS NOT NULL").get().n, 0);
    assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(inv1).status, 'paid');

    // accepted jobs without expenses get one approved Material expense = estimated cost
    assert.equal(b.expensesAdded, 4);
    assert.equal(db.prepare("SELECT SUM(total) s FROM expenses WHERE status='approved' AND cost_type='Material'").get().s, 1540);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM expenses e JOIN quotations q ON q.id=e.quotation_id WHERE q.status<>'accepted'").get().n, 0);

    // same file again: nothing is added twice
    const again = (await t.call('admin', 'POST', '/api/app/import', { data: file.toString('base64') })).body;
    assert.equal(again.created, 0); assert.equal(again.markedPaid, 0); assert.equal(again.expensesAdded, 0); assert.equal(again.updated, 0); assert.equal(again.invoicesFixed.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM quotations').get().n, 6);

    // exports carry the two new fields, and an export can be re-imported
    const ex = await t.call('admin', 'GET', '/api/app/export/quotations.xlsx', undefined, { raw: true });
    const { readXlsx } = await import('../src/importer.js');
    const rows = readXlsx(Buffer.from(await ex.arrayBuffer()));
    assert.deepEqual(rows[0].slice(-3), ['Manual Quotation', 'PO', 'Remarks']);
    assert.ok(rows.some((x) => x[0] === 'DABTS/3' && x.at(-3) === 'DABTS/118/25' && x.at(-1) === 'client went elsewhere'));
  } finally { await t.close(); }
});

test('quotation form saves Manual Quotation and Remarks', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin');
    const body = t.quote({ manual_no: 'DABTS/118/25', remarks: 'paper copy signed on site' });
    const id = (await t.call('admin', 'POST', '/api/app/quotations', body)).body.quotation.id;
    const d = (await t.call('admin', 'GET', `/api/app/quotations/${id}`)).body.quotation;
    assert.equal(d.manual_quotation, 1); assert.equal(d.manual_no, 'DABTS/118/25'); assert.equal(d.remarks, 'paper copy signed on site');
    await t.call('admin', 'PUT', `/api/app/quotations/${id}`, t.quote({ subject: 'Edited' })); // fields omitted: kept
    const kept = (await t.call('admin', 'GET', `/api/app/quotations/${id}`)).body.quotation; assert.equal(kept.remarks, 'paper copy signed on site'); assert.equal(kept.manual_no, 'DABTS/118/25');
  } finally { await t.close(); }
});
