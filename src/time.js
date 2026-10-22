// All business logic runs in Dubai time (UTC+4, no DST). Timestamps are epoch milliseconds (UTC).
export const DUBAI_OFFSET_MS = 4 * 3600 * 1000;
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
export const MINUTE = 60 * 1000;

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

export function parts(ts) {
  const d = new Date(ts + DUBAI_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dow: d.getUTCDay(), // 0 = Sunday
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** Epoch ms of 00:00 Dubai time on the day containing ts. */
export function dubaiMidnight(ts) {
  const p = parts(ts);
  return Date.UTC(p.year, p.month - 1, p.day) - DUBAI_OFFSET_MS;
}

export function dateKey(ts) {
  const p = parts(ts);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 'YYYY-MM-DD' -> epoch ms of Dubai midnight, or null if invalid. */
export function parseDateKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return t - DUBAI_OFFSET_MS;
}

export const fmtTime = (ts) => {
  const p = parts(ts);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
};
export const fmtDate = (ts) => {
  const p = parts(ts);
  return `${WD[p.dow]} ${p.day} ${MO[p.month - 1]} ${p.year}`;
};
/** "Mon 19 Oct 2026, 10:00 - 11:00 (Dubai time)" */
export const fmtRange = (startTs, endTs) => `${fmtDate(startTs)}, ${fmtTime(startTs)} - ${fmtTime(endTs)} (Dubai time)`;
export const fmtStamp = (ts) => `${fmtDate(ts)} ${fmtTime(ts)}`;
export const yymm = (ts) => {
  const p = parts(ts);
  return `${String(p.year).slice(2)}${pad2(p.month)}`;
};
export const yearOf = (ts) => parts(ts).year;
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const money = (n) => round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
