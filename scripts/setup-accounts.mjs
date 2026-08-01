import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config', 'flow.config.json');

try {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  c.accounts = [
    {
      account: 'behruzyuldoshev691@gmail.com',
      chromeUserDataDir: '/home/beka/.config/google-chrome',
      chromeProfile: 'Default',
      cdpPort: 9222
    },
    {
      account: 'behruzzz406@gmail.com',
      chromeUserDataDir: '/home/beka/.config/google-chrome-acc2',
      chromeProfile: 'Default',
      cdpPort: 9223
    }
  ];
  c.expectedAccount = 'behruzyuldoshev691@gmail.com';
  c.projectId = '';
  c.headless = true;
  fs.writeFileSync(configPath, JSON.stringify(c, null, 2) + '\n');
  console.log('[setup-accounts] Successfully configured 2 accounts in flow.config.json.');
} catch (e) {
  console.error('[setup-accounts] Error:', e.message);
}
