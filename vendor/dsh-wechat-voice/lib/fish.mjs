// Fish Audio online TTS (api.fish.audio). This is the expressive-engine option:
// S2-Pro / Drama 3 support inline emotion tags (`[laughing]`, `[whisper]`) and
// voice cloning from a 10-30 s reference, which the local SAPI voices cannot do.
//
// Why an HTTP client instead of running the weights locally: S2-Pro is 9.1 GB of
// weights and Drama 3 is 39.6 GB, so neither fits an 8 GB laptop GPU. The API
// path costs no VRAM at all and speaks with exactly the model from the docs.
//
// The endpoint and payload mirror the official `POST /v1/tts` shape
// (fish_speech ServeTTSRequest: text / format / reference_id / latency /
// normalize / chunk_length), so the same module also drives a self-hosted
// `tools/api_server.py` that has 24 GB+ of VRAM.

import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { wrapPcm16, parseWav } from './wav.mjs';
import { applyGain, decodeMp3ToMono, pcm16FromFloat, trimFloatSilence } from './mp3.mjs';

export const FISH_ENDPOINT = 'https://api.fish.audio/v1/tts';
// Official rules (docs.fish.audio/features/text-to-speech):
//   - the model is chosen with the `model` REQUEST HEADER, not a URL segment;
//   - requests without the header fall back to s2.1-pro;
//   - speed is `prosody.speed`, range 0.5–2.0.
export const FISH_MODELS = [
  { id: 's2.1-pro', label: 'S2.1-Pro · 官方推荐，质量与延迟更好' },
  { id: 's2.1-pro-free', label: 'S2.1-Pro 免费版 · 开发测试用，$0' },
  { id: 's2-pro', label: 'S2-Pro · 上一代，多说话人' },
  { id: 'drama-3', label: 'Drama 3 · 剧本式，可精修' },
];
export const FISH_DEFAULT_MODEL = 's2.1-pro';
// Shown in status and in the WeChat bubble list of voices; a reference_id from
// https://fish.audio/m/<id>/ is what actually replaces it once cloned.
export const FISH_VOICE = 'Fish Audio 默认音色';

const FISH_MAX_CHARS = 2000;

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

/** A Fish voice is either a reference_id (32 hex) or this plugin's label. */
export function isFishVoice(voice) {
  const value = String(voice ?? '').trim();
  if (!value) return false;
  if (value === FISH_VOICE) return true;
  return /^[0-9a-f]{32}$/i.test(value) || /^fish:/i.test(value) || /^[0-9a-f-]{16,64}$/i.test(value);
}

export function normalizeFishModel(model) {
  const value = String(model ?? '').trim().toLowerCase();
  return FISH_MODELS.some(item => item.id === value) ? value : FISH_DEFAULT_MODEL;
}

/** `fish:7f92...` and a bare reference id both become the bare id. */
export function fishReferenceId(voice) {
  const value = String(voice ?? '').trim().replace(/^fish:/i, '');
  if (!value || value === FISH_VOICE) return '';
  return value;
}

export function fishUrl({ endpoint, model } = {}) {
  // The model travels in a header, never in the path: `POST /v1/tts`.
  const base = String(endpoint || FISH_ENDPOINT).replace(/\/+$/, '');
  // Tolerate a config that still carries the old `/v1/tts/<model>` shape.
  const stripped = base.replace(/\/v1\/tts\/[A-Za-z0-9._-]+$/, '/v1/tts');
  return stripped;
}

/**
 * Fish Audio takes speed as `prosody.speed` in 0.5–2.0, so the plugin's
 * -10..10 rate maps linearly onto a sane band instead of a text prompt.
 */
export function fishSpeed(rate = 0) {
  const value = Math.max(-10, Math.min(10, Number(rate) || 0));
  const speed = 1 + value * 0.05; // -10 -> 0.5, 0 -> 1.0, +10 -> 1.5
  return Math.round(Math.max(0.5, Math.min(2, speed)) * 100) / 100;
}

export function buildFishPayload({ text, model, referenceId, format = 'mp3', rate = 0, latency = 'normal' } = {}) {
  const payload = {
    text: String(text ?? ''),
    format,
    latency: latency === 'balanced' ? 'balanced' : 'normal',
    normalize: true,
    streaming: false,
    prosody: { speed: fishSpeed(rate), normalize_loudness: true },
  };
  if (referenceId) payload.reference_id = referenceId;
  const id = normalizeFishModel(model);
  if (id === 'drama-3') payload.single_chunk = true;
  return payload;
}

function looksLikeMp3(buffer) {
  if (buffer.length < 3) return false;
  if (buffer.subarray(0, 3).toString('latin1') === 'ID3') return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

/** Describe an API failure without ever echoing the bearer token. */
function httpDetail(status, type, body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8', 0, 300) : String(body ?? '').slice(0, 300);
  return [`HTTP ${status}`, type || '', text].filter(Boolean).join(' ').slice(0, 320);
}

/** Map an HTTP failure onto the error code auto mode and the owner can act on. */
function statusError(status, type, body) {
  const detail = httpDetail(status, type, body);
  if (status === 401 || status === 403) return coded('TTS_FISH_AUTH', { detail });
  if (status === 402 || status === 429) return coded('TTS_FISH_QUOTA', { detail });
  if (status === 404) return coded('TTS_FISH_MODEL', { detail });
  return coded('TTS_FISH_NETWORK', { detail });
}

/** Shared by the direct and proxied paths so both classify responses identically. */
function judgeResponse(status, contentType, buffer) {
  if (status < 200 || status >= 300) throw statusError(status, contentType, buffer);
  const type = String(contentType ?? '').toLowerCase();
  if (!buffer?.length) throw coded('TTS_FISH_EMPTY', { detail: type || 'empty body' });
  const isWav = buffer.subarray(0, 4).toString('latin1') === 'RIFF';
  if (!isWav && !/audio|mpeg|octet-stream/.test(type) && !looksLikeMp3(buffer)) {
    throw coded('TTS_FISH_EMPTY', {
      detail: `${type || 'unknown type'}: ${buffer.toString('utf8', 0, 160)}`,
    });
  }
  return { buffer, isWav, contentType: type };
}

/**
 * POST through an HTTP proxy.
 *
 * `fetch` cannot be pointed at a proxy without `--use-env-proxy`, and this host
 * process is already running, so the tunnel is built by hand: CONNECT, then TLS
 * over the socket, then a plain https request on top. Needed because
 * api.fish.audio is unreachable from mainland networks.
 */
async function requestViaProxy({ url, headers, body, proxy, timeoutMs }) {
  const target = new URL(url);
  const via = new URL(/^[a-z]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
  const budget = Number(timeoutMs) || 60000;

  const tunnel = await new Promise((resolve, reject) => {
    const connect = http.request({
      host: via.hostname,
      port: Number(via.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}` },
      timeout: budget,
    });
    connect.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(coded('TTS_FISH_NETWORK', { detail: `proxy CONNECT ${response.statusCode}` }));
        return;
      }
      resolve(socket);
    });
    connect.on('timeout', () => { connect.destroy(); reject(coded('TTS_FISH_TIMEOUT', { detail: 'proxy CONNECT timeout' })); });
    connect.on('error', error => reject(coded('TTS_FISH_NETWORK', { detail: `proxy: ${String(error?.message ?? error).slice(0, 160)}` })));
    connect.end();
  });

  const secure = target.protocol === 'https:';
  const socket = secure
    ? tls.connect({ socket: tunnel, servername: target.hostname })
    : tunnel;
  if (secure) {
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', error => reject(coded('TTS_FISH_NETWORK', { detail: `tls: ${String(error?.message ?? error).slice(0, 160)}` })));
    });
  }

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request({
      method: 'POST',
      host: target.hostname,
      port: Number(target.port) || (secure ? 443 : 80),
      path: target.pathname + target.search,
      headers: { ...headers, 'Content-Length': payload.length },
      createConnection: () => socket,
      timeout: budget,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        contentType: String(response.headers['content-type'] ?? ''),
        buffer: Buffer.concat(chunks),
      }));
      response.on('error', error => reject(coded('TTS_FISH_NETWORK', { detail: String(error?.message ?? error).slice(0, 160) })));
    });
    request.on('timeout', () => { request.destroy(); reject(coded('TTS_FISH_TIMEOUT', { detail: 'request timeout' })); });
    request.on('error', error => reject(coded('TTS_FISH_NETWORK', { detail: String(error?.message ?? error).slice(0, 160) })));
    request.end(payload);
  });
}

async function requestFish({ text, apiKey, endpoint, model, referenceId, rate, timeoutMs, proxy }) {
  const url = fishUrl({ endpoint, model });
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    // The documented way to pick a model on the hosted API.
    model: normalizeFishModel(model),
    Accept: 'audio/mpeg,audio/wav,audio/*;q=0.9,*/*;q=0.8',
  };
  const payload = buildFishPayload({ text, model, referenceId, rate, format: 'mp3' });

  if (proxy) {
    const got = await requestViaProxy({ url, headers, body: payload, proxy, timeoutMs });
    return judgeResponse(got.status, got.contentType, got.buffer);
  }

  const controller = new AbortController();
  const budget = Math.max(8000, Math.min(120000, timeoutMs));
  const timer = setTimeout(() => controller.abort(), budget);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    throw coded(timedOut ? 'TTS_FISH_TIMEOUT' : 'TTS_FISH_NETWORK', {
      detail: timedOut ? `no answer in ${budget} ms` : String(error?.message ?? error).slice(0, 200),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = Buffer.from(await response.arrayBuffer().catch(() => Buffer.alloc(0)));
    const type = String(response.headers.get('content-type') ?? '');
    throw statusError(response.status, type, body);
  }

  const type = String(response.headers.get('content-type') ?? '').toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw coded('TTS_FISH_EMPTY', { detail: type || 'empty body' });
  const isWav = buffer.subarray(0, 4).toString('latin1') === 'RIFF';
  if (!isWav && !/audio|mpeg|octet-stream/.test(type) && !looksLikeMp3(buffer)) {
    throw coded('TTS_FISH_EMPTY', {
      detail: `${type || 'unknown type'}: ${buffer.toString('utf8', 0, 160)}`,
    });
  }
  return { buffer, isWav, contentType: type };
}

/**
 * Synthesize `text` through Fish Audio into `outPath` (16-bit mono WAV).
 *
 * `apiKey` is mandatory — an unauthenticated request would just be a 401, and
 * auto mode must fall through to Edge instead of failing the send. The WAV path
 * covers a self-hosted server and a cache hit; the public API answers MP3.
 */
export async function synthesizeFish({
  text, outPath, voice = '', model, apiKey, apiKeyEnv,
  endpoint, rate = 0, volume = 100, latency = 'normal', timeoutMs = 60000, proxy = '',
} = {}) {
  const value = String(text ?? '');
  if (!value.trim()) throw coded('TTS_TEXT_EMPTY');
  if (value.length > FISH_MAX_CHARS) {
    throw coded('TTS_ARGUMENTS_INVALID', { detail: `text longer than ${FISH_MAX_CHARS}` });
  }
  if (!outPath) throw coded('TTS_ARGUMENTS_INVALID', { detail: 'missing outPath' });

  const key = String(apiKey || (apiKeyEnv ? process.env[apiKeyEnv] : '') || '').trim();
  if (!key) {
    throw coded('TTS_FISH_NO_KEY', {
      detail: `set state/voice/config.json fishApiKey, or export ${apiKeyEnv || 'FISH_AUDIO_API_KEY'}`,
    });
  }

  const referenceId = fishReferenceId(voice);
  const fetched = await requestFish({
    text: value, apiKey: key, endpoint, model, referenceId, rate, timeoutMs, proxy,
  });

  let samples;
  let sampleRate;
  if (fetched.isWav) {
    // parseWav only inspects the layout; the samples are re-read as float here.
    const info = parseWav(fetched.buffer);
    const frames = Math.floor(info.dataSize / (info.channels * 2));
    if (!frames) throw coded('TTS_FISH_DECODE_FAILED', { detail: 'wav carried no samples' });
    const mono = new Float32Array(frames);
    for (let index = 0; index < frames; index++) {
      const base = info.dataStart + index * info.channels * 2;
      const left = fetched.buffer.readInt16LE(base);
      const right = info.channels === 2 ? fetched.buffer.readInt16LE(base + 2) : left;
      mono[index] = (left + right) / 2 / 32768;
    }
    samples = trimFloatSilence(mono, info.sampleRate);
    sampleRate = info.sampleRate;
  } else {
    let decoded;
    try {
      decoded = await decodeMp3ToMono(fetched.buffer);
    } catch (error) {
      if (error?.code === 'TTS_MP3_DEPENDENCY') throw coded('TTS_FISH_DEPENDENCY', { detail: error.detail });
      if (error?.code === 'TTS_MP3_EMPTY') throw coded('TTS_FISH_EMPTY', { detail: error.detail });
      throw coded('TTS_FISH_DECODE_FAILED', { detail: error?.detail ?? String(error?.message ?? error) });
    }
    samples = decoded.samples;
    sampleRate = decoded.sampleRate;
  }

  const gained = applyGain(samples, volume);
  const wav = wrapPcm16(pcm16FromFloat(gained), sampleRate, 1);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, wav);
  return {
    path: outPath,
    bytes: wav.length,
    durationMs: Math.round((gained.length / sampleRate) * 1000),
    sampleRate,
    channels: 1,
    engine: 'fish',
    voice: referenceId || FISH_VOICE,
    model: normalizeFishModel(model),
  };
}
