// Settings and a load marker.
//
// DSH rewrites profile cordis.yml itself and strips config keys it does not know
// about, so a plugin cannot rely on `config:` surviving a restart. The durable
// configuration therefore lives in <project>/state/voice/config.json; cordis
// config still wins when it is present, but nothing breaks when it is not.

import fs from 'node:fs';
import path from 'node:path';
import { EDGE_DEFAULT_VOICE } from './edge.mjs';

export const DEFAULTS = {
  engine: 'auto', // auto (Edge -> Baidu -> SAPI) | edge | baidu | sapi | fish
  edgeVoice: EDGE_DEFAULT_VOICE,
  voice: 'Microsoft Yaoyao',
  rate: 0,
  volume: 100,
  maxVoices: 2,
  maxChars: 500,
  maxVoiceMs: 55000,
  fallback: 'stage', // stage | text | error
  // Fish Audio (api.fish.audio). The key is kept here only when the owner pastes
  // it; the env var named by fishApiKeyEnv is the preferred place for it.
  fishApiKey: '',
  fishApiKeyEnv: 'FISH_AUDIO_API_KEY',
  fishEndpoint: '', // empty = https://api.fish.audio/v1/tts; set for a self-hosted server
  fishProxy: '', // e.g. http://127.0.0.1:7890 — needed where api.fish.audio is blocked
  fishModel: 's2.1-pro',
  fishLatency: 'normal', // normal | balanced
  fishFallback: true, // engine=fish: fall through to Edge/SAPI when Fish fails
};

export function settingsFile(root) {
  return path.join(root, 'state', 'voice', 'config.json');
}

export function loadedMarkerFile(root) {
  return path.join(root, 'state', 'voice', 'loaded.json');
}

const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
};

const FISH_MODEL_IDS = ['s2.1-pro', 's2.1-pro-free', 's2-pro', 'drama-3', 's1'];

const trimmed = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '');

/** Validate whatever the user put in config.json; never throw on a bad file. */
export function normalizeSettings(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const fishModel = trimmed(value.fishModel, 32).toLowerCase();
  const fishEndpoint = trimmed(value.fishEndpoint, 512);
  const fishProxy = trimmed(value.fishProxy, 512);
  return {
    engine: ['auto', 'edge', 'baidu', 'sapi', 'fish'].includes(value.engine) ? value.engine : DEFAULTS.engine,
    edgeVoice: typeof value.edgeVoice === 'string' && value.edgeVoice.trim()
      ? value.edgeVoice.trim().slice(0, 64)
      : DEFAULTS.edgeVoice,
    ...(typeof value.voice === 'string' && value.voice.trim() ? { voice: value.voice.trim().slice(0, 64) } : {}),
    rate: clampInt(value.rate ?? DEFAULTS.rate, -10, 10, DEFAULTS.rate),
    volume: clampInt(value.volume ?? DEFAULTS.volume, 0, 100, DEFAULTS.volume),
    maxVoices: clampInt(value.maxVoices ?? DEFAULTS.maxVoices, 1, 3, DEFAULTS.maxVoices),
    maxChars: clampInt(value.maxChars ?? DEFAULTS.maxChars, 40, 1200, DEFAULTS.maxChars),
    maxVoiceMs: clampInt(value.maxVoiceMs ?? DEFAULTS.maxVoiceMs, 5000, 59000, DEFAULTS.maxVoiceMs),
    fallback: ['stage', 'text', 'error'].includes(value.fallback) ? value.fallback : DEFAULTS.fallback,
    fishApiKey: trimmed(value.fishApiKey, 200),
    fishApiKeyEnv: trimmed(value.fishApiKeyEnv, 64) || DEFAULTS.fishApiKeyEnv,
    // Only an http(s) URL is accepted, so a typo cannot silently disable Fish.
    fishEndpoint: /^https?:\/\//i.test(fishEndpoint) ? fishEndpoint.replace(/\/+$/, '') : DEFAULTS.fishEndpoint,
    // Accept `127.0.0.1:7890` as well as a full URL; anything else is dropped.
    fishProxy: (() => {
      const raw = fishProxy.replace(/\/+$/, '');
      if (!raw) return DEFAULTS.fishProxy;
      if (/^https?:\/\//i.test(raw)) return raw;
      if (/^[\w.-]+:\d{1,5}$/.test(raw)) return `http://${raw}`;
      return DEFAULTS.fishProxy;
    })(),
    fishModel: FISH_MODEL_IDS.includes(fishModel) ? fishModel : DEFAULTS.fishModel,
    fishLatency: value.fishLatency === 'balanced' ? 'balanced' : DEFAULTS.fishLatency,
    fishFallback: value.fishFallback === undefined ? DEFAULTS.fishFallback : !!value.fishFallback,
  };
}

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Create the durable config file once so the owner has something to edit. */
export function ensureSettingsFile(root) {
  const file = settingsFile(root);
  if (fs.existsSync(file)) return file;
  try { writeJson(file, DEFAULTS); } catch { /* read-only disk: defaults still work */ }
  return file;
}

/** DEFAULTS <- config.json <- cordis config (highest priority, may be absent). */
export function resolveSettings(root, cordisConfig = {}) {
  const fromFile = readJson(settingsFile(root)) ?? {};
  const fromCordis = {};
  if (cordisConfig && typeof cordisConfig === 'object') {
    for (const key of Object.keys(DEFAULTS)) if (cordisConfig[key] !== undefined) fromCordis[key] = cordisConfig[key];
  }
  return normalizeSettings({ ...DEFAULTS, ...fromFile, ...fromCordis });
}

/** The durable global config as stored on disk (no defaults, no cordis layer). */
export function readSettingsFile(root) {
  return readJson(settingsFile(root)) ?? {};
}

/**
 * Merge `patch` into config.json. Unknown keys are dropped, values are clamped
 * by normalizeSettings, and the write is atomic — a half-written file would
 * break the next voice send.
 */
export function saveSettings(root, patch = {}) {
  const next = { ...readSettingsFile(root) };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch && Object.hasOwn(patch, key) && patch[key] !== undefined) next[key] = patch[key];
  }
  const merged = normalizeSettings({ ...DEFAULTS, ...next });
  try {
    writeJson(settingsFile(root), merged);
  } catch (error) {
    throw Object.assign(new Error('VOICE_SETTINGS_UNWRITABLE'), { code: 'VOICE_SETTINGS_UNWRITABLE', detail: String(error?.message ?? error) });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Per-chat voice. The owner asks in WeChat ("换成晓伊的声音"), and the answer has
// to survive a restart, so it is stored next to the global config rather than in
// the chat history: <root>/state/voice/chats.json = { "wechat:private:1": {...} }.
// ---------------------------------------------------------------------------

export const CHAT_VOICE_KEYS = ['engine', 'edgeVoice', 'voice', 'rate', 'volume', 'fishModel'];

export function chatVoicesFile(root) {
  return path.join(root, 'state', 'voice', 'chats.json');
}

/**
 * Keep only the fields the caller explicitly set, validated by the same rules
 * as the global config, minus anything equal to `baseline` (the settings this
 * chat would otherwise inherit). The baseline matters: engine=auto equals the
 * built-in default but can still be a real override on a machine whose global
 * engine is sapi.
 *
 * Fields absent from `raw` stay absent — this must never fill in defaults, or
 * reading the file back would turn "no override" into "override everything".
 */
export function normalizeChatVoice(raw = {}, baseline = DEFAULTS) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const base = baseline && typeof baseline === 'object' ? baseline : {};
  const out = {};
  for (const key of CHAT_VOICE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const raw_value = value[key];
    if (raw_value === undefined || raw_value === null || raw_value === '') continue;
    const next = normalizeSettings({ ...DEFAULTS, [key]: raw_value })[key];
    if (next === undefined || next === null || next === '') continue;
    if (Object.hasOwn(base, key) && base[key] === next) continue;
    out[key] = next;
  }
  return out;
}

/** Every saved per-chat override, validated but never filtered against a baseline. */
export function readChatVoices(root) {
  const rows = readJson(chatVoicesFile(root));
  const chats = rows?.chats;
  if (!chats || typeof chats !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(chats)) {
    if (!/^wechat:(private|group):[0-9]{1,20}$/.test(key)) continue;
    const saved = normalizeChatVoice(value, {});
    if (Object.keys(saved).length) out[key] = saved;
  }
  return out;
}

/**
 * Merge one chat's overrides into the global settings. `null` values mean
 * "forget this override" so a chat can be reset back to the global voice.
 */
export function applyChatVoice(base, overrides = {}) {
  const merged = { ...base };
  for (const key of CHAT_VOICE_KEYS) {
    if (overrides?.[key] === undefined) continue;
    merged[key] = overrides[key];
  }
  return normalizeSettings(merged);
}

/**
 * Persist a new voice for one chat. `patch` uses the same field names as the
 * global config; a `null` deletes that override. Returns the effective settings
 * for the chat after the write.
 */
export function saveChatVoice(root, chatKey, patch, base = DEFAULTS) {
  const key = String(chatKey ?? '').trim();
  if (!/^wechat:(private|group):[0-9]{1,20}$/.test(key)) throw Object.assign(new Error('CHAT_VOICE_KEY_INVALID'), { code: 'CHAT_VOICE_KEY_INVALID' });
  const rows = readJson(chatVoicesFile(root)) ?? {};
  const chats = rows?.chats && typeof rows.chats === 'object' ? { ...rows.chats } : {};
  const current = { ...(chats[key] ?? {}) };
  for (const field of CHAT_VOICE_KEYS) {
    if (!patch || !Object.hasOwn(patch, field)) continue;
    if (patch[field] === null || patch[field] === '') delete current[field];
    else current[field] = patch[field];
  }
  const saved = normalizeChatVoice(current, base);
  if (Object.keys(saved).length) chats[key] = saved; else delete chats[key];
  writeJson(chatVoicesFile(root), { version: 1, updatedAt: new Date().toISOString(), chats });
  return applyChatVoice(base, saved);
}

/** Durable proof that the plugin was loaded, with the reason when it was not. */
export function writeLoadedMarker(root, payload) {
  try {
    writeJson(loadedMarkerFile(root), { at: new Date().toISOString(), pid: process.pid, root, ...payload });
    return true;
  } catch { return false; }
}
