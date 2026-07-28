// pm2 process configuration for the Flow image API.
// Start with:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'flow-api',
      script: 'scripts/api-server.mjs',
      cwd: __dirname,
      // Node-level safety net (Chrome runs as a separate process; the API's
      // own memory-based Chrome recycle handles Chrome leaks).
      max_memory_restart: '1900M',
      restart_delay: 3000,
      max_restarts: 50,
      autorestart: true,
      out_file: './outputs/pm2-out.log',
      error_file: './outputs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
