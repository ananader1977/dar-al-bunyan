// Shared helpers. No inline scripts or styles anywhere (strict Content-Security-Policy).
export const money = (n) => `AED ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const num2 = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${Number(m[3])} ${MO[Number(m[2]) - 1]} ${m[1]}` : '-'; };
export const fmtMonth = (ym) => { const m = /^(\d{4})-(\d{2})/.exec(String(ym || '')); return m ? `${MO[Number(m[2]) - 1]} ${m[1]}` : ym; };
export const fmtStamp = (ts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ts);
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(Date.now());

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
export async function api(method, path, body) {
  const headers = { 'X-Requested-With': 'dab' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
  catch { throw new ApiError('Network problem. Check your connection and try again.', 0); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

/** Tiny DOM builder (no innerHTML, so text typed by users can never become HTML). */
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') e[k] = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(9)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
export const $ = (s, r = document) => r.querySelector(s);
export const clear = (e) => { while (e.firstChild) e.removeChild(e.firstChild); return e; };
/** Replaces the content of el, skipping null/false children (DOM append would print "null"). */
export const fill = (el, ...kids) => { clear(el); el.append(...kids.flat(9).filter((k) => k != null && k !== false)); return el; };
export function toast(msg, ms = 3500) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
const LABEL = { pending: 'waiting approval', rejected: 'returned', issued: 'unpaid', waiting: 'waiting payment', credited: 'credit note' };
export const badge = (s) => h('span', { class: `badge ${s}` }, LABEL[s] || String(s));
export const qs = (k) => new URLSearchParams(location.search).get(k);
/** Reads a File as base64 (without the data: prefix). */
export const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the file.'));
  r.readAsDataURL(file);
});
