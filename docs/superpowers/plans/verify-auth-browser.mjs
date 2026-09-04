// Register + login round trip with a CDP virtual authenticator. Usage:
//   node verify-auth-browser.mjs <base url> <enrol url>
// Exits non-zero on the first deviation. Needs `npx playwright install chromium` once.
import { chromium } from 'playwright';

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

await browser.close();
console.log('browser round trip ok');
