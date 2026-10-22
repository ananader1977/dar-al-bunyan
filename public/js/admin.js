import { h, fill, toast, badge, money, num2, fmtDay, fmtMonth, fmtStamp, todayIso, fileToBase64 } from '/js/common.js';
import { S, A, isAdmin, run, go, modal, closeModal, field, attachmentsCard, attachButton, exportButton, refresh, loadLookups, pct, del, delButton } from '/js/app.js';
const round2 = (n) => Math.round(n * 100) / 100;

const overdue = (i) => i.status === 'issued' && i.due_date && i.due_date < todayIso();
/** An invoice that was emailed, paid or credited is final (UAE VAT): cancel it with a credit note, never delete it. */
const locked = (i) => !!(i.sent_at || i.status === 'paid' || i.credit_id || i.creditNote);
const partnersOf = (f) => f.partners;
const muted = (t) => h('span', { class: 'muted' }, t);

export const adminViews = {
  // ---------- invoices ----------
  async invoices(el) {
    const st = { status: '' };
    const box = h('div', {});
    const load = async () => {
      const r = await A('GET', `/invoices?status=${st.status}`);
      const tot = r.rows.filter((i) => i.status !== 'cancelled').reduce((a, i) => a + i.total, 0);
      box.replaceChildren(r.rows.length ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Invoice'), h('th', {}, 'Date'), h('th', {}, 'Customer / subject'), h('th', {}, 'Due'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Total'), isAdmin() ? h('th', {}) : null)),
        h('tbody', {}, r.rows.map((i) => h('tr', { class: 'click', onclick: () => go(`invoice/${i.id}`) },
          h('td', { class: 'nowrap' }, h('b', {}, i.number), h('div', { class: 'small muted' }, i.quote_number || '')), h('td', { class: 'nowrap' }, fmtDay(i.issue_date)),
          h('td', {}, h('b', {}, i.client_name), h('div', { class: 'small muted' }, i.subject)), h('td', { class: 'nowrap' }, fmtDay(i.due_date)),
          h('td', {}, i.credit_number ? badge('credited') : badge(overdue(i) ? 'overdue' : i.status), i.credit_number ? h('div', { class: 'small muted' }, i.credit_number) : i.sent_at ? h('div', { class: 'small muted' }, 'emailed') : null),
          h('td', { class: 'num' }, h('b', {}, num2(i.total))),
          isAdmin() ? h('td', { class: 'center' }, locked(i) ? null : delButton(`invoice ${i.number}`, () => del.invoice(i), load)) : null))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 5 }, 'Total (excluding cancelled)'), h('td', { class: 'num' }, num2(tot)), isAdmin() ? h('td', {}) : null)))) : h('p', { class: 'muted' }, 'No invoices.'));
    };
    const chips = h('div', { class: 'chips' }, [['', 'All'], ['issued', 'Unpaid'], ['paid', 'Paid'], ['cancelled', 'Cancelled / credited']].map(([k, l]) => h('button', { class: k === '' ? 'on' : '', onclick: (e) => { st.status = k; chips.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); load(); } }, l)));
    fill(el, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, 'Invoices'), exportButton('invoices', () => `status=${st.status}`)),
      h('p', { class: 'small muted' }, 'Create an invoice from an approved or accepted quotation. Once an invoice is emailed or paid it is final: to cancel it, issue a credit note.'), chips, box));
    await load();
  },

  async invoice(el, id) {
    const d = await A('GET', `/invoices/${id}`);
    const i = d.invoice, c = d.client, cn = d.creditNote;
    const reload = (x) => { if (x) adminViews.invoice(el, id); };
    const btns = [h('a', { class: 'btn alt', href: `/api/app/invoices/${i.id}/pdf`, target: '_blank', rel: 'noopener' }, 'View PDF')];
    if (i.status !== 'cancelled') btns.unshift(h('button', { class: 'btn red', disabled: !c.email, title: c.email ? '' : 'Add the customer email first', onclick: () => run(() => A('POST', `/invoices/${i.id}/send`, {}), `Invoice emailed to ${c.email}`).then(reload) }, i.sent_at ? 'Email again' : 'Email to customer'));
    if (i.status === 'issued') btns.push(h('button', { class: 'btn ok', onclick: () => paidDialog(i, reload) }, 'Customer paid'), S.cfg.payments === 'mock' ? h('a', { class: 'btn alt', href: d.payUrl, target: '_blank', rel: 'noopener' }, 'Test online payment (demo)') : h('button', { class: 'btn alt', onclick: () => { navigator.clipboard?.writeText(d.payUrl); toast('Payment link copied'); } }, 'Copy payment link'));
    if (i.status === 'paid') btns.push(h('button', { class: 'btn alt', onclick: () => confirm('Mark this invoice as unpaid again? The job\'s profit will wait for payment again.') && run(() => A('POST', `/invoices/${i.id}/status`, { status: 'issued' }), 'Marked unpaid').then(reload) }, 'Mark unpaid'));
    if (i.status !== 'cancelled' && d.locked) btns.push(h('button', { class: 'btn danger', onclick: () => creditDialog(i, reload) }, 'Issue credit note'));
    if (i.status !== 'cancelled' && !d.locked) btns.push(h('button', { class: 'btn danger', onclick: () => confirm(`Cancel invoice ${i.number}? It was not emailed or paid, so no credit note is needed. A new invoice can then be created from the quotation.`) && run(() => A('POST', `/invoices/${i.id}/status`, { status: 'cancelled' }), 'Invoice cancelled').then(reload) }, 'Cancel invoice'));
    if (i.quotation_id) btns.push(h('a', { class: 'btn alt', href: `#quote/${i.quotation_id}` }, `Quotation ${i.quote_number}`));
    if (isAdmin() && !d.locked) btns.push(h('button', { class: 'btn danger', onclick: async () => { if (await del.invoice(i)) go('invoices'); } }, 'Delete invoice'));
    fill(el, h('div', { class: 'actions' }, h('h1', {}, `Invoice ${i.number}`), cn ? badge('credited') : badge(overdue(i) ? 'overdue' : i.status)),
      c.email ? null : h('div', { class: 'alert' }, 'This customer has no email address yet. Add it under Customers to email the invoice.'),
      d.locked && i.status !== 'cancelled' ? h('div', { class: 'alert info' }, 'This invoice was emailed or paid, so it is a final tax document. To cancel it, issue a credit note.') : null,
      cn ? h('div', { class: 'card' }, h('h2', {}, `Credit note ${cn.number}`), h('dl', { class: 'kv' }, h('dt', {}, 'Date'), h('dd', {}, fmtDay(cn.issue_date)), h('dt', {}, 'Amount'), h('dd', {}, money(cn.total)), h('dt', {}, 'Reason'), h('dd', {}, cn.reason), h('dt', {}, 'Emailed'), h('dd', {}, cn.sent_at ? fmtStamp(cn.sent_at) : 'Not yet')),
        h('p', { class: 'actions' }, h('a', { class: 'btn alt', href: `/api/app/credit-notes/${cn.id}/pdf`, target: '_blank', rel: 'noopener' }, 'View credit note PDF'),
          h('button', { class: 'btn red', disabled: !c.email, onclick: () => run(() => A('POST', `/credit-notes/${cn.id}/send`, {}), `Credit note emailed to ${c.email}`).then(reload) }, cn.sent_at ? 'Email again' : 'Email to customer'))) : null,
      h('div', { class: 'card' }, h('div', { class: 'actions' }, btns)),
      h('div', { class: 'split' },
        h('div', { class: 'card' }, h('h2', {}, i.subject || 'Invoice'), h('dl', { class: 'kv' },
          h('dt', {}, 'Customer'), h('dd', {}, h('b', {}, c.name)), h('dt', {}, 'Email'), h('dd', {}, c.email || '-'),
          h('dt', {}, 'Invoice date'), h('dd', {}, fmtDay(i.issue_date)), h('dt', {}, 'Due date'), h('dd', {}, fmtDay(i.due_date)), h('dt', {}, 'Client LPO'), h('dd', {}, i.lpo || '-'),
          h('dt', {}, 'Paid'), h('dd', {}, i.status === 'paid' ? `${fmtDay(i.paid_at)} · ${i.payment_method}${i.payment_ref ? ' · ' + i.payment_ref : ''}` : 'Not yet'),
          h('dt', {}, 'Emailed'), h('dd', {}, i.sent_at ? fmtStamp(i.sent_at) : 'Not yet'))),
        h('div', { class: 'card summary' }, h('h2', {}, 'Amount'),
          h('div', { class: 'r' }, h('span', {}, 'Net'), h('b', {}, money(i.net))), h('div', { class: 'r' }, h('span', {}, `VAT ${i.vat_rate}%`), h('b', {}, money(i.vat))),
          h('div', { class: 'r total' }, h('span', {}, 'Total'), h('span', {}, money(i.total))),
          h('p', { class: 'small muted' }, `Online payment: ${S.cfg.payments === 'stripe' ? 'card payments (Stripe)' : 'DEMO mode: customers do not get a payment link yet; use "Test online payment" to try it'}.`))),
      h('div', { class: 'card' }, h('h2', {}, 'Lines'), h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Description'), h('th', { class: 'num' }, 'Qty'), h('th', {}, 'Unit'), h('th', { class: 'num' }, 'Unit price'), h('th', { class: 'num' }, 'Amount'))),
        h('tbody', {}, d.lines.map((l) => h('tr', {}, h('td', {}, l.description), h('td', { class: 'num' }, l.qty), h('td', {}, l.unit), h('td', { class: 'num' }, num2(l.unit_price)), h('td', { class: 'num' }, num2(l.amount)))))))),
      attachmentsCard('invoice', i.id, d.attachments));
  },

  // ---------- expenses ----------
  async expenses(el, arg) {
    await loadLookups();
    const qFilter = /^q(\d+)$/.exec(arg || '');
    const st = { from: '', to: '', type: '', q: '', status: '' };
    const quotes = await jobChoices();
    const kpiBox = h('div', {}), box = h('div', {});
    const load = async () => {
      let rows = (await A('GET', `/expenses?from=${st.from}&to=${st.to}&type=${encodeURIComponent(st.type)}&q=${encodeURIComponent(st.q)}&status=${st.status}`)).rows;
      if (qFilter) rows = rows.filter((e) => e.quotation_id === Number(qFilter[1]));
      if (!qFilter) {
        const f = await A('GET', `/finance?from=${st.from}&to=${st.to}`);
        kpiBox.replaceChildren(shareKpis(f), h('div', { class: 'split' }, splitCheck(f), dealCard(f)));
      }
      const sum = (k) => round2(rows.reduce((a, e) => a + e[k], 0));
      const L = S.lk.settings, P = { a: L.partner_a, b: L.partner_b, aShare: L.partner_a_share, bShare: L.partner_b_share };
      const share = (v) => h('td', { class: `num${v < 0 ? ' negtxt' : ''}` }, v ? num2(v) : muted('-'));
      box.replaceChildren(rows.length ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Paid on'), h('th', {}, 'Job / description'), h('th', {}, 'Type'), h('th', { class: 'num' }, 'Total'),
          h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'Profit'), h('th', { class: 'num' }, `${P.a} ${P.aShare}%`), h('th', { class: 'num' }, `${P.b} ${P.bShare}%`), h('th', {}, 'Paid by'), h('th', { class: 'num' }, `Cost to pay back to ${P.a}`), h('th', {}, 'Approval'), h('th', { class: 'center' }, 'Files'), h('th', {}))),
        h('tbody', {}, rows.map((e) => h('tr', { class: `click${e.status !== 'approved' ? ' waitrow' : ''}`, onclick: () => expenseDialog(e, quotes, load) },
          h('td', { class: 'nowrap' }, fmtDay(e.paid_on)),
          h('td', {}, e.quote_number ? h('div', {}, h('b', {}, e.quote_number), ` · ${e.client_name}`, e.quote_status === 'declined' ? h('span', { class: 'small muted' }, ` (declined: carried by ${P.a}, not shared)`) : null) : null, h('div', { class: e.quote_number ? 'small muted' : '' }, e.description || e.remarks || '-')),
          h('td', {}, e.cost_type), h('td', { class: 'num' }, h('b', {}, num2(e.total)), e.qty !== 1 ? h('div', { class: 'small muted' }, `${e.qty} × ${num2(e.amount)}`) : null),
          h('td', { class: 'num' }, e.revenue ? num2(e.revenue) : muted('-')), h('td', { class: `num${e.profit < 0 ? ' negtxt' : ''}` }, e.profit ? h('b', {}, num2(e.profit)) : muted('-')), share(e.share_a), share(e.share_b),
          h('td', {}, e.paid_by), h('td', { class: 'num' }, e.pay_back ? num2(e.pay_back) : muted('-')),
          h('td', {}, e.status === 'approved' ? h('span', { class: 'small muted' }, 'approved') : [badge(e.status === 'pending' ? 'pending' : 'returned'), h('div', { class: 'small muted' }, e.created_by_name || '')],
            isAdmin() && e.status === 'pending' ? h('div', {}, h('button', { class: 'btn ok sm', onclick: async (ev) => { ev.stopPropagation(); if (await run(() => A('POST', `/expenses/${e.id}/approve`, {}), 'Expense approved')) load(); } }, 'Approve')) : null),
          h('td', { class: 'center' }, attachButton('expense', e.id, e.attach_count, `Files for expense of ${fmtDay(e.paid_on)}`)),
          h('td', { class: 'center' }, isAdmin() ? delButton('expense', () => del.expense(e), load) : null)))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 3 }, `${rows.length} expenses`), h('td', { class: 'num' }, num2(sum('total'))), h('td', { class: 'num' }, num2(sum('revenue'))), h('td', { class: 'num' }, num2(sum('profit'))), h('td', { class: 'num' }, num2(sum('share_a'))), h('td', { class: 'num' }, num2(sum('share_b'))), h('td', {}), h('td', { class: 'num' }, num2(sum('pay_back'))), h('td', { colspan: 3 }))))) : h('p', { class: 'muted' }, 'No expenses for this filter.'));
    };
    const inp = (k, attrs) => h('input', { ...attrs, onchange: (e) => { st[k] = e.target.value; load(); } });
    const chips = h('div', { class: 'chips' }, [['', 'All'], ['pending', 'Waiting approval'], ['returned', 'Returned'], ['approved', 'Approved']].map(([k, l]) => h('button', { class: k === '' ? 'on' : '', onclick: (e) => { st.status = k; chips.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); load(); } }, l)));
    fill(el, qFilter ? null : kpiBox, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, qFilter ? 'Expenses of one job' : 'Expenses'), h('button', { class: 'btn red', onclick: () => expenseDialog({ quotation_id: qFilter ? Number(qFilter[1]) : null }, quotes, load) }, '+ Add expense'), exportButton('expenses', () => `from=${st.from}&to=${st.to}&type=${encodeURIComponent(st.type)}&q=${encodeURIComponent(st.q)}&status=${st.status}${qFilter ? '&quotation=' + qFilter[1] : ''}`), qFilter ? h('a', { class: 'btn link', href: '#expenses' }, 'Show all') : null),
      isAdmin() ? null : h('p', { class: 'small muted' }, 'Expenses you add or change wait for the owner\'s approval before they count in the reports.'),
      h('div', { class: 'toolbar' }, h('label', { class: 'small' }, 'From'), inp('from', { type: 'date' }), h('label', { class: 'small' }, 'To'), inp('to', { type: 'date' }),
        h('select', { onchange: (e) => { st.type = e.target.value; load(); } }, h('option', { value: '' }, 'All cost types'), S.lk.costTypes.map((t) => h('option', { value: t }, t))),
        h('input', { type: 'search', placeholder: 'Search', oninput: (e) => { st.q = e.target.value; clearTimeout(st.t); st.t = setTimeout(load, 250); } })),
      chips, box));
    await load();
  },

  // ---------- financial report ----------
  async finance(el) {
    const y = todayIso().slice(0, 4), m = todayIso().slice(0, 7);
    const lastM = (() => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
    const end = (ym) => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
    const presets = [['All time', '', ''], [`This year (${y})`, `${y}-01-01`, `${y}-12-31`], ['This month', `${m}-01`, end(m)], ['Last month', `${lastM}-01`, end(lastM)]];
    const st = { from: '', to: '' };
    const from = h('input', { type: 'date' }), to = h('input', { type: 'date' });
    const box = h('div', {});
    const load = async () => {
      const f = await A('GET', `/finance?from=${st.from}&to=${st.to}`);
      const t = f.totals, p = partnersOf(f);
      const maxBar = Math.max(1, ...f.monthly.map((x) => Math.max(Math.abs(x.revenue), Math.abs(x.cost))));
      const bars = h('div', { class: 'bars' }, [...f.monthly].reverse().slice(-12).map((x) => {
        const r = h('i', { title: `Revenue ${num2(x.revenue)}` }), c = h('i', { class: 'neg', title: `Costs ${num2(x.cost)}` });
        r.style.height = `${(x.revenue / maxBar) * 100}%`; c.style.height = `${(x.cost / maxBar) * 100}%`;
        return h('div', { class: 'm', title: `${fmtMonth(x.month)}: revenue ${num2(x.revenue)}, costs ${num2(x.cost)}` }, h('div', { class: 'pair' }, r, c), fmtMonth(x.month).slice(0, 3));
      }));
      const maxType = Math.max(1, ...f.costTypes.map((x) => x.total));
      const cell = (v, b) => h('td', { class: `num${v < 0 ? ' negtxt' : ''}` }, b ? h('b', {}, num2(v)) : num2(v));
      box.replaceChildren(
        shareKpis(f),
        h('div', { class: 'split' }, h('div', {}, splitCheck(f), dealCard(f)), h('div', { class: 'card' }, h('h2', {}, 'Revenue (navy) and costs (red) by month'), bars, h('p', { class: 'small muted' }, 'Revenue is placed in the month of the invoice (or of the acceptance when not invoiced yet).'))),
        h('div', { class: 'card' }, h('h2', {}, 'By month'), h('div', { class: 'tablewrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'Costs'), h('th', { class: 'num' }, 'Profit earned'), h('th', { class: 'num' }, 'Margin'), h('th', { class: 'num' }, 'Profit payable'), h('th', { class: 'num' }, `${p.a} ${p.aShare}%`), h('th', { class: 'num' }, `${p.b} ${p.bShare}%`), h('th', { class: 'num' }, 'Personal loans'), h('th', { class: 'num' }, `${p.b} to pay`), h('th', { class: 'num' }, `To pay back to ${p.a}`), h('th', { class: 'num' }, `Total to ${p.a}`))),
          h('tbody', {}, f.monthly.map((x) => h('tr', {}, h('td', { class: 'nowrap' }, fmtMonth(x.month)), cell(x.revenue), cell(x.cost), cell(x.profit, true), h('td', { class: 'num' }, `${pct(x.profit, x.revenue)}%`), cell(x.payable), cell(x.a), cell(x.bGross), cell(x.loans), cell(x.b), cell(x.payBack), cell(x.dueA, true)))),
          h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), cell(t.revenue), cell(t.cost), cell(t.profit), h('td', { class: 'num' }, `${t.margin}%`), cell(t.payable), cell(t.a), cell(t.bGross), cell(t.loans), cell(t.b), cell(t.payBackA), cell(t.dueA)))))),
        h('div', { class: 'card' }, h('h2', {}, 'Costs by type'), f.costTypes.map((x) => { const bar = h('i'); bar.style.width = `${(x.total / maxType) * 100}%`; return h('div', { class: 'small' }, h('div', { class: 'actions' }, h('span', {}, x.type), h('b', { class: 'num' }, `${num2(x.total)} · ${pct(x.total, t.cost)}%`)), h('div', { class: 'hbar' }, bar)); })),
        h('div', { class: 'card' }, h('h2', {}, 'Accepted jobs'), h('p', { class: 'small muted' }, `Actual cost = approved expenses linked to the job. A job's profit becomes payable when the customer pays. Declined jobs are left out; their costs (${num2(t.declinedCost)} in this period) are carried by ${p.a}. Rows turn green when the share is marked paid.`), h('div', { class: 'tablewrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Job'), h('th', {}, 'Customer / subject'), h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'Actual cost'), h('th', { class: 'num' }, 'Profit'), h('th', { class: 'num' }, 'Margin'), h('th', { class: 'num' }, `${p.a} ${p.aShare}%`), h('th', { class: 'num' }, `${p.b} ${p.bShare}%`), h('th', {}, 'Invoice'), h('th', {}, 'Customer paid'), h('th', {}, 'Share paid'), isAdmin() ? h('th', {}) : null)),
          h('tbody', {}, f.jobs.map((j) => h('tr', { class: j.share_paid ? 'paidrow' : '' },
            h('td', { class: 'nowrap' }, h('a', { href: `#quote/${j.id}` }, j.number), h('div', { class: 'small muted' }, fmtDay(j.rev_date))), h('td', {}, h('b', {}, j.client_name), h('div', { class: 'small muted' }, j.subject)),
            cell(j.net), cell(j.actual_cost), cell(j.profit, true), h('td', { class: 'num' }, `${j.margin}%`), cell(j.a), cell(j.b),
            h('td', {}, j.invoice_number ? [j.invoice_number, ' ', badge(j.invoice_status)] : muted('-')),
            h('td', { class: 'nowrap' }, j.paid_at ? badge('paid') : badge('waiting'), j.paid_at ? h('div', { class: 'small muted' }, fmtDay(j.paid_at)) : null),
            h('td', {}, h('input', { type: 'checkbox', checked: !!j.share_paid, 'aria-label': 'Revenue share paid', onchange: async (e) => { const tr = e.target.closest('tr'), on = e.target.checked; tr.classList.toggle('paidrow', on); if (!(await run(() => A('POST', `/quotations/${j.id}/share-paid`, { paid: on }), 'Saved'))) { e.target.checked = !on; tr.classList.toggle('paidrow', !on); } } })),
            isAdmin() ? h('td', { class: 'center' }, delButton(`quotation ${j.number}`, () => del.quote(j), load)) : null)))))));
    };
    const chips = h('div', { class: 'chips' }, presets.map(([l, a, b], i) => h('button', { class: i === 0 ? 'on' : '', onclick: (e) => { st.from = a; st.to = b; from.value = a; to.value = b; chips.querySelectorAll('button').forEach((x) => x.classList.remove('on')); e.target.classList.add('on'); load(); } }, l)));
    const setRange = () => { st.from = from.value; st.to = to.value; chips.querySelectorAll('button').forEach((x) => x.classList.remove('on')); load(); };
    from.onchange = setRange; to.onchange = setRange;
    fill(el, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h1', {}, 'Financial report'), exportButton('finance', () => `from=${st.from}&to=${st.to}`), h('a', { class: 'btn alt sm', href: '/api/app/export.xlsx' }, '⬇ All data')), chips,
      h('div', { class: 'toolbar' }, h('label', { class: 'small' }, 'From'), from, h('label', { class: 'small' }, 'To'), to)), box);
    await load();
  },

  // ---------- partners: balances, payouts, personal loans ----------
  async partners(el) {
    const d = await A('GET', '/partners');
    const P = d.partners;
    const line = (k, v, cls = '') => h('div', { class: `r ${cls}` }, h('span', {}, k), h('b', { class: v < 0 ? 'negtxt' : '' }, money(v)));
    const card = (name, x, rows) => h('div', { class: 'card summary' }, h('h2', {}, name), ...rows, line('Total earned so far', x.entitled, 'total'), line('Already paid out', -x.paid), line('Still owed now', x.balance, 'total'));
    fill(el,
      h('div', { class: 'split' },
        card(P.a, d.a, [line(`${P.aShare}% of profit (paid jobs)`, d.a.share), line('Costs to pay back', d.a.costsBack), line(`Personal loans of ${P.b} to pay back`, d.a.loansBack)]),
        card(P.b, d.b, [line(`${P.bShare}% of profit (paid jobs)`, d.b.share), line('Minus personal loans taken', -d.b.loans)])),
      h('div', { class: 'alert info' }, d.waiting.jobs ? `Waiting for customer payment: ${d.waiting.jobs} job(s), revenue ${money(d.waiting.revenue)}. When paid, ${P.a} gets back their costs (${money(d.waiting.jobCost)}) and the profit (${money(d.waiting.profit)}) is shared.` : 'All accepted jobs are paid by the customers.',
        d.declinedCost ? ` Costs on declined jobs (${money(d.declinedCost)}) are carried by ${P.a} and are not paid back.` : ''),
      h('div', { class: 'split' },
        h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, 'Payments to partners'), h('button', { class: 'btn red sm', onclick: () => paymentDialog(P) }, '+ Record payment')),
          h('p', { class: 'small muted' }, 'Record every transfer to a partner (profit share or costs paid back). It reduces what is still owed.'),
          d.payments.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Partner'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Note'), isAdmin() ? h('th', {}) : null)),
            h('tbody', {}, d.payments.map((x) => h('tr', {}, h('td', { class: 'nowrap' }, fmtDay(x.paid_on)), h('td', {}, x.partner === 'a' ? P.a : P.b), h('td', { class: 'num' }, h('b', {}, num2(x.amount))), h('td', {}, [x.method, x.note].filter(Boolean).join(' · ') || '-', h('div', { class: 'small muted' }, x.created_by_name || '')),
              isAdmin() ? h('td', { class: 'center' }, delButton('payment', () => del.payment(x), refresh)) : null))))) : h('p', { class: 'muted' }, 'No payments recorded yet.')),
        h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, `Personal loans (${P.b})`), h('button', { class: 'btn red sm', onclick: () => loanDialog(P) }, '+ Record loan')),
          h('p', { class: 'small muted' }, `Money ${P.a} advanced to ${P.b}. It is deducted from ${P.b}'s share and paid back to ${P.a}. Loans are not company costs.`),
          d.loans.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Note'), isAdmin() ? h('th', {}) : null)),
            h('tbody', {}, d.loans.map((x) => h('tr', {}, h('td', { class: 'nowrap' }, fmtDay(x.taken_on)), h('td', { class: 'num' }, h('b', {}, num2(x.amount))), h('td', {}, x.note),
              isAdmin() ? h('td', { class: 'center' }, delButton('loan', () => del.loan(x), refresh)) : null))),
            h('tfoot', {}, h('tr', {}, h('td', {}, 'Total'), h('td', { class: 'num' }, num2(d.loans.reduce((a, x) => a + x.amount, 0))), h('td', { colspan: isAdmin() ? 2 : 1 }))))) : h('p', { class: 'muted' }, 'No personal loans.'))));
  },

  // ---------- customers & products ----------
  async clients(el) {
    const lk = await loadLookups();
    const counts = Object.create(null);
    for (const q of (await A('GET', '/quotations')).rows) counts[q.client_name] = (counts[q.client_name] || 0) + 1;
    let term = '';
    const box = h('div', {});
    const draw = () => box.replaceChildren(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Customer'), h('th', {}, 'Contact'), h('th', {}, 'Email'), h('th', {}, 'Phone'), h('th', { class: 'num' }, 'Quotations'), isAdmin() ? h('th', {}) : null)),
      h('tbody', {}, lk.clients.filter((c) => !term || `${c.name} ${c.contact} ${c.email}`.toLowerCase().includes(term)).map((c) => h('tr', { class: 'click', onclick: () => clientDialog(c) },
        h('td', {}, h('b', {}, c.name), c.trn ? h('div', { class: 'small muted' }, `TRN ${c.trn}`) : null), h('td', {}, c.contact), h('td', {}, c.email || h('span', { class: 'muted small' }, 'missing')), h('td', {}, c.phone), h('td', { class: 'num' }, counts[c.name] || 0),
        isAdmin() ? h('td', { class: 'center' }, delButton(`customer ${c.name}`, () => del.client(c), refresh)) : null))))));
    fill(el, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, 'Customers'), h('button', { class: 'btn red', onclick: () => clientDialog({}) }, '+ Add customer'), exportButton('customers')),
      h('p', { class: 'small muted' }, 'Customers are also added automatically from the quotation form.'),
      h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search customers', oninput: (e) => { term = e.target.value.toLowerCase(); draw(); } })), box));
    draw();
  },
  async products(el) {
    const r = await A('GET', '/products');
    let term = '';
    const box = h('div', {});
    const draw = () => box.replaceChildren(h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Product / service'), h('th', {}, 'Unit'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Cost'), h('th', { class: 'num' }, 'Margin'), h('th', { class: 'num' }, 'Used'), isAdmin() ? h('th', {}) : null)),
      h('tbody', {}, r.rows.filter((p) => !term || `${p.name} ${p.category}`.toLowerCase().includes(term)).map((p) => h('tr', { class: 'click', onclick: () => productDialog(p) },
        h('td', {}, h('b', {}, p.name), p.active ? null : h('span', { class: 'small muted' }, ' (hidden)'), p.category ? h('div', { class: 'small muted' }, p.category) : null), h('td', {}, p.unit),
        h('td', { class: 'num' }, num2(p.price)), h('td', { class: 'num' }, num2(p.cost)), h('td', { class: 'num' }, p.price ? `${pct(p.price - p.cost, p.price)}%` : '-'), h('td', { class: 'num' }, p.uses), isAdmin() ? h('td', { class: 'center' }, delButton(`product ${p.name}`, () => del.product(p), refresh)) : null))))));
    fill(el, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, 'Products and services'), h('button', { class: 'btn red', onclick: () => productDialog({}) }, '+ Add product'), exportButton('products')),
      h('p', { class: 'small muted' }, 'New items typed in a quotation are saved here automatically.'),
      h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search products', oninput: (e) => { term = e.target.value.toLowerCase(); draw(); } })), box));
    draw();
  },

  // ---------- users (owner) ----------
  async users(el) {
    const r = await A('GET', '/users');
    fill(el, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, 'Users'), h('button', { class: 'btn red', onclick: () => userDialog({}) }, '+ Add user'), exportButton('users')),
      h('p', { class: 'small muted' }, 'Owner: everything. Operations: everything except approving quotations and expenses, deleting, users, settings, backups and the Trash. To stop someone signing in, untick "Active".'),
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Status'))),
        h('tbody', {}, r.rows.map((u) => h('tr', { class: 'click', onclick: () => userDialog(u) }, h('td', {}, h('b', {}, u.name)), h('td', {}, u.email), h('td', {}, u.role === 'admin' ? 'Owner' : 'Operations'), h('td', {}, u.active ? 'Active' : muted('Disabled')))))))));
  },

  // ---------- activity log and Trash (owner) ----------
  async activity(el, arg) {
    const tab = arg === 'trash' ? 'trash' : 'log';
    const tabs = h('div', { class: 'chips' }, h('button', { class: tab === 'log' ? 'on' : '', onclick: () => go('activity') }, 'Activity log'), h('button', { class: tab === 'trash' ? 'on' : '', onclick: () => go('activity/trash') }, 'Trash'));
    if (tab === 'trash') {
      const r = await A('GET', '/trash');
      fill(el, h('div', { class: 'card' }, h('h2', {}, 'Trash'), tabs, h('p', { class: 'small muted' }, 'Deleted records stay here for 30 days and can be restored. After that they are removed for good, with their files.'),
        r.rows.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Deleted'), h('th', {}, 'What'), h('th', {}, 'By'), h('th', {}))),
          h('tbody', {}, r.rows.map((t) => h('tr', {}, h('td', { class: 'nowrap' }, fmtStamp(t.ts)), h('td', {}, h('b', {}, t.kind), h('div', { class: 'small' }, t.label)), h('td', {}, t.user_name || '-'),
            h('td', {}, h('button', { class: 'btn alt sm', onclick: async () => { if (confirm(`Restore: ${t.label}?`) && await run(() => A('POST', `/trash/${t.id}/restore`, {}), 'Restored')) refresh(); } }, 'Restore'))))))) : h('p', { class: 'muted' }, 'The Trash is empty.')));
      return;
    }
    let term = '';
    const box = h('div', {});
    const load = async () => {
      const r = await A('GET', `/activity?q=${encodeURIComponent(term)}`);
      box.replaceChildren(r.rows.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'Details'))),
        h('tbody', {}, r.rows.map((a) => h('tr', {}, h('td', { class: 'nowrap' }, fmtStamp(a.ts)), h('td', {}, a.user_name || 'system'), h('td', {}, h('b', {}, a.action)), h('td', { class: 'small' }, a.summary)))))) : h('p', { class: 'muted' }, 'Nothing recorded yet.'));
    };
    fill(el, h('div', { class: 'card' }, h('h2', {}, 'Activity log'), tabs, h('p', { class: 'small muted' }, 'Who did what and when: sign-ins, approvals, invoices, payments, expenses, deletes, settings. The latest 500 entries.'),
      h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search (e.g. deleted, DABTS/41, invoice)', oninput: (e) => { term = e.target.value; clearTimeout(load.t); load.t = setTimeout(load, 250); } })), box));
    await load();
  },

  // ---------- settings (owner) ----------
  async settings(el) {
    const r = await A('GET', '/settings');
    const s = r.settings;
    const f = {};
    const inp = (k, label, attrs = {}, hint) => field(label, (f[k] = h(attrs.rows ? 'textarea' : 'input', { value: s[k] ?? '', ...attrs })), hint);
    f.weekly_email = h('select', {}, [['on', 'On: every Monday at 8:00 to everyone'], ['off', 'Off']].map(([v, l]) => h('option', { value: v, selected: (s.weekly_email || 'on') === v }, l)));
    const save = async () => { const body = Object.fromEntries(Object.entries(f).map(([k, e]) => [k, e.value])); if (await run(() => A('PUT', '/settings', body), 'Settings saved')) await loadLookups(); };
    const file = h('input', { type: 'file', accept: '.xlsx', class: 'hide', onchange: async () => {
      const x = file.files[0]; file.value = '';
      if (!x) return;
      toast('Importing…', 2000);
      const res = await run(async () => A('POST', '/import', { data: await fileToBase64(x) }));
      if (res) modal(h('h2', {}, 'Import finished'), h('dl', { class: 'kv' }, h('dt', {}, 'Quotations'), h('dd', {}, res.quotations), h('dt', {}, 'Expenses'), h('dd', {}, res.expenses), h('dt', {}, 'Personal loans'), h('dd', {}, res.loans || 0), h('dt', {}, 'Invoices'), h('dd', {}, res.invoices), h('dt', {}, 'New customers'), h('dd', {}, res.clients), h('dt', {}, 'Skipped (already imported or empty)'), h('dd', {}, res.skipped)), h('p', {}, h('button', { class: 'btn', onclick: closeModal }, 'OK')));
    } });
    const backups = h('div', {});
    const loadBackups = async () => {
      const b = await A('GET', '/backups');
      backups.replaceChildren(h('p', { class: 'small muted' }, b.storage === 'drive' ? 'A copy of the whole database is made every night and saved to Google Drive (30 kept) and the server (14 kept).' : 'A copy of the whole database is made every night on the server (14 kept). Connect Google Drive (see README) so the copies are also kept off the server.'),
        b.rows.length ? h('ul', { class: 'files' }, b.rows.slice(0, 7).map((x) => h('li', {}, h('div', {}, h('b', {}, fmtStamp(x.ts)), h('div', { class: 'small muted' }, `${Math.ceil(x.size / 1024)} KB · ${x.storage === 'drive' ? 'Google Drive + server' : 'server'}${x.error ? ' · ' + x.error : ''}`)),
          x.local_path || x.link ? h('a', { class: 'btn alt sm', href: `/api/app/backups/${x.id}/download` }, 'Download') : null))) : h('p', { class: 'muted small' }, 'No backup yet: the first one is made tonight, or press "Back up now".'),
        h('p', {}, h('button', { class: 'btn alt sm', onclick: async () => { toast('Backing up…', 2000); if (await run(() => A('POST', '/backups', {}), 'Backup made')) loadBackups(); } }, 'Back up now')));
    };
    fill(el,
      h('div', { class: 'split' },
        h('div', { class: 'card' }, h('h2', {}, 'Company (printed on quotations and invoices)'), inp('company_name', 'Company name'), inp('company_tagline', 'Tagline'), inp('company_address', 'Address'),
          h('div', { class: 'grid2' }, inp('company_trn', 'TRN'), inp('company_phone', 'Phone'), inp('company_email', 'Email')),
          h('h2', {}, 'Bank details (printed on invoices)'), inp('bank_account_name', 'Account name'), h('div', { class: 'grid2' }, inp('bank_name', 'Bank'), inp('bank_account_number', 'Account number'), inp('bank_iban', 'IBAN'), inp('bank_swift', 'SWIFT code'))),
        h('div', { class: 'card' }, h('h2', {}, 'Numbers, VAT and margins'),
          h('div', { class: 'grid2' }, inp('quote_prefix', 'Quotation prefix'), inp('next_quote_no', 'Next quotation number', { type: 'number' }), inp('invoice_prefix', 'Invoice prefix'), inp('next_invoice_no', 'Next invoice number', { type: 'number' }), inp('invoice_suffix', 'Invoice / credit note suffix', {}, 'e.g. /26 for 2026'),
            inp('credit_prefix', 'Credit note prefix'), inp('next_credit_no', 'Next credit note number', { type: 'number' }),
            inp('vat_rate', 'VAT %', { type: 'number', step: '0.01' }), inp('quote_validity_days', 'Quotation valid (days)', { type: 'number' }), inp('payment_terms_days', 'Payment terms (days)', { type: 'number' }),
            inp('margin_target', 'Target margin %', { type: 'number' }), inp('margin_floor', 'Minimum margin %', { type: 'number' })),
          h('h2', {}, 'Profit sharing'), h('div', { class: 'grid2' }, inp('partner_a', 'Partner A'), inp('partner_a_share', 'Partner A share %', { type: 'number' }), inp('partner_b', 'Partner B'), inp('partner_b_share', 'Partner B share %', { type: 'number' })))),
      h('div', { class: 'card' }, h('h2', {}, 'Default texts and emails'), inp('quote_terms', 'Quotation terms and conditions', { rows: 5 }), inp('invoice_notes', 'Invoice notes', { rows: 3 }), inp('notify_email', 'Extra email for approval requests (optional)', { type: 'email' }),
        field('Weekly reminder email', f.weekly_email, 'Quotations and expenses waiting for approval, quotations without an answer, jobs not invoiced, overdue invoices and partner balances.'),
        h('p', { class: 'actions' }, h('button', { class: 'btn alt sm', onclick: async () => { if (confirm('Send the weekly reminder to everyone now?')) { const x = await run(() => A('POST', '/weekly-email', {})); if (x) toast(`Weekly reminder: ${x.status}`); } } }, 'Send the weekly reminder now'))),
      h('p', {}, h('button', { class: 'btn red', onclick: save }, 'Save settings')),
      h('div', { class: 'split' },
        h('div', { class: 'card' }, h('h2', {}, 'Backups'), backups),
        h('div', { class: 'card' }, h('h2', {}, 'Connections'), h('dl', { class: 'kv' },
          h('dt', {}, 'Email (Gmail)'), h('dd', {}, r.email.configured ? `Connected: ${r.email.from || r.email.user}` : 'Not connected: emails are only logged in Messages. Set SMTP_* on the server (see README).'),
          h('dt', {}, 'Attachments'), h('dd', {}, r.storage === 'drive' ? 'Google Drive' : 'Server disk (Google Drive not connected; see README)'),
          h('dt', {}, 'Online payments'), h('dd', {}, r.payments === 'stripe' ? 'Stripe (live card payments)' : 'DEMO checkout: switch to Stripe when you are ready')),
          h('p', {}, h('button', { class: 'btn alt sm', onclick: async () => { const x = await run(() => A('POST', '/email-test', {})); if (x) toast(`Test email: ${x.status}`); } }, 'Send me a test email')))),
      h('div', { class: 'card' }, h('h2', {}, 'Data'), h('p', { class: 'small muted' }, 'Import the Zoho "Expenses_Report" Excel file. Rows that were already imported are skipped, so it is safe to import an updated file.'),
        h('p', { class: 'actions' }, file, h('button', { class: 'btn', onclick: () => file.click() }, 'Import Excel file'), h('a', { class: 'btn alt', href: '/api/app/export.xlsx' }, 'Export all data to Excel'))));
    await loadBackups();
  },

  async messages(el) {
    const r = await A('GET', '/messages');
    fill(el, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, 'Messages sent by the app'), exportButton('messages')), r.rows.length ? h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'To'), h('th', {}, 'Subject'), h('th', {}, 'Status'))),
      h('tbody', {}, r.rows.map((m) => h('tr', { class: 'click', onclick: () => modal(h('h2', {}, m.subject), h('p', { class: 'small muted' }, `${fmtStamp(m.ts)} · ${m.to_addr}${m.attachment ? ' · ' + m.attachment : ''}`), m.error ? h('div', { class: 'alert bad' }, m.error) : null, h('pre', { class: 'small' }, m.body), h('p', {}, h('button', { class: 'btn', onclick: closeModal }, 'Close'))) },
        h('td', { class: 'nowrap' }, fmtStamp(m.ts)), h('td', {}, m.to_addr), h('td', {}, m.subject, m.ref ? h('div', { class: 'small muted' }, m.ref) : null), h('td', {}, badge(m.status === 'sent' ? 'sent-ok' : m.status))))))) : h('p', { class: 'muted' }, 'No messages yet.')));
  },
};

// ---------- shared finance pieces ----------
/** The same statistics on the dashboard, the Expenses page and the Financial report, in two groups. */
export function shareKpis(f, { extra = [] } = {}) {
  const t = f.totals, P = f.partners;
  const k = (cls, val, label) => h('div', { class: `kpi${cls ? ' ' + cls : ''}${val < 0 ? ' neg' : ''}` }, h('b', {}, money(val)), h('span', {}, label));
  return h('div', { class: 'kgroups' },
    h('div', { class: 'kgroup' }, h('h3', {}, 'Business'), h('div', { class: 'kpis' },
      k('', t.revenue, `Revenue earned · ${t.jobs} accepted jobs (excl. VAT)`),
      k('red', t.cost, `Costs: material ${num2(t.jobCost)} + other ${num2(t.overheads)}`),
      k('green', t.profit, `Profit earned · margin ${t.margin}%`),
      k('', t.revenueWaiting, t.jobsWaiting ? `Waiting for customer payment · ${t.jobsWaiting} job(s), profit ${num2(t.profitWaiting)}` : 'Waiting for customer payment: none'),
      ...extra)),
    h('div', { class: 'kgroup' }, h('h3', {}, 'Partners (jobs the customer has paid)'), h('div', { class: 'kpis' },
      k('green', t.payable, 'Profit to share now'),
      k('', t.a, `${P.a} · ${P.aShare}% of profit`),
      k('', t.bGross, `${P.b} · ${P.bShare}% of profit`),
      k('red', t.loans, `Personal loans taken by ${P.b}`),
      k('red', t.payBackA, `To pay back to ${P.a}: costs ${num2(t.costsBack)} + loans ${num2(t.loans)}`))));
}

/** Profit − partner A − partner B = 0, and who receives what (only jobs the customer has paid). */
function splitCheck(f) {
  const t = f.totals, P = f.partners;
  const rest = round2(t.payable - t.a - t.bGross);
  const row = (label, v, cls = '') => h('tr', { class: cls }, h('td', {}, label), h('td', { class: `num${v < 0 ? ' negtxt' : ''}` }, num2(v)));
  return h('div', { class: 'card splitcheck' }, h('h2', {}, 'Profit sharing check'), h('table', {}, h('tbody', {},
    row('Profit to share (paid jobs)', t.payable, 'strong'),
    row(`− ${P.a} ${P.aShare}%`, -t.a),
    row(`− ${P.b} ${P.bShare}%`, -t.bGross),
    row(rest === 0 ? '= Left over (fully shared ✓)' : '= Left over', rest, 'strong total'))),
    h('h2', {}, 'Who receives what'), h('table', {}, h('tbody', {},
      row(`${P.a}: ${P.aShare}% of profit`, t.a), row(`${P.a}: costs to pay back`, t.costsBack), row(`${P.a}: personal loans to pay back (from ${P.b}'s share)`, t.loans),
      row(`Total to ${P.a}`, t.dueA, 'strong total'),
      row(`${P.b}: ${P.bShare}% of profit`, t.bGross), row(`${P.b}: minus personal loans he took`, -t.loans),
      row(`Total to ${P.b}`, t.dueB, 'strong total'),
      row(`Total paid out${round2(t.dueA + t.dueB) === round2(t.revenuePaid) ? ' (= revenue received ✓)' : ''}`, round2(t.dueA + t.dueB), 'strong total'))),
    h('p', { class: 'small muted' }, 'What has already been transferred is on the Partners page.'));
}
function dealCard(f) {
  const t = f.totals, P = f.partners;
  return h('div', { class: 'card' }, h('h2', {}, 'How it is calculated'), h('ul', { class: 'small deal' },
    h('li', {}, `All costs (material and other expenses) come off the revenue first and are paid back to ${P.a}.`),
    h('li', {}, `The profit left is split ${P.aShare}/${P.bShare}, once the customer has paid the job.`),
    h('li', {}, `Personal loans are not company costs: they come off ${P.b}'s share and are paid back to ${P.a}.`),
    h('li', {}, `Declined jobs earn nothing; their costs${t.declinedCost ? ` (${num2(t.declinedCost)} in this period)` : ''} are carried by ${P.a} alone.`),
    t.pending.n ? h('li', {}, h('b', {}, `${t.pending.n} expense(s) of ${num2(t.pending.s)} wait for approval and are not counted yet.`)) : null));
}

// ---------- dialogs ----------
async function jobChoices() {
  const rows = [];
  for (const st of ['accepted', 'sent', 'approved', 'pending', 'draft']) rows.push(...(await A('GET', `/quotations?status=${st}`)).rows);
  return rows;
}
/** Search box + list to pick the job (quotation) of an expense. */
function jobPicker(quotes, selectedId, fallbackLabel) {
  const sel = h('select', { size: 6, class: 'jobsel' });
  const draw = (term = '') => {
    const t = term.toLowerCase();
    const list = quotes.filter((q) => !t || `${q.number} ${q.client_name} ${q.subject}`.toLowerCase().includes(t)).slice(0, 80);
    sel.replaceChildren(h('option', { value: '', selected: !selectedId }, 'Other expense (no job): rent, fuel, parking…'),
      ...list.map((q) => h('option', { value: q.id, selected: q.id === selectedId }, `${q.number} · ${q.client_name} · ${q.subject.slice(0, 60)}${q.status !== 'accepted' ? ` (${q.status})` : ''}`)));
    if (selectedId && !list.some((q) => q.id === selectedId)) sel.append(h('option', { value: selectedId, selected: true }, fallbackLabel || `Job ${selectedId}`));
  };
  draw();
  sel.addEventListener('change', () => { selectedId = Number(sel.value) || null; });
  const search = h('input', { type: 'search', placeholder: 'Search job number, customer or subject', oninput: (e) => draw(e.target.value) });
  return { el: h('div', {}, search, sel), get value() { return sel.value; } };
}

function expenseDialog(e, quotes, done) {
  const lk = S.lk;
  const job = jobPicker(quotes, e.quotation_id || null, e.quote_number);
  const f = {
    paid_on: h('input', { type: 'date', value: e.paid_on || todayIso() }),
    cost_type: h('select', {}, lk.costTypes.map((t) => h('option', { value: t, selected: t === (e.cost_type || 'Material') }, t))),
    description: h('input', { value: e.description || '' }), amount: h('input', { type: 'number', step: '0.01', min: 0, value: e.amount ?? '' }), qty: h('input', { type: 'number', step: 'any', min: 0, value: e.qty ?? 1 }),
    paid_by: h('select', {}, [lk.settings.partner_a, lk.settings.partner_b, 'Pending', 'Company'].map((p) => h('option', { value: p, selected: p === (e.paid_by || lk.settings.partner_a) }, p))),
    remarks: h('textarea', { rows: 2, value: e.remarks || '' }),
  };
  const save = async () => {
    const body = { ...Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value])), quotation_id: job.value };
    const r = await run(() => (e.id ? A('PUT', `/expenses/${e.id}`, body) : A('POST', '/expenses', body)), isAdmin() ? 'Expense saved' : 'Expense saved: waiting for the owner\'s approval');
    if (r) { closeModal(); done(); }
  };
  const review = async (approve) => {
    if (approve) { if (await run(() => A('POST', `/expenses/${e.id}/approve`, {}), 'Expense approved')) { closeModal(); done(); } return; }
    const note = prompt('What should be corrected?');
    if (note && await run(() => A('POST', `/expenses/${e.id}/return`, { note }), 'Returned for correction')) { closeModal(); done(); }
  };
  const att = h('div', {});
  modal(h('h2', {}, e.id ? 'Edit expense' : 'Add expense'),
    e.status === 'returned' ? h('div', { class: 'alert bad' }, h('b', {}, 'Returned for correction: '), e.review_note) : null,
    e.status === 'pending' ? h('div', { class: 'alert' }, `Waiting for the owner's approval${e.created_by_name ? ` (entered by ${e.created_by_name})` : ''}. It is not counted in the reports yet.`) : null,
    h('div', { class: 'grid2' }, field('Paid on', f.paid_on), field('Cost type', f.cost_type)), field('Job (quotation)', job.el), field('Description', f.description),
    h('div', { class: 'grid3' }, field('Cost (AED)', f.amount), field('Quantity', f.qty), field('Paid by', f.paid_by)),
    field('Remarks', f.remarks), h('p', { class: 'small muted' }, 'Personal loans are recorded on the Partners page.'), att,
    h('p', { class: 'actions' }, h('button', { class: 'btn red', onclick: save }, 'Save'),
      isAdmin() && e.id && e.status === 'pending' ? [h('button', { class: 'btn ok', onclick: () => review(true) }, 'Approve'), h('button', { class: 'btn danger', onclick: () => review(false) }, 'Return')] : null,
      isAdmin() && e.id ? h('button', { class: 'btn danger', onclick: async () => { if (await del.expense(e)) { closeModal(); done(); } } }, 'Delete') : null,
      h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
  if (e.id) A('GET', `/expenses/${e.id}/attachments`).then((r) => att.replaceChildren(attachmentsCard('expense', e.id, r.attachments))).catch(() => {});
  else att.append(h('p', { class: 'small muted' }, 'Save the expense first, then open it again to attach receipts.'));
}
export { expenseDialog, jobChoices };

function paidDialog(i, done) {
  const date = h('input', { type: 'date', value: todayIso() });
  const method = h('select', {}, ['Bank transfer', 'Cheque', 'Cash', 'Card'].map((m) => h('option', { value: m }, m)));
  const ref = h('input', { placeholder: 'Transfer or cheque number' });
  modal(h('h2', {}, `Customer payment for ${i.number}`), h('p', {}, money(i.total)), field('Paid on', date), field('Method', method), field('Reference', ref),
    h('p', { class: 'small muted' }, 'The job\'s profit becomes payable to the partners.'),
    h('p', { class: 'actions' }, h('button', { class: 'btn ok', onclick: async () => { const r = await run(() => A('POST', `/invoices/${i.id}/paid`, { date: date.value, method: method.value, ref: ref.value }), 'Marked as paid'); if (r) { closeModal(); done(r); } } }, 'Save'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}
function creditDialog(i, done) {
  const date = h('input', { type: 'date', value: todayIso() });
  const reason = h('textarea', { rows: 3, placeholder: 'e.g. Job cancelled by the customer; wrong amount invoiced' });
  modal(h('h2', {}, `Credit note for ${i.number}`),
    h('p', {}, `A tax credit note cancels invoice ${i.number} in full (${money(i.total)} including VAT ${money(i.vat)}). It gets its own number and PDF, which you can email to the customer.`),
    i.status === 'paid' ? h('div', { class: 'alert' }, 'This invoice is paid: the job will be marked unpaid again. Refund the customer or issue a new invoice.') : null,
    field('Credit note date', date), field('Reason (printed on the credit note)', reason),
    h('p', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => { const r = await run(() => A('POST', `/invoices/${i.id}/credit-note`, { date: date.value, reason: reason.value }), 'Credit note issued'); if (r) { closeModal(); done(r); } } }, 'Issue credit note'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}
function paymentDialog(P) {
  const f = { paid_on: h('input', { type: 'date', value: todayIso() }), partner: h('select', {}, h('option', { value: 'a' }, P.a), h('option', { value: 'b' }, P.b)), amount: h('input', { type: 'number', step: '0.01', min: 0 }),
    method: h('select', {}, ['Bank transfer', 'Cash', 'Cheque'].map((m) => h('option', { value: m }, m))), note: h('input', { placeholder: 'e.g. October profit share, costs paid back' }) };
  modal(h('h2', {}, 'Record a payment to a partner'), h('div', { class: 'grid2' }, field('Date', f.paid_on), field('Partner', f.partner), field('Amount (AED)', f.amount), field('Method', f.method)), field('Note', f.note),
    h('p', { class: 'actions' }, h('button', { class: 'btn red', onclick: async () => { if (await run(() => A('POST', '/partners/payments', Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value]))), 'Payment recorded')) { closeModal(); refresh(); } } }, 'Save'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}
function loanDialog(P) {
  const f = { taken_on: h('input', { type: 'date', value: todayIso() }), amount: h('input', { type: 'number', step: '0.01', min: 0 }), note: h('input', { placeholder: 'e.g. personal loan' }) };
  modal(h('h2', {}, `Record a personal loan to ${P.b}`), h('p', { class: 'small muted' }, `Money ${P.a} gave ${P.b}. It is deducted from ${P.b}'s share and paid back to ${P.a}.`),
    h('div', { class: 'grid2' }, field('Date', f.taken_on), field('Amount (AED)', f.amount)), field('Note', f.note),
    h('p', { class: 'actions' }, h('button', { class: 'btn red', onclick: async () => { if (await run(() => A('POST', '/partners/loans', Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value]))), 'Loan recorded')) { closeModal(); refresh(); } } }, 'Save'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}

function clientDialog(c) {
  const f = Object.fromEntries(['name', 'contact', 'email', 'phone', 'address', 'trn'].map((k) => [k, h('input', { value: c[k] || '', type: k === 'email' ? 'email' : 'text' })]));
  f.notes = h('textarea', { rows: 2, value: c.notes || '' });
  const save = async () => {
    const body = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value]));
    if (await run(() => (c.id ? A('PUT', `/clients/${c.id}`, body) : A('POST', '/clients', body)), 'Customer saved')) { closeModal(); refresh(); }
  };
  modal(h('h2', {}, c.id ? c.name : 'New customer'), field('Customer / company name', f.name), h('div', { class: 'grid2' }, field('Contact person', f.contact), field('Email', f.email), field('Phone', f.phone), field('TRN', f.trn)), field('Address', f.address), field('Notes', f.notes),
    h('p', { class: 'actions' }, h('button', { class: 'btn red', onclick: save }, 'Save'),
      c.id && isAdmin() ? h('button', { class: 'btn danger', onclick: async () => { if (await del.client(c)) { closeModal(); refresh(); } } }, 'Delete') : null,
      h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}

function productDialog(p) {
  const f = { name: h('input', { value: p.name || '' }), unit: h('input', { value: p.unit || 'Each', list: 'dl-units' }), price: h('input', { type: 'number', step: '0.01', value: p.price ?? '' }), cost: h('input', { type: 'number', step: '0.01', value: p.cost ?? '' }), category: h('input', { value: p.category || '' }), active: h('input', { type: 'checkbox', checked: p.id ? !!p.active : true }) };
  const save = async () => {
    const body = { name: f.name.value, unit: f.unit.value, price: f.price.value, cost: f.cost.value, category: f.category.value, active: f.active.checked };
    if (await run(() => (p.id ? A('PUT', `/products/${p.id}`, body) : A('POST', '/products', body)), 'Product saved')) { closeModal(); refresh(); }
  };
  modal(h('h2', {}, p.id ? 'Edit product' : 'New product'), h('datalist', { id: 'dl-units' }, (S.lk?.units || []).map((u) => h('option', { value: u }))), field('Name', f.name),
    h('div', { class: 'grid2' }, field('Unit', f.unit), field('Category', f.category), field('Selling price (AED)', f.price), field('Cost (AED, internal)', f.cost)),
    h('label', {}, f.active, ' Show in the quotation form'), h('p', { class: 'actions' }, h('button', { class: 'btn red', onclick: save }, 'Save'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel'),
      p.id && isAdmin() ? h('button', { class: 'btn danger', onclick: async () => { if (await del.product(p)) { closeModal(); refresh(); } } }, 'Delete') : null));
}

function userDialog(u) {
  const f = { name: h('input', { value: u.name || '' }), email: h('input', { type: 'email', value: u.email || '' }), role: h('select', {}, [['operations', 'Operations'], ['admin', 'Owner']].map(([v, l]) => h('option', { value: v, selected: v === (u.role || 'operations') }, l))),
    password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: u.id ? 'Leave empty to keep the current password' : '' }), active: h('input', { type: 'checkbox', checked: u.id ? !!u.active : true }) };
  const save = async () => {
    const body = { name: f.name.value, email: f.email.value, role: f.role.value, active: f.active.checked, ...(f.password.value ? { password: f.password.value } : {}) };
    if (await run(() => (u.id ? A('PUT', `/users/${u.id}`, body) : A('POST', '/users', body)), 'User saved')) { closeModal(); refresh(); }
  };
  modal(h('h2', {}, u.id ? u.name : 'New user'), field('Name', f.name), field('Email (used to sign in)', f.email), field('Role', f.role), field(u.id ? 'New password' : 'Password', f.password, 'At least 10 characters with letters and numbers.'),
    u.id ? h('label', {}, f.active, ' Active (can sign in)') : null, h('p', { class: 'actions' }, h('button', { class: 'btn red', onclick: save }, 'Save'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}
