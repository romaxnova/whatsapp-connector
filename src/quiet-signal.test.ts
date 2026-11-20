import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideSignalSessionDumps } from './quiet-signal.js';

test('session records printed by libsignal are dropped, the notice and other output kept', () => {
  const out: unknown[][] = [];
  const fake = { info: (...a: unknown[]) => out.push(a), warn: (...a: unknown[]) => out.push(a), log: (...a: unknown[]) => out.push(a) };
  hideSignalSessionDumps(fake);
  fake.info('Closing session:', { privKey: Buffer.alloc(32, 9) });
  fake.warn('Session already closed', { privKey: 'x' });
  fake.log('ordinary', { a: 1 });
  assert.deepEqual(out, [['Closing session'], ['Session already closed'], ['ordinary', { a: 1 }]]);
});
