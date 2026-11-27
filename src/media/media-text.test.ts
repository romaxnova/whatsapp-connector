import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { openDatabase } from '../db.js';
import { cleanOcr, cleanTranscript, MediaTextCache, MediaTextError, ocr, ocrConfig, remembered, rememberedSoon, transcribe, transcribeConfig, transcribeLocally } from './media-text.js';

const hasTesseract = spawnSync('tesseract', ['--version']).status === 0;

test('transcription is on with the ElevenLabs key, OCR unless turned off', () => {
  const none = () => false;
  assert.equal(transcribeConfig({}, none), undefined, 'no key and no Whisper on this machine');
  assert.deepEqual(transcribeConfig({ ELEVENLABS_API_KEY: 'k' }, none), { provider: 'elevenlabs', apiKey: 'k', modelId: 'scribe_v1', maxSeconds: 600 });
  assert.equal(transcribeConfig({ ELEVENLABS_API_KEY: 'k', TRANSCRIBE: 'off' }), undefined);
  assert.equal(transcribeConfig({ ELEVENLABS_API_KEY: 'k', TRANSCRIBE_MAX_SECONDS: '120' }, none)!.maxSeconds, 120);
  // Without a key, Whisper on the server (free) whenever the image has it.
  const all = () => true;
  assert.deepEqual(transcribeConfig({ WHISPER_THREADS: '2' }, all), { provider: 'local', binary: '/opt/whisper/whisper-cli', model: '/opt/whisper/ggml-base-q5_1.bin', threads: 2, maxSeconds: 600 });
  assert.equal(transcribeConfig({ ELEVENLABS_API_KEY: 'k', TRANSCRIBE: 'local' }, all)!.provider, 'local', 'free even with a key');
  assert.equal(transcribeConfig({ TRANSCRIBE: 'elevenlabs' }, all), undefined);
  assert.equal(transcribeConfig({ TRANSCRIBE: 'off' }, all), undefined);
  assert.deepEqual(ocrConfig({}), { languages: 'eng+fra+rus' });
  assert.equal(ocrConfig({ OCR: 'off' }), undefined);
  assert.deepEqual(ocrConfig({ OCR_LANGUAGES: 'eng; rm -rf /' }), { languages: 'eng+fra+rus' }, 'only language codes reach the command line');
});

test('transcribe: posts the audio to ElevenLabs speech to text, refuses long audio before any call', async () => {
  const cfg = { provider: 'elevenlabs' as const, apiKey: 'secret', modelId: 'scribe_v1', maxSeconds: 60 };
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

test('Whisper output: one paragraph, without its silence and music markers', () => {
  assert.equal(cleanTranscript(' Salut Pierre,\n c\'est Philippe. [BLANK_AUDIO]\n\n(musique)\n'), "Salut Pierre, c'est Philippe.");
  assert.equal(cleanTranscript('[BLANK_AUDIO]\n'), '');
});

test('a long transcription goes on in the background, is remembered, and is not started twice', async () => {
  const db = openDatabase(':memory:');
  const cache = new MediaTextCache(db, [Buffer.alloc(32, 7)]);
  let runs = 0;
  let finish!: (t: string) => void;
  const slow = () => (runs++, new Promise<string>((r) => (finish = r)));
  assert.deepEqual(await rememberedSoon(cache, 'stt:a', slow, 20), { text: undefined, cached: false, pending: true });
  const again = rememberedSoon(cache, 'stt:a', slow, 1000);
  finish('Bonjour.');
  assert.deepEqual(await again, { text: 'Bonjour.', cached: false });
  assert.equal(runs, 1, 'the second call waited on the same job');
  assert.deepEqual(await rememberedSoon(cache, 'stt:a', slow, 20), { text: 'Bonjour.', cached: true });
  await assert.rejects(rememberedSoon(cache, 'stt:b', async () => { throw new MediaTextError('broken'); }, 1000), /broken/);
});

// Runs only where whisper.cpp and a model are installed (the Docker image, or WHISPER_BIN/WHISPER_MODEL/WHISPER_TEST_AUDIO set).
const local = transcribeConfig(process.env, existsSync);
const sample = process.env['WHISPER_TEST_AUDIO'];
test('Whisper on this server transcribes a voice note', { skip: !(local?.provider === 'local' && sample && existsSync(sample)) && 'whisper.cpp or WHISPER_TEST_AUDIO not here' }, async () => {
  const r = await transcribeLocally(local as Extract<typeof local, { provider: 'local' }>, readFileSync(sample!), { seconds: 30 });
  assert.match(r.text, /Pierre/);
  assert.equal(r.language, 'fr');
  await assert.rejects(transcribeLocally(local as Extract<typeof local, { provider: 'local' }>, Buffer.from('x'), { seconds: 99_999 }), /TRANSCRIBE_MAX_SECONDS/);
});
