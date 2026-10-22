import { api, h, $, clear, fill, toast, badge, money, num2, fmtDay, fmtMonth, fmtStamp, todayIso, fileToBase64 } from '/js/common.js';
import { adminViews, shareKpis, expenseDialog, jobChoices } from '/js/admin.js';

const app = $('#app'), dlg = $('#dlg'), nav = $('#nav');
export const S = { me: null, lk: null, cfg: null };
export const A = (m, p, b) => api(m, `/api/app${p}`, b);
export const isAdmin = () => S.me?.role === 'admin';
export const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, 6000); return null; } };
export const go = (hash) => { if (location.hash === `#${hash}`) route(); else location.hash = hash; };
export function modal(...kids) {
  dlg.replaceChildren(h('div', { class: 'dlg' }, ...kids));
  if (!dlg.open) dlg.showModal();
  return dlg;
}
export const closeModal = () => dlg.open && dlg.close();
export const field = (label, input, hint) => h('div', {}, h('label', {}, label), input, hint ? h('div', { class: 'small muted' }, hint) : null);
export const marginClass = (pct) => (pct >= (S.lk?.settings.margin_target ?? 30) ? 'good' : pct >= (S.lk?.settings.margin_floor ?? 20) ? 'mid' : 'low');
export const pct = (profit, base) => (base ? Math.round((profit / base) * 1000) / 10 : 0);
export async function loadLookups() { S.lk = await A('GET', '/lookups'); return S.lk; }

window.addEventListener('hashchange', route);
// Phones: tables become one card per row (labels come from the column headers).
function cardify() {
  for (const t of app.querySelectorAll('table:not([data-cards])')) {
    const heads = [...t.querySelectorAll(':scope > thead th')].map((th) => th.textContent.trim());
    if (!heads.length || t.classList.contains('lines') || t.closest('.splitcheck')) { t.dataset.cards = 'no'; continue; }
    t.dataset.cards = 'yes';
    for (const tr of t.querySelectorAll(':scope > tbody > tr, :scope > tfoot > tr')) {
      let col = 0;
      for (const td of tr.children) { if (heads[col] && !(td.colSpan > 1)) td.dataset.label = heads[col]; col += td.colSpan || 1; }
    }
  }
}
new MutationObserver(cardify).observe(app, { childList: true, subtree: true });
boot();

async function boot() {
  try { S.me = (await api('GET', '/api/me')).user; } catch { return loginView(); }
  S.cfg = await api('GET', '/api/config');
  await loadLookups();
  nav.replaceChildren(h('span', { class: 'small muted' }, `${S.me.name} · ${S.me.role === 'admin' ? 'Owner' : 'Operations'}`),
    h('button', { class: 'btn alt sm', onclick: changePassword }, 'Password'),
    h('button', { class: 'btn alt sm', onclick: async () => { await api('POST', '/api/logout', {}); location.hash = ''; location.reload(); } }, 'Sign out'));
  route();
}

function loginView() {
  nav.replaceChildren();
  const err = h('div', { class: 'alert bad hide', role: 'alert' });
  app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('img', { class: 'logo', src: '/logo.png', alt: 'Dar Al Bunyan Technical Services', width: 150, height: 153 }),
    h('h1', { class: 'center' }, 'Sign in'),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target));
      try { await api('POST', '/api/login', v); boot(); } catch (x) { err.textContent = x.message; err.classList.remove('hide'); }
    } },
    field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
    field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })), err,
    h('p', {}, h('button', { class: 'btn block red' }, 'Sign in'))))));
}

function changePassword() {
  const f = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    if (v.password !== v.again) return toast('The two new passwords are different.');
    if (await run(() => api('POST', '/api/me/password', { current: v.current, password: v.password }), 'Password changed')) closeModal();
  } }, h('h2', {}, 'Change your password'),
  field('Current password', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
  field('New password', h('input', { name: 'password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }), 'At least 10 characters, with letters and numbers.'),
  field('New password again', h('input', { name: 'again', type: 'password', required: true, autocomplete: 'new-password' })),
  h('p', { class: 'actions' }, h('button', { class: 'btn' }, 'Change password'), h('button', { class: 'btn alt', type: 'button', onclick: closeModal }, 'Cancel')));
  modal(f);
}

// ---------- routing ----------
// Owner: everything. Operations: everything except approvals, deleting, users, settings and the activity log / Trash.
const TABS = () => [
  ['dashboard', 'Dashboard'], ['quotes', 'Quotations'],
  ...(isAdmin() ? [['approvals', 'Approvals']] : []),
  ['invoices', 'Invoices'], ['expenses', 'Expenses'], ['finance', 'Financial report'], ['partners', 'Partners'],
  ['clients', 'Customers'], ['products', 'Products'], ['messages', 'Messages'],
  ...(isAdmin() ? [['users', 'Users'], ['settings', 'Settings'], ['activity', 'Activity & Trash']] : []),
];
let pendingCount = 0;
async function route() {
  if (!S.me) return;
  const [name, arg] = (location.hash.slice(1) || 'dashboard').split('/');
  if (isAdmin()) {
    const [q, e] = await Promise.all([A('GET', '/quotations?status=pending').catch(() => ({ rows: [] })), A('GET', '/expenses?status=pending').catch(() => ({ rows: [] }))]);
    pendingCount = q.rows.length + e.rows.length;
  }
  const active = { quote: 'quotes', edit: 'quotes', invoice: 'invoices' }[name] || name;
  const tabs = h('div', { class: 'tabs' },
    h('a', { class: `new${name === 'new' ? ' on' : ''}`, href: '#new' }, '+ New quotation'),
    TABS().map(([k, l]) => h('a', { class: active === k ? 'on' : '', href: `#${k}` }, l, k === 'approvals' && pendingCount ? h('span', { class: 'count' }, pendingCount) : null)));
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  app.replaceChildren(tabs, body);
  window.scrollTo(0, 0);
  const view = VIEWS[name] || adminViews[name] || VIEWS.dashboard;
  try { await view(body, arg); } catch (e) { body.replaceChildren(h('div', { class: 'alert bad' }, e.message)); }
}
export const refresh = () => route();

// ---------- shared pieces ----------
/** Delete actions (administrators). Each asks for confirmation and resolves true when the record was deleted. */
const really = (msg) => confirm(`${msg}\n\nIt goes to the Trash and can be restored for 30 days (Activity & Trash).`);
export const del = {
  async quote(q) {
    const inv = q.invoice_number ? ` Its invoice ${q.invoice_number} will be deleted too.` : '';
    return really(`Delete quotation ${q.number}?${inv} All expenses linked to it will be deleted too.`) && !!(await run(() => A('DELETE', `/quotations/${q.id}`), `Quotation ${q.number} deleted`));
  },
  async invoice(i) { return really(`Delete invoice ${i.number}? It was not emailed or paid. The quotation stays; a new invoice can be created from it.`) && !!(await run(() => A('DELETE', `/invoices/${i.id}`), `Invoice ${i.number} deleted`)); },
  async payment(x) { return really(`Delete the payment of ${num2(x.amount)} on ${fmtDay(x.paid_on)}?`) && !!(await run(() => A('DELETE', `/partners/payments/${x.id}`), 'Payment deleted')); },
  async loan(x) { return really(`Delete the personal loan of ${num2(x.amount)} on ${fmtDay(x.taken_on)}?`) && !!(await run(() => A('DELETE', `/partners/loans/${x.id}`), 'Loan deleted')); },
  async expense(e) { return really(`Delete this expense of ${num2(e.total)} (${e.cost_type}, ${fmtDay(e.paid_on)})?`) && !!(await run(() => A('DELETE', `/expenses/${e.id}`), 'Expense deleted')); },
  async product(p) { return really(`Delete product "${p.name}"? Quotations that use it keep their lines.`) && !!(await run(() => A('DELETE', `/products/${p.id}`), 'Product deleted')); },
  async client(c) {
    const u = await run(() => A('GET', `/clients/${c.id}/usage`));
    if (!u) return false;
    const used = u.quotations || u.invoices;
    const msg = used ? `Delete customer ${c.name} AND their ${u.quotations} quotation(s) and ${u.invoices} invoice(s)? Their linked expenses are deleted too.` : `Delete customer ${c.name}?`;
    return really(msg) && !!(await run(() => A('DELETE', `/clients/${c.id}${used ? '?force=1' : ''}`), `Customer ${c.name} deleted`));
  },
};
/** A small trash button for table rows; it does not open the row. */
export function delButton(what, action, after) {
  return h('button', { class: 'btn danger sm del', title: `Delete ${what}`, 'aria-label': `Delete ${what}`, onclick: async (ev) => { ev.stopPropagation(); if (await action()) after(); } }, '🗑');
}
export function quoteTable(rows, { showCost = true } = {}) {
  if (!rows.length) return h('p', { class: 'muted' }, 'No quotations.');
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'No.'), h('th', {}, 'Date'), h('th', {}, 'Customer / subject'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Net'), showCost ? h('th', { class: 'num' }, 'Margin') : null, h('th', { class: 'num' }, 'Total'), h('th', { class: 'center' }, 'Files'), isAdmin() ? h('th', {}) : null)),
    h('tbody', {}, rows.map((q) => {
      const m = pct(q.net - q.cost_total, q.net);
      return h('tr', { class: 'click', onclick: () => go(`quote/${q.id}`) },
        h('td', { class: 'nowrap' }, h('b', {}, q.number)), h('td', { class: 'nowrap' }, fmtDay(q.quote_date)),
        h('td', {}, h('div', {}, h('b', {}, q.client_name)), h('div', { class: 'small muted' }, q.subject)),
        h('td', {}, badge(q.status), q.invoice_number ? h('div', { class: 'small muted' }, q.invoice_number) : null),
        h('td', { class: 'num' }, num2(q.net)), showCost ? h('td', { class: 'num' }, h('span', { class: `badge ${marginClass(m) === 'good' ? 'accepted' : marginClass(m) === 'mid' ? 'pending' : 'rejected'}` }, `${m}%`)) : null,
        h('td', { class: 'num' }, h('b', {}, num2(q.total))),
        h('td', { class: 'center' }, attachButton('quotation', q.id, q.attach_count, `Files for ${q.number}`)),
        isAdmin() ? h('td', { class: 'center' }, delButton(`quotation ${q.number}`, () => del.quote(q), refresh)) : null);
    }))));
}

/** Paperclip button with the number of files; opens the attachments of one record in a dialog. */
export function attachButton(entity, id, count, title) {
  const btn = h('button', { class: 'btn alt sm clip', type: 'button', title: 'View or add files', 'aria-label': `${count || 0} files` }, `📎 ${count || 0}`);
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await run(() => A('GET', `/attachments?entity=${entity}&id=${id}`));
    if (!r) return;
    const show = () => modal(h('h2', {}, title), attachmentsCard(entity, id, r.attachments, { onChange: (items) => { r.attachments = items; btn.textContent = `📎 ${items.length}`; } }), h('p', { class: 'right' }, h('button', { class: 'btn alt', onclick: closeModal }, 'Close')));
    show();
    btn._reopen = show;
  });
  return btn;
}

/** "Export to Excel" link; `query` is read when clicked so it follows the current filters. */
export const exportButton = (kind, query = () => '') => h('a', { class: 'btn alt sm', href: `/api/app/export/${kind}.xlsx`, onclick: (e) => { e.currentTarget.href = `/api/app/export/${kind}.xlsx${query() ? '?' + query() : ''}`; } }, '⬇ Export to Excel');

export function attachmentsCard(entity, id, list, { canAdd = true, onChange } = {}) {
  const ul = h('ul', { class: 'files' });
  let first = true;
  const render = (items) => { if (!first && onChange) onChange(items); first = false; renderList(items); };
  const renderList = (items) => ul.replaceChildren(...(items.length ? items.map((a) => h('li', {},
    h('div', {}, h('a', { href: `/api/app/attachments/${a.id}`, target: '_blank', rel: 'noopener' }, a.name),
      h('div', { class: 'small muted' }, [a.storage === 'drive' ? 'Google Drive' : a.storage === 'link' ? 'Drive link' : 'Server', a.size ? `${Math.ceil(a.size / 1024)} KB` : '', a.uploaded_by_name].filter(Boolean).join(' · '))),
    h('button', { class: 'btn danger sm', onclick: async () => { if (!confirm(`Remove ${a.name}?`)) return; const r = await run(() => A('DELETE', `/attachments/${a.id}`), 'Removed'); if (r) render(r.attachments); } }, 'Remove'))) : [h('li', { class: 'muted small' }, 'No files yet.')]));
  render(list);
  const file = h('input', { type: 'file', class: 'hide', onchange: async () => {
    const f = file.files[0]; file.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('Files must be 5 MB or smaller.');
    toast(`Uploading ${f.name}…`, 2000);
    const r = await run(async () => A('POST', '/attachments', { entity, id, name: f.name, mime: f.type || 'application/octet-stream', data: await fileToBase64(f) }), 'File attached');
    if (r) render(r.attachments);
  } });
  const linkName = h('input', { placeholder: 'Name, e.g. Client LPO' });
  const linkUrl = h('input', { type: 'url', placeholder: 'https://drive.google.com/…' });
  const linkForm = h('div', { class: 'linkform hide' }, h('div', { class: 'grid2' }, field('Name', linkName), field('Google Drive link', linkUrl)),
    h('p', { class: 'actions' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      const r = await run(() => A('POST', '/attachments', { entity, id, name: linkName.value, link: linkUrl.value }), 'Link added');
      if (r) { render(r.attachments); linkName.value = ''; linkUrl.value = ''; linkForm.classList.add('hide'); }
    } }, 'Add link'), h('button', { class: 'btn alt sm', type: 'button', onclick: () => linkForm.classList.add('hide') }, 'Cancel')));
  const addLink = () => { linkForm.classList.remove('hide'); linkName.focus(); };
  return h('div', { class: 'card' }, h('h2', {}, 'Attachments'),
    h('p', { class: 'small muted' }, S.lk?.storage === 'drive' ? 'Files are saved to Google Drive.' : 'Files are saved on the server (Google Drive not connected yet).'),
    ul, canAdd ? [h('p', { class: 'actions' }, file, h('button', { class: 'btn alt sm', type: 'button', onclick: () => file.click() }, 'Upload file'), h('button', { class: 'btn alt sm', type: 'button', onclick: addLink }, 'Add Drive link')), linkForm] : null);
}

// ---------- views ----------
const VIEWS = {
  async dashboard(el) {
    const d = await A('GET', '/dashboard');
    const c = d.counts;
    const kids = [h('div', { class: 'kpis' },
      h('div', { class: 'kpi' }, h('b', {}, c.draft + c.rejected), h('span', {}, 'Drafts and returned')),
      h('div', { class: 'kpi red' }, h('b', {}, c.pending), h('span', {}, 'Waiting for approval')),
      h('div', { class: 'kpi' }, h('b', {}, c.approved + c.sent), h('span', {}, 'Approved / sent to customer')),
      h('div', { class: 'kpi green' }, h('b', {}, c.accepted), h('span', {}, 'Accepted jobs')))];
    if (d.finance) {
      const p = d.finance.partners;
      kids.push(h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, `${d.year} so far`), h('a', { class: 'btn link', href: '#finance' }, 'Full financial report'), h('a', { class: 'btn link', href: '#partners' }, 'Partners')),
        shareKpis(d.finance, { extra: [h('div', { class: 'kpi red' }, h('b', {}, money(d.finance.ledger.outstanding.total)), h('span', {}, `${d.finance.ledger.outstanding.count} unpaid invoices`))] }),
        h('div', { class: 'kpis' }, h('div', { class: 'kpi' }, h('b', {}, money(d.balances.a)), h('span', {}, `Still owed to ${p.a} (all time, after payments)`)), h('div', { class: 'kpi' }, h('b', {}, money(d.balances.b)), h('span', {}, `Still owed to ${p.b} (all time, after payments)`)),
          d.pendingExpenses ? h('div', { class: 'kpi red' }, h('b', {}, d.pendingExpenses), h('span', {}, 'Expenses waiting for approval')) : null)));
    }
    kids.push(dashboardCharts(d));
    if (d.pending.length) kids.push(h('div', { class: 'card' }, h('h2', {}, 'Waiting for approval'), quoteTable(d.pending)));
    if (d.mine.length) kids.push(h('div', { class: 'card' }, h('h2', {}, 'My quotations'), quoteTable(d.mine)));
    kids.push(h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, 'Latest quotations'), h('a', { class: 'btn link', href: '#quotes' }, 'All quotations')), quoteTable(d.recent)));
    fill(el, ...kids);
  },

  async quotes(el) {
    const st = { status: sessionStorage.getItem('qStatus') || '', q: '' };
    const box = h('div', {});
    const load = async () => { const r = await A('GET', `/quotations?status=${st.status}&q=${encodeURIComponent(st.q)}`); box.replaceChildren(quoteTable(r.rows)); };
    const chips = h('div', { class: 'chips' }, [['', 'All'], ['draft', 'Draft'], ['pending', 'Waiting approval'], ['approved', 'Approved'], ['rejected', 'Returned'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['declined', 'Declined']]
      .map(([k, l]) => h('button', { class: st.status === k ? 'on' : '', onclick: (e) => { st.status = k; sessionStorage.setItem('qStatus', k); chips.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); load(); } }, l)));
    let t;
    fill(el, h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search number, customer, subject or LPO', oninput: (e) => { st.q = e.target.value; clearTimeout(t); t = setTimeout(load, 250); } }), h('a', { class: 'btn red', href: '#new' }, '+ New quotation'), exportButton('quotations', () => `status=${st.status}&q=${encodeURIComponent(st.q)}`)), chips, box));
    await load();
  },

  async approvals(el) {
    const [r, e] = await Promise.all([A('GET', '/quotations?status=pending'), A('GET', '/expenses?status=pending')]);
    const quotes = e.rows.length ? await jobChoices() : [];
    const review = async (x, approve) => {
      if (approve) { if (await run(() => A('POST', `/expenses/${x.id}/approve`, {}), 'Expense approved')) refresh(); return; }
      const note = prompt('What should be corrected?');
      if (note && await run(() => A('POST', `/expenses/${x.id}/return`, { note }), 'Returned for correction')) refresh();
    };
    fill(el, h('div', { class: 'card' }, h('div', { class: 'actions' }, h('h2', {}, 'Quotations waiting for your approval'), exportButton('quotations', () => 'status=pending')), quoteTable(r.rows)),
      h('div', { class: 'card' }, h('h2', {}, 'Expenses waiting for your approval'), e.rows.length ? h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Paid on'), h('th', {}, 'Job / description'), h('th', {}, 'Type'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Paid by'), h('th', {}, 'Entered by'), h('th', {}))),
        h('tbody', {}, e.rows.map((x) => h('tr', { class: 'click', onclick: () => expenseDialog(x, quotes, refresh) },
          h('td', { class: 'nowrap' }, fmtDay(x.paid_on)), h('td', {}, x.quote_number ? h('b', {}, `${x.quote_number} · ${x.client_name}`) : null, h('div', { class: 'small muted' }, x.description || x.remarks || '-')),
          h('td', {}, x.cost_type), h('td', { class: 'num' }, h('b', {}, num2(x.total))), h('td', {}, x.paid_by), h('td', {}, x.created_by_name || '-'),
          h('td', { class: 'nowrap' }, h('button', { class: 'btn ok sm', onclick: (ev) => { ev.stopPropagation(); review(x, true); } }, 'Approve'), ' ', h('button', { class: 'btn danger sm', onclick: (ev) => { ev.stopPropagation(); review(x, false); } }, 'Return'))))))) : h('p', { class: 'muted' }, 'No expenses waiting.')));
  },

  new: (el) => quoteForm(el, null),
  async edit(el, id) { quoteForm(el, await A('GET', `/quotations/${id}`)); },
  quote: (el, id) => quoteDetail(el, id),
};

// ---------- quotation form: customer, items and terms in one page ----------
async function quoteForm(el, data) {
  await loadLookups();
  const lk = S.lk;
  const q = data?.quotation || {};
  const c = data?.client || {};
  const clientList = h('datalist', { id: 'dl-clients' }, lk.clients.map((x) => h('option', { value: x.name })));
  const productList = h('datalist', { id: 'dl-products' }, lk.products.map((p) => h('option', { value: p.name }, `${p.unit} · ${num2(p.price)}`)));
  const inp = (name, val, attrs = {}) => h('input', { name, value: val ?? '', ...attrs });
  const cf = {
    name: inp('c_name', c.name, { list: 'dl-clients', required: true, autocomplete: 'off', placeholder: 'Type to search or add a new customer' }),
    contact: inp('c_contact', c.contact), email: inp('c_email', c.email, { type: 'email' }), phone: inp('c_phone', c.phone, { type: 'tel' }),
    address: inp('c_address', c.address), trn: inp('c_trn', c.trn),
  };
  let clientId = c.id || null;
  const clientNote = h('div', { class: 'small muted' }, clientId ? 'Existing customer: changes here update the customer record.' : '');
  cf.name.addEventListener('change', () => {
    const hit = lk.clients.find((x) => x.name.toLowerCase() === cf.name.value.trim().toLowerCase());
    clientId = hit ? hit.id : null;
    if (hit) for (const k of ['contact', 'email', 'phone', 'address', 'trn']) cf[k].value = hit[k] || '';
    clientNote.textContent = hit ? 'Existing customer: details filled in.' : cf.name.value.trim() ? 'New customer: it will be saved with this quotation.' : '';
  });
  const f = {
    subject: inp('subject', q.subject, { required: true, placeholder: 'e.g. Overhauling of 90 KW chilled water pump' }),
    site: inp('site', q.site, { placeholder: 'Building / location' }),
    quote_date: inp('quote_date', q.quote_date || todayIso(), { type: 'date' }),
    valid_until: inp('valid_until', q.valid_until, { type: 'date' }),
    lpo: inp('lpo', q.lpo),
    discount_pct: inp('discount_pct', q.discount_pct ?? 0, { type: 'number', min: 0, max: 100, step: '0.01' }),
    terms: h('textarea', { name: 'terms', value: q.terms ?? lk.settings.quote_terms, rows: 5 }),
    notes: h('textarea', { name: 'notes', value: q.notes || '', rows: 3, placeholder: 'Internal notes are printed on the quotation too; keep them customer friendly.' }),
  };
  const vat = q.vat_rate ?? lk.settings.vat_rate;

  // items
  const tbody = h('tbody', {});
  const unitSel = (val) => { const s = h('select', {}, [...new Set([...lk.units, val].filter(Boolean))].map((u) => h('option', { value: u, selected: u === (val || 'Each') }, u))); return s; };
  function addRow(l = {}) {
    const r = {
      product_id: l.product_id || null,
      desc: h('input', { value: l.description || '', list: 'dl-products', placeholder: 'Product or service (type to search or add new)', autocomplete: 'off' }),
      qty: h('input', { type: 'number', value: l.qty ?? 1, min: 0, step: 'any', 'aria-label': 'Quantity' }),
      unit: unitSel(l.unit),
      price: h('input', { type: 'number', value: l.unit_price ?? '', min: 0, step: '0.01', 'aria-label': 'Unit price', placeholder: 'Price' }),
      cost: h('input', { type: 'number', value: l.unit_cost ?? '', min: 0, step: '0.01', 'aria-label': 'Unit cost', placeholder: 'Cost (internal)' }),
      amount: h('td', { class: 'num amt' }), margin: h('div', { class: 'small muted num' }),
    };
    r.desc.addEventListener('change', () => {
      const p = lk.products.find((x) => x.name.toLowerCase() === r.desc.value.trim().toLowerCase());
      r.product_id = p ? p.id : null;
      if (p) { r.price.value = p.price; r.cost.value = p.cost; r.unit.value = p.unit; if (![...r.unit.options].some((o) => o.value === p.unit)) r.unit.append(h('option', { value: p.unit, selected: true }, p.unit)); }
      recalc();
    });
    for (const k of ['qty', 'price', 'cost']) r[k].addEventListener('input', recalc);
    const tr = h('tr', {}, h('td', { class: 'desc' }, r.desc), h('td', {}, r.qty), h('td', {}, r.unit), h('td', {}, r.price), h('td', {}, r.cost), r.amount,
      h('td', {}, h('button', { class: 'btn danger sm', type: 'button', title: 'Remove item', onclick: () => { rows.splice(rows.indexOf(r), 1); tr.remove(); recalc(); } }, '✕')));
    r.amount.append(r.margin);
    r.tr = tr;
    rows.push(r);
    tbody.append(tr);
    recalc();
    return r;
  }
  const rows = [];
  const sum = { sub: h('b'), disc: h('b'), net: h('b'), vat: h('b'), total: h('b'), cost: h('b'), profit: h('b'), margin: h('div', { class: 'margin' }) };
  function recalc() {
    let sub = 0, cost = 0;
    for (const r of rows) {
      const qty = Number(r.qty.value) || 0, a = qty * (Number(r.price.value) || 0), cc = qty * (Number(r.cost.value) || 0);
      sub += a; cost += cc;
      r.amount.firstChild?.nodeType === 3 ? (r.amount.firstChild.textContent = num2(a)) : r.amount.prepend(document.createTextNode(num2(a)));
      r.margin.textContent = a ? `margin ${pct(a - cc, a)}%` : '';
    }
    const d = Math.round(sub * (Number(f.discount_pct.value) || 0)) / 100, net = sub - d, v = (net * vat) / 100;
    sum.sub.textContent = money(sub); sum.disc.textContent = d ? `- ${money(d)}` : money(0); sum.net.textContent = money(net); sum.vat.textContent = money(v); sum.total.textContent = money(net + v);
    sum.cost.textContent = money(cost); sum.profit.textContent = money(net - cost);
    const m = pct(net - cost, net);
    sum.margin.className = `margin ${net ? marginClass(m) : ''}`;
    sum.margin.replaceChildren(h('span', {}, 'Margin'), h('span', {}, net ? `${m}%` : '-'));
  }
  f.discount_pct.addEventListener('input', recalc);
  (data?.lines?.length ? data.lines : [{}]).forEach(addRow);

  const err = h('div', { class: 'alert bad hide', role: 'alert' });
  async function save(then) {
    err.classList.add('hide');
    const body = {
      client: { id: clientId, name: cf.name.value, contact: cf.contact.value, email: cf.email.value, phone: cf.phone.value, address: cf.address.value, trn: cf.trn.value },
      subject: f.subject.value, site: f.site.value, quote_date: f.quote_date.value, valid_until: f.valid_until.value, lpo: f.lpo.value,
      discount_pct: f.discount_pct.value, terms: f.terms.value, notes: f.notes.value,
      lines: rows.map((r) => ({ product_id: r.product_id, description: r.desc.value, qty: r.qty.value, unit: r.unit.value, unit_price: r.price.value, unit_cost: r.cost.value })),
    };
    try {
      const saved = q.id ? await A('PUT', `/quotations/${q.id}`, body) : await A('POST', '/quotations', body);
      const qid = saved.quotation.id;
      if (then === 'submit') await A('POST', `/quotations/${qid}/submit`, {});
      if (then === 'approve') await A('POST', `/quotations/${qid}/approve`, {});
      toast(then === 'submit' ? 'Submitted for approval' : then === 'approve' ? 'Saved and approved' : 'Saved');
      go(`quote/${qid}`);
    } catch (e) { err.textContent = e.message; err.classList.remove('hide'); err.scrollIntoView({ block: 'center' }); }
  }

  const head = h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Qty'), h('th', {}, 'Unit'), h('th', {}, 'Unit price'), h('th', {}, 'Unit cost'), h('th', { class: 'num' }, 'Amount'), h('th', {}));
  fill(el, clientList, productList, h('h1', {}, q.id ? `Edit quotation ${q.number}` : 'New quotation'),
    q.decision_note && q.status === 'rejected' ? h('div', { class: 'alert bad' }, h('b', {}, 'Returned for changes: '), q.decision_note) : null,
    h('div', { class: 'qform' },
      h('div', {},
        h('div', { class: 'card' }, h('h2', {}, 'Customer'), field('Customer name *', cf.name), clientNote,
          h('div', { class: 'grid2' }, field('Contact person', cf.contact), field('Email (for sending)', cf.email), field('Phone', cf.phone), field('TRN', cf.trn)), field('Address', cf.address)),
        h('div', { class: 'card' }, h('h2', {}, 'Quotation details'), field('Subject *', f.subject),
          h('div', { class: 'grid3' }, field('Site / location', f.site), field('Quotation date', f.quote_date), field('Valid until', f.valid_until, 'Empty = date + validity days'), field('Client LPO / reference', f.lpo))),
        h('div', { class: 'card' }, h('h2', {}, 'Products and services'),
          h('p', { class: 'small muted' }, 'Pick a saved product or type a new one: new products are added to the product list automatically. Unit cost is internal and never printed.'),
          h('div', { class: 'tablewrap' }, h('table', { class: 'lines' }, h('thead', {}, head), tbody)),
          h('p', {}, h('button', { class: 'btn alt sm', type: 'button', onclick: () => addRow({}).desc.focus() }, '+ Add item'))),
        h('div', { class: 'card' }, h('h2', {}, 'Terms and notes'), field('Terms and conditions (printed)', f.terms), field('Notes (printed)', f.notes))),
      h('div', { class: 'side' }, h('div', { class: 'card summary' }, h('h2', {}, 'Summary'),
        h('div', { class: 'r' }, h('span', {}, 'Subtotal'), sum.sub),
        h('div', { class: 'r' }, h('label', { class: 'small' }, 'Discount %'), h('span', { class: 'nowrap' }, f.discount_pct)),
        h('div', { class: 'r' }, h('span', {}, 'Discount'), sum.disc), h('div', { class: 'r' }, h('span', {}, 'Net (revenue)'), sum.net),
        h('div', { class: 'r' }, h('span', {}, `VAT ${vat}%`), sum.vat), h('div', { class: 'r total' }, h('span', {}, 'Total'), sum.total),
        h('div', { class: 'r int' }, h('span', {}, 'Cost (internal)'), sum.cost), h('div', { class: 'r int' }, h('span', {}, 'Profit'), sum.profit), sum.margin,
        err,
        h('div', { class: 'stack' },
          isAdmin() ? h('button', { class: 'btn red block', onclick: () => save('approve') }, 'Save and approve') : h('button', { class: 'btn red block', onclick: () => save('submit') }, 'Save and submit for approval'),
          isAdmin() ? h('button', { class: 'btn block', onclick: () => save('submit') }, 'Save and submit for approval') : null,
          h('button', { class: 'btn alt block', onclick: () => save() }, 'Save as draft'),
          h('button', { class: 'btn link', onclick: () => history.back() }, 'Cancel'))))));
  f.discount_pct.classList.add('num');
  f.discount_pct.style.width = '90px';
  recalc();
}

// ---------- quotation detail and workflow ----------
async function quoteDetail(el, id) {
  const d = await A('GET', `/quotations/${id}`);
  const q = d.quotation, c = d.client;
  const reload = (x) => { if (x) quoteDetail(el, id); };
  const act = (path, body, ok) => run(() => A('POST', `/quotations/${q.id}/${path}`, body || {}), ok).then(reload);
  const margin = pct(q.net - q.cost_total, q.net);
  const actualProfit = d.actualCost != null ? q.net - d.actualCost : null;
  const editable = ['draft', 'rejected'].includes(q.status) || (isAdmin() && ['pending', 'approved'].includes(q.status));

  const buttons = [];
  if (editable) buttons.push(h('a', { class: 'btn alt', href: `#edit/${q.id}` }, 'Edit'));
  if (['draft', 'rejected'].includes(q.status)) buttons.push(h('button', { class: 'btn red', onclick: () => act('submit', {}, 'Submitted for approval') }, 'Submit for approval'));
  if (isAdmin() && ['pending', 'draft', 'rejected'].includes(q.status)) buttons.push(h('button', { class: 'btn ok', onclick: () => noteDialog('Approve quotation', 'Comment (optional)', false, (note) => act('approve', { note }, 'Approved')) }, 'Approve'));
  if (isAdmin() && q.status === 'pending') buttons.push(h('button', { class: 'btn danger', onclick: () => noteDialog('Return for changes', 'What should be changed?', true, (note) => act('reject', { note }, 'Returned to creator')) }, 'Return for changes'));
  if (['approved', 'sent'].includes(q.status)) buttons.push(h('button', { class: 'btn red', onclick: () => sendDialog(q, c, d.attachments, reload) }, q.status === 'sent' ? 'Send again' : 'Send to customer'));
  if (['approved', 'sent'].includes(q.status)) buttons.push(
    h('button', { class: 'btn ok', onclick: () => acceptDialog(q, (b) => act('accept', b, 'Marked as accepted')) }, 'Customer accepted'),
    h('button', { class: 'btn danger', onclick: () => noteDialog('Declined / cancelled', 'Reason (optional)', false, (note) => act('decline', { note }, 'Marked as declined / cancelled')) }, 'Declined / cancel'));
  if (['approved', 'sent', 'accepted'].includes(q.status) && !d.invoice) buttons.push(h('button', { class: 'btn', onclick: () => invoiceDialog(q) }, 'Create invoice'));
  if (q.status === 'accepted' && !d.invoice) buttons.push(q.paid_at
    ? h('button', { class: 'btn alt', onclick: () => confirm('Remove the customer payment from this job?') && act('paid', { paid: false }, 'Marked unpaid') }, 'Mark not paid')
    : h('button', { class: 'btn ok', onclick: () => jobPaidDialog(q, (b) => act('paid', b, 'Customer payment recorded')) }, 'Customer paid (no invoice)'));
  if (d.invoice) buttons.push(h('a', { class: 'btn alt', href: `#invoice/${d.invoice.id}` }, `Invoice ${d.invoice.number}`));
  if (isAdmin() && ['approved', 'sent', 'accepted', 'declined', 'pending'].includes(q.status) && !d.invoice) buttons.push(h('button', { class: 'btn alt', onclick: () => confirm('Reopen this quotation as a draft? It will need approval again.') && act('reopen', {}, 'Reopened as draft') }, 'Reopen'));
  buttons.push(h('a', { class: 'btn alt', href: `/api/app/quotations/${q.id}/pdf`, target: '_blank', rel: 'noopener' }, 'View PDF'));
  buttons.push(h('button', { class: 'btn alt', onclick: async () => { const r = await run(() => A('POST', `/quotations/${q.id}/duplicate`, {}), 'Copy created'); if (r) go(`edit/${r.id}`); } }, 'Duplicate'));
  if (isAdmin()) buttons.push(h('button', { class: 'btn danger', onclick: async () => { if (await del.quote({ ...q, invoice_number: d.invoice?.number })) go('quotes'); } }, 'Delete quotation'));

  const status = {
    draft: 'Draft: not submitted yet.', pending: `Waiting for approval since ${q.submitted_at ? fmtStamp(q.submitted_at) : '-'}.`, approved: `Approved by ${q.decided_by_name || '-'}. Ready to send to the customer.`,
    rejected: `Returned for changes by ${q.decided_by_name || '-'}.`, sent: `Sent to the customer${q.sent_at ? ' on ' + fmtStamp(q.sent_at) : ''}. Waiting for the customer's answer.`,
    accepted: `Accepted by the customer${q.closed_at ? ' on ' + fmtDay(q.closed_at) : ''}. ${q.paid_at ? `Customer paid on ${fmtDay(q.paid_at)}: the profit is payable to the partners.` : 'Waiting for the customer\'s payment: the profit is shared once paid.'}`, declined: 'Declined by the customer.',
  }[q.status];

  fill(el, 
    h('div', { class: 'actions' }, h('h1', {}, `Quotation ${q.number}`), badge(q.status)),
    h('div', { class: `alert ${q.status === 'rejected' ? 'bad' : q.status === 'accepted' ? 'good' : 'info'}` }, status, q.decision_note ? h('div', {}, h('b', {}, 'Comment: '), q.decision_note) : null),
    h('div', { class: 'card' }, h('div', { class: 'actions' }, buttons)),
    h('div', { class: 'split' },
      h('div', { class: 'card' }, h('h2', {}, q.subject),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Customer'), h('dd', {}, h('b', {}, c.name), c.contact ? ` · ${c.contact}` : ''),
          h('dt', {}, 'Email / phone'), h('dd', {}, [c.email, c.phone].filter(Boolean).join(' · ') || h('span', { class: 'muted' }, 'not set')),
          c.address ? [h('dt', {}, 'Address'), h('dd', {}, c.address)] : null,
          h('dt', {}, 'Site'), h('dd', {}, q.site || '-'), h('dt', {}, 'Date'), h('dd', {}, fmtDay(q.quote_date)), h('dt', {}, 'Valid until'), h('dd', {}, fmtDay(q.valid_until)),
          h('dt', {}, 'Client LPO'), h('dd', {}, q.lpo || '-'), h('dt', {}, 'Created by'), h('dd', {}, q.created_by_name || '-'))),
      h('div', { class: 'card summary' }, h('h2', {}, 'Revenue, cost and margin'),
        h('div', { class: 'r' }, h('span', {}, 'Subtotal'), h('b', {}, money(q.subtotal))),
        q.discount ? h('div', { class: 'r' }, h('span', {}, `Discount ${q.discount_pct}%`), h('b', {}, `- ${money(q.discount)}`)) : null,
        h('div', { class: 'r' }, h('span', {}, 'Net (revenue)'), h('b', {}, money(q.net))), h('div', { class: 'r' }, h('span', {}, `VAT ${q.vat_rate}%`), h('b', {}, money(q.vat))),
        h('div', { class: 'r total' }, h('span', {}, 'Total'), h('span', {}, money(q.total))),
        h('div', { class: 'r int' }, h('span', {}, 'Estimated cost'), h('b', {}, money(q.cost_total))), h('div', { class: 'r int' }, h('span', {}, 'Estimated profit'), h('b', {}, money(q.net - q.cost_total))),
        h('div', { class: `margin ${marginClass(margin)}` }, h('span', {}, 'Estimated margin'), h('span', {}, `${margin}%`)),
        d.actualCost != null ? [h('div', { class: 'r int' }, h('span', {}, `Actual cost (${d.expenseCount} expenses)`), h('b', {}, money(d.actualCost))),
          h('div', { class: 'r int' }, h('span', {}, 'Actual profit'), h('b', {}, money(actualProfit))),
          q.status === 'accepted' ? h('label', { class: 'small' }, h('input', { type: 'checkbox', checked: !!q.share_paid, onchange: (e) => run(() => A('POST', `/quotations/${q.id}/share-paid`, { paid: e.target.checked }), 'Saved') }), ' Revenue share paid to partners') : null,
          h('p', {}, h('a', { class: 'btn link', href: `#expenses/q${q.id}` }, 'Expenses of this job'))] : null)),
    h('div', { class: 'card' }, h('h2', {}, 'Items'), h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Description'), h('th', { class: 'num' }, 'Qty'), h('th', {}, 'Unit'), h('th', { class: 'num' }, 'Unit price'), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'num' }, 'Unit cost'), h('th', { class: 'num' }, 'Margin'))),
      h('tbody', {}, d.lines.map((l, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, l.description), h('td', { class: 'num' }, l.qty), h('td', {}, l.unit), h('td', { class: 'num' }, num2(l.unit_price)), h('td', { class: 'num' }, num2(l.amount)),
        h('td', { class: 'num muted' }, num2(l.unit_cost)), h('td', { class: 'num muted' }, l.amount ? `${pct(l.amount - l.cost, l.amount)}%` : '-'))))))),
    h('div', { class: 'split' },
      attachmentsCard('quotation', q.id, d.attachments),
      h('div', { class: 'card' }, h('h2', {}, 'History'), h('ul', { class: 'timeline' }, d.events.map((e) => h('li', {}, h('b', {}, e.action), ` · ${e.user_name || 'system'} · ${fmtStamp(e.ts)}`, e.note ? h('div', { class: 'small muted' }, e.note) : null))))),
    q.terms ? h('div', { class: 'card' }, h('h2', {}, 'Terms'), h('p', { class: 'small' }, ...q.terms.split('\n').flatMap((t, i) => (i ? [h('br'), t] : [t])))) : null,
  );
}

function noteDialog(title, label, required, onOk) {
  const ta = h('textarea', { rows: 3, required });
  modal(h('h2', {}, title), field(label, ta), h('p', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => { if (required && !ta.value.trim()) return toast('Please write a comment.'); closeModal(); onOk(ta.value.trim()); } }, 'Confirm'),
    h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}
function acceptDialog(q, onOk) {
  const lpo = h('input', { value: q.lpo || '' }), date = h('input', { type: 'date', value: todayIso() });
  modal(h('h2', {}, `Customer accepted ${q.number}`), field('Client LPO number', lpo), field('Accepted on', date),
    h('p', { class: 'actions' }, h('button', { class: 'btn ok', onclick: () => { closeModal(); onOk({ lpo: lpo.value, date: date.value }); } }, 'Mark accepted'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}
function sendDialog(q, c, atts, done) {
  const to = h('input', { type: 'email', value: c.email || '', readOnly: true });
  const msg = h('textarea', { rows: 3, value: 'Please find attached our quotation for your review. We look forward to working with you.' });
  const picks = atts.filter((a) => a.storage !== 'link').map((a) => ({ a, cb: h('input', { type: 'checkbox' }) }));
  modal(h('h2', {}, `Send ${q.number} to the customer`),
    c.email ? null : h('div', { class: 'alert bad' }, 'This customer has no email address. Edit the quotation and add it, or use "Mark as sent".'),
    field('To', to, 'Sent from the company Gmail account with the quotation PDF attached.'), field('Message', msg),
    picks.length ? h('div', {}, h('label', {}, 'Also attach'), picks.map(({ a, cb }) => h('label', { class: 'small' }, cb, ` ${a.name}`))) : null,
    h('p', { class: 'actions' },
      h('button', { class: 'btn red', disabled: !c.email, onclick: async () => { const r = await run(() => A('POST', `/quotations/${q.id}/send`, { email: true, message: msg.value, attachmentIds: picks.filter((p) => p.cb.checked).map((p) => p.a.id) }), 'Quotation emailed'); if (r) { closeModal(); done(r); } } }, 'Send email'),
      h('button', { class: 'btn alt', onclick: async () => { const r = await run(() => A('POST', `/quotations/${q.id}/send`, { email: false }), 'Marked as sent'); if (r) { closeModal(); done(r); } } }, 'Mark as sent (no email)'),
      h('button', { class: 'btn link', onclick: closeModal }, 'Cancel')));
}
function jobPaidDialog(q, onOk) {
  const date = h('input', { type: 'date', value: todayIso() });
  modal(h('h2', {}, `Customer paid ${q.number}`), h('p', { class: 'small muted' }, 'Use this for jobs paid without an invoice in the app. Jobs with an invoice are marked paid on the invoice.'), field('Paid on', date),
    h('p', { class: 'actions' }, h('button', { class: 'btn ok', onclick: () => { closeModal(); onOk({ paid: true, date: date.value }); } }, 'Save'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}
function invoiceDialog(q) {
  const date = h('input', { type: 'date', value: todayIso() });
  modal(h('h2', {}, `Create invoice for ${q.number}`), h('p', {}, `Amount: ${money(q.total)} (net ${money(q.net)} + VAT ${money(q.vat)}). The quotation is marked accepted.`), field('Invoice date', date),
    h('p', { class: 'actions' }, h('button', { class: 'btn', onclick: async () => { const r = await run(() => A('POST', `/quotations/${q.id}/invoice`, { issue_date: date.value }), 'Invoice created'); if (r) { closeModal(); go(`invoice/${r.invoice.id}`); } } }, 'Create invoice'), h('button', { class: 'btn alt', onclick: closeModal }, 'Cancel')));
}

export { fmtMonth };


// ---------- dashboard bar charts ----------
function barChart(rows, series, { height = 190 } = {}) {
  const max = Math.max(1, ...rows.flatMap((r) => series.map((x) => Math.abs(r[x.key] || 0))));
  return h('div', {},
    h('div', { class: 'legend' }, series.map((x) => h('span', {}, h('i', { class: x.cls }), x.label))),
    h('div', { class: 'bars auto' }, rows.map((r) => {
      const pair = h('div', { class: 'pair' }, series.map((x) => { const b = h('i', { class: x.cls, title: `${x.label}: ${num2(r[x.key])}` }); b.style.height = `${(Math.max(0, r[x.key] || 0) / max) * 100}%`; return b; }));
      pair.style.height = `${height}px`;
      return h('div', { class: 'm', title: series.map((x) => `${x.label} ${num2(r[x.key])}`).join(' · ') }, pair, h('span', {}, fmtMonth(r.month).replace(/ \d{2}(\d{2})$/, " '$1")));
    })));
}
function dashboardCharts(d) {
  const cards = [];
  if (d.finance && d.finance.monthly.length) {
    const rows = [...d.finance.monthly].reverse();
    cards.push(h('div', { class: 'card' }, h('h2', {}, `Revenue, costs and profit by month (${d.year})`),
      barChart(rows, [{ key: 'revenue', label: 'Revenue', cls: 'navy' }, { key: 'cost', label: 'Costs', cls: 'red' }, { key: 'profit', label: 'Profit', cls: 'green' }]),
      h('p', { class: 'small muted' }, 'Revenue = accepted jobs (excl. VAT), in the month of the invoice. Months with a loss show no profit bar.')));
  }
  if (d.quoteMonths?.length) {
    cards.push(h('div', { class: 'card' }, h('h2', {}, 'Quotations by month (value excl. VAT)'),
      barChart(d.quoteMonths, [{ key: 'quoted', label: 'Quoted', cls: 'navy' }, { key: 'accepted', label: 'Accepted', cls: 'green' }]),
      h('p', { class: 'small muted' }, d.quoteMonths.map((m) => `${fmtMonth(m.month)}: ${m.n} quotations, ${m.won} accepted`).slice(-3).join(' · '))));
  }
  return h('div', { class: cards.length > 1 ? 'split' : '' }, cards);
}
