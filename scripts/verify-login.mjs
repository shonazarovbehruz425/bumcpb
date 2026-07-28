#!/usr/bin/env node
// Verify that the configured Chrome profile is logged into Google Flow.
// Launches Chrome headless, navigates to Flow, reports whether the session
// is authenticated. Does NOT generate anything (no credits used).
import { launchChromeDirect, closeBrowser } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';

async function main() {
  console.log('[verify] Launching Chrome (headless) with your profile...');
  const { page } = await launchChromeDirect({ headless: true });

  console.log('[verify] Navigating to Google Flow...');
  const res = await navigateToFlow(page);

  const url = page.url();
  console.log('');
  console.log('==================================================');
  console.log(' URL          :', url);
  console.log(' Authenticated:', res.authenticated);
  if (res.authenticated) {
    console.log(' RESULT       : LOGGED IN — session works headless!');
  } else {
    console.log(' RESULT       : NOT logged in (redirected to sign-in).');
    console.log('                Re-login in VNC with: google-chrome --password-store=basic');
  }
  console.log('==================================================');

  try { await page.screenshot({ path: 'login-check.png' }); console.log('[verify] Screenshot: login-check.png'); } catch {}

  await closeBrowser();
  process.exit(res.authenticated ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify] Error:', e.message);
  process.exit(2);
});
