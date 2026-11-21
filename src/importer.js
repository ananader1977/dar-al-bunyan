// Imports the Zoho "Expenses_Report" Excel file: jobs become customers + accepted/declined quotations
// (and invoices when the remarks name one), every row becomes an expense. Safe to run twice: rows that
// were already imported are skipped.
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { tx } from './db.js';
import { round2 } from './time.js';
import { HttpError } from './http.js';

// ---- minimal .xlsx reader: first worksheet -> array of row arrays --------------------------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new HttpError(400, 'This is not an Excel (.xlsx) file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lstart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(lstart, lstart + csize);
    files[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw));
    p += 46 + nlen + elen + clen;
  }
  return files;
}
const xmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export function readXlsx(buf) {
  const files = unzip(buf);
  const get = (n) => (files[n] ? files[n]().toString('utf8') : '');
  const shared = [];
  for (const m of get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const firstId = (/<sheet [^>]*r:id="([^"]+)"/.exec(wb) || [])[1];
  const target = firstId && (new RegExp(`Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`Target="([^"]+)"[^>]*Id="${firstId}"`).exec(rels) || [])[1];
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = get(sheetPath) || get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new HttpError(400, 'No worksheet found in this file.');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const t = (/t="(\w+)"/.exec(attrs) || [])[1];
      const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = xmlText((/<is>([\s\S]*?)<\/is>/.exec(inner) || [])[1] || '');
      else if (t === 'str' || t === 'e') val = v !== undefined ? xmlText(v) : '';
      else if (t === 'b') val = v === '1';
      else if (v !== undefined) val = Number(v);
      row[ref ? colIndex(ref) : row.length] = val;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? '' : x)));
  }
  return rows;
}

// ---- import -------------------------------------------------------------------------------
const CLIENT_RULES = [
  [/seddiqi|reem|mirdif/i, 'Seddiqi'],
  [/\brta\b|bus station|bus depo|khawaneej|al aweer|al aw\b/i, 'RTA'],
  [/meydan/i, 'Meydan'],
  [/lehbab/i, 'Lehbab Farmhouse'],
  [/capricorn/i, 'Capricorn'],
  [/food court/i, 'Jebel Ali Food Court'],
  [/pepsi/i, 'Pepsi'],
  [/city tower/i, 'City Tower 2'],
];
export const clientFor = (subject) => (CLIENT_RULES.find(([re]) => re.test(subject)) || [null, 'Unassigned'])[1];

const excelDate = (v) => {
  if (typeof v === 'number' && v > 20000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s);
  if (m) return `${m[3]}-${String(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
};
const numOf = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };

export function importExpensesReport(ctx, buf, user = null) {
  const rows = readXlsx(buf);
  if (rows.length < 2) throw new HttpError(400, 'The file has no data rows.');
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n.toLowerCase()); if (i >= 0) return i; } return -1; };
  const C = {
    createdBy: col('Created By'), paidOn: col('Paid On'), quote: col('Quotation Number'), subject: col('Subject'), qstatus: col('Quotation Status'),
    revenue: col('Revenue Total1', 'Revenue Total', 'Revenue'), cost: col('Cost'), qty: col('Quantities', 'Quantity'), total: col('Total Actual Costs', 'Total Cost'),
    type: col('Cost Type'), paidBy: col('Paid By'), paidBack: col('Cost Paid back To Mohamed?', 'Cost Paid Back'), sharePaid: col('Revenue Share paid?', 'Revenue Share Paid'), remarks: col('Remarks'),
  };
  if (C.paidOn < 0 || C.cost < 0) throw new HttpError(400, 'This does not look like the Expenses Report (missing "Paid On" or "Cost" columns).');
  const { db } = ctx;
  const svc = ctx.service;
  const s = ctx.settings();
  const at = (r, i) => (i >= 0 ? r[i] : '');
  const result = { quotations: 0, expenses: 0, invoices: 0, clients: 0, loans: 0, skipped: 0 };
  const usersByEmail = Object.fromEntries(db.prepare('SELECT id,email FROM users').all().map((u) => [u.email, u.id]));
  let maxQuote = 0, maxInv = 0, invSuffix = null;

  tx(db, () => {
    for (const r of rows.slice(1)) {
      const paidOn = excelDate(at(r, C.paidOn));
      const qn = String(at(r, C.quote) ?? '').trim();
      const subject = String(at(r, C.subject) || '').trim();
      const revenue = round2(numOf(at(r, C.revenue)));
      const cost = round2(numOf(at(r, C.cost)));
      const qty = numOf(at(r, C.qty)) || 1;
      const total = round2(numOf(at(r, C.total)) || cost * qty);
      const remarks = String(at(r, C.remarks) || '').trim();
      if (!paidOn || (!revenue && !total && !qn)) { result.skipped++; continue; }
      const creator = usersByEmail[String(at(r, C.createdBy) || '').toLowerCase()] || user?.id || null;
      let quoteId = null;
      // personal loans go to their own table (deducted from partner B's share)
      if (!qn && /loan/i.test(String(at(r, C.type) || ''))) {
        const note = remarks.split('\n')[0] || 'Personal loan';
        if (db.prepare('SELECT 1 FROM partner_loans WHERE taken_on=? AND amount=? AND note=?').get(paidOn, total, note)) { result.skipped++; continue; }
        db.prepare('INSERT INTO partner_loans(taken_on,amount,note,created_by,created_at) VALUES(?,?,?,?,?)').run(paidOn, total, note, creator, ctx.now());
        result.loans = (result.loans || 0) + 1;
        continue;
      }

      if (qn) {
        const number = `${s.quote_prefix}${qn}`;
        if (/^\d+$/.test(qn)) maxQuote = Math.max(maxQuote, Number(qn));
        const existing = db.prepare('SELECT id FROM quotations WHERE number=?').get(number);
        if (existing) { result.skipped++; continue; } // already imported
        const clientName = clientFor(subject);
        const before = db.prepare('SELECT id FROM clients WHERE name=?').get(clientName);
        const clientId = svc.upsertClient({ name: clientName, notes: clientName === 'Unassigned' ? 'Jobs from the Excel import with no client in the subject. Reassign them.' : 'Created from the Excel import; add contact details.' }, { update: false });
        if (!before) result.clients++;
        const st = String(at(r, C.qstatus) || '').toLowerCase().startsWith('decl') ? 'declined' : 'accepted';
        const vatRate = Number(s.vat_rate) || 5;
        const t = svc.totals([{ amount: revenue, cost: total }], 0, vatRate);
        const lpo = [...remarks.matchAll(/(?:LPO|PO)[:\s]*([0-9]{6,}(?:\s*\((?:old|new)\))?)/gi)].map((m) => m[1].trim()).join(', ');
        // the jobs in the old sheet were all paid by the customers
        quoteId = Number(db.prepare(`INSERT INTO quotations(number,client_id,subject,quote_date,valid_until,status,discount_pct,vat_rate,subtotal,discount,net,vat,total,cost_total,lpo,terms,notes,share_paid,created_by,closed_at,paid_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,0,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(number, clientId, subject || `Job ${qn}`, paidOn, paidOn, st, vatRate, t.subtotal, t.net, t.vat, t.total, t.cost_total, lpo, '',
          remarks, String(at(r, C.sharePaid)).toLowerCase() === 'yes' ? 1 : 0, creator, paidOn, st === 'accepted' ? paidOn : null, ctx.now(), ctx.now()).lastInsertRowid);
        db.prepare('INSERT INTO quote_lines(quotation_id,pos,description,qty,unit,unit_price,unit_cost,amount,cost) VALUES(?,1,?,1,?,?,?,?,?)').run(quoteId, subject || `Job ${qn}`, 'Job', revenue, total, revenue, total);
        db.prepare('INSERT INTO quote_events(quotation_id,ts,user_id,action,note) VALUES(?,?,?,?,?)').run(quoteId, ctx.now(), user?.id || null, 'imported from Excel', st);
        result.quotations++;
        const inv = /Invo(?:i?ce|ive)\s*:?\s*([A-Z]+\/\d+\/\d+)/i.exec(remarks);
        if (inv && st === 'accepted' && !db.prepare('SELECT 1 FROM invoices WHERE number=?').get(inv[1])) {
          const im = /^(.*?)(\d+)(\/\d+)$/.exec(inv[1]);
          if (im && im[1] === s.invoice_prefix) { maxInv = Math.max(maxInv, Number(im[2])); invSuffix = im[3]; }
          const iid = Number(db.prepare(`INSERT INTO invoices(number,quotation_id,client_id,subject,issue_date,due_date,lpo,net,vat_rate,vat,total,status,paid_at,payment_method,payment_ref,pay_token,notes,created_by,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,'paid',?,'Bank transfer','Imported as paid',?,'',?,?)`).run(inv[1], quoteId, clientId, subject, paidOn, paidOn, lpo, t.net, vatRate, t.vat, t.total, paidOn, crypto.randomBytes(16).toString('base64url'), creator, ctx.now()).lastInsertRowid);
          db.prepare('INSERT INTO invoice_lines(invoice_id,pos,description,qty,unit,unit_price,amount) VALUES(?,1,?,1,?,?,?)').run(iid, subject, 'Job', revenue, revenue);
          result.invoices++;
        }
      } else {
        const dup = db.prepare('SELECT 1 FROM expenses WHERE quotation_id IS NULL AND paid_on=? AND cost_type=? AND total=? AND remarks=?').get(paidOn, String(at(r, C.type) || 'Others'), total, remarks);
        if (dup) { result.skipped++; continue; }
      }
      if (total) {
        svc.saveExpense({ id: creator }, {
          paid_on: paidOn, quotation_id: quoteId, cost_type: String(at(r, C.type) || 'Others'), description: qn ? subject : remarks.split('\n')[0] || String(at(r, C.type) || ''),
          amount: cost || total / qty, qty, paid_by: String(at(r, C.paidBy) || 'Pending'), paid_back: String(at(r, C.paidBack)).toLowerCase() === 'yes', remarks,
        });
        result.expenses++;
      }
    }
    const cur = Number(s.next_quote_no) || 1;
    if (maxQuote + 1 > cur) svc.setSetting('next_quote_no', maxQuote + 1);
    if (maxInv && maxInv + 1 > (Number(s.next_invoice_no) || 1)) { svc.setSetting('next_invoice_no', maxInv + 1); if (invSuffix) svc.setSetting('invoice_suffix', invSuffix); }
  });
  return result;
}

// ---- Quotations sheet (the app's own "Quotations" Excel export, edited or extended) ---------
// Rows with a Number that exists are UPDATED; rows with a new Number are ADDED under that number; rows with no Number are ADDED
// as manual quotations and get the next free number. Amounts of an existing invoice are corrected to match its quotation.
const QUOTE_RANK = { draft: 0, pending: 1, rejected: 1, approved: 2, sent: 3, accepted: 4, declined: 4 };
const STATUS_WORDS = { draft: 'draft', 'waiting approval': 'sent', pending: 'pending', approved: 'approved', returned: 'rejected', rejected: 'rejected', sent: 'sent', accepted: 'accepted', declined: 'declined' };
/** The "Manual Quotation" cell holds the number of the manual quotation (text, e.g. DABTS/118/25). Blank = leave as is; Yes / No only set the flag. */
const manualCell = (v) => {
  const t = String(v ?? '').trim();
  if (!t) return { manual: null, manualNo: null };
  if (/^(yes|y|true|1|manual)$/i.test(t)) return { manual: true, manualNo: null };
  if (/^(no|n|false|0)$/i.test(t)) return { manual: false, manualNo: null };
  return { manual: true, manualNo: t };
};
const yes = (v) => /^(yes|y|true|1|manual)$/i.test(String(v ?? '').trim());
const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
class DryRun extends Error {}

export function isQuotationSheet(rows) {
  const head = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
  return head.includes('number') && head.includes('net (excl. vat)') && !head.includes('paid on');
}

export function importQuotationsSheet(ctx, buf, user = null, { dry = false } = {}) {
  const rows = readXlsx(buf);
  if (!isQuotationSheet(rows)) throw new HttpError(400, 'This does not look like the Quotations export (needs "Number" and "Net (excl. VAT)" columns).');
  const head = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n.toLowerCase()); if (i >= 0) return i; } return -1; };
  const C = { number: col('Number'), date: col('Date'), customer: col('Customer'), subject: col('Subject'), site: col('Site'), status: col('Status'), net: col('Net (excl. VAT)'),
    vat: col('VAT'), total: col('Total'), cost: col('Estimated cost'), lpo: col('LPO'), invoice: col('Invoice'), createdBy: col('Created by'), manual: col('Manual Quotation'), remarks: col('Remarks') };
  if (C.date < 0 || C.net < 0) throw new HttpError(400, 'The "Date" and "Net (excl. VAT)" columns are required.');
  const at = (r, i) => (i >= 0 ? r[i] : '');
  const { db } = ctx, svc = ctx.service, s = ctx.settings();
  const users = db.prepare('SELECT id,name FROM users').all();
  const userByName = (n) => users.find((u) => u.name.trim().toLowerCase() === String(n || '').trim().toLowerCase())?.id || null;
  const out = { kind: 'quotations', dry, rows: 0, created: 0, createdNumbered: 0, updated: 0, unchanged: 0, newClients: 0, generated: [], updates: [], invoicesFixed: [], markedPaid: 0, expensesAdded: 0, invoiceNotes: [], warnings: [] };
  const warn = (line, msg) => out.warnings.push(`Row ${line}: ${msg}`);

  // 1. read every row into a clean record
  const recs = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    if (!r.some((v) => String(v ?? '').trim() !== '')) return;
    const date = excelDate(at(r, C.date));
    const net = round2(numOf(at(r, C.net)));
    const stRaw = String(at(r, C.status) || '').trim().toLowerCase();
    if (!date) { warn(line, 'no valid Date: skipped.'); return; }
    if (!(net > 0)) { warn(line, 'Net amount is empty or zero: skipped.'); return; }
    if (stRaw && !STATUS_WORDS[stRaw]) { warn(line, `unknown status "${at(r, C.status)}": skipped.`); return; }
    const vat = round2(numOf(at(r, C.vat))), total = round2(numOf(at(r, C.total)));
    const vatRate = C.vat >= 0 && String(at(r, C.vat)) !== '' ? Math.round((vat / net) * 10000) / 100 : Number(s.vat_rate) || 5;
    if (C.total >= 0 && String(at(r, C.total)) !== '' && !same(net + vat, total)) warn(line, `Net ${net} + VAT ${vat} is not Total ${total}; the total was recalculated from Net and VAT.`);
    const numRaw = String(at(r, C.number) ?? '').trim();
    const lpoRaw = at(r, C.lpo);
    recs.push({
      line, date, net, vatRate: vatRate >= 0 && vatRate <= 100 ? vatRate : Number(s.vat_rate) || 5, cost: round2(numOf(at(r, C.cost))), status: STATUS_WORDS[stRaw] || null,
      number: numRaw ? (/^\d+$/.test(numRaw) ? `${s.quote_prefix}${numRaw}` : numRaw) : '', customer: String(at(r, C.customer) || '').trim(),
      subject: String(at(r, C.subject) || '').trim(), site: String(at(r, C.site) || '').trim(), lpo: typeof lpoRaw === 'number' ? String(Math.round(lpoRaw)) : String(lpoRaw || '').trim(),
      invoice: String(at(r, C.invoice) || '').trim(), creator: userByName(at(r, C.createdBy)) || user?.id || null,
      ...manualCell(at(r, C.manual)), remarks: String(at(r, C.remarks) || '').trim(),
    });
  });
  const seen = new Map();
  for (const r of recs) if (r.number) { if (seen.has(r.number)) warn(r.line, `Number ${r.number} is also on row ${seen.get(r.number)}; the later row wins.`); seen.set(r.number, r.line); }

  const clientFrom = (r) => {
    const name = r.customer && r.customer.toLowerCase() !== 'unassigned' ? r.customer : null;
    if (!name) return null;
    return svc.upsertClient({ name, notes: 'Created from the Excel import; add contact details.' }, { update: false });
  };
  const subjectOf = (r) => r.subject || (r.site ? `Job - ${r.site}` : 'Job');
  const setLines = (qid, subject, net, cost) => {
    db.prepare('DELETE FROM quote_lines WHERE quotation_id=?').run(qid);
    db.prepare('INSERT INTO quote_lines(quotation_id,pos,description,qty,unit,unit_price,unit_cost,amount,cost) VALUES(?,1,?,1,?,?,?,?,?)').run(qid, subject, 'Job', net, cost, net, cost);
  };
  const ev = (qid, note) => db.prepare('INSERT INTO quote_events(quotation_id,ts,user_id,action,note) VALUES(?,?,?,?,?)').run(qid, ctx.now(), user?.id || null, 'imported from Excel', note);
  let maxNo = 0;
  const clientsBefore = db.prepare('SELECT COUNT(*) n FROM clients').get().n;

  const update = (q, r) => {
    const t = svc.totals([{ amount: r.net, cost: r.cost }], 0, r.vatRate);
    const ch = {};
    const set = {};
    const diff = (k, label, oldV, newV, same_) => { if (!(same_ ?? oldV === newV)) { ch[label] = [oldV, newV]; set[k] = newV; } };
    const cid = clientFrom(r);
    if (cid && cid !== q.client_id) diff('client_id', 'customer', db.prepare('SELECT name FROM clients WHERE id=?').get(q.client_id).name, db.prepare('SELECT name FROM clients WHERE id=?').get(cid).name, false), set.client_id = cid;
    if (r.subject) diff('subject', 'subject', q.subject, r.subject);
    if (r.site) diff('site', 'site', q.site, r.site);
    diff('quote_date', 'date', q.quote_date, r.date);
    if (r.lpo) diff('lpo', 'LPO', q.lpo, r.lpo);
    if (r.remarks) diff('remarks', 'remarks', q.remarks, r.remarks);
    if (r.manualNo !== null) { diff('manual_no', 'manual quotation no.', q.manual_no || '-', r.manualNo, q.manual_no === r.manualNo); set.manual_quotation = 1; }
    else if (r.manual !== null) diff('manual_quotation', 'manual quotation', q.manual_quotation ? 'Yes' : 'No', r.manual ? 'Yes' : 'No', !!q.manual_quotation === r.manual), set.manual_quotation = r.manual ? 1 : 0;
    if (r.status && r.status !== q.status) {
      const closing = r.status === 'accepted' || r.status === 'declined';
      if (closing || QUOTE_RANK[r.status] > QUOTE_RANK[q.status]) { ch.status = [q.status, r.status]; set.status = r.status; if (closing && !q.closed_at) set.closed_at = r.date; if (r.status === 'pending' && !q.submitted_at) set.submitted_at = ctx.now(); }
      else warn(r.line, `${q.number}: status kept as "${q.status}" (the sheet says "${r.status}", which would move it backwards).`);
    }
    const amountsChanged = !same(q.net, t.net) || !same(q.cost_total, t.cost_total) || !same(q.vat, t.vat) || !same(q.total, t.total) || !same(q.vat_rate, r.vatRate) || Number(q.discount) !== 0;
    if (amountsChanged) {
      for (const [k, lab] of [['net', 'net'], ['vat', 'VAT'], ['total', 'total'], ['cost_total', 'estimated cost']]) if (!same(q[k], t[k])) ch[lab] = [q[k], t[k]];
      Object.assign(set, { discount_pct: 0, discount: 0, vat_rate: r.vatRate, subtotal: t.subtotal, net: t.net, vat: t.vat, total: t.total, cost_total: t.cost_total });
    }
    if (!Object.keys(ch).length && !amountsChanged) { out.unchanged++; return; }
    const note = [];
    if (amountsChanged) {
      const lines = db.prepare('SELECT description,qty,unit,unit_price,unit_cost,amount,cost FROM quote_lines WHERE quotation_id=? ORDER BY pos').all(q.id);
      if (lines.length === 1 && lines[0].qty === 1) { db.prepare('UPDATE quote_lines SET unit_price=?,amount=?,unit_cost=?,cost=? WHERE quotation_id=?').run(t.net, t.net, t.cost_total, t.cost_total, q.id); }
      else { setLines(q.id, r.subject || q.subject, t.net, t.cost_total); if (lines.length > 1) { note.push(`${lines.length} item lines were replaced by one line; previous lines: ${JSON.stringify(lines)}`); ch['item lines'] = [`${lines.length} lines`, '1 line']; } }
    }
    set.updated_at = ctx.now();
    db.prepare(`UPDATE quotations SET ${Object.keys(set).map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(set), q.id);
    ev(q.id, [`changed: ${Object.entries(ch).map(([k, [a, b]]) => `${k} ${a} -> ${b}`).join('; ')}`, ...note].join(' | '));
    out.updated++;
    out.updates.push({ number: q.number, changes: ch });
  };

  const insert = (r, number) => {
    const t = svc.totals([{ amount: r.net, cost: r.cost }], 0, r.vatRate);
    const cid = clientFrom(r) || svc.upsertClient({ name: r.customer ? 'Unassigned' : clientFor(`${subjectOf(r)} ${r.site}`), notes: 'Jobs from the Excel import with no client given. Reassign them.' }, { update: false });
    const subject = subjectOf(r);
    if (!r.subject) warn(r.line, `no Subject: used "${subject}".`);
    const st = r.status || 'draft';
    const closing = st === 'accepted' || st === 'declined';
    const manual = r.manualNo ? true : r.manual !== null ? r.manual : !r.number;
    const qid = Number(db.prepare(`INSERT INTO quotations(number,client_id,subject,site,quote_date,valid_until,status,discount_pct,vat_rate,subtotal,discount,net,vat,total,cost_total,lpo,terms,notes,manual_quotation,manual_no,remarks,created_by,submitted_at,closed_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,0,?,?,0,?,?,?,?,?,?,'',?,?,?,?,?,?,?,?)`).run(number, cid, subject, r.site, r.date, addDaysIso(r.date, Number(s.quote_validity_days) || 30), st, r.vatRate, t.subtotal, t.net, t.vat, t.total, t.cost_total,
      r.lpo, s.quote_terms, manual ? 1 : 0, r.manualNo || '', r.remarks, r.creator, st === 'pending' ? ctx.now() : null, closing ? r.date : null, ctx.now(), ctx.now()).lastInsertRowid);
    setLines(qid, subject, t.net, t.cost_total);
    ev(qid, `${manual ? 'manual quotation ' : ''}added from the Excel sheet (row ${r.line}), status ${st}`);
    out.created++;
    return qid;
  };

  try {
    tx(db, () => {
      const handled = new Set();
      const find = (r) => {
        if (r.number) return db.prepare('SELECT * FROM quotations WHERE number=?').get(r.number);
        // no number: an identical quotation (same date, net, subject, site, LPO) is the same job, not a new one
        return db.prepare('SELECT * FROM quotations WHERE quote_date=? AND ABS(net-?)<0.005 AND lower(subject)=lower(?) AND lower(site)=lower(?) AND lower(lpo)=lower(?)').get(r.date, r.net, subjectOf(r), r.site, r.lpo || '');
      };
      const fresh = [];
      for (const r of recs) {
        if (r.number && seen.get(r.number) !== r.line) continue; // duplicate number in the file: the later row wins
        const q = find(r);
        if (q) { if (handled.has(q.id)) { warn(r.line, `same job as an earlier row (${q.number}): skipped.`); continue; } handled.add(q.id); update(q, r); out.rows++; continue; }
        fresh.push(r);
      }
      // new rows that already carry a Number keep it; the others get the next free numbers, oldest date first
      for (const r of fresh.filter((x) => x.number)) { insert(r, r.number); out.createdNumbered++; out.rows++; const n = /(\d+)$/.exec(r.number); if (n && r.number.startsWith(s.quote_prefix)) maxNo = Math.max(maxNo, Number(n[1])); }
      let next = Number(db.prepare("SELECT value FROM settings WHERE key='next_quote_no'").get()?.value) || 1;
      for (const r of fresh.filter((x) => !x.number).sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)) {
        while (db.prepare('SELECT 1 FROM quotations WHERE number=?').get(`${s.quote_prefix}${next}`)) next++;
        const number = `${s.quote_prefix}${next++}`;
        insert(r, number); out.rows++;
        out.generated.push({ row: r.line, number, date: r.date, subject: subjectOf(r), net: r.net });
      }
      svc.setSetting('next_quote_no', Math.max(next, maxNo + 1));

      // 3. invoices must show the same amounts as their quotation
      const invMismatch = db.prepare("SELECT i.*, q.number qnum, q.net qnet, q.vat qvat, q.total qtotal, q.vat_rate qrate, q.discount qdisc, q.discount_pct qdpct, q.id qid FROM invoices i JOIN quotations q ON q.id=i.quotation_id WHERE i.status<>'cancelled' AND q.id=?");
      for (const r of recs) {
        const q = find(r);
        if (!q) continue;
        const inv = invMismatch.get(q.id);
        // Accepted jobs in the sheet count as paid by the customer (so the partners' profit share includes them); their issued invoice is marked paid too
        const fresh_ = db.prepare('SELECT status, paid_at, quote_date, closed_at FROM quotations WHERE id=?').get(q.id);
        if (fresh_.status === 'accepted' && !fresh_.paid_at) {
          const paidOn = inv?.issue_date || fresh_.closed_at || fresh_.quote_date;
          db.prepare('UPDATE quotations SET paid_at=?, updated_at=? WHERE id=?').run(paidOn, ctx.now(), q.id);
          if (inv && inv.status === 'issued') db.prepare("UPDATE invoices SET status='paid', paid_at=?, payment_method='Bank transfer', payment_ref='Imported as paid' WHERE id=?").run(paidOn, inv.id);
          ev(q.id, `marked as paid by the customer on ${paidOn}`);
          out.markedPaid++;
        }
        // Costs in the finance report are expenses, not the quotation's estimate: an accepted job with no expenses at all gets one approved Material expense for its estimated cost
        const qc = db.prepare('SELECT id, subject, quote_date, cost_total FROM quotations WHERE id=?').get(q.id);
        if (fresh_.status === 'accepted' && qc.cost_total > 0 && !db.prepare('SELECT 1 FROM expenses WHERE quotation_id=?').get(q.id)) {
          db.prepare("INSERT INTO expenses(paid_on,quotation_id,cost_type,description,amount,qty,total,paid_by,paid_back,remarks,status,created_by,created_at) VALUES(?,?,'Material',?,?,1,?,'Pending',0,'Estimated cost from the Excel import',?,?,?)")
            .run(qc.quote_date, q.id, qc.subject, qc.cost_total, qc.cost_total, 'approved', user?.id || null, ctx.now());
          ev(q.id, `material expense of ${qc.cost_total} added from the estimated cost`);
          out.expensesAdded++;
        }
        if (!inv) { if (r.invoice) out.invoiceNotes.push(`${q.number}: the sheet shows invoice ${r.invoice}, but the app has no invoice for it. Nothing was created.`); continue; }
        if (r.invoice && r.invoice !== inv.number) out.invoiceNotes.push(`${q.number}: the sheet shows invoice ${r.invoice}, the app has ${inv.number}. Left as in the app.`);
        if (same(inv.net, inv.qnet) && same(inv.vat, inv.qvat) && same(inv.total, inv.qtotal)) continue;
        db.prepare('UPDATE invoices SET net=?, vat_rate=?, vat=?, total=? WHERE id=?').run(inv.qnet, inv.qrate, inv.qvat, inv.qtotal, inv.id);
        db.prepare('DELETE FROM invoice_lines WHERE invoice_id=?').run(inv.id);
        const ins = db.prepare('INSERT INTO invoice_lines(invoice_id,pos,description,qty,unit,unit_price,amount) VALUES(?,?,?,?,?,?,?)');
        const ql = db.prepare('SELECT * FROM quote_lines WHERE quotation_id=? ORDER BY pos').all(q.id);
        ql.forEach((l, i) => ins.run(inv.id, i + 1, l.description, l.qty, l.unit, l.unit_price, l.amount));
        svc.audit(user, 'invoice amounts corrected by import', 'invoice', inv.id, `${inv.number}: total ${inv.total} -> ${inv.qtotal}`);
        out.invoicesFixed.push({ invoice: inv.number, quotation: inv.qnum, status: inv.status, old: { net: inv.net, vat: inv.vat, total: inv.total }, new: { net: inv.qnet, vat: inv.qvat, total: inv.qtotal } });
      }
      out.newClients = db.prepare('SELECT COUNT(*) n FROM clients').get().n - clientsBefore;
      if (dry) throw new DryRun();
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; }
  return out;
}
const addDaysIso = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
