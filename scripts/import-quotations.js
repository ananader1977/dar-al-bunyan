// Imports a Quotations Excel sheet from the command line (a preview unless --apply is given):
//   npm run import-quotations -- ./Quotations-2026-11-21.xlsx            (preview, nothing is saved)
//   npm run import-quotations -- ./Quotations-2026-11-21.xlsx --apply    (saves)
// The same import is available in the app under Settings > Import Excel file.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/app.js';
import { importQuotationsSheet } from '../src/importer.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: npm run import-quotations -- path/to/Quotations.xlsx [--apply]'); process.exit(1); }
const apply = process.argv.includes('--apply');
const ctx = createContext({ config: { ...loadConfig(), importFile: '' } });
console.log(JSON.stringify(importQuotationsSheet(ctx, fs.readFileSync(file), null, { dry: !apply }), null, 2));
if (!apply) console.log('\nPreview only. Add --apply to save.');
