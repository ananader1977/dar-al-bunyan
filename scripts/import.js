// Imports the Zoho "Expenses_Report" Excel file into the database from the command line:
//   npm run import -- ./Expenses_Report.xlsx
// (The same import is available in the app under Settings > Import Excel file.)
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/app.js';
import { importExpensesReport } from '../src/importer.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: npm run import -- path/to/Expenses_Report.xlsx'); process.exit(1); }
const ctx = createContext({ config: { ...loadConfig(), importFile: '' } });
console.log(importExpensesReport(ctx, fs.readFileSync(file)));
