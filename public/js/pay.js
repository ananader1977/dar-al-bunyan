import { api, h, $, qs, money, fmtDay, badge } from '/js/common.js';
const app = $('#app'), inv = qs('inv'), t = qs('t');
const base = `/api/pay/${encodeURIComponent(inv || '')}`;
async function show() {
  try {
    const i = await api('GET', `${base}?t=${encodeURIComponent(t || '')}${qs('done') ? '&check=1' : ''}`);
    const msg = h('div', { class: 'alert bad hide' });
    const btn = h('button', { class: 'btn red block', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Opening secure payment…';
      try { const r = await api('POST', `${base}/checkout?t=${encodeURIComponent(t)}`, {}); location.href = r.url; }
      catch (e) { msg.textContent = e.message; msg.classList.remove('hide'); btn.disabled = false; btn.textContent = `Pay ${money(i.total)}`; }
    } }, `Pay ${money(i.total)}`);
    app.replaceChildren(h('div', { class: 'card login' }, h('div', { class: 'actions' }, h('h1', {}, `Invoice ${i.number}`), badge(i.status)),
      h('dl', { class: 'kv' }, h('dt', {}, 'Customer'), h('dd', {}, i.client), h('dt', {}, 'Subject'), h('dd', {}, i.subject || '-'), h('dt', {}, 'Invoice date'), h('dd', {}, fmtDay(i.issue_date)), h('dt', {}, 'Due date'), h('dd', {}, fmtDay(i.due_date)),
        h('dt', {}, 'Net'), h('dd', {}, money(i.net)), h('dt', {}, 'VAT'), h('dd', {}, money(i.vat)), h('dt', {}, 'Total'), h('dd', {}, h('b', {}, money(i.total)))),
      i.status === 'paid' ? h('div', { class: 'alert good' }, 'This invoice is paid. Thank you!') : i.status === 'cancelled' ? h('div', { class: 'alert' }, 'This invoice was cancelled.') : [msg, h('p', {}, btn),
        i.provider === 'mock' ? h('p', { class: 'small muted' }, 'Online card payment is in demo mode. To pay now, please use the bank details on the invoice.') : null],
      h('p', {}, h('a', { class: 'btn alt block', href: `${base}/pdf?t=${encodeURIComponent(t)}`, target: '_blank', rel: 'noopener' }, 'Download invoice (PDF)'))));
  } catch (e) { app.replaceChildren(h('div', { class: 'alert bad' }, e.message)); }
}
show();
