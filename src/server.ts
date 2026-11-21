/**
 * Entry point: wires configuration, storage, the WhatsApp connection and the HTTP app together.
 */
import { MediaTextCache } from './media/media-text.js';
import { hideSignalSessionDumps } from './quiet-signal.js';
import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './log.js';
import { checkpoint, cleanupExpired, compact, fileSizes, openDatabase } from './db.js';
import { memoryReport } from './memory.js';
import { AuthStore } from './auth/store.js';
import { ClientRegistry } from './auth/clients.js';
import { ConnectorOAuthProvider } from './auth/provider.js';
import { createApp } from './app.js';
import { SqliteUploadVault, UploadStore } from './uploads.js';
import { SqliteAuthState } from './whatsapp/auth-state.js';
import { MessageStore } from './whatsapp/store.js';
import { WhatsAppService } from './whatsapp/client.js';
import { allTools } from './mcp/tools/index.js';
import { VERSION } from './version.js';

const DAY_S = 24 * 60 * 60;

function main(): void {
  hideSignalSessionDumps();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  if (config.storageWarning) log.warn(config.storageWarning);
  if (!config.peerUploadHosts.length) log.warn('PEER_UPLOAD_HOSTS is empty: WhatsApp files cannot be sent to G-Spot Assistant until it lists its host');
  const db = openDatabase(config.dbPath);
  const keys = [config.encryptionKey, config.encryptionKeyPrevious];
  const auth = new SqliteAuthState(db, keys);
  if (config.encryptionKeyPrevious) {
    const n = auth.reencrypt();
    if (n > 0) log.info('re-encrypted the whatsapp session with the current key; TOKEN_ENCRYPTION_KEY_PREVIOUS can be removed once old messages are no longer needed', { count: n });
  }
  const messages = new MessageStore(db, keys);
  const noise = messages.purgeNoise();
  if (noise) log.info('removed technical notices from the message index', { count: noise });
  const store = new AuthStore(db);
  const clients = new ClientRegistry(store, { allowedRedirectUris: config.allowedRedirectUris, cimdAllowedHosts: config.cimdAllowedHosts, dcrEnabled: config.dcrEnabled }, log);
  const provider = new ConnectorOAuthProvider(
    store,
    clients,
    { mcpUrl: config.mcpUrl, consentPath: '/consent', accessTokenTtlSeconds: config.accessTokenTtlSeconds, refreshTokenTtlSeconds: config.refreshTokenTtlSeconds },
    log,
  );
  const uploads = new UploadStore({}, Date.now, new SqliteUploadVault(db, keys));
  const wa = new WhatsAppService(auth, messages, log, { fullHistory: config.fullHistory, logLevel: config.logLevel });
  const mediaText = new MediaTextCache(db, keys);
  const app = createApp({ config, log, store, clients, provider, tools: allTools, messages, wa, uploads, mediaText });
  const server = app.listen(config.port, '0.0.0.0', (err?: Error) => {
    if (err) {
      log.error('could not start listening', { port: config.port, error: err.message });
      process.exit(1);
    }
    log.info('listening', { version: VERSION, port: config.port, mcpUrl: config.mcpUrl.href, tools: allTools.length, messages: messages.count() });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 15 * 60_000;

  wa.start().catch((err: unknown) => log.error('whatsapp could not start', { error: err instanceof Error ? err.message : String(err) }));

  const logMemory = () => {
    const sizes = fileSizes(db);
    log.info('memory', { ...memoryReport(), dbMb: Math.round((sizes.pages * sizes.pageSize) / 104857.6) / 10, state: wa.status().state });
  };
  logMemory();

  const housekeeping = setInterval(
    () => {
      try {
        cleanupExpired(db);
        store.pruneClients(30 * DAY_S);
        uploads.sweep();
        if (config.retentionDays > 0) messages.purgeBefore(Math.floor(Date.now() / 1000) - config.retentionDays * DAY_S);
        compact(db);
        logMemory();
      } catch (err) {
        log.warn('housekeeping failed', { error: err instanceof Error ? err.message : String(err) });
      }
    },
    60 * 60 * 1000,
  );
  housekeeping.unref();

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    clearInterval(housekeeping);
    wa.stop();
    server.close(() => {
      try {
        checkpoint(db, 'TRUNCATE');
      } catch {
        /* best effort */
      }
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
