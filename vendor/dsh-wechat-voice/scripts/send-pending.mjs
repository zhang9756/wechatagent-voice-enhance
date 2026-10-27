#!/usr/bin/env node
// Drain the staged voice queue through the native /SendVoiceMsg route.
//
//   node scripts/send-pending.mjs --check      # 只看有没有待发、路由通不通
//   node scripts/send-pending.mjs --dry-run    # 演练，不发
//   node scripts/send-pending.mjs --limit 5    # 真的发前 5 条
//
// Queue entries hold the staged WAV; each one is encoded to WeChat SILK right
// before sending. Nothing here invents success: items are marked sent only when
// the hook accepts them, and a missing route aborts the whole run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, readIoConfig, chatForSession, hookCredential } from '../lib/context.mjs';
import { createStore } from '../lib/store.mjs';
import { conversationAllowed, grantedTools } from '../lib/auth.mjs';
import { resolveTarget, hookIdentity, probeVoiceRoute, sendVoice } from '../lib/wechat.mjs';
import { encodeSilk } from '../lib/silk.mjs';
import { explainError } from '../lib/voice-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

const argv = process.argv.slice(2);
const flag = name => argv.includes('--' + name);
const value = name => { const index = argv.indexOf('--' + name); return index >= 0 ? argv[index + 1] : undefined; };

const limit = Math.max(1, Math.min(50, Number(value('limit')) || 50));
const checkOnly = flag('check');
const dryRun = flag('dry-run') || checkOnly;

const store = createStore({ root });
const config = readConfig(root);
const ioConfig = readIoConfig(root);
const credential = hookCredential(root, config);
const pending = store.pending().filter(item => item.status !== 'sent');

const summary = async () => {
  const probe = await probeVoiceRoute({ credential });
  return { pending: pending.length, voiceRoute: probe, hookUrl: credential.baseUrl, tokenPresent: !!credential.token };
};

if (checkOnly) {
  console.log(JSON.stringify(await summary(), null, 2));
  process.exit(0);
}

const probe = await probeVoiceRoute({ credential });
if (!probe.supported) {
  console.error(explainError(Object.assign(new Error(probe.reason), { code: probe.reason })));
  console.error(JSON.stringify({ pending: pending.length, voiceRoute: probe }, null, 2));
  process.exit(2);
}
if (!pending.length) { console.log(JSON.stringify({ ok: true, sent: 0, note: '没有待发语音' }, null, 2)); process.exit(0); }

const identity = await hookIdentity({ credential });
if (identity.raw?.nativeVoiceSend === false) {
  console.error('原生语音路由存在，但语音对象布局不可用（nativeVoiceSend=false），先修 hook。');
  process.exit(2);
}
let sent = 0, skipped = 0, failed = 0;
const results = [];
for (const item of pending.slice(0, limit)) {
  const chat = /^wechat:(private|group):([0-9]+)$/.exec(String(item.chat ?? ''));
  if (!chat) { skipped++; results.push({ id: item.id, chat: item.chat, skipped: 'CHAT_KEY_INVALID' }); continue; }
  const [, kind, id] = chat;
  if (!conversationAllowed(config, kind, id)) { skipped++; results.push({ id: item.id, chat: item.chat, skipped: 'CHAT_NOT_ALLOWED' }); continue; }
  if (!grantedTools(config, item.chat).includes('wechat_voice_say')) { skipped++; results.push({ id: item.id, chat: item.chat, skipped: 'TOOL_NOT_GRANTED' }); continue; }
  if (dryRun) { results.push({ id: item.id, chat: item.chat, dryRun: true }); continue; }
  try {
    const wxid = await resolveTarget({ ioConfig, kind, id });
    const silk = item.silkPath ? { path: item.silkPath, durationMs: item.durationMs } : await encodeSilk({ root, wavPath: item.path });
    await sendVoice({ credential, account: identity.account, wxid, file: silk.path, durationMs: silk.durationMs, format: 'silk' });
    store.resolvePending(item.id, 'sent');
    sent++; results.push({ id: item.id, chat: item.chat, sent: true });
  } catch (error) {
    failed++; results.push({ id: item.id, chat: item.chat, error: error.code ?? String(error), message: explainError(error) });
  }
}
console.log(JSON.stringify({ ok: failed === 0, sent, skipped, failed, dryRun, results }, null, 2));
process.exit(failed === 0 ? 0 : 1);
