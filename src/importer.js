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
