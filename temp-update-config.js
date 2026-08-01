const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config', 'flow.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

config.projectId = '66432ae8-910e-4c93-9f36-b4e8f0c39b04';
config.headless = false;

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Config updated successfully!');
console.log('projectId:', config.projectId);
console.log('headless:', config.headless);
