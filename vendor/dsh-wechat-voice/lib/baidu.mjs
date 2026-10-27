// Baidu Fanyi online TTS. This is the fallback that keeps replies sounding
// human when Edge Read Aloud is unreachable from this network (both endpoints
// can answer 403/200 depending on region and time of day).
//
// The endpoint is keyless but public, so it is deliberately only used for the
// text the owner already chose to send, and `engine: 'sapi'` opts out entirely.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { wrapPcm16 } from './wav.mjs';
import { applyGain, decodeMp3ToMono, pcm16FromFloat } from './mp3.mjs';

export const BAIDU_ENDPOINT = 'https://fanyi.baidu.com/gettts';
export const BAIDU_VOICE = '百度自然女声';

const BAIDU_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const BAIDU_MAX_CHARS = 600;

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

/** Map the plugin's -10..10 rate onto Baidu's spd=1..9 (5 is neutral). */
export function baiduSpeed(rate = 0) {
  const number = Number(rate);
  const clamped = Number.isFinite(number) ? Math.max(-10, Math.min(10, Math.round(number))) : 0;
  return Math.max(3, Math.min(7, 5 + Math.round(clamped / 5)));
}

export function baiduUrl({ text, rate = 0 } = {}) {
  const params = new URLSearchParams({
    lan: 'zh',
    text: String(text ?? ''),
    spd: String(baiduSpeed(rate)),
    source: 'web',
  });
  return `${BAIDU_ENDPOINT}?${params.toString()}`;
}

function looksLikeMp3(buffer) {
  if (buffer.length < 3) return false;
  if (buffer.subarray(0, 3).toString('latin1') === 'ID3') return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

async function requestBaiduMp3({ text, rate, timeoutMs = 20000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Math.min(30000, timeoutMs)));
  let response;
  try {
    response = await fetch(baiduUrl({ text, rate }), {
      signal: controller.signal,
      headers: {
        'User-Agent': BAIDU_USER_AGENT,
        Referer: 'https://fanyi.baidu.com/',
        Accept: 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
      },
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    throw coded(timedOut ? 'TTS_BAIDU_TIMEOUT' : 'TTS_BAIDU_NETWORK', {
      detail: timedOut ? 'request timeout' : String(error?.message ?? error),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw coded('TTS_BAIDU_NETWORK', { detail: `HTTP ${response.status}` });
  const type = String(response.headers.get('content-type') ?? '');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw coded('TTS_BAIDU_EMPTY', { detail: type || 'empty body' });
  if (!/audio|mpeg|octet-stream/i.test(type) && !looksLikeMp3(buffer)) {
    throw coded('TTS_BAIDU_EMPTY', { detail: `${type || 'unknown type'}: ${buffer.toString('utf8', 0, 160)}` });
  }
  return buffer;
}

/**
 * Synthesize through Baidu into `outPath` (16-bit mono WAV). The service
 * returns 16 kHz MP3; SILK encoding resamples it to 16 kHz anyway.
 */
export async function synthesizeBaidu({ text, outPath, rate = 0, volume = 100, timeoutMs = 20000 } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) throw coded('TTS_TEXT_EMPTY');
  if (value.length > BAIDU_MAX_CHARS) throw coded('TTS_ARGUMENTS_INVALID', { detail: `text longer than ${BAIDU_MAX_CHARS}` });
  if (!outPath) throw coded('TTS_ARGUMENTS_INVALID', { detail: 'missing outPath' });

  const mp3 = await requestBaiduMp3({ text: value, rate, timeoutMs });
  let decoded;
  try {
    decoded = await decodeMp3ToMono(mp3);
  } catch (error) {
    if (error?.code === 'TTS_MP3_DEPENDENCY') throw coded('TTS_BAIDU_DEPENDENCY', { detail: error.detail });
    if (error?.code === 'TTS_MP3_EMPTY') throw coded('TTS_BAIDU_EMPTY', { detail: error.detail });
    throw coded('TTS_BAIDU_DECODE_FAILED', { detail: error?.detail ?? String(error?.message ?? error) });
  }
  const samples = applyGain(decoded.samples, volume);
  const wav = wrapPcm16(pcm16FromFloat(samples), decoded.sampleRate, 1);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, wav);
  return {
    path: outPath,
    bytes: wav.length,
    durationMs: Math.round((samples.length / decoded.sampleRate) * 1000),
    sampleRate: decoded.sampleRate,
    channels: 1,
    engine: 'baidu',
    voice: BAIDU_VOICE,
    mp3Bytes: mp3.length,
  };
}
