#!/usr/bin/env node
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const configDir = path.join(PROJECT_ROOT, 'config');
const configPath = path.join(configDir, 'flow.config.json');
const examplePath = path.join(configDir, 'flow.config.example.json');

const EMAIL_PLACEHOLDER = '<enter-your-google-email>';

function log(msg) {
  console.log(`[setup] ${msg}`);
}
function warn(msg) {
  console.warn(`[setup] WARNING: ${msg}`);
}

function getHomeDir() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME;
}

function chromeCandidates() {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || path.join(getHomeDir(), 'AppData', 'Local');
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
}

function detectChromePath() {
  const found = chromeCandidates().find((p) => fs.existsSync(p));
  return found || null;
}

function detectUserDataDir() {
  const home = getHomeDir();
  if (process.platform === 'win32') {
    const lad = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return path.join(lad, 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(home, '.config', 'google-chrome');
}

function enumerateProfiles(userDataDir) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return [];
  try {
    return fs
      .readdirSync(userDataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => name === 'Default' || /^Profile \d+$/.test(name));
  } catch {
    return [];
  }
}

function main() {
  // Req 2.6: preserve existing config, never overwrite user values.
  if (fs.existsSync(configPath)) {
    log(`Existing config found at ${configPath} — leaving it untouched.`);
    try {
      const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      log(`  expectedAccount   : ${current.expectedAccount ?? '(unset)'}`);
      log(`  chromePath        : ${current.chromePath ?? '(unset)'}`);
      log(`  chromeUserDataDir : ${current.chromeUserDataDir ?? '(unset)'}`);
      log(`  chromeProfile     : ${current.chromeProfile ?? '(unset)'}`);
    } catch (e) {
      warn(`Could not parse existing config: ${e.message}`);
    }
    printNextSteps();
    return;
  }

  // Base object from the example template.
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
  } catch (e) {
    warn(`Could not read example config (${e.message}); starting from an empty config.`);
  }

  // Auto-detect environment values (non-fatal on failure).
  const userDataDir = detectUserDataDir();
  const chromePath = detectChromePath();
  const profiles = enumerateProfiles(userDataDir);

  base.chromeUserDataDir = userDataDir;
  if (chromePath) {
    base.chromePath = chromePath;
    log(`Detected Chrome: ${chromePath}`);
  } else {
    base.chromePath = '';
    warn('Chrome executable not found in standard locations. Set "chromePath" manually.');
  }

  if (profiles.length > 0) {
    base.chromeProfile = profiles[0];
    log(`Detected Chrome profiles: ${profiles.join(', ')} (using "${profiles[0]}")`);
  } else {
    warn('No Chrome profiles detected. Keeping default "chromeProfile". Adjust if needed.');
  }

  // Req 2.5: leave the account as a placeholder for the user.
  base.expectedAccount = EMAIL_PLACEHOLDER;

  fs.writeFileSync(configPath, JSON.stringify(base, null, 2) + '\n', 'utf-8');
  log(`Wrote ${configPath}`);
  printNextSteps();
}

function printNextSteps() {
  const isWin = process.platform === 'win32';
  console.log('');
  console.log('==================================================================');
  console.log(' Setup complete. Final step:');
  console.log('==================================================================');
  console.log(` 1. Open: config${path.sep}flow.config.json`);
  console.log(` 2. Set "expectedAccount" to your Google email (replace "${EMAIL_PLACEHOLDER}").`);
  if (isWin) {
    console.log(' 3. Start the browser:  scripts\\start-browser.cmd');
    console.log(' 4. Start the server :  npm start   (or scripts\\start-mcp.cmd)');
  } else {
    console.log(' 3. Start the browser:  npm run start-browser');
    console.log(' 4. Start the server :  npm start');
  }
  console.log('==================================================================');
}

main();
