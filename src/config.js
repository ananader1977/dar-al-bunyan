// Runtime configuration, read from environment variables (see .env.example).
export function loadConfig(env = process.env) {
  const port = Number(env.PORT) || 3000;
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const user = (n, role, fallbackEmail, fallbackName) => ({
    email: (env[`${n}_EMAIL`] || fallbackEmail).trim().toLowerCase(),
    password: env[`${n}_PASSWORD`] || '',
    name: env[`${n}_NAME`] || fallbackName,
    role,
  });
  return {
    nodeEnv: env.NODE_ENV || 'development',
    port,
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    dbPath: env.DB_PATH || './data/app.db',
    // The three starting accounts. Passwords come from the hosting dashboard; if empty on first start,
    // a password is generated and printed once in the server log.
    seedUsers: [
      user('ADMIN1', 'admin', 'admin1@daralbunyan.ae', 'Administrator 1'),
      user('ADMIN2', 'admin', 'admin2@daralbunyan.ae', 'Administrator 2'),
      user('OPS', 'operations', 'operations@daralbunyan.ae', 'Operations'),
    ],
    // Excel file imported automatically on first start when the database is empty (optional).
    importFile: env.IMPORT_FILE || './data/import/Expenses_Report.xlsx',
    // 'stripe' for real card payments, 'mock' for the built-in demo checkout
    paymentProvider: (env.PAYMENT_PROVIDER || 'mock').toLowerCase(),
    stripe: { secretKey: env.STRIPE_SECRET_KEY || '', webhookSecret: env.STRIPE_WEBHOOK_SECRET || '' },
    smtp: {
      host: (env.SMTP_HOST || '').trim(),
      port: Number(env.SMTP_PORT) || 587,
      secure: env.SMTP_SECURE === 'true', // true = implicit TLS (port 465)
      user: (env.SMTP_USER || '').trim(), // e.g. ananader1@gmail.com with SMTP_HOST=smtp.gmail.com
      pass: (env.SMTP_PASS || '').replace(/\s+/g, ''), // Gmail app passwords are shown with spaces
      from: env.SMTP_FROM || '',
      rejectUnauthorized: env.SMTP_REJECT_UNAUTHORIZED !== 'false',
    },
    // Google Drive for attachments (OAuth client + refresh token of the Google account, see README).
    // Without these, attachments are kept on the server disk.
    drive: {
      clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
      refreshToken: (env.GOOGLE_REFRESH_TOKEN || '').trim(),
      folderId: (env.GOOGLE_DRIVE_FOLDER_ID || '').trim(), // optional: put all files in this folder
    },
    uploadDir: env.UPLOAD_DIR || '',
    disableRateLimit: env.DISABLE_RATE_LIMIT === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
  };
}

export function validateConfig(cfg) {
  const problems = [];
  if (cfg.paymentProvider !== 'mock' && cfg.paymentProvider !== 'stripe') problems.push(`PAYMENT_PROVIDER must be "stripe" or "mock" (got "${cfg.paymentProvider}")`);
  if (cfg.paymentProvider === 'stripe' && !cfg.stripe.secretKey) problems.push('STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe');
  const emails = cfg.seedUsers.map((u) => u.email);
  if (new Set(emails).size !== emails.length) problems.push('ADMIN1_EMAIL, ADMIN2_EMAIL and OPS_EMAIL must be different');
  return problems;
}
