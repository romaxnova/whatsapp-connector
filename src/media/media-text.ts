/**
 * Text from media, done only when Claude opens a file:
 * - voice notes and audio are transcribed by ElevenLabs Speech to Text (Scribe), with the
 *   ELEVENLABS_API_KEY the voice messages already use;
 * - photos are read by Tesseract OCR on this server: they never leave it.
 * Results are remembered, encrypted, so each file costs once. Shared, file for file, by the
 * WhatsApp and Telegram connectors.
 */
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { decryptBytes, deriveKey, encryptBytes } from '../crypto.js';
import type { Db } from '../db.js';

export interface TranscribeConfig {
  apiKey: string;
  modelId: string;
  /** Longest audio transcribed, to spare the ElevenLabs quota. */
  maxSeconds: number;
}

export interface OcrConfig {
  /** Tesseract languages, e.g. "eng+fra+rus". */
  languages: string;
}

export const DEFAULT_STT_MODEL = 'scribe_v1';
export const DEFAULT_TRANSCRIBE_MAX_SECONDS = 600;
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

/** Transcription settings: on whenever ELEVENLABS_API_KEY is set, unless TRANSCRIBE=off. */
export function transcribeConfig(env: NodeJS.ProcessEnv): TranscribeConfig | undefined {
  const apiKey = env['ELEVENLABS_API_KEY']?.trim();
  if (!apiKey || off(env['TRANSCRIBE'])) return undefined;
  const max = Number(env['TRANSCRIBE_MAX_SECONDS']?.trim() || DEFAULT_TRANSCRIBE_MAX_SECONDS);
  return {
    apiKey,
    modelId: env['ELEVENLABS_STT_MODEL_ID']?.trim() || DEFAULT_STT_MODEL,
    maxSeconds: Number.isFinite(max) && max > 0 ? Math.min(max, 7200) : DEFAULT_TRANSCRIBE_MAX_SECONDS,
  };
}

/** OCR settings: on unless OCR=off. */
export function ocrConfig(env: NodeJS.ProcessEnv): OcrConfig | undefined {
  if (off(env['OCR'])) return undefined;
  const langs = env['OCR_LANGUAGES']?.trim() || DEFAULT_OCR_LANGUAGES;
  return { languages: /^[a-z_]{3,10}(\+[a-z_]{3,10})*$/i.test(langs) ? langs : DEFAULT_OCR_LANGUAGES };
}

/** The words of a voice note or an audio file, from ElevenLabs. */
export async function transcribe(
  cfg: TranscribeConfig,
  audio: Buffer,
  opts: { filename?: string; mimetype?: string; seconds?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; language?: string }> {
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
export async function remembered(cache: MediaTextCache | undefined, ref: string, f: () => Promise<string | undefined>): Promise<{ text: string | undefined; cached: boolean }> {
  const hit = cache?.get(ref);
  if (hit !== undefined) return { text: hit || undefined, cached: true };
  const text = await f();
  cache?.put(ref, text ?? '');
  return { text, cached: false };
}
