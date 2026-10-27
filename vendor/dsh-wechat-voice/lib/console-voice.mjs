// Voice settings for the console UI.
//
// The console is a browser page served by scripts/console-server.mjs, while the
// voice plugin runs inside DSH. The console therefore cannot call the plugin's
// tools directly, and the plugin needs DSH running to answer. Reading the same
// JSON files the plugin uses keeps the panel working even while DSH is closed,
// and gives one obvious source of truth:
//
//   state/voice/config.json   global default (engine / edgeVoice / voice / rate…)
//   state/voice/chats.json    { chats: { "wechat:private:1": {edgeVoice, rate…} } }
//
// The catalogue below mirrors EDGE_VOICES in packages/dsh-wechat-voice/lib/edge.mjs.
// It is duplicated on purpose: the console must render the list while DSH is
// not running, and a missing plugin must not blank the panel.

import fs from 'node:fs';
import path from 'node:path';

const MB = 1024 * 1024;

export const VOICE_KEY = /^wechat:(private|group):[0-9]{1,20}$/;

/** Same list and Chinese labels as the plugin's EDGE_VOICES. */
export const EDGE_VOICES = [
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓', group: '普通话', description: '温暖自然女声，默认' },
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊', group: '普通话', description: '活泼少女声' },
  { name: 'zh-CN-YunxiNeural', label: '云希', group: '普通话', description: '年轻男声' },
  { name: 'zh-CN-YunjianNeural', label: '云健', group: '普通话', description: '沉稳男声' },
  { name: 'zh-CN-YunyangNeural', label: '云扬', group: '普通话', description: '新闻播音男声' },
  { name: 'zh-CN-YunxiaNeural', label: '云夏', group: '普通话', description: '少年声' },
  { name: 'zh-CN-XiaoshuangNeural', label: '晓双', group: '普通话', description: '童声' },
  { name: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北', group: '方言', description: '东北女声' },
  { name: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮', group: '方言', description: '陕西女声' },
  { name: 'zh-HK-HiuMaanNeural', label: '曉曼', group: '粤语', description: '粤语女声' },
  { name: 'zh-HK-WanLungNeural', label: '雲龍', group: '粤语', description: '粤语男声' },
  { name: 'zh-TW-HsiaoChenNeural', label: '曉臻', group: '台湾', description: '台湾女声' },
  { name: 'zh-TW-YunJheNeural', label: '雲哲', group: '台湾', description: '台湾男声' },
];

const BY_LABEL = new Map();
for (const item of EDGE_VOICES) {
  const short = item.name.replace(/^[a-z]{2,3}-[A-Za-z]{2,}-/, '').replace(/Neural$/, '');
  for (const alias of [item.name, item.name.toLowerCase(), short, short.toLowerCase(), item.label]) BY_LABEL.set(alias, item.name);
}

/** A full Edge neural voice id, e.g. zh-CN-XiaoyiNeural. */
export const EDGE_ID = /^[a-z]{2,3}-[A-Za-z]{2,}-[A-Za-z0-9-]+Neural$/;

/** Accept `晓伊`, `xiaoyi` or the full id; return '' when it is neither. */
export function resolveVoiceName(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const hit = BY_LABEL.get(text) ?? BY_LABEL.get(text.toLowerCase());
  if (hit) return hit;
  return EDGE_ID.test(text) ? text : '';
}

export function voiceLabel(name) {
  const id = resolveVoiceName(name) || String(name ?? '');
  return EDGE_VOICES.find(item => item.name === id)?.label ?? id;
}

export const VOICE_DEFAULTS = {
  engine: 'auto',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  voice: 'Microsoft Yaoyao',
  rate: 0,
  volume: 100,
};

const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
};

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MB) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export const voiceFiles = root => ({
  global: path.join(root, 'state', 'voice', 'config.json'),
  chats: path.join(root, 'state', 'voice', 'chats.json'),
});

/** Only keep the fields the plugin understands, clamped the same way. */
export function normalizeVoice(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    engine: ['auto', 'edge', 'baidu', 'sapi', 'volc'].includes(value.engine) ? value.engine : VOICE_DEFAULTS.engine,
    edgeVoice: resolveVoiceName(value.edgeVoice) || VOICE_DEFAULTS.edgeVoice,
    voice: typeof value.voice === 'string' && value.voice.trim() ? value.voice.trim().slice(0, 64) : VOICE_DEFAULTS.voice,
    rate: clampInt(value.rate, -10, 10, VOICE_DEFAULTS.rate),
    volume: clampInt(value.volume, 0, 100, VOICE_DEFAULTS.volume),
  };
}

/** The global default, as the plugin would resolve it from config.json alone. */
export function readGlobalVoice(root) {
  const saved = readJson(voiceFiles(root).global);
  return { ...normalizeVoice({ ...VOICE_DEFAULTS, ...(saved ?? {}) }), configured: saved !== null };
}

/** Every chat with a saved override, already merged over the global default. */
export function readChatVoiceOverrides(root) {
  const saved = readJson(voiceFiles(root).chats);
  const chats = saved?.chats;
  if (!chats || typeof chats !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(chats)) {
    if (!VOICE_KEY.test(key) || !value || typeof value !== 'object') continue;
    const patch = {};
    for (const field of ['engine', 'edgeVoice', 'voice', 'rate', 'volume']) {
      if (value[field] !== undefined && value[field] !== null && value[field] !== '') patch[field] = value[field];
    }
    if (Object.keys(patch).length) out[key] = patch;
  }
  return out;
}

/** Effective voice for one chat: global default, then this chat's overrides. */
export function effectiveVoice(root, key) {
  const global = readGlobalVoice(root);
  const override = readChatVoiceOverrides(root)[key] ?? {};
  const merged = normalizeVoice({ ...global, ...override });
  return {
    ...merged,
    label: voiceLabel(merged.edgeVoice),
    overrides: override,
    inherited: Object.keys(override).length === 0,
  };
}

/** What the panel needs in one round trip. */
export function voiceSnapshot(root, key) {
  return {
    ok: true,
    key,
    voices: EDGE_VOICES,
    engines: [
      { id: 'auto', label: '自动', description: '在线自然语音优先，连不上时自动回退本机语音' },
      { id: 'edge', label: '仅在线', description: '只用在线神经网络音色，失败直接报错' },
      { id: 'baidu', label: '百度女声', description: '只用百度在线女声，忽略所选音色' },
      { id: 'sapi', label: '仅本机', description: '完全离线，音色是 Windows 自带语音' },
    ],
    global: { ...readGlobalVoice(root), label: voiceLabel(readGlobalVoice(root).edgeVoice) },
    chat: key && VOICE_KEY.test(key) ? effectiveVoice(root, key) : null,
    note: '更改在本机保存后，下一条语音立即生效，不用重启；试听只在本机合成，不会发出。',
  };
}

/**
 * Save the voice for one chat (`scope: 'chat'`) or for every chat
 * (`scope: 'global'`). `null` deletes the field, so `{edgeVoice: null}` on a
 * chat means "follow the global default again".
 *
 * Throws a 400-class error with a readable message when the input cannot be
 * honoured — the console turns that into a toast next to the field.
 */
export function saveVoice(root, { key, scope = 'chat', engine, edgeVoice, rate, volume, reset = false } = {}) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (scope === 'chat' && !VOICE_KEY.test(String(key ?? ''))) fail('聊天标识无效，请重新打开此会话设置。');
  const files = voiceFiles(root);

  const patch = {};
  if (reset === true) {
    patch.engine = null;
    patch.edgeVoice = null;
    patch.voice = null;
    patch.rate = null;
    patch.volume = null;
  } else {
    if (edgeVoice !== undefined) {
      if (edgeVoice === null) patch.edgeVoice = null;
      else {
        const name = resolveVoiceName(edgeVoice);
        if (!name) fail('请从列表中选择音色。');
        patch.edgeVoice = name;
      }
    }
    if (engine !== undefined) {
      if (!['auto', 'edge', 'baidu', 'sapi', 'volc'].includes(engine)) fail('请选择有效的语音引擎。');
      patch.engine = engine;
    }
    if (rate !== undefined) {
      const value = Number(rate);
      if (!Number.isFinite(value) || Math.round(value) !== value || value < -10 || value > 10) fail('语速需要是 -10 到 10 的整数。');
      patch.rate = value;
    }
    if (volume !== undefined) {
      const value = Number(volume);
      if (!Number.isFinite(value) || Math.round(value) !== value || value < 0 || value > 100) fail('音量需要是 0 到 100 的整数。');
      patch.volume = value;
    }
  }
  if (!Object.keys(patch).length) fail('没有要保存的语音设置。');

  const global = readGlobalVoice(root);

  if (scope === 'global') {
    const current = readJson(files.global) ?? {};
    const next = { ...current };
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete next[field];
      else next[field] = value;
    }
    const saved = withPlayableEngine(normalizeVoice({ ...VOICE_DEFAULTS, ...next }));
    writeJson(files.global, saved);
    return voiceSnapshot(root, key);
  }

  const rows = readJson(files.chats) ?? {};
  const chats = rows?.chats && typeof rows.chats === 'object' ? { ...rows.chats } : {};
  const current = { ...(chats[key] ?? {}) };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete current[field];
    else current[field] = value;
  }
  // Choosing an online voice while the engine is offline/baidu would store a
  // voice that never gets heard, so the engine follows the voice here too.
  const merged = normalizeVoice({ ...global, ...current });
  const playable = withPlayableEngine(merged);
  if (playable.engine !== merged.engine) current.engine = playable.engine;
  // Drop overrides identical to the global default: they would pin the chat to
  // today's default and silently ignore a later global change.
  for (const field of Object.keys(current)) {
    const normalized = normalizeVoice({ ...VOICE_DEFAULTS, ...current })[field];
    if (normalized === global[field]) delete current[field];
    else current[field] = normalized;
  }
  if (Object.keys(current).length) chats[key] = current; else delete chats[key];
  writeJson(files.chats, { version: 1, updatedAt: new Date().toISOString(), chats });
  return voiceSnapshot(root, key);
}

/** An Edge voice can only be heard through an online engine. */
function withPlayableEngine(settings) {
  if (!EDGE_ID.test(settings.edgeVoice)) return settings;
  if (!['sapi', 'baidu'].includes(settings.engine)) return settings;
  return { ...settings, engine: 'auto' };
}