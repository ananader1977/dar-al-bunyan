# Dar Al Bunyan Technical Services: Quotations, Invoices & Profit Sharing

A simple web app for Dar Al Bunyan Technical Services L.L.C. It replaces Zoho Creator.

- **One-form quotations:** the customer, products and services, discount, terms and LPO all go in one page. New customers and new products are saved automatically.
- **Approval workflow:** Operations creates a quotation and submits it; the owner approves it or returns it with a comment. Every step is emailed. After approval the quotation can be emailed to the customer as a PDF.
- **Revenue, cost and margin:** shown live on every line and quotation, with an internal unit cost that is never printed.
- **Tax invoices and credit notes (PDF):** invoices are created from a quotation with continuous numbering (`DABTS/82/26`, …). Once an invoice is emailed or paid it is final: to cancel it, issue a **tax credit note** (`DABTS/CN/1/26`, …) with its own PDF.
- **Customer payments:** a job's profit is shared only after the customer has paid (on the invoice, or "Customer paid" on jobs without an invoice).
- **Expenses:** job costs and other expenses. Expenses entered by Operations wait for the owner's approval before they count.
- **Financial report:** revenue (in the month of the invoice), costs, profit, what is waiting for customer payment, and the **60/40 profit sharing** (Mohamed / Ramdas), by month, by cost type and per job, with an Excel export.
- **Partners page:** what each partner has earned, what was already paid out and what is still owed; personal loans.
- **Approvals page (owner):** quotations and expenses waiting for approval.
- **Trash and activity log (owner):** deleted records can be restored for 30 days; every important action is logged with who and when.
- **Automatic daily backups:** to Google Drive (when connected) and the server disk; "Back up now" and downloads under Settings.
- **Weekly reminder email:** every Monday 8:00 (Dubai) to everyone: approvals waiting, quotations without an answer, jobs not invoiced, overdue invoices and partner balances.
- **Excel export on every page**, following the filters you set on that page.
- **Attachments in Google Drive:** LPOs, receipts, photos and drawings on quotations, invoices and expenses (📎 button, or paste a Drive link).
- **Phone friendly:** on a phone, lists show one card per row.
- **Email through Gmail**, **online payment** (demo now, Stripe later) and **Excel import** of the Zoho `Expenses_Report.xlsx`.

It needs Node.js 22.13 or later and has no npm packages. It uses the built-in SQLite database and the same design as the Consultancy app, in Dar Al Bunyan navy and red.

## Roles

There are two roles: the **owner** (shown as "Owner"; `admin` in the settings) and **Operations**.

| | Owner | Operations |
|---|---|---|
| Quotations: create, edit, submit, send, accepted / declined | ✓ | ✓ |
| Approve or return quotations | ✓ | |
| Invoices: create, email, customer paid, credit notes | ✓ | ✓ |
| Expenses: add and edit | ✓ (counted at once) | ✓ (wait for approval) |
| Approve or return expenses | ✓ | |
| Financial report, Partners page (record payments and loans), customers, products, messages, Excel exports | ✓ | ✓ |
| Delete anything (goes to the Trash) | ✓ | |
| Users, settings, import, backups, weekly email, Trash and activity log | ✓ | |

Users cannot be deleted: to stop someone signing in, untick "Active".

### Deleting and the Trash

The owner has a 🗑 button on the lists and a Delete button on each record. Deleted records go to **Activity & Trash → Trash** and can be restored for 30 days; after that they are removed for good, with their files.

- **Quotation:** its invoice and all expenses linked to it go with it.
- **Customer:** if it has quotations or invoices, the confirmation says how many, and they go with it.
- **Product:** quotations that used it keep their lines.
- **Invoices that were emailed or paid** (and credited ones) cannot be deleted: UAE VAT rules require a credit note instead. Their quotation cannot be deleted either.

## Quick start (your computer)

```bash
cp .env.example .env      # then fill in the passwords (or export the variables)
npm start                 # http://localhost:3000
npm test                  # automated tests
```

Three accounts are created on the first start from `ADMIN1_*`, `ADMIN2_*` and `OPS_*`. If a password is left empty, one is generated and printed once in the server log.

Import your data in the app under **Settings → Import Excel file**, or from the command line with `npm run import -- Expenses_Report.xlsx`. Importing the same file again skips rows that were already imported.

## Put it online (Render)

1. Push this repository to GitHub. Keep it **private**, because it is company software.
2. In Render, go to **New → Blueprint** and pick the repository. `render.yaml` sets everything up, with a 1 GB disk for the database and uploads on the Starter plan.
3. Fill in these settings:
   - `BASE_URL`: for example `https://dar-al-bunyan.onrender.com`
   - `ADMIN1_PASSWORD`, `ADMIN2_EMAIL`, `ADMIN2_PASSWORD`, `OPS_EMAIL`, `OPS_PASSWORD`
   - `SMTP_PASS` (see Gmail below)
4. Open the site and sign in. Then go to **Settings**, fill in the TRN and bank details, and **Import** your Excel file.

When a `*_PASSWORD` variable is set, that account's password is reset to it on every restart. To let users keep a password they changed in the app, delete the variable in Render after the first sign-in.

## Gmail (ananader1@gmail.com)

1. Google Account → Security → turn on **2-Step Verification**.
2. Google Account → Security → **App passwords** → create one called "Dar Al Bunyan app".
3. Put the 16 letters in `SMTP_PASS`. The other settings are already in `render.yaml` (`smtp.gmail.com`, port 587, `ananader1@gmail.com`).
4. In the app go to **Settings → Send me a test email**.

To change the sender to another Gmail account later, change `SMTP_USER` and `SMTP_FROM` and create a new app password for that account. Gmail limits a normal account to about 500 emails a day.

## Google Drive for attachments

Without these settings, files are stored on the server disk and everything still works.

1. Go to <https://console.cloud.google.com>, create a project, then go to **APIs & Services → Library** and enable the **Google Drive API**.
2. Go to **OAuth consent screen**: choose External, give the app a name, add `ananader1@gmail.com` as a test user, and **Publish** the app. While it stays in "Testing", the refresh token expires after 7 days.
3. Go to **Credentials → Create credentials → OAuth client ID** and choose type **Desktop app**. Copy the client ID and secret.
4. On your computer run:
   `GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google-auth`
   Open the link, sign in with ananader1@gmail.com and allow access. Copy the printed `GOOGLE_REFRESH_TOKEN`.
5. In Render, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN`. Optionally set `GOOGLE_DRIVE_FOLDER_ID`, the last part of a Drive folder's link, to keep all files in one folder.

The app only asks for the `drive.file` permission, so it can only see the files it uploaded itself, not the rest of your Drive.

## Online payments (later)

The app starts with `PAYMENT_PROVIDER=mock`. While in demo mode, customers do **not** get a payment link in the invoice email or PDF, so nobody can "pay" with the demo card. Administrators can try the flow with **Test online payment (demo)** on an invoice.

To go live with Stripe:

1. Set `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
2. Add a webhook at `BASE_URL/api/webhooks/stripe` for the event `checkout.session.completed`.

Invoice emails will then include a **Pay online** button, and paid invoices are marked automatically.

## How the financial report counts

- **Revenue:** the net amount, before VAT, of quotations marked **accepted**, placed in the month of the invoice date (or the acceptance date while there is no invoice).
- **Costs:** approved expenses (material for jobs and other expenses), dated by the paid-on date.
- **Profit earned:** revenue minus costs.
- **Profit to share now:** only jobs the customer has paid: their revenue minus their costs minus all other expenses. Jobs not paid yet are shown as "waiting for customer payment".
- **The partners' deal:**
  - All costs come off the revenue first and are paid back to Mohamed.
  - The profit left is split by the partner shares in Settings, 60% Mohamed / 40% Ramdas.
  - **Personal loans** (Partners page) are not company costs: they are deducted from Ramdas's share and paid back to Mohamed.
  - **Declined jobs** earn nothing; their costs are carried by Mohamed alone (not shared, not paid back). The report shows the amount.
  - The "Profit sharing check" shows that profit − 60% − 40% leaves 0.00, and "Who receives what" adds up to the revenue received.
- **Partners page:** total earned so far (all time) minus the payments recorded = what is still owed to each partner.

## Backups

- Every night after 2:00 (Dubai) the app copies the whole database: to **Google Drive** when it is connected (30 copies kept) and to the server disk next to the database (14 copies kept).
- **Settings → Backups** shows the latest copies, with **Back up now** and **Download**.
- Connect Google Drive (above): a copy only on the server disk does not protect you if the server's disk is lost.
- To restore, stop the service and replace the database file (`DB_PATH`) with a downloaded backup; or ask for help.
- You can also download **Settings → Export all data to Excel** at any time.
