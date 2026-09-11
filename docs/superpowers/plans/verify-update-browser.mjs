// Clicks through the update dialog. Usage: node verify-update-browser.mjs <base url> <expected version>
import { chromium } from 'playwright';

const [base, version] = process.argv.slice(2);
const fail = (m) => { console.error('FAIL: ' + m); process.exit(1); };
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + '/#/');
await page.waitForSelector('#side-version', { timeout: 15000 }).catch(() => fail('no version in sidebar'));
const text = await page.textContent('#side-version');
if (!text.includes(version + ' available')) fail('sidebar must announce the update, got: ' + text);
await page.click('#side-version button');
await page.waitForSelector('#update-ok', { timeout: 5000 }).catch(() => fail('update dialog did not open'));
await page.click('#update-ok');
await page.waitForFunction(() => /Updating/.test(document.querySelector('.dialog-sub')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => fail('dialog did not switch to Updating'));
await browser.close();
console.log('update dialog ok');
