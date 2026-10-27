// Resolve "which WeChat conversation is this DSH session?" and read the project
// configuration that the phone-side bot already uses.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;

/** The plugin ships inside the WeChatAgent project: <root>/packages/dsh-wechat-voice. */
export function defaultRoot() {
  if (process.env.WECHATAGENT_ROOT) return path.resolve(process.env.WECHATAGENT_ROOT);
  return path.resolve(here, '..', '..', '..');
}

function readJsonFile(file, maxBytes = MB) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return null; }
}

export function readConfig(root) {
  return readJsonFile(path.join(root, 'config/wechatagent.json'));
}

export function readIoConfig(root) {
  return readJsonFile(path.join(root, 'state/wechat-io-config.json')) ?? {};
}

/** The single per-account state directory, e.g. state/accounts/<sha256>. */
export function accountScope(root) {
  try {
    const dirs = fs.readdirSync(path.join(root, 'state', 'accounts'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name);
    return dirs.length === 1 ? dirs[0] : null;
  } catch { return null; }
}

/** Map `wechat:private:1769324077` -> `{key, kind, id}`. */
export function chatParts(key) {
  const match = /^wechat:(private|group):([0-9]{1,20})$/.exec(String(key ?? '').trim());
  if (!match) return null;
  return { key: `wechat:${match[1]}:${match[2]}`, kind: match[1], id: match[2] };
}

/**
 * Find the conversation key bound to a DSH session id. Rotation keeps old ids
 * under `profiles[key].previousSessions`, so those resolve too.
 */
export function chatForSession(root, sessionId) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) return null;
  const scope = accountScope(root);
  const candidates = [
    scope ? path.join(root, 'state', 'accounts', scope, 'dsh-sessions.json') : '',
    path.join(process.env.DSH_HOME ?? '', 'dsh-social-bridge', 'sessions.json'),
  ].filter(candidate => candidate && fs.existsSync(candidate));
  for (const file of candidates) {
    const saved = readJsonFile(file, 8 * MB);
    const conversations = saved?.conversations;
    if (!conversations || typeof conversations !== 'object') continue;
    for (const [key, value] of Object.entries(conversations)) {
      if (String(value) === sid) { const parts = chatParts(key); if (parts) return { ...parts, sessionId: sid, source: 'current' }; }
    }
    for (const [key, profile] of Object.entries(saved?.profiles ?? {})) {
      if (Array.isArray(profile?.previousSessions) && profile.previousSessions.some(item => String(item) === sid)) {
        const parts = chatParts(key);
        if (parts) return { ...parts, sessionId: sid, source: 'previous' };
      }
    }
  }
  return null;
}

/** Hook base url + token, mirroring what scripts/hook-onebot.mjs uses. */
export function hookCredential(root, config) {
  const baseUrl = String(config?.hook?.baseUrl ?? 'http://127.0.0.1:30001').replace(/\/+$/, '');
  const version = String(config?.hook?.expectedVersion ?? '').trim();
  const tokenFiles = [
    version ? path.join(root, 'state', 'hook', `wechat-${version}`, 'wechatagent-hook.token') : '',
    path.join(root, 'state', 'hook', 'wechatagent-hook.token'),
    path.join(root, 'state', 'hook', 'native-token.txt'),
  ].filter(Boolean);
  for (const file of tokenFiles) {
    try {
      const token = fs.readFileSync(file, 'utf8').trim();
      if (/^[a-f0-9]{64}$/i.test(token)) return { baseUrl, token };
    } catch { /* try next */ }
  }
  return { baseUrl, token: '' };
}
