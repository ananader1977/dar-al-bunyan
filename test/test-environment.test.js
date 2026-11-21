import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';

test('live app: the load-data endpoint does not exist', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin');
    assert.equal((await t.call('admin', 'POST', '/api/app/test/load-data', { data: 'x' })).status, 404);
    assert.equal((await t.call(null, 'GET', '/api/config')).body.testMode, false);
  } finally { await t.close(); }
});

test('test app: banner flag, no emails, and a live backup can be loaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dab-testenv-'));
  const t = await startTestApp({ testMode: true, dbPath: path.join(dir, 'app.db'), smtp: { host: 'smtp.example.invalid', port: 587, user: 'x', pass: 'y', from: 'x' } });
  try {
    await t.login('admin');
    t.ctx.restart = () => {};
    assert.equal((await t.call(null, 'GET', '/api/config')).body.testMode, true);
    // a message is logged, never sent, even though SMTP is configured
    const r = await t.ctx.notifier.email({ to: 'customer@example.com', subject: 'Hi', text: 'x' });
    assert.equal(r.status, 'logged');
    // a backup of this very database is accepted and staged for the next start
    const backup = path.join(dir, 'backup.sqlite');
    t.ctx.db.prepare('VACUUM INTO ?').run(backup);
    const ok = await t.call('admin', 'POST', '/api/app/test/load-data', { data: fs.readFileSync(backup).toString('base64') });
    assert.equal(ok.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'app.db.restore')));
    // rubbish is refused
    assert.equal((await t.call('admin', 'POST', '/api/app/test/load-data', { data: Buffer.alloc(5000, 1).toString('base64') })).status, 400);
    // operations cannot do it
    await t.login('ops');
    assert.notEqual((await t.call('ops', 'POST', '/api/app/test/load-data', { data: 'x' })).status, 200);
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
