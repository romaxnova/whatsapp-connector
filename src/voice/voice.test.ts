import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { toneMp3 } from '../test-fixtures.js';
import { envelope, synthesize, telegramWaveform, toVoiceNote, voiceConfig, VoiceError } from './voice.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('voice settings come from the environment only, with a model and a length limit by default', () => {
  assert.equal(voiceConfig({}), undefined);
  assert.equal(voiceConfig({ ELEVENLABS_API_KEY: 'k' }), undefined);
  assert.deepEqual(voiceConfig({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'abcdefgh12' }), { apiKey: 'k', voiceId: 'abcdefgh12', modelId: 'eleven_multilingual_v2', maxChars: 600 });
  assert.equal(voiceConfig({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'abcdefgh12', ELEVENLABS_MODEL_ID: 'eleven_v3', VOICE_MAX_CHARS: '200' })!.maxChars, 200);
});

test('synthesize: refuses long texts before calling ElevenLabs, sends the key and model, explains refusals', async () => {
  const cfg = { apiKey: 'secret', voiceId: 'abcdefgh12', modelId: 'eleven_v3', maxChars: 20 };
  let called = 0;
  const fake = (async (url: string | URL, init?: RequestInit) => {
    called++;
    assert.match(String(url), /\/v1\/text-to-speech\/abcdefgh12\?output_format=mp3_44100_128$/);
    assert.equal((init!.headers as Record<string, string>)['xi-api-key'], 'secret');
    assert.equal(JSON.parse(String(init!.body)).model_id, 'eleven_v3');
    return new Response(Buffer.from('ID3fake'), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(synthesize(cfg, 'x'.repeat(21), {}, fake), (e: unknown) => e instanceof VoiceError && /limited to 20/.test((e as Error).message));
  assert.equal(called, 0);
  assert.deepEqual(await synthesize(cfg, 'Bonjour', {}, fake), Buffer.from('ID3fake'));
  const quota = (async () => new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'You have 0 credits' } }), { status: 401 })) as typeof fetch;
  await assert.rejects(synthesize(cfg, 'Bonjour', {}, quota), /API key|quota/);
  // Style tags go before the text with v3 models only, and do not count against the limit.
  let sentText = '';
  const capture = (async (_u: string | URL, init?: RequestInit) => ((sentText = JSON.parse(String(init!.body)).text), new Response(Buffer.from('x')))) as typeof fetch;
  await synthesize({ ...cfg, styleTags: '[strong French accent]' }, 'Привет, это я', {}, capture);
  assert.equal(sentText, '[strong French accent] Привет, это я');
  await synthesize({ ...cfg, styleTags: '[strong French accent]' }, 'Привет', { modelId: 'eleven_multilingual_v2' }, capture);
  assert.equal(sentText, 'Привет');
});

test('waveforms: 64 bars for WhatsApp, 100 levels packed in 5 bits for Telegram', () => {
  const pcm = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 8000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 3) * 30000 * (1 - i / 8000)), i * 2);
  const bars = envelope(pcm, 64, 100);
  assert.equal(bars.length, 64);
  assert.equal(Math.max(...bars), 100);
  assert.ok(bars[0]! > bars[63]!);
  const packed = telegramWaveform([31, 0, 1, 16]);
  assert.equal(packed.length, 3);
  // 31 → bits 0-4, 0 → 5-9, 1 → bit 10, 16 → bit 19
  assert.equal(packed[0], 0b00011111);
  assert.equal(packed[1], 0b00000100);
  assert.equal(packed[2], 0b00001000);
});

test('toVoiceNote: MP3 becomes mono 48 kHz Ogg Opus with duration and waveform', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const note = await toVoiceNote(toneMp3());
  assert.equal(note.ogg.subarray(0, 4).toString(), 'OggS');
  assert.ok(note.ogg.includes(Buffer.from('OpusHead')));
  assert.equal(note.ogg[note.ogg.indexOf(Buffer.from('OpusHead')) + 9], 1, 'mono');
  assert.equal(note.seconds, 2);
  assert.equal(note.waveform.length, 64);
  assert.ok(note.waveform[0]! > note.waveform[60]!, 'the fade shows in the waveform');
  assert.equal(note.levels100.length, 100);
});
