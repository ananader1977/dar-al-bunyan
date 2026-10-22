// One-time helper: connects the app to Google Drive and prints the refresh token.
// 1. In Google Cloud Console create an OAuth client of type "Desktop app" (see README).
// 2. Run:  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google-auth
// 3. Open the printed link, sign in with the Gmail account (e.g. ananader1@gmail.com) and allow access.
// 4. Copy the printed GOOGLE_REFRESH_TOKEN into the hosting dashboard.
import http from 'node:http';

const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) { console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.'); process.exit(1); }
const port = Number(process.env.PORT) || 5179;
const redirect = `http://127.0.0.1:${port}/callback`;
const scope = 'https://www.googleapis.com/auth/drive.file';
const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent' })}`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
  const code = u.searchParams.get('code');
  if (!code) { res.end(`Google returned: ${u.searchParams.get('error') || 'no code'}`); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const data = await r.json();
  if (!data.refresh_token) { res.end('No refresh token received. Remove the app at myaccount.google.com/permissions and run this again.'); console.error(data); return; }
  res.end('Done. Go back to the terminal and copy the refresh token.');
  console.log('\nGOOGLE_REFRESH_TOKEN=' + data.refresh_token + '\n');
  server.close();
});
server.listen(port, '127.0.0.1', () => console.log(`Open this link in your browser and sign in with your Google account:\n\n${url}\n`));
