import { startConnection } from './connection.js';
import { startDashboard } from './dashboard/server.js';
import { config } from './config.js';
import { commandCount } from './handler.js';

(async () => {
  console.log('🚀 Starting bot...');
  console.log(`📦 Loaded ${commandCount} commands (single-file)`);
  await startConnection();
  startDashboard(config.dashboardPort);
})();