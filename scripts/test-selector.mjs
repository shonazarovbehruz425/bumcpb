import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function runTest() {
  console.log('--- LIVE DOM INSPECTOR START ---');
  let browser;
  try {
    console.log('Connecting via CDP to port 9222...');
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  } catch (e) {
    console.log('CDP connection failed, launching fresh headless Chromium...');
    browser = await chromium.launch({ headless: true });
  }

  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  const targetUrl = 'https://labs.google/fx/ru/tools/flow/project/7401dff5-f325-4ec2-90e0-4639a6d7d5ff';
  console.log(`Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

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
