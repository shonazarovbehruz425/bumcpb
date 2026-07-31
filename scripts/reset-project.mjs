import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', 'config', 'flow.config.json');

try {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  c.projectId = '';
  fs.writeFileSync(configPath, JSON.stringify(c, null, 2) + '\n');
  console.log('[reset-project] projectId cleared.');
} catch (e) {
  console.error('[reset-project] failed:', e.message);
}
