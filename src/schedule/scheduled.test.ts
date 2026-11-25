import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db.js';
import { silentLogger } from '../log.js';
import { LATE_LIMIT_MS, localTime, parseSendAt, ScheduledSender, ScheduledStore } from './scheduled.js';

const KEY = Buffer.alloc(32, 9);
const TZ = 'Europe/Paris';

test('send times: local wall-clock time in the timezone (summer and winter), future only, 90 days at most', () => {
  const now = Date.UTC(2026, 10, 25, 12, 0);
  assert.equal(parseSendAt('2026-11-26T08:30', TZ, now), Date.UTC(2026, 10, 26, 7, 30), 'winter: UTC+1');
  assert.equal(parseSendAt('2027-01-20 18:00', TZ, now), Date.UTC(2027, 0, 20, 17, 0));
  assert.equal(parseSendAt('2026-11-26T08:30:00+01:00', TZ, now), Date.UTC(2026, 10, 26, 7, 30));
  assert.equal(parseSendAt('2026-07-01T08:30', TZ, Date.UTC(2026, 5, 1)), Date.UTC(2026, 6, 1, 6, 30), 'summer: UTC+2');
  assert.throws(() => parseSendAt('2026-11-24T08:30', TZ, now), /already past/);
  assert.throws(() => parseSendAt('2027-06-01T08:30', TZ, now), /90 days/);
  assert.throws(() => parseSendAt('tomorrow 8:30', TZ, now), /not a send time/);
  assert.throws(() => parseSendAt('2026-11-26', TZ, now), /not a send time/);
  assert.match(localTime(Date.UTC(2026, 10, 26, 7, 30), TZ), /26 Nov 2026, 08:30 \(Europe\/Paris\)/);
});

test('the queue keeps text encrypted, lists what waits, cancels only waiting ones', () => {
  const db = openDatabase(':memory:');
  const s = new ScheduledStore(db, [KEY], () => 1_000);
  const m = s.add({ chatId: 'c1', chatName: 'Pierre', text: 'Rendez-vous à 9h', sendAt: 5_000 });
  const raw = db.prepare('SELECT text_enc FROM scheduled_messages').get() as { text_enc: Uint8Array };
  assert.ok(!Buffer.from(raw.text_enc).toString('utf8').includes('Rendez-vous'));
  assert.deepEqual(s.list().map((x) => [x.chatName, x.text, x.status]), [['Pierre', 'Rendez-vous à 9h', 'pending']]);
  assert.equal(s.cancel(m.id)?.status, 'cancelled');
  assert.equal(s.cancel(m.id), undefined);
  assert.equal(s.list().length, 0);
  assert.equal(s.list({ all: true }).length, 1);
});

test('the sender sends what is due, waits while disconnected, and tells the user when it gives up', async () => {
  let now = 10_000;
  const db = openDatabase(':memory:');
  const s = new ScheduledStore(db, [KEY], () => now);
  const sent: [string, string][] = [];
  const notes: string[] = [];
  let ready = true;
  let failSends = false;
  const sender = new ScheduledSender(
    s,
    {
      ready: () => ready,
      send: async (chat, text) => {
        if (failSends) throw new Error('not allowed in this chat');
        sent.push([chat, text]);
        return `msg-${sent.length}`;
      },
      notify: async (text) => void notes.push(text),
    },
    silentLogger,
    { timezone: TZ, now: () => now },
  );
  const a = s.add({ chatId: 'c1', chatName: 'Pierre', text: 'Bonjour', sendAt: 20_000 });
  await sender.tick();
  assert.equal(sent.length, 0, 'not due yet');
  now = 20_000;
  await sender.tick();
  assert.deepEqual(sent, [['c1', 'Bonjour']]);
  assert.equal(s.get(a.id)?.status, 'sent');

  const b = s.add({ chatId: 'c2', chatName: 'Alice', text: 'Coucou', sendAt: 30_000 });
  now = 30_000;
  ready = false;
  await sender.tick();
  assert.equal(s.get(b.id)?.status, 'pending', 'waits for the connection');
  now = 30_000 + LATE_LIMIT_MS + 1;
  await sender.tick();
  assert.equal(s.get(b.id)?.status, 'failed');
  assert.match(notes[0]!, /scheduled message to Alice .* could not be sent: the connection was down/);
  assert.match(notes[0]!, /Coucou/);

  ready = true;
  failSends = true;
  const c = s.add({ chatId: 'c3', chatName: 'Bob', text: 'Salut', sendAt: now });
  for (let i = 0; i < 3; i++) {
    await sender.tick();
    now += 3 * 60_000;
  }
  assert.equal(s.get(c.id)?.status, 'failed', 'three refusals and it stops');
  assert.match(notes[1]!, /to Bob .* not allowed in this chat/);
});
