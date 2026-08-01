import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config', 'flow.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Update project IDs
config.projectId = '7401dff5-f325-4ec2-90e0-4639a6d7d5ff';

// Update accounts with correct project IDs
config.accounts = [
  {
    account: 'behruzyuldoshev691@gmail.com',
    chromeUserDataDir: '/home/beka/.config/google-chrome',
    chromeProfile: 'Default',
    cdpPort: 9222,
    projectId: '7401dff5-f325-4ec2-90e0-4639a6d7d5ff'
  },
  {
    account: 'behruzzz406@gmail.com',
    chromeUserDataDir: '/home/beka/.config/google-chrome',
    chromeProfile: 'Profile 1',
    cdpPort: 9223,
    projectId: '7f3bc736-6c4e-4573-a207-6bb887a95317'
  }
];

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('✅ Config updated with correct project IDs!');
console.log('Account 1:', config.accounts[0].account, '→', config.accounts[0].projectId);
console.log('Account 2:', config.accounts[1].account, '→', config.accounts[1].projectId);
