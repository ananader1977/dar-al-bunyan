import { loadConfig, validateConfig } from './config.js';
import { createContext, createWebApp } from './app.js';

const config = loadConfig();
const problems = validateConfig(config);
if (problems.length) {
  console.error('Configuration problems:\n - ' + problems.join('\n - '));
  process.exit(1);
}
const ctx = createContext({ config });
const server = createWebApp(ctx).server();

if (ctx.createdUsers.length) {
  console.log('\n=== Accounts created ===');
  for (const u of ctx.createdUsers) console.log(`  ${u.role.padEnd(10)} ${u.email}   password: ${u.password || '(from environment)'}`);
  console.log('Generated passwords are shown once. Change them after signing in.\n');
}
if (ctx.firstImport) console.log('[import] Excel data imported:', JSON.stringify(ctx.firstImport));
if (ctx.payments.name === 'mock') console.warn('[info] PAYMENT_PROVIDER=mock: online invoice payments use the DEMO checkout (no real money).');
if (!config.smtp.host) console.warn('[info] SMTP not configured: emails are only logged (see Messages).');
console.log(`[info] attachments are stored in: ${ctx.storage.kind === 'drive' ? 'Google Drive' : 'the server disk (data/uploads)'}`);

ctx.jobs.start(); // daily backup, Trash clean-up, Monday reminder email
server.listen(config.port, () => console.log(`Dar Al Bunyan app running at ${config.baseUrl} (port ${config.port})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
