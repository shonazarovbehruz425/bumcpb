import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolveChromePath } from '../src/utils/paths.js';

async function runTest() {
  console.log('--- LIVE DOM INSPECTOR START ---');

  const profileDir = path.resolve(process.cwd(), 'chrome-profile-kiara');
  console.log('Using persistent user data dir:', profileDir);

  const chromeBin = resolveChromePath();
  console.log('Resolved Chrome binary path:', chromeBin);
  const cdpPort = 9222;

  console.log('Launching Chrome directly via spawn with DISPLAY=:1 and anti-detection flags...');
  const child = spawn(chromeBin, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox'
  ], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' } });
  child.unref();

  await new Promise(r => setTimeout(r, 4000));

  console.log('Connecting via CDP...');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  const targetUrl = 'https://labs.google/fx/ru/tools/flow/project/7401dff5-f325-4ec2-90e0-4639a6d7d5ff';
  console.log(`Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  console.log('Current Page URL:', page.url());
  console.log('Current Page Title:', await page.title());

  const domInfo = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]')].map(el => ({
      tag: el.tagName,
      id: el.id,
      className: el.className,
      placeholder: el.getAttribute('placeholder') || '',
      role: el.getAttribute('role') || '',
      contenteditable: el.getAttribute('contenteditable') || '',
      innerText: (el.innerText || '').substring(0, 50),
      isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
    }));

    const buttons = [...document.querySelectorAll('button, a[role="button"]')].map(el => ({
      tag: el.tagName,
      text: (el.textContent || '').trim().substring(0, 50),
      ariaLabel: el.getAttribute('aria-label') || '',
      isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
    })).filter(b => b.isVisible);

    return { inputs, buttonsCount: buttons.length, buttonsSample: buttons.slice(0, 15) };
  });

  console.log('\n--- INPUTS / TEXTAREAS / COMPOSERS FOUND ---');
  console.dir(domInfo.inputs, { depth: null });

  console.log('\n--- VISIBLE BUTTONS SAMPLE ---');
  console.dir(domInfo.buttonsSample, { depth: null });

  const screenshotPath = path.resolve('outputs/live-dom-test.png');
  fs.mkdirSync('outputs', { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`\nScreenshot saved to: ${screenshotPath}`);

  console.log('--- LIVE DOM INSPECTOR END ---');
  process.exit(0);
}

runTest().catch(err => {
  console.error('Inspector failed:', err);
  process.exit(1);
});
