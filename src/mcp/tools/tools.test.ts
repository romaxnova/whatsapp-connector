import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { call, ME, testConfig, testContext, waMsg } from '../../test-support.js';
import { makePdf, makePng } from '../../test-fixtures.js';
import { listChatsTool, readChatTool, searchTool, markReadTool, statusTool } from './chats.js';
import { filesToLinkTool, getFileTool, listFilesTool } from './files.js';
import { createUploadLinkTool, sendFileTool, sendMessageTool, sendVoiceTool } from './send.js';
import { createMcpServer } from '../server.js';
import { allTools } from './index.js';
import { spawnSync } from 'node:child_process';
import { toneMp3 } from '../../test-fixtures.js';
import { parseWhen } from './common.js';
import { UploadStore } from '../../uploads.js';
import { uploadRouter } from '../../web/upload.js';
import { silentLogger } from '../../log.js';
import sharp from 'sharp';

const GROUP = '120363000000000001@g.us';
const ALICE = '33611111111@s.whatsapp.net';
const BOB = '33622222222@s.whatsapp.net';

function seeded() {
  const ctx = testContext();
  ctx.store.upsertContact({ id: ALICE, name: 'Alice Martin' });
  ctx.store.upsertContact({ id: BOB, notify: 'Bob' });
  ctx.store.upsertGroup({ id: GROUP, subject: 'Appartements Paris', participants: [{ id: ALICE }, { id: BOB }, { id: ME }] });
  ctx.store.upsertChat({ id: GROUP, unreadCount: 2 }, true);
  ctx.store.ingest(
    [
      waMsg({ chat: GROUP, id: 'G1', participant: ALICE, ts: 1_763_400_000, message: { conversation: 'Nouveau T2 rue Oberkampf, 1100€' } }),
      waMsg({ chat: GROUP, id: 'G2', participant: BOB, ts: 1_763_400_100, message: { documentMessage: { fileName: 'dossier-location.pdf', mimetype: 'application/pdf', fileLength: 5000, mediaKey: Buffer.alloc(32, 1), directPath: '/x' } } }),
      waMsg({ chat: GROUP, id: 'G3', participant: ALICE, ts: 1_763_400_200, message: { imageMessage: { caption: 'le salon', mimetype: 'image/jpeg', mediaKey: Buffer.alloc(32, 1), directPath: '/y' } } }),
      waMsg({ chat: ALICE, id: 'D1', ts: 1_763_300_000, message: { conversation: 'Tu as visité ?' } }),
    ],
    { live: true },
  );
  return ctx;
}

test('parseWhen reads dates in the configured zone, and relative days', () => {
  // 2026-11-01 00:00 in Paris is 23:00 UTC the day before (winter time).
  assert.equal(parseWhen('2026-11-01', 'Europe/Paris'), Date.UTC(2026, 9, 31, 23, 0) / 1000);
  assert.equal(parseWhen('2026-07-01T10:00', 'Europe/Paris'), Date.UTC(2026, 6, 1, 8, 0) / 1000);
  assert.equal(parseWhen('7d', 'UTC', 10 * 86400e3), 3 * 86400);
});

test('list chats: groups first by recency, names, unread, previews; query finds by name', async () => {
  const ctx = seeded();
  const all = await call(listChatsTool, {}, ctx);
  const json = JSON.parse(all.text) as { chats: { name: string; unread?: number; last_message?: string }[] };
  assert.equal(json.chats[0]!.name, 'Appartements Paris');
  assert.equal(json.chats[0]!.unread, 2);
  assert.match(json.chats[0]!.last_message!, /Alice Martin: le salon/);
  assert.equal(json.chats[1]!.name, 'Alice Martin');
  const q = JSON.parse((await call(listChatsTool, { query: 'appart' }, ctx)).text) as { chats: { chat_id: string }[] };
  assert.deepEqual(q.chats.map((c) => c.chat_id), [GROUP]);
});

test('read chat: a transcript with senders, files and ids; chat found by name', async () => {
  const ctx = seeded();
  const r = await call(readChatTool, { chat: 'appartements paris' }, ctx);
  assert.equal(r.isError, false);
  assert.match(r.text, /Appartements Paris \(group, 3 members\)/);
  assert.match(r.text, /\] Alice Martin: Nouveau T2 rue Oberkampf, 1100€ #G1/);
  assert.match(r.text, /~Bob \(\+33622222222\): \[document "dossier-location\.pdf", 5 KB\] #G2/);
  const page = await call(readChatTool, { chat: GROUP, limit: 1 }, ctx);
  assert.match(page.text, /#G3/);
  assert.match(page.text, /before "G3"/);
  const older = await call(readChatTool, { chat: GROUP, limit: 5, before: 'G3' }, ctx);
  assert.doesNotMatch(older.text, /#G3/);
  assert.match(older.text, /#G1/);
});

test('ambiguous chat names are listed back instead of guessed', async () => {
  const ctx = seeded();
  ctx.store.upsertGroup({ id: '120363000000000002@g.us', subject: 'Appartements Lyon' });
  const r = await call(readChatTool, { chat: 'appartements' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.text, /Several chats match/);
  assert.match(r.text, /Appartements Lyon/);
});

test('search across chats and by sender', async () => {
  const ctx = seeded();
  const r = await call(searchTool, { query: 'oberkampf' }, ctx);
  assert.match(r.text, /Appartements Paris · Alice Martin: Nouveau T2/);
  const bySender = await call(searchTool, { sender: 'Alice Martin' }, ctx);
  assert.match(bySender.text, /#G1/);
  assert.doesNotMatch(bySender.text, /#G2/);
});

test('list files, then read a PDF and look at a photo', async () => {
  const ctx = seeded();
  const files = JSON.parse((await call(listFilesTool, { chat: 'Appartements Paris' }, ctx)).text) as { files: { message_id: string; name: string; type: string }[] };
  assert.deepEqual(files.files.map((f) => f.message_id), ['G3', 'G2']);
  assert.match(files.files[0]!.name, /^IMG-.*\.jpg$/);
  const docs = JSON.parse((await call(listFilesTool, { type: 'document', query: 'dossier' }, ctx)).text) as { files: { message_id: string }[] };
  assert.deepEqual(docs.files.map((f) => f.message_id), ['G2']);

  ctx.wa.files.set('G2', makePdf([['Dossier de location', 'Revenus: 3x le loyer']]));
  const pdf = await call(getFileTool, { message_id: 'G2' }, ctx);
  assert.match(pdf.text, /dossier-location\.pdf/);
  assert.match(pdf.text, /Revenus: 3x le loyer/);

  // A 1200×900 photo, well over what a tool result carries, comes back scaled down.
  ctx.wa.files.set('G3', await sharp({ create: { width: 1200, height: 900, channels: 3, noise: { type: 'gaussian' as const, mean: 128, sigma: 60 }, background: '#000' } }).jpeg({ quality: 95 }).toBuffer());
  const photo = await call(getFileTool, { message_id: 'G3' }, ctx);
  const image = photo.result.content.find((c) => c.type === 'image');
  assert.ok(image, photo.text);
  assert.ok(Buffer.from((image as { data: string }).data, 'base64').length <= 96 * 1024);

  ctx.wa.files.set('G3', makePng(4, 4));
  const small = await call(getFileTool, { message_id: 'G3' }, ctx);
  assert.equal(small.result.content.find((c) => c.type === 'image')?.type, 'image');
});

test('send message: replies, new numbers checked on WhatsApp, blanks refused', async () => {
  const ctx = seeded();
  const r = await call(sendMessageTool, { chat: 'Appartements Paris', text: 'Je prends la visite de samedi', reply_to: 'G1' }, ctx);
  assert.equal(r.isError, false);
  assert.equal(ctx.wa.sent[0]!.jid, GROUP);
  assert.equal(ctx.wa.sent[0]!.quoted?.key.id, 'G1');
  assert.equal(ctx.wa.sent[0]!.quoted?.message?.conversation, 'Nouveau T2 rue Oberkampf, 1100€');

  const blank = await call(sendMessageTool, { chat: ALICE, text: 'Appelle-moi au [téléphone]' }, ctx);
  assert.equal(blank.isError, true);
  assert.equal(ctx.wa.sent.length, 1);

  ctx.wa.onWhatsApp.add('33677777777');
  const fresh = await call(sendMessageTool, { chat: '+33 6 77 77 77 77', text: 'Bonjour, je vous contacte pour l’appartement' }, ctx);
  assert.equal(fresh.isError, false, fresh.text);
  assert.equal(ctx.wa.sent[1]!.jid, '33677777777@s.whatsapp.net');
  const nobody = await call(sendMessageTool, { chat: '+33 6 88 88 88 88', text: 'Bonjour' }, ctx);
  assert.match(nobody.text, /not on WhatsApp/);
});

test('mark read sends read receipts for the latest incoming messages', async () => {
  const ctx = seeded();
  await call(markReadTool, { chat: GROUP }, ctx);
  assert.deepEqual(ctx.wa.read.map((k) => k.id).sort(), ['G1', 'G2', 'G3']);
  assert.equal(ctx.store.chat(GROUP)!.unread, 0);
});

test('not linked: tools say what to do instead of failing', async () => {
  const ctx = seeded();
  ctx.wa.state = { state: 'unlinked' };
  const s = JSON.parse((await call(statusTool, {}, ctx)).text) as { state: string; note: string };
  assert.equal(s.state, 'unlinked');
  assert.match(s.note, /admin/);
});

/** A peer connector (G-Spot Assistant runs this same upload code) on a local port. */
async function peer() {
  const uploads = new UploadStore();
  const app = express();
  app.use('/upload', uploadRouter(uploads, silentLogger));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  return { uploads, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('files to link: WhatsApp files land in the peer connector as upload_ids', async () => {
  const p = await peer();
  try {
    const ctx = seeded();
    ctx.config = testConfig({ PEER_UPLOAD_HOSTS: p.host });
    const pdf = makePdf([['Bail signé']]);
    ctx.wa.files.set('G2', pdf);
    const link = p.uploads.createLink();
    const r = await call(filesToLinkTool, { upload_url: `${p.origin}/upload/${link.token}`, message_ids: ['G2', 'G1'] }, ctx);
    const json = JSON.parse(r.text) as { sent: number; failed: number; files: { upload_id?: string; error?: string }[]; link_id: string };
    assert.equal(json.sent, 1);
    assert.equal(json.failed, 1);
    assert.match(json.files[1]!.error!, /carries no file/);
    const staged = p.uploads.get(json.files[0]!.upload_id!)!;
    assert.equal(staged.filename, 'dossier-location.pdf');
    assert.equal(staged.mimeType, 'application/pdf');
    assert.deepEqual(staged.data, pdf);
    assert.equal(json.link_id, link.linkId);
  } finally {
    p.close();
  }
});

test('files to link: a host that is not one of the owner\'s connectors is refused', async () => {
  const ctx = seeded();
  ctx.wa.files.set('G2', Buffer.from('x'));
  const r = await call(filesToLinkTool, { upload_url: 'https://evil.example/upload/AAAAAAAAAAAAAAAAAAAAAAAA', message_ids: ['G2'] }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.text, /not one of the connectors/);
});

test('upload link then send file: what came through the link goes out as a document', async () => {
  const ctx = seeded();
  const link = JSON.parse((await call(createUploadLinkTool, {}, ctx)).text) as { upload_url: string; link_id: string };
  assert.match(link.upload_url, /^https:\/\/wa\.test\/upload\//);
  const token = link.upload_url.split('/upload/')[1]!;
  ctx.uploads.consumeLinkFiles(token, [{ data: makePdf([['Quittance']]), filename: 'quittance-octobre.pdf', mimeType: 'application/pdf' }]);
  const r = await call(sendFileTool, { chat: 'Alice', upload_ids: [link.link_id], caption: 'La quittance' }, ctx);
  assert.equal(r.isError, false, r.text);
  const sent = ctx.wa.sent[0]!;
  assert.equal(sent.jid, ALICE);
  assert.equal(sent.file?.filename, 'quittance-octobre.pdf');
  assert.equal(sent.file?.mimetype, 'application/pdf');
  assert.equal(sent.file?.caption, 'La quittance');
});

test('voice: the tool is offered only when ElevenLabs is set up; it sends a voice note, as a reply', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg not installed' }, async () => {
  const off = seeded();
  const listed = (ctx: ReturnType<typeof seeded>) => Object.keys((createMcpServer(ctx, allTools) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.ok(!listed(off).includes('whatsapp_send_voice'));
  const ctx = seeded();
  ctx.config = testConfig({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'abcdefgh12', VOICE_MAX_CHARS: '40' });
  ctx.fetchImpl = (async () => new Response(toneMp3(), { status: 200 })) as typeof fetch;
  assert.ok(listed(ctx).includes('whatsapp_send_voice'));
  const r = await call(sendVoiceTool, { chat: 'Appartements Paris', text: 'Je prends la visite de samedi', reply_to: 'G1' }, ctx);
  assert.equal(r.isError, false, r.text);
  const sent = ctx.wa.sent[0]!;
  assert.equal(sent.jid, GROUP);
  assert.equal(sent.quoted?.key.id, 'G1');
  assert.equal(sent.voice!.ogg.subarray(0, 4).toString(), 'OggS');
  assert.equal(sent.voice!.seconds, 2);
  const long = await call(sendVoiceTool, { chat: ALICE, text: 'x'.repeat(41) }, ctx);
  assert.match(long.text, /limited to 40/);
  assert.equal(ctx.wa.sent.length, 1);
  // An accent asked for in the request goes to ElevenLabs as audio tags, with the expressive model.
  let body: { text: string; model_id: string } | undefined;
  ctx.fetchImpl = (async (_u: string | URL, init?: RequestInit) => ((body = JSON.parse(String(init!.body))), new Response(toneMp3(), { status: 200 }))) as typeof fetch;
  const styled = await call(sendVoiceTool, { chat: ALICE, text: 'Hey, dinner?', style: 'strong West African accent, playful' }, ctx);
  assert.equal(styled.isError, false, styled.text);
  assert.deepEqual(body, { text: '[strong West African accent] [playful] Hey, dinner?', model_id: 'eleven_v3' });
  assert.match(styled.text, /"style": "\[strong West African accent\] \[playful\]"/);
  // An accent from another language: the phonetic spelling is read as that language.
  const accented = await call(sendVoiceTool, { chat: ALICE, text: 'Привет', accent_language: 'fr', phonetic_text: 'Privièt', style: 'playful' }, ctx);
  assert.equal(accented.isError, false, accented.text);
  assert.deepEqual(body, { text: '[playful] Privièt', model_id: 'eleven_v3', language_code: 'fr' });
  assert.match((await call(sendVoiceTool, { chat: ALICE, text: 'Привет', accent_language: 'fr' }, ctx)).text, /needs phonetic_text/);
});
