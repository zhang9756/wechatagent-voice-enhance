// 火山引擎 TTS · fish.audio 兼容代理
// 把 dsh-wechat-voice 插件发出的 fish.audio 格式请求，
// 转发到火山引擎语音技术 TTS（openspeech.bytedance.com），并返回音频。
//
// 用法：
//   1. 编辑同目录 volc-config.json（appid/token/音色映射）
//   2. node proxy.mjs
//   3. 在 state/voice/config.json 里设 fishEndpoint = http://127.0.0.1:8787/v1/tts
//
// 音色 ID 规则（reference_id）：
//   - 32 位十六进制 ID -> 查 volc-config.json 的 voices 映射表
//   - 其他字符串       -> 直接当作火山的 voice_type 透传

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
  console.error('并填入火山引擎的 appid / token / 音色映射后重新运行。');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const appid = String(config.appid ?? '').trim();
const token = String(config.token ?? '').trim();
const cluster = String(config.cluster ?? 'volcano_tts').trim();
const port = Number(config.port ?? 8787);
const voices = config.voices ?? {};
const defaultVoice = String(config.defaultVoice ?? '').trim();
const endpoint = String(config.endpoint ?? 'https://openspeech.bytedance.com/api/v1/tts').trim();

if (!appid || !token) {
  console.error('[volc-proxy] 缺少 appid 或 token，请编辑 ' + CONFIG_PATH);
  process.exit(1);
}

function mapVoice(referenceId) {
  const value = String(referenceId ?? '').trim();
  if (!value) return defaultVoice;
  if (Object.prototype.hasOwnProperty.call(voices, value)) return String(voices[value]);
  if (!/^[0-9a-f]{32}$/i.test(value)) return value; // 非 32 位 hex：透传为 voice_type
  return defaultVoice;
}

async function synthesizeVolc({ text, voiceType, encoding = 'mp3', speed = 1.0 }) {
  const reqid = crypto.randomUUID();
  const body = {
    app: { appid, token, cluster },
    user: { uid: 'dsh-wechat-voice' },
    audio: {
      voice_type: voiceType,
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
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error('火山 TTS HTTP ' + response.status + ' ' + detail);
  }
  const result = await response.json();
  if (result.code !== 3000) {
    throw new Error('火山 TTS 错误 code=' + result.code + ' ' + String(result.message ?? '').slice(0, 200));
  }
  return Buffer.from(result.data, 'base64');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, appid: appid.slice(0, 3) + '***' }));
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
    const voiceType = mapVoice(referenceId);
    const encoding = format === 'wav' ? 'wav' : 'mp3';
    try {
      const audio = await synthesizeVolc({ text, voiceType, encoding, speed });
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
  console.log('[volc-proxy] 运行中: http://127.0.0.1:' + port + '/v1/tts');
  console.log('[volc-proxy] 默认音色: ' + (defaultVoice || '(未设置)'));
});