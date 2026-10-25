const config = require('./config');
const db = require('./db');
const authSvc = require('./services/auth');
const { createApp } = require('./app');

async function main() {
  await db.connect();
  await authSvc.bootstrapFromEnv();
  const app = createApp();

  const server = app.listen(config.port, '0.0.0.0');

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[FATAL] Port ${config.port} is already in use by another process.`);
      console.error(`To fix this, stop the process currently using port ${config.port}.`);
      console.error(`  PowerShell: Stop-Process -Id (Get-NetTCPConnection -LocalPort ${config.port}).OwningProcess -Force`);
      console.error(`  CMD: netstat -ano | findstr :${config.port}\n`);
    } else {
      console.error('[FATAL] Server error:', err);
    }
    process.exit(1);
  });

  server.on('listening', () => {
    console.log(`HCM Lite API listening on :${config.port} (db: ${db.kind()} @ ${db.host()}, ai: ${config.ai.apiKey ? config.ai.model : 'off'})`);
  });

  const stop = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});
