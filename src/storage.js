// Attachment storage: Google Drive (when GOOGLE_* variables are set) or the server disk.
// Drive uses the "drive.file" scope, so the app can only see the files it created itself.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './http.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export function createStorage(ctx) {
  const d = ctx.config.drive;
  const driveOn = !!(d.clientId && d.clientSecret && d.refreshToken);
  const localDir = ctx.config.uploadDir || path.join(path.dirname(path.resolve(ctx.config.dbPath === ':memory:' ? './data/x' : ctx.config.dbPath)), 'uploads');
  let token = null;

  async function accessToken() {
    if (token && token.exp > Date.now() + 60000) return token.value;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: d.clientId, client_secret: d.clientSecret, refresh_token: d.refreshToken, grant_type: 'refresh_token' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new HttpError(502, `Google Drive sign-in failed: ${data.error_description || data.error || res.status}`);
    token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
    return token.value;
  }

  async function driveSave(name, mime, buf) {
    const boundary = `dab_${crypto.randomBytes(8).toString('hex')}`;
    const meta = { name, ...(d.folderId ? { parents: [d.folderId] } : {}) };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `Google Drive upload failed: ${data?.error?.message || res.status}`);
    return { storage: 'drive', drive_id: data.id, link: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`, local_path: null };
  }

  return {
    kind: driveOn ? 'drive' : 'local',
    async save(name, mime, buf) {
      if (driveOn) return driveSave(name, mime, buf);
      fs.mkdirSync(localDir, { recursive: true });
      const file = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${path.extname(name).replace(/[^.\w]/g, '').slice(0, 10)}`;
      fs.writeFileSync(path.join(localDir, file), buf);
      return { storage: 'local', drive_id: null, link: '', local_path: file };
    },
    /** Returns the file bytes (used for downloads of local files and for email attachments). */
    async read(att) {
      if (att.storage === 'local') return fs.readFileSync(path.join(localDir, path.basename(att.local_path)));
      if (att.storage === 'drive') {
        const res = await fetch(`${DRIVE}/files/${encodeURIComponent(att.drive_id)}?alt=media`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
        if (!res.ok) throw new HttpError(502, `Google Drive download failed (${res.status})`);
        return Buffer.from(await res.arrayBuffer());
      }
      throw new HttpError(400, 'This attachment is a link only.');
    },
    async remove(att) {
      try {
        if (att.storage === 'local' && att.local_path) fs.rmSync(path.join(localDir, path.basename(att.local_path)), { force: true });
        if (att.storage === 'drive' && att.drive_id && driveOn) {
          await fetch(`${DRIVE}/files/${encodeURIComponent(att.drive_id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await accessToken()}` } });
        }
      } catch (e) { console.error('[storage] remove failed:', e.message); }
    },
  };
}
