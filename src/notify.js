// Email through SMTP (Gmail: smtp.gmail.com + app password). Every message is recorded in the outbox
// (Admin > Messages). Without SMTP settings, messages are only logged there (status "logged").
import { sendMail } from './smtp.js';
import { money } from './time.js';
import { escHtml } from './util.js';
import { fmtDay } from './docs.js';

export function createNotifier(ctx) {
  const { db, config } = ctx;
  const log = (to, subject, body, status, error, attachment, ref) =>
    db.prepare('INSERT INTO outbox(ts,to_addr,subject,body,status,error,attachment,ref) VALUES(?,?,?,?,?,?,?,?)')
      .run(ctx.now(), to, subject, String(body).slice(0, 4000), status, error || null, attachment || null, ref || null);

  async function email({ to, cc, subject, text, html, attachments = [], ref }) {
    const list = [].concat(to || []).filter(Boolean);
    if (!list.length) return { status: 'skipped' };
    const all = [...list, ...[].concat(cc || []).filter(Boolean)];
    const names = attachments.map((a) => a.filename).join(', ');
    if (!config.smtp.host) { log(all.join(', '), subject, text, 'logged', 'Email not configured (SMTP_HOST)', names, ref); return { status: 'logged' }; }
    try {
      await sendMail({ ...config.smtp, from: config.smtp.from || config.smtp.user, to: all, subject, text, html, attachments });
      log(all.join(', '), subject, text, 'sent', null, names, ref);
      return { status: 'sent' };
    } catch (e) {
      console.error(`[email] ${subject} -> ${all.join(', ')} failed: ${e.message}`);
      log(all.join(', '), subject, text, 'failed', String(e.message || e), names, ref);
      return { status: 'failed', error: String(e.message || e) };
    }
  }

  const layout = (s, title, inner) => `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<div style="max-width:600px;margin:0 auto;padding:16px"><div style="background:#fff;border-bottom:4px solid #1f2a4d;padding:16px 22px;border-radius:12px 12px 0 0"><table style="border-collapse:collapse"><tr><td style="padding:0 12px 0 0"><img src="${escHtml(config.baseUrl)}/mark.png" width="44" height="44" alt="" style="display:block"></td><td><div style="font-size:12px;color:#6b7280">${escHtml(s.company_name)}</div><div style="font-size:19px;font-weight:bold;color:#1f2a4d">${escHtml(title)}</div></td></tr></table></div>
<div style="background:#fff;padding:22px;border-radius:0 0 12px 12px;line-height:1.55;font-size:14px">${inner}</div>
<p style="font-size:12px;color:#6b7280;text-align:center">${escHtml(s.company_name)}${s.company_address ? ' - ' + escHtml(s.company_address) : ''}${s.company_phone ? ' - ' + escHtml(s.company_phone) : ''}</p></div></body></html>`;
  const row = (k, v) => `<tr><td style="padding:5px 14px 5px 0;color:#6b7280;white-space:nowrap">${k}</td><td style="padding:5px 0"><b>${v}</b></td></tr>`;
  const table = (rows) => `<table style="border-collapse:collapse;font-size:14px">${rows.join('')}</table>`;
  const button = (href, label, color = '#c8202a') => `<p style="margin:20px 0"><a href="${escHtml(href)}" style="background:${color};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">${escHtml(label)}</a></p>`;
  const admins = () => db.prepare("SELECT email FROM users WHERE role='admin' AND active=1").all().map((r) => r.email);
  const quoteRows = (q) => [row('Quotation', escHtml(q.number)), row('Client', escHtml(q.client_name)), row('Subject', escHtml(q.subject)), row('Total', `AED ${money(q.total)} (incl. VAT)`)];
  const appLink = (q) => `${config.baseUrl}/app/#quote/${q.id}`;

  return {
    email,
    async approvalRequested(q, by) {
      const s = ctx.settings();
      const subject = `Approval needed: ${q.number} - ${q.client_name}`;
      const margin = q.net ? Math.round(((q.net - q.cost_total) / q.net) * 100) : 0;
      return email({
        to: admins(), cc: s.notify_email || null, subject, ref: q.number,
        text: `${by.name} submitted quotation ${q.number} for approval.\nClient: ${q.client_name}\nSubject: ${q.subject}\nTotal: AED ${money(q.total)}\nMargin: ${margin}%\nReview: ${appLink(q)}`,
        html: layout(s, 'Quotation waiting for approval', `<p>${escHtml(by.name)} submitted a quotation for your approval.</p>${table([...quoteRows(q), row('Cost', `AED ${money(q.cost_total)}`), row('Margin', `${margin}%`)])}${button(appLink(q), 'Review and approve', '#1f2a4d')}`),
      });
    },
    async decision(q, approved, note, by) {
      const s = ctx.settings();
      const creator = q.created_by ? db.prepare('SELECT email FROM users WHERE id=?').get(q.created_by) : null;
      if (!creator) return null;
      const word = approved ? 'approved' : 'returned for changes';
      return email({
        to: creator.email, ref: q.number, subject: `${q.number} ${word}`,
        text: `${by.name} ${word} quotation ${q.number}.${note ? `\nComment: ${note}` : ''}\n${appLink(q)}`,
        html: layout(s, `Quotation ${word}`, `<p>${escHtml(by.name)} ${word} your quotation.</p>${table([...quoteRows(q), ...(note ? [row('Comment', escHtml(note))] : [])])}${button(appLink(q), 'Open quotation', '#1f2a4d')}`),
      });
    },
    async quotationToClient(q, client, pdf, extra = [], message = '') {
      const s = ctx.settings();
      return email({
        to: client.email, ref: q.number, subject: `Quotation ${q.number} - ${q.subject}`,
        attachments: [{ filename: `Quotation-${q.number.replace(/[^\w-]/g, '_')}.pdf`, contentType: 'application/pdf', content: pdf }, ...extra],
        text: `Dear ${client.contact || client.name},\n\n${message || 'Please find attached our quotation for your review.'}\n\nQuotation: ${q.number}\nSubject: ${q.subject}\nTotal: AED ${money(q.total)} (incl. VAT)\nValid until: ${fmtDay(q.valid_until)}\n\nRegards,\n${s.company_name}`,
        html: layout(s, `Quotation ${q.number}`, `<p>Dear ${escHtml(client.contact || client.name)},</p><p>${escHtml(message || 'Please find attached our quotation for your review.')}</p>${table([row('Quotation', escHtml(q.number)), row('Subject', escHtml(q.subject)), row('Total', `AED ${money(q.total)} (incl. VAT)`), row('Valid until', fmtDay(q.valid_until))])}<p>To accept, reply to this email or send your LPO.</p><p>Regards,<br>${escHtml(s.company_name)}</p>`),
      });
    },
    async invoiceToClient(inv, client, pdf, payLink, extra = []) {
      const s = ctx.settings();
      return email({
        to: client.email, ref: inv.number, subject: `Tax invoice ${inv.number} - ${s.company_name}`,
        attachments: [{ filename: `Invoice-${inv.number.replace(/[^\w-]/g, '_')}.pdf`, contentType: 'application/pdf', content: pdf }, ...extra],
        text: `Dear ${client.contact || client.name},\n\nPlease find attached tax invoice ${inv.number}.\nAmount due: AED ${money(inv.total)}\nDue date: ${fmtDay(inv.due_date)}${payLink ? `\nPay online: ${payLink}` : ''}\n\nRegards,\n${s.company_name}`,
        html: layout(s, `Tax invoice ${inv.number}`, `<p>Dear ${escHtml(client.contact || client.name)},</p><p>Please find attached our tax invoice.</p>${table([row('Invoice', escHtml(inv.number)), row('Amount due', `AED ${money(inv.total)}`), row('Due date', fmtDay(inv.due_date))])}${payLink ? button(payLink, 'Pay online') : '<p>Payment details are on the attached invoice.</p>'}<p>Regards,<br>${escHtml(s.company_name)}</p>`),
      });
    },
    async creditNoteToClient(cn, inv, client, pdf) {
      const s = ctx.settings();
      return email({
        to: client.email, ref: cn.number, subject: `Tax credit note ${cn.number} - ${s.company_name}`,
        attachments: [{ filename: `Credit-note-${cn.number.replace(/[^\w-]/g, '_')}.pdf`, contentType: 'application/pdf', content: pdf }],
        text: `Dear ${client.contact || client.name},\n\nPlease find attached tax credit note ${cn.number}, which cancels invoice ${inv.number} (AED ${money(cn.total)}).\nReason: ${cn.reason}\n\nRegards,\n${s.company_name}`,
        html: layout(s, `Tax credit note ${cn.number}`, `<p>Dear ${escHtml(client.contact || client.name)},</p><p>Please find attached our tax credit note.</p>${table([row('Credit note', escHtml(cn.number)), row('Cancels invoice', escHtml(inv.number)), row('Amount', `AED ${money(cn.total)}`), row('Reason', escHtml(cn.reason))])}<p>Regards,<br>${escHtml(s.company_name)}</p>`),
      });
    },
    async expenseForApproval(e, by) {
      const s = ctx.settings();
      const link = `${config.baseUrl}/app/#approvals`;
      const what = `${e.cost_type}${e.quote_number ? ' for ' + e.quote_number : ' (no job)'}${e.description ? ' - ' + e.description : ''}`;
      return email({
        to: admins(), subject: `Expense to approve: AED ${money(e.total)} - ${by.name}`, ref: `expense-${e.id}`,
        text: `${by.name} recorded an expense that needs your approval.\n${what}\nPaid on: ${fmtDay(e.paid_on)}\nAmount: AED ${money(e.total)}\nReview: ${link}`,
        html: layout(s, 'Expense waiting for approval', `<p>${escHtml(by.name)} recorded an expense.</p>${table([row('What', escHtml(what)), row('Paid on', fmtDay(e.paid_on)), row('Amount', `AED ${money(e.total)}`), row('Paid by', escHtml(e.paid_by))])}${button(link, 'Review expenses', '#1f2a4d')}`),
      });
    },
    /** Monday reminder: what is waiting for someone to act. `d` comes from the weekly summary. */
    async weekly(to, d) {
      const s = ctx.settings();
      const list = (title, items, fmt) => items.length ? `<h3 style="color:#1f2a4d;margin:18px 0 6px">${escHtml(title)} (${items.length})</h3><ul style="margin:0;padding-left:18px">${items.slice(0, 15).map((x) => `<li>${fmt(x)}</li>`).join('')}${items.length > 15 ? `<li>and ${items.length - 15} more</li>` : ''}</ul>` : '';
      const q = (x) => `<b>${escHtml(x.number)}</b> ${escHtml(x.client_name)} - ${escHtml(x.subject)} - AED ${money(x.total ?? x.net)}`;
      const html = layout(s, 'Weekly reminder', `<p>Good morning. Here is what is waiting this week.</p>
        ${list('Quotations waiting for approval', d.pendingQuotes, q)}
        ${list('Expenses waiting for approval', d.pendingExpenses, (x) => `${fmtDay(x.paid_on)} - ${escHtml(x.cost_type)} - AED ${money(x.total)} (${escHtml(x.created_by_name || '')})`)}
        ${list('Sent to customers, no answer yet', d.awaiting, (x) => `${q(x)}${x.valid_until && x.valid_until < d.today ? ' - <b style="color:#c8202a">expired ' + fmtDay(x.valid_until) + '</b>' : ''}`)}
        ${list('Accepted jobs not invoiced', d.unbilled, q)}
        ${list('Overdue invoices', d.overdue, (x) => `<b>${escHtml(x.number)}</b> ${escHtml(x.client_name)} - AED ${money(x.total)} - due ${fmtDay(x.due_date)}`)}
        ${list('Invoices not paid yet (not overdue)', d.unpaid, (x) => `<b>${escHtml(x.number)}</b> ${escHtml(x.client_name)} - AED ${money(x.total)} - due ${fmtDay(x.due_date)}`)}
        ${d.empty ? '<p><b>Nothing is waiting. Well done.</b></p>' : ''}
        <h3 style="color:#1f2a4d;margin:18px 0 6px">Partners</h3>${table([row(`Still owed to ${escHtml(s.partner_a)}`, `AED ${money(d.balances.a)}`), row(`Still owed to ${escHtml(s.partner_b)}`, `AED ${money(d.balances.b)}`)])}
        ${button(`${config.baseUrl}/app/`, 'Open the app', '#1f2a4d')}`);
      const text = `Weekly reminder\nQuotations waiting for approval: ${d.pendingQuotes.length}\nExpenses waiting for approval: ${d.pendingExpenses.length}\nSent, no answer yet: ${d.awaiting.length}\nAccepted jobs not invoiced: ${d.unbilled.length}\nOverdue invoices: ${d.overdue.length}\nUnpaid invoices: ${d.unpaid.length}\n${config.baseUrl}/app/`;
      return email({ to, subject: `Weekly reminder - ${s.company_name}`, text, html, ref: 'weekly' });
    },
    async paymentReceived(inv, client) {
      const s = ctx.settings();
      const subject = `Payment received: ${inv.number}`;
      const text = `Payment of AED ${money(inv.total)} received for invoice ${inv.number} (${client.name}). Reference: ${inv.payment_ref}`;
      await email({ to: admins(), subject, text, ref: inv.number, html: layout(s, 'Payment received', `<p>${escHtml(text)}</p>`) });
      if (client.email) await email({ to: client.email, ref: inv.number, subject: `Receipt for invoice ${inv.number}`, text: `Thank you. We received AED ${money(inv.total)} for invoice ${inv.number}.\n\n${s.company_name}`, html: layout(s, 'Thank you for your payment', `<p>We received your payment.</p>${table([row('Invoice', escHtml(inv.number)), row('Amount', `AED ${money(inv.total)}`), row('Reference', escHtml(inv.payment_ref))])}`) });
    },
  };
}
