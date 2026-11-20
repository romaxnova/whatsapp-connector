/**
 * Voice messages: text → speech (ElevenLabs) → a voice note WhatsApp and Telegram
 * play as such (Ogg Opus, mono, 48 kHz, no metadata), with its duration and
 * waveform. Shared, file for file, by the WhatsApp and Telegram connectors.
 *
 * The API key only ever comes from the environment (ELEVENLABS_API_KEY): the
 * code is public and every person deploys their own copy with their own key.
 */
import { spawn } from 'node:child_process';

export interface VoiceConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  maxChars: number;
  /** Audio tags said before every text with eleven_v3 when no style is asked for, e.g. "[strong French accent] [playful]". */
  styleTags?: string;
}

export const DEFAULT_VOICE_MODEL = 'eleven_multilingual_v2';
export const DEFAULT_VOICE_MAX_CHARS = 600;

export class VoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceError';
  }
}

/** The voice settings from the environment; undefined when voice messages are not set up. */
export function voiceConfig(env: NodeJS.ProcessEnv): VoiceConfig | undefined {
  const apiKey = env['ELEVENLABS_API_KEY']?.trim();
  const voiceId = env['ELEVENLABS_VOICE_ID']?.trim();
  if (!apiKey || !voiceId) return undefined;
  const max = Number(env['VOICE_MAX_CHARS']?.trim() || DEFAULT_VOICE_MAX_CHARS);
  return {
    apiKey,
    voiceId,
    modelId: env['ELEVENLABS_MODEL_ID']?.trim() || DEFAULT_VOICE_MODEL,
    maxChars: Number.isInteger(max) && max > 0 ? Math.min(max, 5000) : DEFAULT_VOICE_MAX_CHARS,
    ...(env['ELEVENLABS_STYLE_TAGS']?.trim() ? { styleTags: env['ELEVENLABS_STYLE_TAGS'].trim() } : {}),
  };
}

/** The model that understands audio tags, used whenever a style is asked for. */
export const EXPRESSIVE_VOICE_MODEL = 'eleven_v3';

/**
 * A delivery asked for in a request ("strong West African accent, playful") as audio
 * tags ("[strong West African accent] [playful]"). Tags already in brackets are kept as they are.
 */
export function styleTags(style: string): string {
  const s = style.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!s) return '';
  // Words outside brackets would be read aloud: keep only the tags.
  if (s.includes('[')) return (s.match(/\[[^[\]]{1,80}\]/g) ?? []).join(' ');
  return s
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `[${part.replace(/[[\]]/g, '')}]`)
    .join(' ');
}

/** The model and the text actually sent to ElevenLabs for a text and an optional style. */
export function voicePlan(cfg: VoiceConfig, text: string, opts: { modelId?: string; style?: string } = {}): { modelId: string; spoken: string; tags?: string } {
  const asked = opts.style ? styleTags(opts.style) : '';
  // Audio tags ([French accent], [laughs]…) are only understood by the v3 models; other models would read them aloud.
  const modelId = opts.modelId ?? (asked && !/^eleven_v3/.test(cfg.modelId) ? EXPRESSIVE_VOICE_MODEL : cfg.modelId);
  const tags = /^eleven_v3/.test(modelId) ? asked || cfg.styleTags : undefined;
  return { modelId, spoken: tags ? `${tags} ${text}` : text, ...(tags ? { tags } : {}) };
}

/** Speech for a text, as MP3, from ElevenLabs, said in the style asked for if any. */
export async function synthesize(cfg: VoiceConfig, text: string, opts: { voiceId?: string; modelId?: string; style?: string } = {}, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const clean = text.trim();
  if (!clean) throw new VoiceError('The text to say is empty.');
  if (clean.length > cfg.maxChars) {
    throw new VoiceError(`The text is ${clean.length} characters; voice messages are limited to ${cfg.maxChars} (VOICE_MAX_CHARS) to spare the ElevenLabs quota. Shorten it or send it as text.`);
  }
  const { modelId, spoken } = voicePlan(cfg, clean, opts);
  const voiceId = (opts.voiceId ?? cfg.voiceId).trim();
  if (!/^[A-Za-z0-9]{8,40}$/.test(voiceId)) throw new VoiceError('The voice id is not valid.');
  let res: Response;
  try {
    res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': cfg.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: spoken, model_id: modelId, ...(/^eleven_v3/.test(modelId) ? {} : { voice_settings: { stability: 0.5, similarity_boost: 0.75 } }) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new VoiceError(`ElevenLabs could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      const d = (JSON.parse(body) as { detail?: { status?: string; message?: string } | string }).detail;
      detail = typeof d === 'string' ? d : [d?.status, d?.message].filter(Boolean).join(': ') || detail;
    } catch {
      /* not JSON */
    }
    if (res.status === 401) throw new VoiceError(`ElevenLabs refused the API key (${detail}). Check ELEVENLABS_API_KEY.`);
    if (/quota/i.test(detail)) throw new VoiceError(`The ElevenLabs quota for this month is used up (${detail}).`);
    throw new VoiceError(`ElevenLabs refused (${res.status}): ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Runs ffmpeg with stdin → stdout. */
function ffmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new VoiceError(`ffmpeg could not start: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => reject(new VoiceError(`ffmpeg is not available on this server (${e.message}).`)));
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new VoiceError(`ffmpeg failed: ${err.slice(0, 300)}`))));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

export interface VoiceNote {
  /** Ogg Opus, mono, 48 kHz, without metadata (chapter tags break playback on iPhone). */
  ogg: Buffer;
  seconds: number;
  /** 64 amplitudes 0–100, as WhatsApp draws them. */
  waveform: Uint8Array;
  /** 100 amplitudes 0–31, as Telegram expects them (packed with telegramWaveform). */
  levels100: number[];
}

/** Amplitude envelope of PCM s16le samples, in `bars` buckets scaled to 0..top. */
export function envelope(pcm: Buffer, bars: number, top: number): number[] {
  const n = Math.floor(pcm.length / 2);
  if (!n) return new Array(bars).fill(0);
  const per = Math.max(1, Math.floor(n / bars));
  const raw: number[] = [];
  for (let b = 0; b < bars; b++) {
    let sum = 0;
    let count = 0;
    for (let i = b * per; i < Math.min(n, (b + 1) * per); i++) {
      sum += Math.abs(pcm.readInt16LE(i * 2));
      count++;
    }
    raw.push(count ? sum / count : 0);
  }
  const max = Math.max(...raw) || 1;
  return raw.map((v) => Math.round((v / max) * top));
}

/** Telegram's waveform: values 0–31 packed 5 bits each, least significant bit first. */
export function telegramWaveform(levels: number[]): Buffer {
  const bits = levels.length * 5;
  const out = Buffer.alloc(Math.ceil(bits / 8));
  levels.forEach((v, i) => {
    const value = Math.max(0, Math.min(31, Math.round(v)));
    for (let k = 0; k < 5; k++) {
      if ((value >> k) & 1) {
        const bit = i * 5 + k;
        out[bit >> 3]! |= 1 << (bit & 7);
      }
    }
  });
  return out;
}

/** Any audio (MP3 from ElevenLabs) → a voice note with its duration and waveform. */
export async function toVoiceNote(audio: Buffer): Promise<VoiceNote> {
  const ogg = await ffmpeg(['-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-map_metadata', '-1', '-f', 'ogg', 'pipe:1'], audio);
  const pcm = await ffmpeg(['-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], ogg);
  const seconds = Math.max(1, Math.round(pcm.length / 2 / 8000));
  return { ogg, seconds, waveform: Uint8Array.from(envelope(pcm, 64, 100)), levels100: envelope(pcm, 100, 31) };
}
