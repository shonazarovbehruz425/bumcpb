import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config', 'flow.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Keep only first account
if (config.accounts && config.accounts.length > 0) {
  config.accounts = [config.accounts[0]];
  console.log('✅ Config updated - using single account:', config.accounts[0].account);
} else {
  console.log('⚠️  No accounts found in config');
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Config saved!');
