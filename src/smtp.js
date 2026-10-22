// Minimal dependency-free SMTP client: implicit TLS or STARTTLS, AUTH PLAIN/LOGIN, HTML + text, attachments.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addrOnly = (a) => (/<([^>]+)>/.exec(a) || [null, a])[1].trim();

export function buildMessage({ from, to, subject, text, html, attachments = [], messageId, date }) {
  const mixed = `mix_${crypto.randomBytes(8).toString('hex')}`;
  const alt = `alt_${crypto.randomBytes(8).toString('hex')}`;
  const headers = [
    `From: ${from}`,
    `To: ${[].concat(to).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${(date || new Date()).toUTCString()}`,
    `Message-ID: <${messageId || crypto.randomUUID()}@consultancy-operation>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const body = [];
  body.push(`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '');
  body.push(`--${alt}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text || '')));
  if (html) body.push(`--${alt}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html)));
  body.push(`--${alt}--`);
  for (const a of attachments) {
    const name = a.filename.replace(/[^\w.\- ]/g, '_');
    body.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      wrap76(b64(a.content)),
    );
  }
  body.push(`--${mixed}--`, '');
  return `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}`;
}

class Conn {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.attach(socket);
  }
  attach(socket) {
    this.socket = socket;
    this.buf = '';
    this.waiters = [];
    this.error = null;
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      this.buf += d;
      this.flush();
    });
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('SMTP connection closed unexpectedly')));
  }
  fail(e) {
    this.error = this.error || e;
    this.waiters.splice(0).forEach((w) => w.reject(e));
  }
  flush() {
    while (this.waiters.length) {
      const lines = this.buf.split('\r\n');
      // a complete reply ends with a line "NNN text" (no hyphen after code) followed by CRLF
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) { end = i; break; }
      if (end < 0) return;
      const reply = lines.slice(0, end + 1);
      this.buf = lines.slice(end + 1).join('\r\n');
      this.waiters.shift().resolve({ code: Number(reply[end].slice(0, 3)), lines: reply });
    }
  }
  read() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('SMTP timeout')), this.timeoutMs);
      this.waiters.push({ resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.flush();
    });
  }
  async cmd(line, expect) {
    if (line !== null) this.socket.write(`${line}\r\n`);
    const r = await this.read();
    if (expect && !expect.includes(r.code)) throw new Error(`SMTP error after "${String(line).split(' ')[0]}": ${r.lines.join(' | ')}`);
    return r;
  }
}

export async function sendMail(opts) {
  const { host, port, secure = false, user, pass, from, to, rejectUnauthorized = true, timeoutMs = 20000, starttls = true } = opts;
  const recipients = [].concat(to);
  const socket = await new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect({ host, port, family: 4, rejectUnauthorized, servername: host }, () => resolve(s))
      : net.connect({ host, port, family: 4 }, () => resolve(s));
    s.once('error', reject);
  });
  const conn = new Conn(socket, timeoutMs);
  try {
    await conn.cmd(null, [220]);
    let ehlo = await conn.cmd(`EHLO ${os.hostname() || 'localhost'}`, [250]);
    if (!secure && starttls && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await conn.cmd('STARTTLS', [220]);
      const upgraded = tls.connect({ socket, host, rejectUnauthorized, servername: host });
      await new Promise((res, rej) => (upgraded.once('secureConnect', res), upgraded.once('error', rej)));
      socket.removeAllListeners('data');
      socket.removeAllListeners('close');
      conn.attach(upgraded);
      ehlo = await conn.cmd(`EHLO ${os.hostname() || 'localhost'}`, [250]);
    }
    if (user) {
      const mechs = ehlo.lines.join(' ').toUpperCase();
      if (mechs.includes('PLAIN') || !mechs.includes('LOGIN')) {
        await conn.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
      } else {
        await conn.cmd('AUTH LOGIN', [334]);
        await conn.cmd(b64(user), [334]);
        await conn.cmd(b64(pass), [235]);
      }
    }
    await conn.cmd(`MAIL FROM:<${addrOnly(from)}>`, [250]);
    for (const r of recipients) await conn.cmd(`RCPT TO:<${addrOnly(r)}>`, [250, 251]);
    await conn.cmd('DATA', [354]);
    const raw = buildMessage(opts).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    conn.socket.write(`${raw}\r\n.\r\n`);
    const done = await conn.read();
    if (done.code !== 250) throw new Error(`SMTP rejected message: ${done.lines.join(' | ')}`);
    try { await conn.cmd('QUIT'); } catch { /* ignore */ }
    return { accepted: recipients };
  } finally {
    conn.socket.destroy();
  }
}
