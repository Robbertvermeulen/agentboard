// Register + login round trip with a CDP virtual authenticator. Usage:
//   node verify-auth-browser.mjs <base url> <enrol url>
// Exits non-zero on the first deviation. Needs `npx playwright install chromium` once.
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const [base, enrolUrl] = process.argv.slice(2);
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

// 1. Enrol: open the link, register, land on the board.
await page.goto(enrolUrl);
await page.getByRole('button', { name: 'Register this device' }).click();
// Scoped to #sidebar: the auth views render their own .side-logo (shared
// logo mark) too, which would match immediately and defeat the wait.
await page.waitForSelector('#sidebar .side-logo', { timeout: 15000 }).catch(() => fail('board did not render after enrol'));
const boards = await page.evaluate(() => fetch('/api/boards').then((r) => r.status));
if (boards !== 200) fail('api after enrol: ' + boards);

// 2. Sign out → 401 → login view.
await page.click('#side-signout');
await page.waitForSelector('#login-btn', { timeout: 15000 }).catch(() => fail('login view did not render after sign out'));
const after = await page.evaluate(() => fetch('/api/boards').then((r) => r.status));
if (after !== 401) fail('api after sign out: ' + after);

// 3. One-click login with the discoverable credential.
await page.click('#login-btn');
await page.waitForSelector('#sidebar .side-logo', { timeout: 15000 }).catch(() => fail('board did not render after login'));
const again = await page.evaluate(() => fetch('/api/boards').then((r) => r.status));
if (again !== 200) fail('api after login: ' + again);

// 4. Rolling cookie: backdate last_seen_at past the once-a-day throttle,
// then confirm an authenticated request re-issues ab_session with a fresh
// Max-Age, and that the throttle holds on the very next request.
const db = new Database(process.env.AGENTBOARD_DATA + '/board.db');
db.prepare("UPDATE auth_session SET last_seen_at = '2020-01-01T00:00:00Z'").run();
db.close();

const reissuesCookie = (res) =>
  res.headersArray().some((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('ab_session='));

const res1 = await context.request.get(base + '/api/boards');
if (!reissuesCookie(res1)) fail('session cookie was not re-issued after touch');

const res2 = await context.request.get(base + '/api/boards');
if (reissuesCookie(res2)) fail('session cookie was re-issued again — throttle not respected');

await browser.close();
console.log('browser round trip ok');
