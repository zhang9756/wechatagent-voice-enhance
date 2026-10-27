// 火山引擎 TTS · fish.audio 兼容代理
// 把 dsh-wechat-voice 插件发出的 fish.audio 格式请求，
// 转发到火山引擎 TTS 接口，并返回音频。
//
// 支持两种火山引擎接口：
//   v3（推荐）：https://openspeech.bytedance.com/api/v3/tts/create
//              鉴权 X-Api-Key: <apiKey>，模型如 seed-audio-1.0
//   v2：        https://openspeech.bytedance.com/api/v1/tts
//              鉴权 appid + token（body 里）
//
// 配置：同目录 volc-config.json（见 volc-config.example.json）
// 音色 ID 规则（reference_id）：
//   - 32 位十六进制 ID -> 查 voicePrompt 映射表，得到一段声音描述前缀
//   - 其他字符串       -> 直接当作 voice_type（仅 v2 支持）
//
// 用法：
//   1. 编辑 volc-config.json
//   2. node proxy.mjs  （或双击 start-volc-proxy.bat）
//   3. 在 state/voice/config.json 设 fishEndpoint = http://127.0.0.1:8787/v1/tts

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.VOLC_CONFIG || path.join(HERE, 'volc-config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('[volc-proxy] 找不到配置文件：' + CONFIG_PATH);
  console.error('请先把同目录下的 volc-config.example.json 复制为 volc-config.json，');
  console.error('并填入火山引擎的 API Key 后重新运行。');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const mode = String(config.mode ?? 'v3').trim().toLowerCase();
const port = Number(config.port ?? 8787);
const endpoint = String(config.endpoint ?? '').trim() || (
  mode === 'v2'
    ? 'https://openspeech.bytedance.com/api/v1/tts'
    : 'https://openspeech.bytedance.com/api/v3/tts/create'
);
const voicePrompt = config.voicePrompt ?? {};
const defaultVoicePrompt = String(config.defaultVoicePrompt ?? '').trim();

function resolveVoice(referenceId) {
  const value = String(referenceId ?? '').trim();
  if (!value) return defaultVoicePrompt;
  if (Object.prototype.hasOwnProperty.call(voicePrompt, value)) return String(voicePrompt[value]);
  return defaultVoicePrompt;
}

async function synthesizeVolc({ text, voicePromptText, encoding = 'mp3', speed = 1.0 }) {
  if (mode === 'v2') {
    const appid = String(config.appid ?? '').trim();
    const token = String(config.token ?? '').trim();
    if (!appid || !token) throw new Error('v2 模式需要 appid/token');
    const cluster = String(config.cluster ?? 'volcano_tts').trim();
    const reqid = crypto.randomUUID();
    const body = {
      app: { appid, token, cluster },
      user: { uid: 'dsh-wechat-voice' },
      audio: {
        voice_type: voicePromptText || String(config.defaultVoice ?? 'BV001_streaming'),
        encoding,
        speed_ratio: Math.max(0.5, Math.min(2, Number(speed) || 1)),
        rate: 24000,
        bitrate: 160,
        loudness_ratio: 1.0,
      },
      request: { reqid, text: String(text ?? ''), operation: 'query' },
    };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error('火山 v2 HTTP ' + response.status + ' ' + (await response.text()).slice(0, 300));
    const result = await response.json();
    if (result.code !== 3000) throw new Error('火山 v2 错误 code=' + result.code + ' ' + String(result.message ?? '').slice(0, 200));
    return Buffer.from(result.data, 'base64');
  }

  // v3 模式
  const apiKey = String(config.apiKey ?? '').trim();
  const model = String(config.model ?? 'seed-audio-1.0').trim();
  if (!apiKey) throw new Error('v3 模式需要 apiKey（X-Api-Key）');
  const prompt = voicePromptText ? voicePromptText + ' ' + text : text;
  const body = {
    model,
    text_prompt: prompt,
    audio_config: {
      format: encoding,
      sample_rate: 48000,
      pitch_rate: 0,
      speech_rate: Math.round((Number(speed) - 1) * 100),
      loudness_rate: 0,
    },
    watermark: {},
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error('火山 v3 HTTP ' + response.status + ' ' + (await response.text()).slice(0, 300));
  const result = await response.json();
  if (!result.audio) {
    throw new Error('火山 v3 错误 ' + JSON.stringify(result).slice(0, 300));
  }
  return Buffer.from(result.audio, 'base64');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mode, hasApiKey: !!(config.apiKey ?? config.token ?? '') }));
  }
  if (req.method === 'POST' && /\/v1\/tts\/?$/.test(url.pathname)) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let payload;
    try { payload = JSON.parse(raw); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"invalid json"}'); }
    const text = String(payload.text ?? '');
    const referenceId = String(payload.reference_id ?? '');
    const format = String(payload.format ?? 'mp3');
    const speed = Number(payload.prosody?.speed) || 1.0;
    if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"empty text"}'); }
    const prompt = resolveVoice(referenceId);
    const encoding = format === 'wav' ? 'wav' : 'mp3';
    try {
      const audio = await synthesizeVolc({ text, voicePromptText: prompt, encoding, speed });
      res.writeHead(200, { 'Content-Type': encoding === 'wav' ? 'audio/wav' : 'audio/mpeg' });
      return res.end(audio);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(error.message ?? error).slice(0, 300) }));
    }
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(port, '127.0.0.1', () => {
  console.log('[volc-proxy] 运行中: http://127.0.0.1:' + port + '/v1/tts（' + mode + ' 模式）');
  console.log('[volc-proxy] 模型/音色: ' + (mode === 'v2' ? (config.defaultVoice ?? '') : (config.model ?? 'seed-audio-1.0')));
});