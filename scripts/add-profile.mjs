#!/usr/bin/env node
// CLI script to easily add/register a 2nd or 3rd Chrome profile to flow.config.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'flow.config.json');

const args = process.argv.slice(2);
const profileName = args[0] || 'Profile 1';
const projectId = args[1];
const email = args[2] || 'account2@gmail.com';

if (!projectId) {
  console.log('Usage: node scripts/add-profile.mjs <profileName> <projectId> [email]');
  console.log('Example: node scripts/add-profile.mjs "Profile 1" "66432ae8-910e-4c93-9f36-b4e8f0c39b04" "my2ndaccount@gmail.com"');
  process.exit(1);
}

try {
  const conf = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  conf.profiles = conf.profiles || [];
  
  // Update or add profile
  const existingIdx = conf.profiles.findIndex(p => p.profileName === profileName);
  const profileData = { profileName, projectId, email, addedAt: new Date().toISOString() };

  if (existingIdx >= 0) {
    conf.profiles[existingIdx] = profileData;
    console.log(`[profile] Updated profile "${profileName}" in config.`);
  } else {
    conf.profiles.push(profileData);
    console.log(`[profile] Added new profile "${profileName}" to config.`);
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(conf, null, 2) + '\n');
  console.log(`[profile] Successfully saved! Total profiles: ${conf.profiles.length}`);
} catch (e) {
  console.error('[profile] Failed to update config:', e.message);
  process.exit(1);
}
