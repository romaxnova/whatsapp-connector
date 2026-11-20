#!/usr/bin/env node
// Says one phrase with several ElevenLabs voices and models, and saves each as an MP3 to compare by ear.
//
//   ELEVENLABS_API_KEY=... node scripts/voice-preview.mjs --list
//   ELEVENLABS_API_KEY=... node scripts/voice-preview.mjs \
//     --voices iP95p4xoKVk53GoZ742B,N2lVS1w4EtoT3dr4eOWO \
//     --models eleven_multilingual_v2,eleven_v3 \
//     --tags "[strong French accent] [playful]" \
//     --text "Привет! Это я, твой голосовой помощник. Ну что, сегодня идём ужинать?"
//
// Tags are only sent to eleven_v3 models. Every sample costs its characters from the monthly quota
// (10,000 on the free plan): the script prints the total before it starts. Free accounts can only use
// their own voices and the built-in ones through the API (library voices need a paid plan).
import { mkdirSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []),
);
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('Set ELEVENLABS_API_KEY.');
  process.exit(1);
}
const api = (path, init = {}) => fetch(`https://api.elevenlabs.io${path}`, { ...init, headers: { 'xi-api-key': key, 'content-type': 'application/json', ...(init.headers ?? {}) } });

if (args.list) {
  const { voices } = await (await api('/v1/voices')).json();
  for (const v of voices) console.log(`${v.voice_id}  ${v.name}  [${v.category}; ${v.labels?.gender ?? '?'}; ${v.labels?.accent ?? '?'}]`);
  const sub = await (await api('/v1/user/subscription')).json();
  console.log(`\nQuota: ${sub.character_count} of ${sub.character_limit} characters used this month.`);
  process.exit(0);
}

const text = args.text ?? 'Привет! Это я, твой голосовой помощник. Ну что, сегодня идём ужинать?';
const voices = (args.voices ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const models = (args.models ?? 'eleven_multilingual_v2,eleven_v3').split(',').map((s) => s.trim()).filter(Boolean);
const tags = args.tags && args.tags !== 'true' ? `${args.tags.trim()} ` : '';
if (!voices.length) {
  console.error('Give --voices id1,id2 (see --list).');
  process.exit(1);
}
const jobs = voices.flatMap((voice) => models.map((model) => ({ voice, model, text: model.startsWith('eleven_v3') ? tags + text : text })));
console.log(`${jobs.length} samples, ${jobs.reduce((n, j) => n + j.text.length, 0)} characters of quota.`);
const dir = args.out ?? 'voice-previews';
mkdirSync(dir, { recursive: true });
for (const [i, j] of jobs.entries()) {
  const res = await api(`/v1/text-to-speech/${j.voice}?output_format=mp3_44100_128`, { method: 'POST', body: JSON.stringify({ text: j.text, model_id: j.model }) });
  if (!res.ok) {
    console.log(`✗ ${j.voice} ${j.model}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    continue;
  }
  const file = `${dir}/${String(i + 1).padStart(2, '0')}_${j.voice}_${j.model}.mp3`;
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`✓ ${file}`);
}
