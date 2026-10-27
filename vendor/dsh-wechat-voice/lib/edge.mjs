// Edge Read Aloud neural TTS. This is the "sounds like a person" path: it uses
// the same Edge speech backend as the browser's Read Aloud, so zh-CN voices like
// Xiaoxiao/Xiaoyi are available without an Azure key. The service only returns
// MP3 (raw PCM formats are accepted then dropped), so lib/edge.mjs decodes the
// MP3 with a WASM mpg123 build and hands the rest of the pipeline a plain WAV.
//
// Network failures are deliberately coded: lib/tts.mjs turns them into an
// automatic SAPI fallback, because a WeChat reply must still go out offline.

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { wrapPcm16 } from './wav.mjs';
import { decodeMp3ToMono, pcm16FromFloat, trimFloatSilence } from './mp3.mjs';

export { pcm16FromFloat, trimFloatSilence };

export const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** Voices worth offering in docs/preview; any Edge `*Neural` name also works. */
export const EDGE_VOICES = [
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温暖自然女声' },
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼少女声' },
  { name: 'zh-CN-YunxiNeural', label: '云希 · 年轻男声' },
  { name: 'zh-CN-YunjianNeural', label: '云健 · 沉稳男声' },
  { name: 'zh-CN-YunyangNeural', label: '云扬 · 新闻播音男声' },
  { name: 'zh-CN-YunxiaNeural', label: '云夏 · 少年声' },
  { name: 'zh-CN-XiaoshuangNeural', label: '晓双 · 童声' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北女声' },
  { name: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西女声' },
  { name: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声' },
  { name: 'zh-HK-WanLungNeural', label: '雲龍 · 粤语男声' },
  { name: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声' },
  { name: 'zh-TW-YunJheNeural', label: '雲哲 · 台湾男声' },
];

/**
 * The owner talks in Chinese names ("换成晓伊的声音"), so map aliases onto real
 * Edge voice ids. Built from EDGE_VOICES so docs and lookup never drift apart.
 */
const EDGE_VOICE_ALIASES = new Map();
for (const entry of EDGE_VOICES) {
  const short = entry.name.replace(/^[a-z]{2,3}-[A-Za-z]{2,}-/, '').replace(/Neural$/, '');
  const zhLabel = entry.label.split(' · ')[0];
  for (const alias of [entry.name, entry.name.toLowerCase(), short, short.toLowerCase(), zhLabel]) {
    EDGE_VOICE_ALIASES.set(alias, entry.name);
  }
}

/** Accept a full Edge id or a Chinese alias; return '' when it is neither. */
export function resolveEdgeVoice(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (isEdgeVoice(text)) return text;
  return EDGE_VOICE_ALIASES.get(text) ?? EDGE_VOICE_ALIASES.get(text.toLowerCase()) ?? '';
}

/** Human label for a voice id, so replies can say "晓伊" instead of the id. */
export function edgeVoiceLabel(value) {
  const id = resolveEdgeVoice(value) || String(value ?? '').trim();
  const hit = EDGE_VOICES.find(item => item.name === id);
  if (hit) return hit.label.split(' · ')[0];
  const match = /-([A-Za-z0-9]+)Neural$/.exec(id);
  return match?.[1] ?? id;
}

const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
const EDGE_GEC_VERSION = '1-156.0.4314.42';
const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

let clockOffsetMs = 0;

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export const escapeSsml = value => String(value ?? '').replace(/[&<>"']/g, char => XML_ESCAPES[char]);

/** True for `zh-CN-XiaoxiaoNeural`-style names, false for SAPI names. */
export function isEdgeVoice(value) {
  return /^[a-z]{2,3}-[A-Za-z]{2,}-[A-Za-z0-9-]+Neural$/.test(String(value ?? '').trim());
}

/**
 * Map the plugin's SAPI-ish -10..10 rate and 0..100 volume onto Edge prosody.
 * Edge accepts -50%..+100% rate; 10 units therefore become a 2x speed-up.
 */
export function edgeProsody(rate = 0, volume = 100) {
  const speed = clampInt(rate, -10, 10, 0) * 10;
  const level = clampInt(volume, 0, 100, 100);
  return {
    rate: `${speed >= 0 ? '+' : ''}${speed}%`,
    volume: level >= 100 ? '+0%' : `-${100 - level}%`,
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

export function edgeSsml({ text, voice = EDGE_DEFAULT_VOICE, rate = 0, volume = 100 } = {}) {
  const prosody = edgeProsody(rate, volume);
  const match = /^([a-z]{2,3}-[A-Z]{2})/.exec(String(voice ?? ''));
  const language = match?.[1] ?? 'zh-CN';
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeSsml(language)}">`
    + `<voice name="${escapeSsml(voice)}"><prosody pitch="+0Hz" rate="${prosody.rate}" volume="${prosody.volume}">`
    + escapeSsml(text)
    + '</prosody></voice></speak>';
}

async function secMsGec() {
  const ticks = Math.floor((Date.now() + clockOffsetMs) / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  const windowsTicks = rounded * 10000000;
  return crypto.createHash('sha256').update(`${windowsTicks}${EDGE_TOKEN}`).digest('hex').toUpperCase();
}

const randomHex = bytes => crypto.randomBytes(bytes).toString('hex');

function connectionUrl(gec) {
  return 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1'
    + `?Ocp-Apim-Subscription-Key=${EDGE_TOKEN}`
    + `&Sec-MS-GEC=${gec}`
    + `&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`
    + `&ConnectionId=${randomHex(16)}`;
}

/**
 * The service rejects an otherwise valid handshake with an empty HTTP 200 when
 * the request stops looking like Edge's own Read Aloud connection. These
 * headers (not just UA/Origin) are part of that fingerprint.
 */
export function edgeHandshake(gec) {
  return {
    url: connectionUrl(gec),
    options: {
      origin: EDGE_ORIGIN,
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': EDGE_USER_AGENT,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
  };
}

async function loadWebSocket() {
  try {
    const mod = await import('ws');
    return mod.default ?? mod.WebSocket ?? mod;
  } catch (error) {
    throw coded('TTS_EDGE_DEPENDENCY', { detail: `ws: ${error?.message ?? error}` });
  }
}

/** One Edge turn, returning the MP3 bytes. Retries once after a 403 clock skew. */
export async function requestEdgeAudio({ text, voice = EDGE_DEFAULT_VOICE, rate = 0, volume = 100, timeoutMs = 30000 } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) throw coded('TTS_TEXT_EMPTY');
  if (!isEdgeVoice(voice)) throw coded('TTS_EDGE_VOICE', { detail: String(voice ?? '') });

  const WebSocket = await loadWebSocket();
  const synthesisTimeoutMs = Math.max(15000, Math.min(60000, Number(timeoutMs) || 30000));

  const connectOnce = () => new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    let connectTimer;
    let idleTimer;
    const audio = [];
    let lastText = '';

    const finish = (error, payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
      try { socket?.terminate(); } catch { /* already closed */ }
      if (error) reject(error); else resolve(payload);
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(coded('TTS_EDGE_TIMEOUT', { detail: 'no audio before turn.end' })), synthesisTimeoutMs);
    };
    const handshakeFailed = (status, serverDate) => {
      finish(Object.assign(coded('TTS_EDGE_NETWORK', { detail: `handshake ${status}` }), {
        status,
        serverDate,
      }));
    };

    (async () => {
      const handshake = edgeHandshake(await secMsGec());
      socket = new WebSocket(handshake.url, handshake.options);
      socket.binaryType = 'nodebuffer';
      connectTimer = setTimeout(() => finish(coded('TTS_EDGE_TIMEOUT', { detail: 'connect timeout' })), 10000);

      socket.once('unexpected-response', (request, response) => {
        const status = response?.statusCode;
        const serverDate = response?.headers?.date;
        try { request.destroy(); } catch { /* already gone */ }
        try { response.destroy(); } catch { /* already gone */ }
        handshakeFailed(status, serverDate);
      });

      socket.once('open', () => {
        clearTimeout(connectTimer);
        const requestId = randomHex(16);
        const config = {
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: EDGE_OUTPUT_FORMAT,
              },
            },
          },
        };
        socket.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(config)}`);
        const ssml = edgeSsml({ text: value, voice, rate, volume });
        socket.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`);
        armIdle();
      });

      socket.on('message', (data, isBinary) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!isBinary) {
          lastText = buffer.toString('utf8').slice(0, 300);
          if (lastText.includes('Path:turn.end')) {
            finish(null, Buffer.concat(audio));
          } else {
            armIdle();
          }
          return;
        }
        if (buffer.length < 2) return;
        const headerLength = buffer.readUInt16BE(0);
        if (headerLength === 0 || buffer.length < 2 + headerLength) return;
        const header = buffer.subarray(2, 2 + headerLength).toString('utf8');
        if (!header.includes('Path:audio')) return;
        audio.push(buffer.subarray(2 + headerLength));
        armIdle();
      });

      socket.once('error', error => {
        finish(coded('TTS_EDGE_NETWORK', { detail: `websocket: ${error?.message ?? error}` }));
      });
      socket.once('close', (code, reason) => {
        if (!settled) {
          finish(coded('TTS_EDGE_NETWORK', {
            detail: `closed before turn.end (${code}${reason?.length ? ` ${String(reason).slice(0, 80)}` : ''})${lastText ? ` ${lastText}` : ''}`,
          }));
        }
      });
    })().catch(error => {
      finish(error?.code ? error : coded('TTS_EDGE_NETWORK', { detail: String(error?.message ?? error) }));
    });
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const mp3 = await connectOnce();
      if (!mp3.length) throw coded('TTS_EDGE_EMPTY', { detail: 'service returned no audio' });
      return mp3;
    } catch (error) {
      const serverTime = typeof error?.serverDate === 'string' ? Date.parse(error.serverDate) : NaN;
      if (attempt === 0 && error?.status === 403 && Number.isFinite(serverTime)) {
        clockOffsetMs = serverTime - Date.now();
        continue;
      }
      throw error;
    }
  }
  throw coded('TTS_EDGE_NETWORK', { detail: 'retry exhausted' });
}

async function decodeMp3(mp3) {
  try {
    return await decodeMp3ToMono(mp3);
  } catch (error) {
    if (error?.code === 'TTS_MP3_DEPENDENCY') throw coded('TTS_EDGE_DEPENDENCY', { detail: error.detail });
    if (error?.code === 'TTS_MP3_DECODE_FAILED') throw coded('TTS_EDGE_DECODE_FAILED', { detail: error.detail });
    if (error?.code === 'TTS_MP3_EMPTY') throw coded('TTS_EDGE_EMPTY', { detail: error.detail });
    throw error;
  }
}

/**
 * Synthesize Edge neural speech into `outPath` (16-bit mono WAV, 24 kHz).
 * The caller's SILK encoder resamples to 16 kHz later.
 */
export async function synthesizeEdge({ text, outPath, voice = EDGE_DEFAULT_VOICE, rate = 0, volume = 100, timeoutMs = 30000 } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) throw coded('TTS_TEXT_EMPTY');
  if (!isEdgeVoice(voice)) throw coded('TTS_EDGE_VOICE', { detail: String(voice ?? '') });
  if (!outPath) throw coded('TTS_ARGUMENTS_INVALID', { detail: 'missing outPath' });

  const mp3 = await requestEdgeAudio({ text: value, voice, rate, volume, timeoutMs });
  const { samples, sampleRate } = await decodeMp3(mp3);
  const wav = wrapPcm16(pcm16FromFloat(samples), sampleRate, 1);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, wav);
  return {
    path: outPath,
    bytes: wav.length,
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    sampleRate,
    channels: 1,
    engine: 'edge',
    voice,
    mp3Bytes: mp3.length,
  };
}
