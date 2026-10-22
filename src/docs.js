// Quotation and tax invoice PDFs in Dar Al Bunyan colours (navy + red), with the company logo.
import fs from 'node:fs';
import { Pdf, PAGE_W, PAGE_H } from './pdf.js';
import { decodePng } from './png.js';
import { money } from './time.js';

const NAVY = '#1f2a4d';
const RED = '#c8202a';
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#d9dce4';
let LOGO;
function logo() {
  if (LOGO === undefined) {
    try { LOGO = decodePng(fs.readFileSync(new URL('../public/logo.png', import.meta.url))); } catch { LOGO = null; }
  }
  return LOGO;
}
export const fmtDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '-';
  return `${Number(m[3])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${m[1]}`;
};
const qtyText = (n) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2));

/**
 * doc: { title, number, meta: [[label, value]], client: {name, contact, email, phone, address, trn},
 *        subject, lines: [{description, qty, unit, unit_price, amount}], totals: {subtotal, discount, discount_pct, net, vat_rate, vat, total},
 *        notesTitle, notes, footerBlocks: [[title, text]] }
 */
export function renderPdf(doc, s) {
  const pdf = new Pdf({ title: `${doc.title} ${doc.number}`, author: s.company_name });
  const L = 42, R = PAGE_W - 42;
  const header = () => {
    const lg = logo();
    if (lg) pdf.image(lg, L, 24, 64, 65);
    const x = lg ? L + 76 : L;
    pdf.text(s.company_name, x, 46, { size: 13, bold: true, fill: NAVY });
    const sub = [s.company_address, s.company_trn ? `TRN: ${s.company_trn}` : '', [s.company_phone, s.company_email].filter(Boolean).join('  |  ')].filter(Boolean);
    sub.forEach((t, i) => pdf.text(t, x, 61 + i * 12, { size: 8.5, fill: MUTED }));
    pdf.text(doc.title, R, 46, { size: 18, bold: true, align: 'right', fill: RED });
    pdf.text(`No. ${doc.number}`, R, 63, { size: 10.5, bold: true, align: 'right', fill: INK });
    pdf.rect(L, 100, R - L, 3, { fill: NAVY });
    pdf.rect(L, 103, 90, 3, { fill: RED });
  };
  header();

  let y = 128;
  pdf.text(doc.toLabel || 'BILL TO', L, y, { size: 8, bold: true, fill: MUTED });
  pdf.text('DETAILS', 330, y, { size: 8, bold: true, fill: MUTED });
  y += 14;
  const c = doc.client || {};
  const to = [c.name, c.contact && `Attn: ${c.contact}`, ...(c.address ? pdf.wrap(c.address, 250, 9.5) : []), c.phone, c.email, c.trn && `TRN: ${c.trn}`].filter(Boolean);
  to.forEach((t, i) => pdf.text(t, L, y + i * 12.5, { size: 9.5, bold: i === 0, fill: INK }));
  doc.meta.forEach(([k, v], i) => {
    pdf.text(k, 330, y + i * 12.5, { size: 9, fill: MUTED });
    pdf.text(String(v || '-'), 425, y + i * 12.5, { size: 9.5, fill: INK });
  });
  y += Math.max(to.length, doc.meta.length) * 12.5 + 12;
  if (doc.subject) {
    const sl = pdf.wrap(doc.subject, R - L - 70, 10, true);
    pdf.rect(L, y, R - L, sl.length * 13 + 12, { fill: '#f1f3f8' });
    pdf.text('Subject', L + 10, y + 16, { size: 9, fill: MUTED });
    sl.forEach((t, i) => pdf.text(t, L + 64, y + 16 + i * 13, { size: 10, bold: true, fill: INK }));
    y += sl.length * 13 + 24;
  }

  const col = { n: L + 8, desc: L + 30, qty: 360, unit: 368, price: 470, amount: R - 8 };
  const tableHead = () => {
    pdf.rect(L, y, R - L, 22, { fill: NAVY });
    const o = { size: 8.5, bold: true, fill: '#ffffff' };
    pdf.text('#', col.n, y + 15, o);
    pdf.text('Description', col.desc, y + 15, o);
    pdf.text('Qty', col.qty, y + 15, { ...o, align: 'right' });
    pdf.text('Unit', col.unit, y + 15, o);
    pdf.text('Unit price', col.price, y + 15, { ...o, align: 'right' });
    pdf.text('Amount (AED)', col.amount, y + 15, { ...o, align: 'right' });
    y += 22;
  };
  tableHead();
  doc.lines.forEach((l, i) => {
    const dl = pdf.wrap(l.description, 290, 9.5);
    const h = Math.max(22, dl.length * 12 + 10);
    if (y + h > PAGE_H - 200) { pdf.newPage(); header(); y = 125; tableHead(); }
    if (i % 2) pdf.rect(L, y, R - L, h, { fill: '#f8f9fc' });
    pdf.text(String(i + 1), col.n, y + 15, { size: 9, fill: MUTED });
    dl.forEach((t, j) => pdf.text(t, col.desc, y + 15 + j * 12, { size: 9.5, fill: INK }));
    pdf.text(qtyText(l.qty), col.qty, y + 15, { size: 9.5, align: 'right', fill: INK });
    pdf.text(l.unit || '', col.unit, y + 15, { size: 9, fill: MUTED });
    pdf.text(money(l.unit_price), col.price, y + 15, { size: 9.5, align: 'right', fill: INK });
    pdf.text(money(l.amount), col.amount, y + 15, { size: 9.5, align: 'right', fill: INK });
    y += h;
    pdf.line(L, y, R, y, { stroke: LINE, lineWidth: 0.5 });
  });

  y += 12;
  if (y > PAGE_H - 190) { pdf.newPage(); header(); y = 125; }
  const t = doc.totals;
  const rows = [['Subtotal', money(t.subtotal)]];
  if (t.discount > 0) rows.push([`Discount (${Number(t.discount_pct)}%)`, `- ${money(t.discount)}`], ['Net amount', money(t.net)]);
  rows.push([`VAT (${Number(t.vat_rate)}%)`, money(t.vat)]);
  rows.forEach(([k, v], i) => {
    pdf.text(k, 400, y + 12 + i * 15, { size: 9.5, fill: MUTED });
    pdf.text(v, R - 8, y + 12 + i * 15, { size: 9.5, align: 'right', fill: INK });
  });
  y += rows.length * 15 + 8;
  pdf.rect(390, y, R - 390, 26, { fill: NAVY });
  pdf.text('TOTAL (AED)', 400, y + 17, { size: 10, bold: true, fill: '#ffffff' });
  pdf.text(money(t.total), R - 8, y + 17, { size: 11, bold: true, align: 'right', fill: '#ffffff' });
  const totalsBottom = y + 26;

  let ny = totalsBottom - rows.length * 15 - 8 - 4;
  for (const [title, text] of doc.blocks || []) {
    if (!text) continue;
    const lines = pdf.wrap(text, 320, 8.5);
    if (ny + lines.length * 11 + 30 > PAGE_H - 50) { pdf.newPage(); header(); ny = 125; }
    pdf.text(title.toUpperCase(), L, ny + 12, { size: 8, bold: true, fill: RED });
    lines.forEach((ln, i) => pdf.text(ln, L, ny + 25 + i * 11, { size: 8.5, fill: INK }));
    ny += lines.length * 11 + 32;
  }
  const bottom = Math.max(ny, totalsBottom + 20);
  if (doc.signature && bottom < PAGE_H - 110) {
    pdf.line(L, bottom + 50, L + 170, bottom + 50, { stroke: LINE });
    pdf.text(`For ${s.company_name}`, L, bottom + 63, { size: 8.5, fill: MUTED });
    pdf.line(R - 170, bottom + 50, R, bottom + 50, { stroke: LINE });
    pdf.text('Client acceptance (name, signature, date)', R, bottom + 63, { size: 8.5, align: 'right', fill: MUTED });
  }
  pdf.pages.forEach((_, i) => {
    pdf.cur = pdf.pages[i];
    pdf.line(L, PAGE_H - 34, R, PAGE_H - 34, { stroke: LINE, lineWidth: 0.5 });
    pdf.text(`${s.company_name}${s.company_tagline ? ' - ' + s.company_tagline : ''}`, L, PAGE_H - 22, { size: 7.5, fill: MUTED });
    pdf.text(`Page ${i + 1} of ${pdf.pages.length}`, R, PAGE_H - 22, { size: 7.5, align: 'right', fill: MUTED });
  });
  return pdf.toBuffer();
}

export function quotationPdf(q, lines, client, s) {
  return renderPdf({
    title: 'QUOTATION', number: q.number, toLabel: 'QUOTATION FOR', signature: true,
    meta: [['Date', fmtDay(q.quote_date)], ['Valid until', fmtDay(q.valid_until)], ['Site', q.site || '-'], ['Client LPO', q.lpo || '-']],
    client, subject: q.subject, lines,
    totals: { subtotal: q.subtotal, discount: q.discount, discount_pct: q.discount_pct, net: q.net, vat_rate: q.vat_rate, vat: q.vat, total: q.total },
    blocks: [['Terms and conditions', q.terms], ['Notes', q.notes]],
  }, s);
}

const STAMP = (ts) => {
  const d = new Date(ts + 4 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};

/**
 * Tax invoice in the same layout as the Consultancy invoices (FROM / BILL TO, grey details box,
 * Net / VAT / Total per line, totals block, footer), in Dar Al Bunyan navy and red.
 */
/** Tax credit note: same layout as the invoice it cancels. */
export function creditNotePdf(cn, inv, lines, client, s, { generatedAt = Date.now() } = {}) {
  return invoicePdf(inv, lines, client, s, { generatedAt, credit: cn });
}

export function invoicePdf(inv, lines, client, s, { payLink, generatedAt = Date.now(), credit = null } = {}) {
  const cancelled = inv.status === 'cancelled' && !credit;
  const docNo = credit ? credit.number : inv.number;
  const pdf = new Pdf({ title: credit ? `Tax Credit Note ${credit.number}` : `Tax Invoice ${inv.number}`, author: s.company_name });
  const L = 45, R = PAGE_W - 45;
  const rate = Number(inv.vat_rate) || 0;

  // header: logo + company + TRN | TAX INVOICE + number
  const header = () => {
    const lg = logo();
    const nameX = lg ? L + 70 : L;
    if (lg) pdf.image(lg, L, 22, 60, 61);
    let size = 15;
    let nameLines = pdf.wrap(s.company_name, R - 185 - nameX, size, true);
    if (nameLines.length > 2) { size = 12; nameLines = pdf.wrap(s.company_name, R - 185 - nameX, size, true); }
    nameLines = nameLines.slice(0, 3);
    const top = nameLines.length > 1 ? 42 : 50;
    nameLines.forEach((t, i) => pdf.text(t, nameX, top + i * (size + 2), { size, bold: true, fill: NAVY }));
    pdf.text(`TRN: ${s.company_trn || '-'}`, nameX, top + (nameLines.length - 1) * (size + 2) + 15, { size: 10, fill: MUTED });
    pdf.text(credit ? 'TAX CREDIT NOTE' : cancelled ? 'CANCELLED INVOICE' : 'TAX INVOICE', R, 50, { size: 20, bold: true, align: 'right', fill: RED });
    pdf.text(`No. ${docNo}`, R, 68, { size: 11, bold: true, align: 'right', fill: INK });
    pdf.rect(L, 100, R - L, 3, { fill: NAVY });
    pdf.rect(L, 100, 90, 3, { fill: RED });
  };
  header();

  // FROM / BILL TO
  let y = 130;
  pdf.text('FROM', L, y, { size: 8, bold: true, fill: MUTED });
  pdf.text('BILL TO', 310, y, { size: 8, bold: true, fill: MUTED });
  y += 14;
  const fromName = pdf.wrap(s.company_name, 240, 10, true);
  const from = [...fromName, ...(s.company_address ? pdf.wrap(s.company_address, 240, 10) : []), s.company_phone && `Tel: ${s.company_phone}`, s.company_email && `Email: ${s.company_email}`].filter(Boolean);
  const c = client || {};
  const toName = pdf.wrap(c.name || '', 240, 10, true);
  const to = [...toName, c.contact && `Attn: ${c.contact}`, ...(c.address ? pdf.wrap(c.address, 240, 10) : []), c.email, c.phone, c.trn && `TRN: ${c.trn}`].filter(Boolean);
  from.forEach((t, i) => pdf.text(t, L, y + i * 13, { size: 10, bold: i < fromName.length, fill: INK }));
  to.forEach((t, i) => pdf.text(t, 310, y + i * 13, { size: 10, bold: i < toName.length, fill: INK }));
  y += Math.max(from.length, to.length) * 13 + 16;

  // grey details box
  const payText = inv.status === 'paid' ? `Paid ${fmtDay(inv.paid_at)}${inv.payment_method ? ' - ' + inv.payment_method : ''}${inv.payment_ref ? ' - ' + inv.payment_ref : ''}` : cancelled ? 'Cancelled' : `Due ${fmtDay(inv.due_date)}`;
  const meta = credit ? [
    ['Credit note date', fmtDay(credit.issue_date)],
    ['Original tax invoice', `${inv.number} dated ${fmtDay(inv.issue_date)}`],
    ['Quotation reference', inv.quote_number || '-'],
    ...(inv.lpo ? [['Client LPO', inv.lpo]] : []),
    ['Subject', inv.subject || '-'],
    ['Reason', credit.reason || '-'],
  ] : [
    ['Invoice date', fmtDay(inv.issue_date)],
    ['Due date', fmtDay(inv.due_date)],
    ['Quotation reference', inv.quote_number || '-'],
    ...(inv.lpo ? [['Client LPO', inv.lpo]] : []),
    ['Subject', inv.subject || '-'],
    ['Payment', payText],
  ];
  const metaRows = meta.map(([k, v]) => [k, pdf.wrap(String(v), R - L - 160, 10)]);
  const boxH = metaRows.reduce((a, [, v]) => a + v.length * 13 + 4, 0) + 16;
  pdf.rect(L, y, R - L, boxH, { fill: '#f1f3f8' });
  let my = y + 20;
  for (const [k, v] of metaRows) {
    pdf.text(k, L + 12, my, { size: 9, fill: MUTED });
    v.forEach((t, i) => pdf.text(t, L + 150, my + i * 13, { size: 10, fill: INK }));
    my += v.length * 13 + 4;
  }
  y += boxH + 24;

  // lines: Description | Net | VAT | Total
  const col = { desc: L + 8, net: 375, vat: 455, total: R - 8 };
  const tableHead = () => {
    pdf.rect(L, y, R - L, 24, { fill: NAVY });
    const o = { size: 9, bold: true, fill: '#ffffff' };
    pdf.text('Description', col.desc, y + 16, o);
    pdf.text('Net (AED)', col.net, y + 16, { ...o, align: 'right' });
    pdf.text('VAT (AED)', col.vat, y + 16, { ...o, align: 'right' });
    pdf.text('Total (AED)', col.total, y + 16, { ...o, align: 'right' });
    y += 24;
  };
  tableHead();
  for (const l of lines) {
    const desc = Number(l.qty) && l.unit && l.amount >= 0 ? `${l.description} (${qtyText(l.qty)} ${l.unit} x ${money(l.unit_price)})` : l.description;
    const dl = pdf.wrap(desc, 255, 10);
    const h = Math.max(30, dl.length * 13 + 16);
    if (y + h > PAGE_H - 210) { pdf.newPage(); header(); y = 125; tableHead(); }
    const vat = Math.round(l.amount * rate) / 100;
    dl.forEach((t, j) => pdf.text(t, col.desc, y + 19 + j * 13, { size: 10, fill: INK }));
    pdf.text(money(l.amount), col.net, y + 19, { size: 10, align: 'right', fill: INK });
    pdf.text(money(vat), col.vat, y + 19, { size: 10, align: 'right', fill: INK });
    pdf.text(money(l.amount + vat), col.total, y + 19, { size: 10, align: 'right', fill: INK });
    y += h;
    pdf.line(L, y, R, y, { stroke: LINE });
  }

  // totals
  y += 22;
  if (y > PAGE_H - 200) { pdf.newPage(); header(); y = 130; }
  pdf.text('Subtotal (excl. VAT)', 345, y, { size: 10, fill: INK });
  pdf.text(money(inv.net), col.total, y, { size: 10, align: 'right', fill: INK });
  pdf.text(`VAT ${rate}%`, 345, y + 18, { size: 10, fill: INK });
  pdf.text(money(inv.vat), col.total, y + 18, { size: 10, align: 'right', fill: INK });
  pdf.text(credit ? 'Total credited (AED)' : 'Total (AED)', 345, y + 38, { size: 12, bold: true, fill: RED });
  pdf.text(money(inv.total), col.total, y + 38, { size: 12, bold: true, align: 'right', fill: RED });
  pdf.line(340, y + 43, R, y + 43, { stroke: RED, lineWidth: 1 });
  y += 74;

  // closing text: thank you (paid) or payment instructions (unpaid)
  const bank = [s.bank_account_name && `Account name: ${s.bank_account_name}`, s.bank_name && `Bank: ${s.bank_name}`, s.bank_account_number && `Account number: ${s.bank_account_number}`, s.bank_iban && `IBAN: ${s.bank_iban}`, s.bank_swift && `SWIFT: ${s.bank_swift}`].filter(Boolean);
  const closing = credit ? [`This credit note cancels tax invoice ${inv.number} in full (AED ${money(inv.total)} including VAT AED ${money(inv.vat)}).`, 'The amount above is credited to your account.']
    : cancelled ? ['This invoice has been cancelled.']
    : inv.status === 'paid' ? [`Paid in full${inv.payment_method ? ' by ' + inv.payment_method.toLowerCase() : ''}. Thank you.`]
      : [`Please pay by ${fmtDay(inv.due_date)} and quote invoice number ${inv.number}.`, ...(bank.length ? ['', 'Bank transfer details:', ...bank] : []), ...(payLink ? [`Pay online: ${payLink}`] : [])];
  if (inv.notes && !credit) closing.push('', ...String(inv.notes).split('\n'));
  for (const t of closing) {
    for (const ln of pdf.wrap(t, R - L, 10)) {
      if (y > PAGE_H - 60) { pdf.newPage(); header(); y = 130; }
      pdf.text(ln, L, y, { size: 10, fill: INK });
      y += 14;
    }
  }

  // footer on every page
  const contact = [s.company_phone, s.company_email, s.company_address].filter(Boolean).join('  |  ');
  pdf.pages.forEach((_, i) => {
    pdf.cur = pdf.pages[i];
    pdf.line(L, PAGE_H - 50, R, PAGE_H - 50, { stroke: LINE, lineWidth: 0.5 });
    pdf.text(s.company_name, PAGE_W / 2, PAGE_H - 36, { size: 8, bold: true, align: 'center', fill: NAVY });
    const foot = `${contact ? contact + '  -  ' : ''}Computer-generated document, no signature required. Generated ${STAMP(generatedAt)}.${pdf.pages.length > 1 ? `  Page ${i + 1} of ${pdf.pages.length}` : ''}`;
    pdf.wrap(foot, R - L + 40, 7.5).slice(0, 2).forEach((t, j) => pdf.text(t, PAGE_W / 2, PAGE_H - 24 + j * 10, { size: 7.5, align: 'center', fill: MUTED }));
  });
  return pdf.toBuffer();
}
