// TTS dispatcher: Edge neural voices when reachable, Windows SAPI otherwise.
//
// SAPI child processes are spawned with stdio ignored on purpose: this project runs
// inside a Windows harness that can confine named pipes, and a piped
// child_process call fails there with EPERM. Everything the caller needs comes
// back through files and exit codes instead.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseWav } from './wav.mjs';
import { synthesizeEdge, isEdgeVoice, EDGE_DEFAULT_VOICE } from './edge.mjs';
import { synthesizeBaidu, BAIDU_VOICE } from './baidu.mjs';
import { synthesizeFish, isFishVoice, FISH_VOICE, FISH_DEFAULT_MODEL } from './fish.mjs';

export { isEdgeVoice, EDGE_DEFAULT_VOICE, BAIDU_VOICE, isFishVoice, FISH_VOICE };

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPEAK_SCRIPT = path.join(here, '..', 'voices', 'sapi-speak.ps1');

// PowerShell 7 sees the modern OneCore voices (Microsoft Yaoyao, Kangkang…),
// Windows PowerShell 5.1 only sees the legacy "Desktop" voice set. The bundled
// dsh-ops pwsh lives inside the DSH profile's node_modules, so PATH alone is not
// enough when this runs inside the DSH host process.
const DSH_PROFILE_DIRS = () => {
  const dirs = [];
  if (process.env.DSH_PROFILE_DIR) dirs.push(process.env.DSH_PROFILE_DIR);
  const home = process.env.DSH_HOME;
  if (home) dirs.push(path.join(home, 'profiles', process.env.DSH_PROFILE || 'desktop'));
  return dirs;
};

const bundledPwsh = () => {
  const found = [];
  for (const profileDir of DSH_PROFILE_DIRS()) {
    const scoped = path.join(profileDir, 'node_modules', '@dsh-ops');
    let entries = [];
    try { entries = fs.readdirSync(scoped, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^pwsh-/.test(entry.name)) continue;
      found.push(path.join(scoped, entry.name, 'bin', 'pwsh.exe'));
    }
  }
  return found;
};

const SHELL_CANDIDATES = () => {
  const candidates = [];
  const push = value => { if (value && !candidates.includes(value)) candidates.push(value); };
  if (process.env.DSH_VOICE_PWSH) push(process.env.DSH_VOICE_PWSH);
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) push(path.join(dir, 'pwsh.exe'));
  for (const bundled of bundledPwsh()) push(bundled);
  if (process.env.ProgramFiles) push(path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'));
  if (process.env['ProgramFiles(x86)']) push(path.join(process.env['ProgramFiles(x86)'], 'PowerShell', '7', 'pwsh.exe'));
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  // 5.1 fallback: fewer voices, but it is always installed with Windows.
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) push(path.join(dir, 'powershell.exe'));
  if (process.env.SystemRoot) push(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  return candidates;
};

let cachedShell;
let cachedVoices = { at: 0, list: [] };

function resolveShell() {
  if (cachedShell !== undefined) return cachedShell;
  for (const candidate of SHELL_CANDIDATES()) {
    try { if (fs.existsSync(candidate)) { cachedShell = candidate; return cachedShell; } } catch { /* next */ }
  }
  cachedShell = null;
  return cachedShell;
}

export const shellInUse = () => resolveShell();

const EXIT_REASONS = {
  2: 'TTS_ARGUMENTS_INVALID',
  3: 'TTS_ENGINE_UNAVAILABLE',
  4: 'TTS_VOICE_NOT_INSTALLED',
  5: 'TTS_TEXT_EMPTY',
  6: 'TTS_SYNTHESIS_FAILED',
};

function run(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const shell = resolveShell();
    if (!shell) { reject(Object.assign(new Error('TTS_SHELL_UNAVAILABLE'), { code: 'TTS_SHELL_UNAVAILABLE' })); return; }
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SPEAK_SCRIPT, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(new Error('TTS_SHELL_UNAVAILABLE'), { code: 'TTS_SHELL_UNAVAILABLE', cause: error })); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) { resolve({ ok: true }); return; }
      const reason = EXIT_REASONS[code] ?? 'TTS_SYNTHESIS_FAILED';
      reject(Object.assign(new Error(reason), { code: reason, exitCode: code }));
    });
  });
}

function errorText(outPath) {
  try {
    const text = fs.readFileSync(outPath + '.err', 'utf8').trim();
    return text.slice(0, 400);
  } catch { return ''; }
}

/** Installed SAPI voices as `[{name, culture, gender, enabled}]`. Cached 60 s. */
export async function listVoices({ timeoutMs = 30000, fresh = false } = {}) {
  if (!fresh && cachedVoices.list.length && Date.now() - cachedVoices.at < 60000) return cachedVoices.list;
  const out = path.join(os.tmpdir(), `dsh-voice-voices-${process.pid}-${Date.now()}.json`);
  try {
    await run(['-List', '-Out', out], { timeoutMs });
    const rows = JSON.parse(fs.readFileSync(out, 'utf8'));
    const list = Array.isArray(rows) ? rows : [];
    cachedVoices = { at: Date.now(), list };
    return list;
  } catch (error) {
    error.detail = errorText(out);
    throw error;
  } finally {
    for (const file of [out, out + '.err']) { try { fs.unlinkSync(file); } catch { /* best effort */ } }
  }
}

/**
 * Synthesize `text` into `outPath` (a .wav) with SAPI. Returns `{path, bytes,
 * durationMs, sampleRate, channels}`; throws a coded error on failure.
 */
export async function synthesizeSapi({ text, outPath, voice = '', rate = 0, volume = 100, sampleRate = 22050, timeoutMs = 60000 }) {
  const value = String(text ?? '');
  if (!value.trim()) throw Object.assign(new Error('TTS_TEXT_EMPTY'), { code: 'TTS_TEXT_EMPTY' });
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const textFile = outPath + '.txt';
  await fsp.writeFile(textFile, value, 'utf8');
  const args = ['-TextFile', textFile, '-Out', outPath, '-Rate', String(Math.round(rate)), '-Volume', String(Math.round(volume)), '-SampleRate', String(sampleRate)];
  if (voice) args.push('-Voice', voice);
  try {
    await run(args, { timeoutMs: timeoutMs + Math.min(60000, Math.round(value.length * 12)) });
    const buffer = await fsp.readFile(outPath);
    const info = parseWav(buffer);
    return {
      path: outPath, bytes: buffer.length, durationMs: info.durationMs,
      sampleRate: info.sampleRate, channels: info.channels, engine: 'sapi', voice: voice || '',
    };
  } catch (error) {
    error.detail = errorText(outPath);
    throw error;
  } finally {
    for (const file of [textFile, outPath + '.err']) { try { fs.unlinkSync(file); } catch { /* best effort */ } }
    if (!fs.existsSync(outPath)) { try { fs.unlinkSync(outPath); } catch { /* nothing to clean */ } }
  }
}

// Preference order for an anime-ish zh-CN female voice, best first.
const VOICE_PREFERENCE = ['Microsoft Xiaoxiao', 'Microsoft Xiaoyi', 'Microsoft Yaoyao', 'Microsoft Huihui', 'Microsoft Kangkang'];

// When Edge is unreachable, auto mode should not pay a 10 s connect timeout on
// every chunk for the next two minutes. Explicit `engine: 'edge'` still retries.
const EDGE_DOWN_MS = 120000;
const EDGE_COOLDOWN_CODES = new Set(['TTS_EDGE_NETWORK', 'TTS_EDGE_TIMEOUT', 'TTS_EDGE_PROTOCOL', 'TTS_EDGE_DEPENDENCY']);
let edgeDownUntil = 0;

export const edgeCooldownUntil = () => edgeDownUntil;

async function sapiFallback({ text, outPath, sapiVoice, rate, volume, sampleRate, timeoutMs, edgeError, baiduError, fishError, fallbackFrom = 'edge' }) {
  let fallbackVoice = sapiVoice;
  try {
    const picked = await pickVoice(sapiVoice || '');
    if (picked.name) fallbackVoice = picked.name;
  } catch { /* let SAPI itself report the failure */ }
  const made = await synthesizeSapi({ text, outPath, voice: fallbackVoice, rate, volume, sampleRate, timeoutMs });
  const reasons = [edgeError?.code, baiduError?.code && `baidu:${baiduError.code}`, fishError?.code && `fish:${fishError.code}`]
    .filter(Boolean);
  return {
    ...made,
    engine: 'sapi',
    fallbackFrom,
    fallbackReason: reasons.join(';') || 'TTS_EDGE_NETWORK',
    fallbackDetail: String(edgeError?.message ?? baiduError?.message ?? fishError?.message ?? '').slice(0, 160),
  };
}

/**
 * In auto mode the online voices are a chain, not a single bet: Edge first,
 * then Baidu, then the offline SAPI voice. A reply must never be blocked by
 * one service's regional outage.
 */
async function onlineFallback({ text, outPath, sapiVoice, rate, volume, sampleRate, timeoutMs, edgeError, fishError }) {
  try {
    const made = await synthesizeBaidu({
      text, outPath, rate, volume, timeoutMs: Math.min(timeoutMs, 20000),
    });
    return {
      ...made,
      fallbackFrom: fishError ? 'fish,edge' : 'edge',
      fallbackReason: [fishError?.code, edgeError?.code].filter(Boolean).join(';') || 'TTS_EDGE_NETWORK',
      fallbackDetail: String(edgeError?.message ?? fishError?.message ?? '').slice(0, 160),
    };
  } catch (baiduError) {
    return sapiFallback({
      text, outPath, sapiVoice, rate, volume, sampleRate, timeoutMs, edgeError, baiduError, fishError,
      fallbackFrom: fishError ? 'fish,edge' : 'edge',
    });
  }
}

/**
 * Engine dispatcher.
 *
 * `auto` keeps the cheapest-and-most-available order for normal chat: Edge
 * neural voice, then Baidu, then the offline SAPI engine. Fish Audio is
 * *deliberately* not in that chain — it is a paid API and the owner picks it
 * explicitly (`engine: 'fish'`) or by asking for a Fish voice.
 *
 * `fish` uses Fish Audio when a key is configured and otherwise reports
 * TTS_FISH_NO_KEY instead of silently speaking in another voice — a silent
 * substitution would look like success while sounding wrong. Pass
 * `fallbackOnFishError: true` to fall through to the Edge chain anyway.
 */
export async function synthesize({
  text, outPath, voice = '', rate = 0, volume = 100, sampleRate = 22050,
  timeoutMs = 60000, engine = 'sapi', sapiVoice = '',
  fishApiKey = '', fishApiKeyEnv = 'FISH_AUDIO_API_KEY', fishEndpoint = '', fishModel = FISH_DEFAULT_MODEL,
  fishLatency = 'normal', fishProxy = '', fallbackOnFishError = false,
} = {}) {
  const mode = ['auto', 'edge', 'baidu', 'sapi', 'fish'].includes(String(engine)) ? String(engine) : 'sapi';
  if (mode === 'sapi') return synthesizeSapi({ text, outPath, voice, rate, volume, sampleRate, timeoutMs });
  if (mode === 'baidu') return synthesizeBaidu({ text, outPath, rate, volume, timeoutMs });

  const fishArgs = {
    text, outPath, voice, model: fishModel, apiKey: fishApiKey, apiKeyEnv: fishApiKeyEnv,
    endpoint: fishEndpoint, rate, volume, latency: fishLatency, timeoutMs, proxy: fishProxy,
  };

  if (mode === 'fish') {
    try {
      return await synthesizeFish(fishArgs);
    } catch (fishError) {
      if (!fallbackOnFishError) throw fishError;
      const edgeVoice = isEdgeVoice(voice) ? voice : EDGE_DEFAULT_VOICE;
      try {
        const made = await synthesizeEdge({ text, outPath, voice: edgeVoice, rate, volume, timeoutMs });
        return { ...made, fallbackFrom: 'fish', fallbackReason: fishError.code, fallbackDetail: String(fishError.message ?? '').slice(0, 160) };
      } catch (edgeError) {
        if (EDGE_COOLDOWN_CODES.has(edgeError?.code)) edgeDownUntil = Date.now() + EDGE_DOWN_MS;
        return onlineFallback({
          text, outPath, sapiVoice, rate, volume, sampleRate, timeoutMs, edgeError, fishError,
        });
      }
    }
  }

  // An explicit Fish voice on `auto` means the owner wants Fish, even though the
  // stored engine is still the everyday one.
  if (mode === 'auto' && isFishVoice(voice)) {
    try {
      return await synthesizeFish(fishArgs);
    } catch (fishError) {
      const edgeVoice = EDGE_DEFAULT_VOICE;
      try {
        const made = await synthesizeEdge({ text, outPath, voice: edgeVoice, rate, volume, timeoutMs });
        return { ...made, fallbackFrom: 'fish', fallbackReason: fishError.code, fallbackDetail: String(fishError.message ?? '').slice(0, 160) };
      } catch (edgeError) {
        if (EDGE_COOLDOWN_CODES.has(edgeError?.code)) edgeDownUntil = Date.now() + EDGE_DOWN_MS;
        return onlineFallback({
          text, outPath, sapiVoice, rate, volume, sampleRate, timeoutMs, edgeError, fishError,
        });
      }
    }
  }

  const edgeVoice = isEdgeVoice(voice) ? voice : EDGE_DEFAULT_VOICE;
  if (mode === 'auto' && Date.now() < edgeDownUntil) {
    return onlineFallback({
      text, outPath, sapiVoice, rate, volume, sampleRate, timeoutMs,
      edgeError: Object.assign(new Error('TTS_EDGE_NETWORK'), { code: 'TTS_EDGE_NETWORK', detail: 'edge cooling down' }),
    });
  }
  try {
    return await synthesizeEdge({ text, outPath, voice: edgeVoice, rate, volume, timeoutMs });
  } catch (error) {
    if (EDGE_COOLDOWN_CODES.has(error?.code)) edgeDownUntil = Date.now() + EDGE_DOWN_MS;
    if (mode !== 'auto') throw error;
    return onlineFallback({ text, outPath, sapiVoice, rate, volume, sampleRate, timeoutMs, edgeError: error });
  }
}

/**
 * Resolve a usable voice name. Returns `{name, fellBack, note}`; falls back to
 * whatever zh-CN voice this machine actually has instead of failing a send.
 *
 * Matching is deliberately loose: the owner says "Huihui" while SAPI reports
 * "Microsoft Huihui Desktop". A loose hit counts as success (fellBack: false),
 * so a caller that validates names does not reject a real voice.
 */
export async function pickVoice(preferred = '') {
  const voices = await listVoices().catch(() => []);
  const usable = voices.filter(item => item.enabled);
  const loose = value => {
    const needle = String(value ?? '').trim().toLowerCase();
    if (!needle) return null;
    return usable.find(item => item.name.toLowerCase() === needle)
      ?? usable.find(item => item.name.toLowerCase().includes(needle))
      ?? usable.find(item => needle.includes(item.name.toLowerCase()))
      ?? null;
  };
  if (preferred) {
    const hit = loose(preferred);
    if (hit) return { name: hit.name, fellBack: false, note: '' };
  }
  const zh = usable.filter(item => /^zh/i.test(item.culture));
  for (const want of VOICE_PREFERENCE) {
    const hit = zh.find(item => item.name.startsWith(want));
    if (hit) return { name: hit.name, fellBack: !!preferred, note: preferred ? `本机没有 ${preferred}，改用 ${hit.name}` : '' };
  }
  const female = zh.find(item => /female/i.test(item.gender)) ?? zh[0] ?? usable[0];
  if (!female) return { name: '', fellBack: !!preferred, note: '本机没有可用 SAPI 语音' };
  return { name: female.name, fellBack: !!preferred, note: preferred ? `本机没有 ${preferred}，改用 ${female.name}` : '' };
}
