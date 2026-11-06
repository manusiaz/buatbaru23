'use strict';
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const sesi = require('./sesi');
const sync = require('./sync');
const retensi = require('./retensi');

async function main() {
  await db.migrate();
  await sesi.compensateDowntime();
  await sesi.heartbeat();
  sesi.startBackground();
  retensi.start();
  require('./saldo').start();
  await sync.resumePending();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`${config.appName} berjalan di ${config.baseUrl} (port ${config.port})`);
  });
  const stop = async () => {
    server.close();
    sesi.stopBackground();
    await sesi.heartbeat().catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error('Gagal start:', e);
  process.exit(1);
});
