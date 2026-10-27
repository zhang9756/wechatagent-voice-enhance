// Convert a staged WAV into 16 kHz mono 16-bit raw PCM for the SILK encoder.
//
//   node scripts/wav-to-pcm.mjs <in.wav> <out.pcm> [rate]

import fs from 'node:fs';
import path from 'node:path';
import { parseWav, toMono16k } from '../lib/wav.mjs';

const [, , input, output, rateArg] = process.argv;
if (!input || !output) {
  console.error('usage: node wav-to-pcm.mjs <in.wav> <out.pcm> [rate]');
  process.exit(2);
}
const rate = Number(rateArg) || 16000;
const buffer = fs.readFileSync(input);
const info = parseWav(buffer);
const mono = toMono16k(buffer, rate);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, mono.pcm);
console.log(JSON.stringify({
  input, inputRate: info.sampleRate, inputMs: info.durationMs,
  output, outputRate: mono.sampleRate, pcmBytes: mono.pcm.length, outputMs: mono.durationMs,
}));
