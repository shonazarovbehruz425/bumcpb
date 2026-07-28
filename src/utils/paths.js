import os from 'os';
import path from 'path';
import fs from 'fs';
import { FlowError, ErrorCodes } from './errors.js';

/**
 * Cross-platform home directory (replaces process.env.HOME).
 */
export function getHomeDir() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME;
}

/**
 * Standard Windows Chrome install locations, in priority order.
 */
export function windowsChromeCandidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env['LOCALAPPDATA'] || path.join(getHomeDir(), 'AppData', 'Local');
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
}

/**
 * Standard Linux Chrome/Chromium install locations, in priority order.
 */
export function linuxChromeCandidates() {
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
}

/**
 * Standard macOS Chrome install locations, in priority order.
 */
export function macChromeCandidates() {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(getHomeDir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ];
}

/**
 * Chrome install candidates for the current platform, in priority order.
 */
export function chromeCandidates() {
  if (process.platform === 'win32') return windowsChromeCandidates();
  if (process.platform === 'darwin') return macChromeCandidates();
  return linuxChromeCandidates();
}

/**
 * Resolve the Chrome executable path.
 * Config value wins when it points to an existing file; otherwise the first
 * existing standard install candidate; otherwise throws.
 */
export function resolveChromePath(chromePathFromConfig) {
  if (chromePathFromConfig && fs.existsSync(chromePathFromConfig)) {
    return chromePathFromConfig;
  }
  const found = chromeCandidates().find((p) => fs.existsSync(p));
  if (found) return found;
  const hint = process.platform === 'win32' ? 'chrome.exe' : 'the chrome/chromium binary';
  throw new FlowError(
    ErrorCodes.INVALID_PARAMS,
    `Chrome executable not found. Set "chromePath" in config/flow.config.json to the full path of ${hint}.`
  );
}

/**
 * Default Chrome user data directory for the current platform.
 */
export function defaultUserDataDir() {
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

/**
 * Compose the profile source directory from the user data dir and profile name.
 */
export function resolveProfileSource(userDataDir, profile) {
  return path.join(userDataDir, profile);
}

/**
 * Create a unique temp profile directory path under the OS temp dir.
 */
export function makeTempProfileDir() {
  return path.join(os.tmpdir(), `chrome-kiara-cdp-${Date.now()}`);
}
