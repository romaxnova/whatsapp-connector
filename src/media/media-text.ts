/**
 * Text from media, done only when Claude opens a file:
 * - voice notes and audio are transcribed by ElevenLabs Speech to Text (Scribe) when
 *   ELEVENLABS_API_KEY is set, and otherwise for free on this server by Whisper (whisper.cpp,
 *   built into the image), so the audio never leaves it;
 * - photos are read by Tesseract OCR on this server: they never leave it.
 * Results are remembered, encrypted, so each file costs once. Shared, file for file, by the
 * WhatsApp and Telegram connectors.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { decryptBytes, deriveKey, encryptBytes } from '../crypto.js';
import type { Db } from '../db.js';

export type TranscribeConfig = ElevenLabsTranscribe | LocalTranscribe;

export interface ElevenLabsTranscribe {
  provider: 'elevenlabs';
  apiKey: string;
  modelId: string;
  /** Longest audio transcribed, to spare the ElevenLabs quota. */
  maxSeconds: number;
}

/** Whisper on this server: free, private, a few times faster than real time on a small server. */
export interface LocalTranscribe {
  provider: 'local';
  /** whisper.cpp's command-line program. */
  binary: string;
  /** Its model file (ggml). */
  model: string;
  threads: number;
  /** Longest audio transcribed, to bound the time and CPU one file takes. */
  maxSeconds: number;
}

export interface OcrConfig {
  /** Tesseract languages, e.g. "eng+fra+rus". */
  languages: string;
}

export const DEFAULT_STT_MODEL = 'scribe_v1';
export const DEFAULT_TRANSCRIBE_MAX_SECONDS = 600;
/** Where the image puts whisper.cpp and its multilingual "small" model (quantized, 181 MB; clearly better than "base" in Russian). */
export const DEFAULT_WHISPER_BIN = '/opt/whisper/whisper-cli';
export const DEFAULT_WHISPER_MODEL = '/opt/whisper/ggml-small-q5_1.bin';
export const DEFAULT_OCR_LANGUAGES = 'eng+fra+rus';
/** Bigger files are not sent for transcription (a voice note of 10 minutes is about 5 MB). */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

export class MediaTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaTextError';
  }
}

const off = (v: string | undefined) => /^(0|false|off|no)$/i.test(v?.trim() ?? '');

/**
 * Transcription settings. TRANSCRIBE: "auto" (default) uses ElevenLabs when ELEVENLABS_API_KEY is
 * set and Whisper on this server otherwise; "local" always uses Whisper (free, even with a key);
 * "elevenlabs" only ElevenLabs; "off" none.
 */
export function transcribeConfig(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): TranscribeConfig | undefined {
  const mode = (env['TRANSCRIBE']?.trim().toLowerCase() || 'auto').replace(/^(1|true|on|yes)$/, 'auto');
  if (off(mode)) return undefined;
  const max = Number(env['TRANSCRIBE_MAX_SECONDS']?.trim() || DEFAULT_TRANSCRIBE_MAX_SECONDS);
  const maxSeconds = Number.isFinite(max) && max > 0 ? Math.min(max, 7200) : DEFAULT_TRANSCRIBE_MAX_SECONDS;
  const apiKey = env['ELEVENLABS_API_KEY']?.trim();
  if (apiKey && mode !== 'local') return { provider: 'elevenlabs', apiKey, modelId: env['ELEVENLABS_STT_MODEL_ID']?.trim() || DEFAULT_STT_MODEL, maxSeconds };
  if (mode === 'elevenlabs') return undefined;
  const binary = env['WHISPER_BIN']?.trim() || DEFAULT_WHISPER_BIN;
  const model = env['WHISPER_MODEL']?.trim() || DEFAULT_WHISPER_MODEL;
  if (!exists(binary) || !exists(model)) return undefined;
  const threads = Number(env['WHISPER_THREADS']?.trim() || Math.min(4, availableParallelism()));
  return { provider: 'local', binary, model, threads: Number.isInteger(threads) ? Math.max(1, Math.min(threads, 16)) : 4, maxSeconds };
}

/** OCR settings: on unless OCR=off. */
export function ocrConfig(env: NodeJS.ProcessEnv): OcrConfig | undefined {
  if (off(env['OCR'])) return undefined;
  const langs = env['OCR_LANGUAGES']?.trim() || DEFAULT_OCR_LANGUAGES;
  return { languages: /^[a-z_]{3,10}(\+[a-z_]{3,10})*$/i.test(langs) ? langs : DEFAULT_OCR_LANGUAGES };
}

/** The words of a voice note or an audio file, from ElevenLabs or from Whisper on this server. */
export async function transcribe(
  cfg: TranscribeConfig,
  audio: Buffer,
  opts: { filename?: string; mimetype?: string; seconds?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; language?: string }> {
  if (cfg.provider === 'local') return transcribeLocally(cfg, audio, opts);
  if (opts.seconds !== undefined && opts.seconds > cfg.maxSeconds) {
    throw new MediaTextError(`It lasts ${Math.round(opts.seconds / 60)} minutes; transcription stops at ${Math.round(cfg.maxSeconds / 60)} (TRANSCRIBE_MAX_SECONDS) to spare the ElevenLabs quota.`);
  }
  if (audio.length > MAX_TRANSCRIBE_BYTES) throw new MediaTextError('The file is too big to transcribe here (25 MB at most).');
  const form = new FormData();
  form.append('model_id', cfg.modelId);
  form.append('tag_audio_events', 'false');
  form.append('file', new Blob([new Uint8Array(audio)], { type: opts.mimetype || 'application/octet-stream' }), opts.filename || 'audio');
  let res: Response;
  try {
    res = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey, accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new MediaTextError(`ElevenLabs could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      const d = (JSON.parse(body) as { detail?: { status?: string; message?: string } | string }).detail;
      detail = typeof d === 'string' ? d : [d?.status, d?.message].filter(Boolean).join(': ') || detail;
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new MediaTextError(`ElevenLabs refused the API key (${detail}). Check ELEVENLABS_API_KEY.`);
    if (/quota|credits/i.test(detail)) throw new MediaTextError(`The ElevenLabs quota for this month is used up (${detail}).`);
    throw new MediaTextError(`ElevenLabs could not transcribe it (${res.status}): ${detail}`);
  }
  let parsed: { text?: string; language_code?: string };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new MediaTextError('ElevenLabs answered something unexpected.');
  }
  return { text: (parsed.text ?? '').trim(), ...(parsed.language_code ? { language: parsed.language_code } : {}) };
}

/** One local transcription at a time: each uses several cores and about 400 MB while it runs. */
let localQueue: Promise<unknown> = Promise.resolve();

/** About how long Whisper takes on this server for audio of that length (seconds). */
export function localEstimate(seconds: number | undefined, threads = 4): number {
  return Math.ceil(((seconds ?? 60) * (threads >= 4 ? 0.22 : 0.35)) + 3);
}

/**
 * Whisper (whisper.cpp) on this server: ffmpeg turns the audio into 16 kHz mono, whisper-cli finds
 * the language and writes the words. Nothing leaves the server; temporary files are deleted.
 */
export async function transcribeLocally(cfg: LocalTranscribe, audio: Buffer, opts: { seconds?: number } = {}): Promise<{ text: string; language?: string }> {
  if (opts.seconds !== undefined && opts.seconds > cfg.maxSeconds) {
    throw new MediaTextError(`It lasts ${Math.round(opts.seconds / 60)} minutes; transcription on this server stops at ${Math.round(cfg.maxSeconds / 60)} (TRANSCRIBE_MAX_SECONDS).`);
  }
  if (audio.length > MAX_TRANSCRIBE_BYTES) throw new MediaTextError('The file is too big to transcribe here (25 MB at most).');
  const job = localQueue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stt-'));
    try {
      const input = join(dir, 'in');
      const wav = join(dir, 'speech.wav');
      await writeFile(input, audio, { mode: 0o600 });
      await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-t', String(cfg.maxSeconds), '-c:a', 'pcm_s16le', wav], Buffer.alloc(0), 120_000);
      const seconds = Math.max(1, ((await stat(wav)).size - 44) / 32_000);
      const { stdout, stderr } = await runBoth(cfg.binary, ['-m', cfg.model, '-f', wav, '-l', 'auto', '-t', String(cfg.threads), '-nt'], Math.max(120_000, seconds * 4_000));
      const language = /auto-detected language: ([a-z]{2,3})/.exec(stderr)?.[1];
      return { text: cleanTranscript(stdout), ...(language ? { language } : {}) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  localQueue = job.catch(() => undefined);
  return job;
}

/** Whisper's output as plain text: one paragraph, without its markers for silence or music. */
export function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((l) => l.replace(/\[(?:BLANK_AUDIO|MUSIC|Music|music|NOISE|silence|Silence)\]|\((?:music|musique|музыка)\)/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Runs a program, killed after a timeout; its output and the end of its log. */
function runBoth(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new MediaTextError(`${cmd} could not start: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-16_000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new MediaTextError(`Speech recognition is not available on this server (${e.message}).`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new MediaTextError('Speech recognition took too long.'));
      else if (code === 0) resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: err });
      else reject(new MediaTextError(`Speech recognition failed: ${err.slice(-200)}`));
    });
  });
}

/** Runs a program with stdin → stdout, killed after a timeout. */
function run(cmd: string, args: string[], input: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new MediaTextError(`${cmd} could not start: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new MediaTextError(`${cmd} is not available on this server (${e.message}).`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new MediaTextError(`${cmd} took too long.`));
      else if (code === 0) resolve(Buffer.concat(out));
      else reject(new MediaTextError(`${cmd} failed: ${err.slice(0, 200)}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/**
 * The text in an image, from Tesseract, or undefined when there is hardly any. The image is
 * turned grey and enlarged when small, which reads screenshots and phone photos better.
 */
export async function ocr(image: Buffer, cfg: OcrConfig, timeoutMs = 45_000): Promise<string | undefined> {
  let png: Buffer;
  try {
    const img = sharp(image, { failOn: 'none', limitInputPixels: 80_000_000 }).rotate();
    const { width = 0 } = await img.metadata();
    png = await img
      .resize({ width: width && width < 1200 ? Math.min(width * 2, 2400) : Math.min(width || 3000, 3000), withoutEnlargement: false })
      .grayscale()
      .normalize()
      .png({ compressionLevel: 1 })
      .toBuffer();
  } catch {
    throw new MediaTextError('This image could not be prepared for text recognition.');
  }
  const out = await run('tesseract', ['stdin', 'stdout', '-l', cfg.languages, '--psm', '3'], png, timeoutMs);
  return cleanOcr(out.toString('utf8'));
}

/** Tidies Tesseract's output and drops it when it holds no real words (noise from a photo). */
export function cleanOcr(raw: string): string | undefined {
  const lines = raw
    .replace(/\f/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const words = text.match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return words.length >= 2 ? text : undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media_text (
  ref TEXT PRIMARY KEY,
  text_enc BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** Transcripts and OCR results, encrypted, kept for 180 days: a file is transcribed or read once. */
export class MediaTextCache {
  private readonly keys: Buffer[];

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
    private readonly now: () => number = Date.now,
  ) {
    this.keys = masterKeys.filter((k): k is Buffer => Boolean(k)).map((k) => deriveKey(k, 'media-text'));
    db.exec(SCHEMA);
  }

  get(ref: string): string | undefined {
    const row = this.db.prepare('SELECT text_enc FROM media_text WHERE ref = ?').get(ref) as { text_enc: Uint8Array } | undefined;
    if (!row) return undefined;
    try {
      return decryptBytes(row.text_enc, this.keys, ref).toString('utf8');
    } catch {
      return undefined;
    }
  }

  put(ref: string, text: string): void {
    const blob = encryptBytes(Buffer.from(text, 'utf8'), this.keys[0]!, ref);
    this.db.prepare('INSERT INTO media_text (ref, text_enc, created_at) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET text_enc = excluded.text_enc, created_at = excluded.created_at').run(ref, blob, this.now());
    this.db.prepare('DELETE FROM media_text WHERE created_at < ?').run(this.now() - 180 * 24 * 3600 * 1000);
  }

  /** Forgets everything (when the account is unlinked or logged out). */
  clear(): void {
    this.db.prepare('DELETE FROM media_text').run();
  }
}

/** Runs f once per ref: from the cache when it was done before. An empty result is remembered too. */
const inflight = new Map<string, Promise<string | undefined>>();

/**
 * Like remembered(), but waits at most waitMs: a longer job goes on in the background and is
 * remembered when done, and a second call meanwhile waits on the same job instead of starting another.
 */
export async function rememberedSoon(
  cache: MediaTextCache | undefined,
  ref: string,
  f: () => Promise<string | undefined>,
  waitMs: number,
): Promise<{ text: string | undefined; cached: boolean; pending?: true }> {
  const hit = cache?.get(ref);
  if (hit !== undefined) return { text: hit || undefined, cached: true };
  let job = inflight.get(ref);
  if (!job) {
    job = f().then((text) => {
      cache?.put(ref, text ?? '');
      return text;
    });
    const done = job.finally(() => inflight.delete(ref));
    done.catch(() => undefined);
    inflight.set(ref, job);
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), waitMs)));
  try {
    const r = await Promise.race([job, late]);
    return r === 'late' ? { text: undefined, cached: false, pending: true } : { text: r, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function remembered(cache: MediaTextCache | undefined, ref: string, f: () => Promise<string | undefined>): Promise<{ text: string | undefined; cached: boolean }> {
  const hit = cache?.get(ref);
  if (hit !== undefined) return { text: hit || undefined, cached: true };
  const text = await f();
  cache?.put(ref, text ?? '');
  return { text, cached: false };
}
