#!/usr/bin/env node
// Discover how Flow links each generated IMAGE to its PROMPT text in the DOM.
// Needed to correlate results when several prompts are generated concurrently.
// Run: node scripts/discover-results.mjs
import { launchChromeDirect, closeBrowser, getPage } from '../src/browser/connect.js';
import { navigateToFlow } from '../src/browser/launch-profile.js';
import { ensureProjectInContext } from '../src/navigation/project-navigator.js';
import { takeScreenshot } from '../src/utils/screenshots.js';

async function main() {
  const { page } = await launchChromeDirect({ headless: true });
  await navigateToFlow(page);
  await ensureProjectInContext(page, { name: 'Discover', campaign: 'api' });
  await page.waitForTimeout(3500);

  const data = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().substring(0, 160);
    const out = [];
    const imgs = Array.from(document.querySelectorAll('img'));
    imgs.forEach((img) => {
      const src = img.src || '';
      const m = src.match(/media\.getMediaUrlRedirect\?name=([a-f0-9-]+)/);
      if (!m || img.width < 100) return;

      // Walk up parents, collect any aria-label/title/text that could be the prompt.
      const attrs = [];
      let el = img;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const al = el.getAttribute && el.getAttribute('aria-label');
        const ti = el.getAttribute && el.getAttribute('title');
        const dp = el.getAttribute && el.getAttribute('data-prompt');
        if (al) attrs.push('aria=' + clean(al));
        if (ti) attrs.push('title=' + clean(ti));
        if (dp) attrs.push('data-prompt=' + clean(dp));
      }
      // Nearest reasonably-sized container's visible text.
      let container = img;
      for (let i = 0; i < 8 && container.parentElement; i++) {
        container = container.parentElement;
        const t = clean(container.textContent);
        if (t.length > 15) { break; }
      }
      out.push({
        uuid: m[1],
        alt: clean(img.alt),
        titleImg: clean(img.title),
        ariaImg: clean(img.getAttribute('aria-label')),
        parentAttrs: attrs.slice(0, 8),
        containerText: clean(container.textContent),
      });
    });
    return out.slice(0, 10);
  }).catch((e) => ({ error: e.message }));

  console.log('==================== IMAGE ↔ PROMPT ====================');
  console.log(JSON.stringify(data, null, 2));
  console.log('========================================================');
  try { await takeScreenshot(getPage(), 'discover-results'); } catch {}
  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => { console.error('ERROR:', e.message); try { await closeBrowser(); } catch {}; process.exit(1); });
