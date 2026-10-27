// Voice staging area. Everything lives under <WeChatAgentRoot>/state/voice so a
// future native /SendVoiceMsg route (and the user's own file browser) can find
// it, and so cleanup never touches unrelated project state.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MB = 1024 * 1024;

export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

export function voiceRoot(root) {
  return path.join(root, 'state', 'voice');
}

export function createStore({ root, maxFiles = 200, maxBytes = 64 * MB } = {}) {
  const base = voiceRoot(root);
  const outgoing = path.join(base, 'outgoing');
  const index = path.join(base, 'index.json');
  const pendingPath = path.join(base, 'pending.json');

  const ensure = () => { fs.mkdirSync(outgoing, { recursive: true }); };

  function readJson(file, fallback) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * MB) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback;
    } catch { return fallback; }
  }

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  /** Deterministic key for "same words, same voice, same engine, same speed" reuse. */
  function cacheKey({ text, voice, rate, volume, engine }) {
    return sha256(JSON.stringify([
      String(text).trim(), voice ?? '', Number(rate) || 0, Number(volume) || 0, engine ?? '',
    ])).slice(0, 32);
  }

  function findReusable(key) {
    const rows = readJson(index, { version: 1, entries: {} });
    const entry = rows.entries?.[key];
    if (!entry?.id) return null;
    const file = path.join(outgoing, entry.id + '.wav');
    if (!fs.existsSync(file)) { delete rows.entries[key]; writeJson(index, rows); return null; }
    return { ...entry, path: file };
  }

  function remember(key, entry) {
    const rows = readJson(index, { version: 1, entries: {} });
    rows.version = 1;
    rows.entries = rows.entries ?? {};
    rows.entries[key] = entry;
    const keys = Object.keys(rows.entries);
    if (keys.length > maxFiles * 2) {
      for (const stale of keys.slice(0, keys.length - maxFiles)) delete rows.entries[stale];
    }
    writeJson(index, rows);
  }

  /**
   * Store a synthesized wav + its metadata. Reuses the existing file when the
   * identical audio was produced before.
   */
  async function put({ wavPath, text, voice, rate, volume, durationMs, engine = '', extra = {}, key: reuseKey }) {
    ensure();
    const buffer = await fsp.readFile(wavPath);
    if (!buffer.length || buffer.length > 16 * MB) throw Object.assign(new Error('VOICE_FILE_SIZE_INVALID'), { code: 'VOICE_FILE_SIZE_INVALID' });
    const id = sha256(buffer);
    const target = path.join(outgoing, id + '.wav');
    if (!fs.existsSync(target)) {
      const temp = target + '.' + crypto.randomUUID() + '.tmp';
      await fsp.writeFile(temp, buffer);
      await fsp.rename(temp, target);
    }
    // A fallback is requested as one engine but produced by another. Cache it
    // under the requested key so the next identical request reuses it, while
    // the entry still records the engine/voice that actually made the audio.
    const key = reuseKey || cacheKey({ text, voice, rate, volume, engine });
    const entry = {
      id,
      path: target,
      bytes: buffer.length,
      durationMs,
      voice: voice ?? '',
      engine: engine ?? '',
      rate: Number(rate) || 0,
      volume: Number(volume) || 100,
      text: String(text ?? '').slice(0, 2000),
      format: 'wav/pcm16',
      createdAt: Date.now(),
      ...extra,
    };
    remember(key, entry);
    return { ...entry, path: target, cached: false };
  }

  /** Queue an entry for later delivery (hook voice route not available yet). */
  function queuePending(entry) {
    const rows = readJson(pendingPath, { version: 1, entries: [] });
    rows.version = 1;
    rows.entries = Array.isArray(rows.entries) ? rows.entries : [];
    if (!rows.entries.some(item => item.id === entry.id && item.chat === entry.chat)) {
      rows.entries.push(entry);
      if (rows.entries.length > 200) rows.entries = rows.entries.slice(-200);
    }
    writeJson(pendingPath, rows);
    return entry;
  }

  function pending() {
    const rows = readJson(pendingPath, { version: 1, entries: [] });
    return Array.isArray(rows.entries) ? rows.entries : [];
  }

  function resolvePending(id, status = 'sent') {
    const rows = readJson(pendingPath, { version: 1, entries: [] });
    rows.entries = (rows.entries ?? []).map(item => (item.id === id ? { ...item, status, resolvedAt: Date.now() } : item));
    writeJson(pendingPath, rows);
  }

  /** Keep the staging area bounded; never drop files still waiting to be sent. */
  function prune() {
    let files;
    try { files = fs.readdirSync(outgoing).filter(name => /^[a-f0-9]{64}\.(wav|silk)$/.test(name)); } catch { return { removed: 0, bytes: 0 }; }
    const protectedIds = new Set(pending().filter(item => item.status !== 'sent').map(item => item.id));
    const stats = files.map(name => {
      const file = path.join(outgoing, name);
      const stat = fs.statSync(file);
      return { file, name, id: name.replace(/\.(wav|silk)$/, ''), size: stat.size, mtimeMs: stat.mtimeMs };
    }).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = stats.reduce((sum, item) => sum + item.size, 0);
    let removed = 0, bytes = 0;
    for (const item of stats) {
      if (total <= maxBytes && stats.length - removed <= maxFiles) break;
      if (protectedIds.has(item.id)) continue;
      try { fs.unlinkSync(item.file); total -= item.size; removed++; bytes += item.size; } catch { /* locked file, try later */ }
    }
    return { removed, bytes };
  }

  return { base, outgoing, cacheKey, findReusable, put, queuePending, pending, resolvePending, prune };
}
