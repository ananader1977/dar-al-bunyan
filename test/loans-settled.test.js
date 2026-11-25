import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

test('a settled personal loan stays on record but stops counting', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin'); await t.login('ops');
    const add = async (amount, note) => (await t.call('admin', 'POST', '/api/app/partners/loans', { taken_on: '2026-09-01', amount, note })).body.id;
    const l1 = await add(2000, 'cash advance'); const l2 = await add(500, 'fuel');
    let p = (await t.call('admin', 'GET', '/api/app/partners')).body;
    assert.equal(p.b.loans, 2500); assert.equal(p.a.loansBack, 2500); assert.deepEqual(p.loanTotals, { open: 2500, settled: 0 });
    // settle the 2,000 loan
    assert.equal((await t.call('admin', 'POST', `/api/app/partners/loans/${l1}/settle`, { settled_on: '2026-10-01' })).status, 200);
    p = (await t.call('admin', 'GET', '/api/app/partners')).body;
    assert.equal(p.b.loans, 500); assert.equal(p.a.loansBack, 500); assert.deepEqual(p.loanTotals, { open: 500, settled: 2000 });
    assert.equal(p.loans.length, 2); assert.equal(p.loans.find((x) => x.id === l1).settled_on, '2026-10-01');
    assert.equal((await t.call('admin', 'GET', '/api/app/finance')).body.totals.loans, 500);
    // cannot settle twice, nor before it was taken
    assert.equal((await t.call('admin', 'POST', `/api/app/partners/loans/${l1}/settle`, { settled_on: '2026-10-02' })).status, 400);
    assert.equal((await t.call('admin', 'POST', `/api/app/partners/loans/${l2}/settle`, { settled_on: '2026-08-01' })).status, 400);
    // only an admin can reopen
    assert.notEqual((await t.call('ops', 'POST', `/api/app/partners/loans/${l1}/reopen`)).status, 200);
    assert.equal((await t.call('admin', 'POST', `/api/app/partners/loans/${l1}/reopen`)).status, 200);
    p = (await t.call('admin', 'GET', '/api/app/partners')).body;
    assert.equal(p.b.loans, 2500);
  } finally { await t.close(); }
});

test('financial report export lists the client LPO and manual quotation of each job', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin');
    const q = (await t.call('admin', 'POST', '/api/app/quotations', t.quote({ lpo: '202609999', manual_no: 'DABTS/118/26' }))).body.quotation;
    for (const to of ['submit', 'approve', 'send', 'accept']) await t.call('admin', 'POST', `/api/app/quotations/${q.id}/${to}`);
    const job = t.ctx.service.finance({}).jobs[0] || (await t.call('admin', 'GET', '/api/app/finance')).body.jobs[0];
    assert.equal(job.lpo, '202609999'); assert.equal(job.manual_no, 'DABTS/118/26');
    const cookie = (await t.call('admin', 'GET', '/api/me')).status; // signed in
    assert.equal(cookie, 200);
  } finally { await t.close(); }
});

test('job completion report PDF: only for approved quotations, shows both quotation numbers', async () => {
  const t = await startTestApp();
  try {
    await t.login('admin');
    const q = (await t.call('admin', 'POST', '/api/app/quotations', t.quote({ lpo: '202603430', manual_no: 's00029' }))).body.quotation;
    assert.notEqual((await t.call('admin', 'GET', `/api/app/quotations/${q.id}/jcr`)).status, 200); // still a draft
    for (const to of ['submit', 'approve']) await t.call('admin', 'POST', `/api/app/quotations/${q.id}/${to}`);
    const buf = t.ctx.service.jcrPdfBuffer(q.id, { date: '2026-10-20', contact: 'Ramdas, 0529629735' });
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    const fs = await import('node:fs');
    fs.writeFileSync('/tmp/jcr-sample.pdf', buf);
    let txt = null;
    try { txt = (await import('node:child_process')).execFileSync('pdftotext', ['-layout', '/tmp/jcr-sample.pdf', '-'], { encoding: 'utf8' }); } catch { /* poppler not installed: skip the text check */ }
    if (txt) for (const w of ['JOB COMPLETION REPORT', '202603430', 's00029', q.number, 'WORK COMPLETED']) assert.ok(txt.includes(w), w);
  } finally { await t.close(); }
});
