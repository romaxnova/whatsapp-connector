import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { MessageStore, fold } from './store.js';
import { parseMessage } from './content.js';
import { SqliteAuthState } from './auth-state.js';
import { initAuthCreds } from 'baileys';
import { ME, TEST_KEY, waMsg } from '../test-support.js';

const GROUP = '120363000000000001@g.us';
const ALICE = '33611111111@s.whatsapp.net';
const ALICE_LID = '99887766554433@lid';

function store() {
  const db = openDatabase(':memory:');
  const s = new MessageStore(db, [TEST_KEY]);
  s.setMe(ME);
  return { db, s };
}

test('parseMessage: text, captions, documents, voice notes, reactions, edits, deletions', () => {
  assert.deepEqual(parseMessage({ message: { conversation: 'salut' } }), { kind: 'text', text: 'salut' });
  const doc = parseMessage({ message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'bail.pdf', mimetype: 'application/pdf', fileLength: 2048, caption: 'le bail', pageCount: 3 } } } } });
  assert.equal(doc.kind, 'document');
  assert.equal(doc.text, 'le bail');
  assert.deepEqual(doc.media, { mimetype: 'application/pdf', filename: 'bail.pdf', size: 2048, pages: 3 });
  assert.equal(parseMessage({ message: { audioMessage: { ptt: true, seconds: 12 } } }).kind, 'voice');
  const img = parseMessage({ message: { imageMessage: { caption: 'salon', mimetype: 'image/jpeg', contextInfo: { stanzaId: 'Q1', quotedMessage: { conversation: 'des photos ?' } } } } });
  assert.equal(img.kind, 'image');
  assert.equal(img.quotedId, 'Q1');
  assert.equal(img.quotedText, 'des photos ?');
  assert.deepEqual(parseMessage({ message: { reactionMessage: { key: { id: 'T1' }, text: '👍' } } }).reaction, { targetId: 'T1', emoji: '👍' });
  assert.equal(parseMessage({ message: { protocolMessage: { type: 0, key: { id: 'T2' } } } }).revokes, 'T2');
  assert.deepEqual(parseMessage({ message: { protocolMessage: { type: 14, key: { id: 'T3' }, editedMessage: { conversation: 'corrigé' } } } }).edit, { targetId: 'T3', text: 'corrigé' });
  assert.match(parseMessage({ message: { locationMessage: { degreesLatitude: 48.85, degreesLongitude: 2.35, name: 'Bastille' } } }).text!, /Bastille.*48\.85,2\.35/);
  assert.equal(parseMessage({ message: { ephemeralMessage: { message: { conversation: 'éphémère' } } } }).text, 'éphémère');
});

test('fold ignores accents, case and punctuation', () => {
  assert.equal(fold('Appart’ Élysée!'), 'appart elysee');
});

test('ingest: group messages, names from pushName, edits, reactions and deletions', () => {
  const { s } = store();
  s.upsertGroup({ id: GROUP, subject: 'Appartements Paris 🏠', participants: [{ id: ALICE }, { id: ME, admin: 'admin' }] });
  s.ingest(
    [
      waMsg({ chat: GROUP, id: 'A1', participant: ALICE, pushName: 'Alice', ts: 100, message: { conversation: 'T3 à Bastille, 1400€ CC' } }),
      waMsg({ chat: GROUP, id: 'A2', fromMe: true, ts: 101, message: { conversation: 'Intéressé !' } }),
      waMsg({ chat: GROUP, id: 'A3', participant: ALICE, ts: 102, message: { reactionMessage: { key: { id: 'A2' }, text: '❤️' } } }),
      waMsg({ chat: GROUP, id: 'A4', participant: ALICE, ts: 103, message: { protocolMessage: { type: 14, key: { id: 'A1' }, editedMessage: { conversation: 'T3 à Bastille, 1350€ CC' } } } }),
      waMsg({ chat: GROUP, id: 'A5', participant: ALICE, ts: 104, message: { conversation: 'oups' } }),
      waMsg({ chat: GROUP, id: 'A6', participant: ALICE, ts: 105, message: { protocolMessage: { type: 0, key: { id: 'A5' } } } }),
    ],
    { live: true },
  );
  const { messages } = s.messages(GROUP, { limit: 10 });
  assert.deepEqual(messages.map((m) => m.id), ['A1', 'A2', 'A5']);
  assert.equal(messages[0]!.text, 'T3 à Bastille, 1350€ CC');
  assert.equal(messages[0]!.edited, true);
  assert.equal(messages[2]!.deleted, true);
  assert.equal(messages[2]!.text, undefined);
  assert.deepEqual(s.reactions(GROUP, ['A2']).get('A2'), [{ sender: ALICE, emoji: '❤️' }]);
  assert.equal(s.personName(ALICE), '~Alice (+33611111111)');
  assert.equal(s.chatName(GROUP), 'Appartements Paris 🏠');
  assert.equal(s.findChats('appartements')[0]?.jid, GROUP);
  assert.equal(s.findChats('paris appart').length, 1);
  assert.equal(s.search({ query: 'bastille 1350', limit: 5 }).messages[0]?.id, 'A1');
  assert.equal(s.search({ query: 'bastille 1400', limit: 5 }).messages.length, 0);
});

test('text and raw messages are encrypted at rest', () => {
  const { db, s } = store();
  s.ingest([waMsg({ chat: ALICE, id: 'S1', ts: 10, message: { conversation: 'code secret 4242' } })], { live: true });
  const row = db.prepare('SELECT body_enc, raw_enc FROM wa_messages').get() as { body_enc: Uint8Array; raw_enc: Uint8Array };
  assert.ok(!Buffer.from(row.body_enc).toString('latin1').includes('4242'));
  assert.ok(!Buffer.from(row.raw_enc).toString('latin1').includes('4242'));
  assert.equal(s.rawMessage(ALICE, 'S1')?.message?.conversation, 'code secret 4242');
});

test('raw media messages keep what a download needs, without thumbnails', () => {
  const { s } = store();
  const mediaKey = Buffer.alloc(32, 1);
  s.ingest([waMsg({ chat: ALICE, id: 'M1', ts: 10, message: { documentMessage: { fileName: 'dossier.pdf', mimetype: 'application/pdf', mediaKey, directPath: '/v/t62/abc', url: 'https://mmg.whatsapp.net/x', fileEncSha256: Buffer.alloc(32, 2), jpegThumbnail: Buffer.alloc(3000, 9) } } })], { live: false });
  const raw = s.rawMessage(ALICE, 'M1')!;
  const doc = raw.message!.documentMessage!;
  assert.equal(doc.directPath, '/v/t62/abc');
  assert.deepEqual(Buffer.from(doc.mediaKey!), mediaKey);
  assert.ok(!doc.jpegThumbnail || doc.jpegThumbnail.length === 0);
});

test('a chat first seen under a LID merges into the phone number once WhatsApp maps it', () => {
  const { s } = store();
  s.ingest([waMsg({ chat: ALICE_LID, id: 'L1', ts: 10, pushName: 'Alice', message: { conversation: 'coucou' } })], { live: true });
  s.ingest([waMsg({ chat: ALICE, id: 'L2', ts: 11, message: { conversation: 'ça va ?' } })], { live: true });
  assert.equal(s.chats().length, 2);
  s.mapLid(ALICE_LID, ALICE);
  const chats = s.chats();
  assert.equal(chats.length, 1);
  assert.equal(chats[0]!.jid, ALICE);
  assert.deepEqual(s.messages(ALICE, { limit: 5 }).messages.map((m) => m.id), ['L1', 'L2']);
  // A later message addressed by LID with its phone number alongside lands in the same chat.
  s.ingest([waMsg({ chat: '11112222333344@lid', remoteJidAlt: '33622222222@s.whatsapp.net', id: 'L3', ts: 12, message: { conversation: 'hey' } })], { live: true });
  assert.ok(s.chat('33622222222@s.whatsapp.net'));
});

test('unread counts: history sets them, live updates add, a read resets', () => {
  const { s } = store();
  s.upsertChat({ id: ALICE, unreadCount: 3 }, true);
  s.upsertChat({ id: ALICE, unreadCount: 2 }, false);
  assert.equal(s.chat(ALICE)!.unread, 5);
  s.upsertChat({ id: ALICE, unreadCount: 0 }, false);
  assert.equal(s.chat(ALICE)!.unread, 0);
  s.upsertChat({ id: ALICE, unreadCount: -1 }, false);
  assert.equal(s.chat(ALICE)!.unread, 1);
});

test('the WhatsApp session is stored encrypted and survives a reload', async () => {
  const db = openDatabase(':memory:');
  const auth = new SqliteAuthState(db, [TEST_KEY]);
  assert.equal(auth.isRegistered(), false);
  const { state, saveCreds } = auth.load();
  state.creds = { ...initAuthCreds(), registered: true, me: { id: ME } };
  saveCreds();
  assert.equal(auth.isRegistered(), true);
  await state.keys.set({ 'pre-key': { '1': { public: Buffer.alloc(32, 3), private: Buffer.alloc(32, 4) } } });
  const raw = db.prepare("SELECT value_enc FROM wa_auth WHERE type = 'pre-key'").get() as { value_enc: string };
  assert.ok(!raw.value_enc.includes('AwMD'));
  const again = new SqliteAuthState(db, [TEST_KEY]);
  const keys = await again.load().state.keys.get('pre-key', ['1']);
  assert.deepEqual(Buffer.from(keys['1']!.public), Buffer.alloc(32, 3));
  auth.clear();
  assert.equal(again.isRegistered(), false);
});
