export const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@<>()\\,;:"]+@[^\s@<>()\\,;:"]+\.[A-Za-z]{2,}$/.test(s);

/** Returns the cleaned mobile ("+971501234567" style) or null when invalid. */
export function cleanMobile(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\s\-().]/g, '');
  return /^\+?[0-9]{8,15}$/.test(s) ? s : null;
}

/** WhatsApp wants digits only with country code. UAE local numbers (05x...) are converted to 9715x... */
export function whatsappNumber(mobile) {
  let m = String(mobile || '').replace(/[^0-9]/g, '');
  if (m.startsWith('00')) m = m.slice(2);
  if (m.startsWith('05') && m.length === 10) m = '971' + m.slice(1);
  else if (m.startsWith('5') && m.length === 9) m = '971' + m;
  return m;
}

export const clampStr = (s, max) => String(s ?? '').trim().slice(0, max);
