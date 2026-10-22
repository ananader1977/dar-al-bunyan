import { api, h, $, qs, money } from '/js/common.js';
const app = $('#app'), sid = qs('s');
const back = `/pay.html?inv=${encodeURIComponent(qs('inv') || '')}&t=${encodeURIComponent(qs('t') || '')}`;
try {
  const s = await api('GET', `/api/pay-demo/${encodeURIComponent(sid)}`);
  if (s.status !== 'open') location.replace(back);
  const msg = h('div', { class: 'alert bad hide' });
  const btn = h('button', { class: 'btn ok block', onclick: async () => {
    btn.disabled = true; btn.textContent = 'Processing…';
    try { await api('POST', `/api/pay-demo/${encodeURIComponent(sid)}/complete`, {}); location.href = back; }
    catch (e) { msg.textContent = e.message; msg.classList.remove('hide'); btn.disabled = false; btn.textContent = 'Pay now'; }
  } }, `Pay ${money(s.amount)} (demo)`);
  app.replaceChildren(h('div', { class: 'card login' }, h('h1', {}, 'Demo checkout'),
    h('div', { class: 'alert' }, 'DEMO MODE: no card is charged. The real payment gateway will replace this page when it is activated.'),
    h('dl', { class: 'kv' }, h('dt', {}, 'Invoice'), h('dd', {}, s.number), h('dt', {}, 'Customer'), h('dd', {}, s.client), h('dt', {}, 'Amount'), h('dd', {}, h('b', {}, money(s.amount)))),
    h('label', {}, 'Card number'), h('input', { value: '4242 4242 4242 4242', disabled: true }), msg, h('p', {}, btn), h('a', { href: back }, 'Cancel')));
} catch (e) { app.replaceChildren(h('div', { class: 'alert bad' }, e.message)); }
