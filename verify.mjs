/**
 * End-to-end check in a real browser: the WASM parser loads, a contract is
 * analysed live, and the report reacts to editing.
 *
 *   node verify.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 8099;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 600));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

// Google Fonts is unreachable from some sandboxes; the fallback stacks cover it.
const IGNORE = /ERR_TUNNEL_CONNECTION_FAILED|fonts\.(googleapis|gstatic)\.com/;
const errors = [];
page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });
page.on('pageerror', e => { if (!IGNORE.test(e.message)) errors.push('pageerror: ' + e.message); });

let ok = true;
const check = async (label, fn) => {
  let v;
  try { v = await fn(); } catch (e) { v = false; console.log(`      ${e.message.split('\n')[0]}`); }
  console.log(`${v ? 'PASS' : 'FAIL'}  ${label}${typeof v === 'string' ? ' — ' + v : ''}`);
  if (!v) ok = false;
};

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

// The whole point: WebAssembly must load and analyse without a server.
await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Analysed'), null, { timeout: 20000 });
await check('WASM parser loads and analyses on open', async () =>
  (await page.locator('#status').innerText()));

await check('page opens on a real contract, already analysed', async () =>
  (await page.locator('#source').inputValue()).includes('DataKey::Seq'));
await check('report is visible at rest', async () => !(await page.locator('#report').isHidden()));
await check('verdict states the finding', async () =>
  (await page.locator('#verdict').innerText()).includes('critical'));
await check('findings rendered with source context', async () => {
  const f = await page.locator('.finding').count();
  const hits = await page.locator('pre.code .ln.hit').count();
  return f > 0 && hits > 0 && `${f} findings, ${hits} highlighted lines`; });
await check('graph draws one circle and one label per entry point', async () => {
  const c = await page.locator('#graph circle.node').count();
  const l = await page.locator('#graph text.label').count();
  return c > 0 && c === l && `${c} entry points`; });
await check('self-conflict is explained', async () =>
  (await page.locator('#graph-note').innerText()).includes('itself'));

// Editing must re-analyse. Fix the counter and the critical finding must go.
const fixed = `#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};
#[contracttype]
#[derive(Clone)]
pub enum DataKey { Admin, Job(Address) }
#[contract]
pub struct Fixed;
#[contractimpl]
impl Fixed {
    pub fn create_job(env: Env, owner: Address) {
        owner.require_auth();
        env.storage().persistent().set(&DataKey::Job(owner), &1u64);
    }
}`;
await page.locator('#source').fill(fixed);
await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Analysed'), null, { timeout: 10000 });
await check('editing re-runs the analysis', async () => {
  const crit = await page.locator('.finding.critical').count();
  const verdict = await page.locator('#verdict').innerText();
  return crit === 0 && verdict.includes('No conflicts') && 'counter removed, verdict now clean'; });
await check('clean contract retitles the graph', async () =>
  (await page.locator('#graph-title').innerText()).toLowerCase().includes('all independent'));

// Example buttons load and re-analyse.
await page.locator('.example', { hasText: 'Instance storage' }).click();
await page.waitForFunction(() => document.getElementById('source').value.includes('InstanceTrap'), null, { timeout: 10000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Analysed'), null, { timeout: 10000 });
await check('example button loads and analyses', async () => {
  const n = await page.locator('.finding.critical').count();
  return n === 2 && `${n} critical findings`; });

await check('severity filter works', async () => {
  const before = await page.locator('.finding').count();
  await page.locator('.chip.critical').click();
  await page.waitForTimeout(150);
  const after = await page.locator('.finding').count();
  await page.locator('.chip.critical').click();
  return after < before && `${before} -> ${after}`; });

await check('remediation opens', async () => {
  await page.locator('.finding details summary').first().click();
  return (await page.locator('.finding details pre.fix').first().innerText()).length > 80; });

// Broken input must degrade, not explode.
await page.locator('#source').fill('#[contractimpl]\nimpl A { pub fn f(env: Env) { env.storage().');
await page.waitForTimeout(600);
await check('half-typed source does not break the page', async () =>
  !(await page.locator('#err').isVisible()) || !(await page.locator('#err').innerText()).includes('Analysis failed'));

// Download produces a valid report.
await page.locator('.example', { hasText: 'Sequence counter' }).click();
await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Analysed'), null, { timeout: 10000 });
const dl = page.waitForEvent('download');
await page.locator('#download').click();
const download = await dl;
await check('download emits a valid report', async () => {
  const stream = await download.createReadStream();
  let body = '';
  for await (const chunk of stream) body += chunk;
  const parsed = JSON.parse(body);
  return parsed.schema_version === 1 && parsed.findings.length > 0
    && `${download.suggestedFilename()}, ${parsed.findings.length} findings`; });

await page.screenshot({ path: '/mnt/user-data/outputs/braid-web.png' });
await page.setViewportSize({ width: 430, height: 900 });
await page.waitForTimeout(400);
await page.screenshot({ path: '/mnt/user-data/outputs/braid-web-mobile.png' });

console.log(errors.length ? '\nCONSOLE ERRORS:\n' + errors.join('\n') : '\nNo console errors.');
await browser.close();
server.kill();
process.exit(ok && errors.length === 0 ? 0 : 1);
