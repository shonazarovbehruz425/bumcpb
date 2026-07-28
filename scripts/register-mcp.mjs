#!/usr/bin/env node
// Register this MCP server with an AI client (Claude Desktop by default).
// - Auto-fills the absolute path to src/index.js
// - Backs up the existing client config before editing
// - Prints a copy-paste snippet for any other MCP client
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'src', 'index.js');
const SERVER_KEY = 'google-flow';

const serverEntry = {
  command: 'node',
  args: [SERVER_ENTRY],
};

function claudeConfigPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Claude', 'claude_desktop_config.json');
}

function printSnippet() {
  const snippet = {
    mcpServers: {
      [SERVER_KEY]: serverEntry,
    },
  };
  console.log('');
  console.log('Copy-paste this into your MCP client config (Claude Desktop, etc.):');
  console.log('------------------------------------------------------------------');
  console.log(JSON.stringify(snippet, null, 2));
  console.log('------------------------------------------------------------------');
}

function main() {
  const cfgPath = claudeConfigPath();
  const cfgDir = path.dirname(cfgPath);

  try {
    fs.mkdirSync(cfgDir, { recursive: true });

    let config = {};
    if (fs.existsSync(cfgPath)) {
      // Back up before editing (safety-first).
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${cfgPath}.backup-${stamp}`;
      fs.copyFileSync(cfgPath, backup);
      console.log(`[register] Backup saved: ${backup}`);
      try {
        config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) || {};
      } catch {
        console.warn('[register] Existing config was not valid JSON; starting fresh.');
        config = {};
      }
    } else {
      console.log('[register] No Claude Desktop config found — creating a new one.');
    }

    config.mcpServers = config.mcpServers || {};
    config.mcpServers[SERVER_KEY] = serverEntry;

    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`[register] Registered "${SERVER_KEY}" in ${cfgPath}`);
    console.log(`[register] Server: node ${SERVER_ENTRY}`);
    console.log('[register] Restart Claude Desktop for the change to take effect.');
  } catch (e) {
    console.warn(`[register] Could not auto-register (${e.message}).`);
    console.warn('[register] Use the manual snippet below instead.');
  }

  printSnippet();
}

main();
