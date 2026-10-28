import { config } from './config.js';
import { closeDb } from './db.js';
import { log } from './logger.js';
import { startBot } from './bot/index.js';
import { createApp } from './server/app.js';

// One process: HTTP API (Roblox + bot) and the Discord bot share one SQLite database.
const app = createApp();
const server = app.listen(config.port, () => log.info(`API listening on port ${config.port}`));

let client;
try {
  client = await startBot();
} catch (err) {
  log.error('Failed to start the Discord bot', err);
  process.exit(1);
}

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  server.close(() => {
    client?.destroy();
    closeDb();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('Unhandled rejection', err));
