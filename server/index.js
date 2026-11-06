/** Server entry point: loads .env, then starts listening. */

import { createApp } from './app.js';
import { loadConfig } from './config.js';

try {
  process.loadEnvFile();
} catch (error) {
  // No .env yet is fine: the app runs in demo-only mode until credentials exist.
  if (error.code !== 'ENOENT') throw error;
}

const config = loadConfig();

createApp(config).listen(config.port, config.host, () => {
  console.log(`Listening room open at ${config.canonicalOrigin}`);
  if (!config.configured) {
    console.log(`Spotify login disabled, demo mode only. Missing in .env: ${config.missing.join(', ')}`);
  }
  if (config.usesRejectedLocalhost) {
    console.warn('Spotify rejects "localhost" redirect URIs. Use http://127.0.0.1:<port>/... instead.');
  }
});
