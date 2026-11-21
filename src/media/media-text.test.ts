import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { openDatabase } from '../db.js';
import { cleanOcr, MediaTextCache, MediaTextError, ocr, ocrConfig, remembered, transcribe, transcribeConfig } from './media-text.js';

const hasTesseract = spawnSync('tesseract', ['--version']).status === 0;

test('transcription is on with the ElevenLabs key, OCR unless turned off', () => {
  assert.equal(transcribeConfig({}), undefined);
  assert.deepEqual(transcribeConfig({ ELEVENLABS_API_KEY: 'k' }), { apiKey: 'k', modelId: 'scribe_v1', maxSeconds: 600 });
  assert.equal(transcribeConfig({ ELEVENLABS_API_KEY: 'k', TRANSCRIBE: 'off' }), undefined);
  assert.equal(transcribeConfig({ ELEVENLABS_API_KEY: 'k', TRANSCRIBE_MAX_SECONDS: '120' })!.maxSeconds, 120);
  assert.deepEqual(ocrConfig({}), { languages: 'eng+fra+rus' });
  assert.equal(ocrConfig({ OCR: 'off' }), undefined);
  assert.deepEqual(ocrConfig({ OCR_LANGUAGES: 'eng; rm -rf /' }), { languages: 'eng+fra+rus' }, 'only language codes reach the command line');
});

test('transcribe: posts the audio to ElevenLabs speech to text, refuses long audio before any call', async () => {
  const cfg = { apiKey: 'secret', modelId: 'scribe_v1', maxSeconds: 60 };
  let calls = 0;
  const fake = (async (url: string | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal((init!.headers as Record<string, string>)['xi-api-key'], 'secret');
    const form = init!.body as FormData;
    assert.equal(form.get('model_id'), 'scribe_v1');
    assert.equal((form.get('file') as File).name, 'note.ogg');
    return new Response(JSON.stringify({ text: ' Привет, это я. ', language_code: 'rus' }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await transcribe(cfg, Buffer.from('OggS'), { filename: 'note.ogg', mimetype: 'audio/ogg', seconds: 5 }, fake), { text: 'Привет, это я.', language: 'rus' });
  await assert.rejects(transcribe(cfg, Buffer.from('OggS'), { seconds: 3600 }, fake), (e: unknown) => e instanceof MediaTextError && /TRANSCRIBE_MAX_SECONDS/.test((e as Error).message));
  assert.equal(calls, 1);
  const refused = (async () => new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'no credits' } }), { status: 402 })) as typeof fetch;
  await assert.rejects(transcribe(cfg, Buffer.from('x'), {}, refused), /quota/);
});

test('OCR output: tidied, and dropped when it is only noise', () => {
  assert.equal(cleanOcr('  T2 rue  Oberkampf\n\n\n\n1100 €  \f'), 'T2 rue Oberkampf\n\n1100 €');
  assert.equal(cleanOcr(' ~ |. ,\n'), undefined);
});

test('the cache keeps results encrypted, remembers empty ones, and forgets on clear', async () => {
  const db = openDatabase(':memory:');
  const cache = new MediaTextCache(db, [Buffer.alloc(32, 3)]);
  let runs = 0;
  const f = async () => (runs++, 'Loyer 1100 €');
  assert.deepEqual(await remembered(cache, 'ocr:a:1', f), { text: 'Loyer 1100 €', cached: false });
  assert.deepEqual(await remembered(cache, 'ocr:a:1', f), { text: 'Loyer 1100 €', cached: true });
  assert.equal(runs, 1);
  const row = db.prepare('SELECT text_enc FROM media_text').get() as { text_enc: Uint8Array };
  assert.ok(!Buffer.from(row.text_enc).toString('utf8').includes('Loyer'), 'stored encrypted');
  assert.deepEqual(await remembered(cache, 'ocr:a:2', async () => undefined), { text: undefined, cached: false });
  assert.deepEqual(await remembered(cache, 'ocr:a:2', f), { text: undefined, cached: true }, 'an image without text is not read again');
  cache.clear();
  assert.equal(cache.get('ocr:a:1'), undefined);
});

test('ocr reads the text of a screenshot', { skip: !hasTesseract && 'tesseract is not installed here' }, async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220"><rect width="100%" height="100%" fill="white"/><text x="30" y="90" font-family="DejaVu Sans, sans-serif" font-size="44">Appartement T2 1100 euros</text><text x="30" y="170" font-family="DejaVu Sans, sans-serif" font-size="44">Квартира на Бастилии</text></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const text = await ocr(png, { languages: 'eng+fra+rus' });
  assert.match(text ?? '', /Appartement T2 1100/);
  assert.match(text ?? '', /Квартира/);
});
