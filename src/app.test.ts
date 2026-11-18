import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { AuthStore } from './auth/store.js';
import { ClientRegistry } from './auth/clients.js';
import { ConnectorOAuthProvider } from './auth/provider.js';
import { silentLogger } from './log.js';
import { MessageStore } from './whatsapp/store.js';
import { allTools } from './mcp/tools/index.js';
import { FakeWhatsApp, TEST_KEY, testConfig } from './test-support.js';

async function start() {
  const config = testConfig({ BASE_URL: 'http://localhost' });
  const db = openDatabase(':memory:');
  const store = new AuthStore(db);
  const clients = new ClientRegistry(store, { allowedRedirectUris: config.allowedRedirectUris, cimdAllowedHosts: config.cimdAllowedHosts, dcrEnabled: true }, silentLogger);
  const provider = new ConnectorOAuthProvider(store, clients, { mcpUrl: config.mcpUrl, consentPath: '/consent', accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400 }, silentLogger);
  const wa = new FakeWhatsApp();
  wa.state = { state: 'unlinked' };
  const app = createApp({ config, log: silentLogger, store, clients, provider, tools: allTools, messages: new MessageStore(db, [TEST_KEY]), wa });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close(), config };
}

test('health, OAuth metadata, MCP behind a bearer token', async () => {
  const s = await start();
  try {
    assert.equal(await (await fetch(`${s.base}/healthz`)).text(), 'ok');
    const meta = (await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json()) as { client_id_metadata_document_supported: boolean };
    assert.equal(meta.client_id_metadata_document_supported, true);
    const mcp = await fetch(`${s.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(mcp.status, 401);
  } finally {
    s.close();
  }
});

test('admin needs the password; the right one opens the linking page', async () => {
  const s = await start();
  try {
    const redirect = await fetch(`${s.base}/admin`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get('location')!, /^\/admin\/login/);
    const post = (password: string) =>
      fetch(`${s.base}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' }, body: new URLSearchParams({ password, next: '/admin' }) });
    assert.equal((await post('wrong password here')).status, 401);
    const ok = await post('correct horse battery staple');
    assert.equal(ok.status, 302);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
    const admin = await (await fetch(`${s.base}/admin`, { headers: { cookie } })).text();
    assert.match(admin, /not linked/);
    assert.match(admin, /Get a pairing code/);
    assert.match(admin, /Link with phone number instead/);
  } finally {
    s.close();
  }
});
