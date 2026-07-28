#!/usr/bin/env node
// Cross-platform Chrome launcher with CDP debugging (Windows / Linux / macOS).
// Launches Chrome using the configured profile so the MCP server can attach.
//
// Usage:
//   node scripts/start-browser.mjs            # visible window (for login)
//   HEADLESS=1 node scripts/start-browser.mjs # headless (for servers)
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { resolveChromePath, resolveProfileSource } from '../src/utils/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const configPath = path.join(PROJECT_ROOT, 'config', 'flow.config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    console.error(`[start-browser] Could not read ${configPath}: ${e.message}`);
    console.error('[start-browser] Run "npm run setup" first.');
    process.exit(1);
  }
}

function main() {
  const cfg = loadConfig();
  const cdpPort = cfg.cdpPort || 9222;
  const userDataDir = cfg.chromeUserDataDir;
  const profile = cfg.chromeProfile || 'Default';

  let chromePath;
  try {
    chromePath = resolveChromePath(cfg.chromePath);
  } catch (e) {
    console.error(`[start-browser] ${e.message}`);
    process.exit(1);
  }

  const profileSource = resolveProfileSource(userDataDir, profile);
  if (!userDataDir || !fs.existsSync(profileSource)) {
    console.warn(`[start-browser] Profile "${profile}" not found at ${profileSource}.`);
    console.warn('[start-browser] Make sure you have logged into Google in that profile at least once.');
  }

  const headless = process.env.HEADLESS === '1' || cfg.headless === true;

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profile}`,
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
  ];
  if (headless) args.push('--headless=new');
  if (process.platform === 'linux') {
    // Common flags needed on headless/root Linux servers.
    args.push('--no-sandbox', '--disable-dev-shm-usage');
  }

  console.log(`[start-browser] Launching Chrome (profile "${profile}", CDP port ${cdpPort}, headless=${headless})`);
  console.log(`[start-browser] Chrome: ${chromePath}`);

  const child = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
  child.unref();

  console.log(`[start-browser] Chrome started (pid ${child.pid}). CDP: http://127.0.0.1:${cdpPort}`);
}

main();
