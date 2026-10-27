// WAV -> WeChat SILK. The hook's /SendVoiceMsg accepts the on-disk client
// format only: 0x02, "#!SILK_V3", then the encoder's frame stream. The encoder
// is the official SILK SDK built locally (see docs/VOICE_BUBBLE_RE.md) and is
// invoked with -tencent so it emits that leading byte.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWav, toMono16k } from './wav.mjs';

const run = promisify(execFile);
const RATE = 16000;
const MIN_MS = 1000;
const MAX_MS = 60000;
const MAX_BYTES = 16 * 1024 * 1024;

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

export function encoderPath(root) {
  return process.env.WECHAT_VOICE_SILK_ENCODER || path.join(root, 'state', 'silk', 'bin', 'silk_encoder.exe');
}

/**
 * Encode one staged WAV next to itself (`<name>.silk`). Recordings shorter than
 * one second are padded with silence: WeChat's own recorder refuses < 1 s, and
 * the bubble duration must match what the client expects.
 */
export async function encodeSilk({ root, wavPath, timeoutMs = 20000 } = {}) {
  const encoder = encoderPath(root);
  if (!fs.existsSync(encoder)) throw coded('SILK_ENCODER_MISSING', { detail: encoder });
  if (!wavPath || path.extname(wavPath).toLowerCase() !== '.wav') throw coded('SILK_INPUT_INVALID', { detail: String(wavPath ?? '') });

  const buffer = await fsp.readFile(wavPath);
  const source = parseWav(buffer);
  const mono = toMono16k(buffer, RATE);
  let durationMs = mono.durationMs;
  let pcm = mono.pcm;
  if (durationMs < MIN_MS) {
    const missing = (MIN_MS - durationMs) * (RATE / 1000);
    pcm = Buffer.concat([pcm, Buffer.alloc(Math.ceil(missing) * 2)]);
    durationMs = MIN_MS;
  }
  if (durationMs > MAX_MS) throw coded('SILK_TOO_LONG', { durationMs, maxMs: MAX_MS });

  const dir = path.dirname(wavPath);
  const stem = path.basename(wavPath, path.extname(wavPath));
  const stamp = process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const target = path.join(dir, stem + '.silk');
  const tempPcm = path.join(dir, '.' + stem + '.' + stamp + '.pcm');
  const tempSilk = path.join(dir, '.' + stem + '.' + stamp + '.silk');
  await fsp.writeFile(tempPcm, pcm);
  try {
    let silk;
    try {
      await run(encoder, [tempPcm, tempSilk, '-Fs_API', String(RATE), '-tencent', '-quiet'], {
        timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
      });
      silk = await fsp.readFile(tempSilk);
    } catch (error) {
      throw coded('SILK_ENCODE_FAILED', { detail: String(error?.stderr ?? error?.message ?? error).slice(0, 300) });
    }
    if (silk.length < 10 || silk.length > MAX_BYTES || silk[0] !== 0x02 || silk.toString('ascii', 1, 10) !== '#!SILK_V3') {
      throw coded('SILK_OUTPUT_INVALID', { bytes: silk.length });
    }
    const temp = target + '.' + stamp + '.tmp';
    await fsp.writeFile(temp, silk);
    await fsp.rename(temp, target);
    return { path: target, bytes: silk.length, durationMs, sourceRate: source.sampleRate, sourceMs: source.durationMs };
  } finally {
    try { await fsp.unlink(tempPcm); } catch { /* best effort */ }
    try { await fsp.unlink(tempSilk); } catch { /* best effort */ }
  }
}
