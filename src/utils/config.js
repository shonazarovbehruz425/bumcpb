import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FLOW_HOME = path.resolve(__dirname, '..', '..');
const configPath = path.join(FLOW_HOME, 'config', 'flow.config.json');

// Load config fresh on every read to avoid stale cache issues
function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[CONFIG] Failed to load config from ${configPath}: ${err.message}`);
    return {};
  }
}

// Initial load for default export compatibility
let config = loadConfig();

export default config;

export function get(key, fallback = undefined) {
  // Reload config on every get() call to ensure fresh values
  const freshConfig = loadConfig();
  return freshConfig[key] !== undefined ? freshConfig[key] : fallback;
}

export function getFlowHome() {
  const freshConfig = loadConfig();
  return freshConfig.flowHome || FLOW_HOME;
}
