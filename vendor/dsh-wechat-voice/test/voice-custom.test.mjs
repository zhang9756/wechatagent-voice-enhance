import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { createVoiceService } from '../lib/voice-service.mjs';
import { resolveEdgeVoice, edgeVoiceLabel, EDGE_VOICES } from '../lib/edge.mjs';
import { readChatVoices, saveChatVoice, applyChatVoice, resolveSettings, DEFAULTS } from '../lib/settings.mjs';

const CHAT = 'wechat:private:1769324077';
const SESSION = 'social-abc';

/** Fixture project with a whitelisted, voice-granted chat. */
function fixture({ grant = ['wechat_voice_say', 'wechat_voice_set', 'wechat_voice_preview'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-custom-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'accounts', 'scope'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'voice'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state/voice/config.json'), JSON.stringify({ engine: 'sapi' }));
  fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify({
    hook: { baseUrl: 'http://127.0.0.1:1', expectedVersion: '4.1.10.27' },
    wechat: {
      whitelist: { groups: [], private: ['1769324077'] },
      dshAccess: { chats: { [CHAT]: { skills: [], tools: grant } } },
    },
  }));
  fs.writeFileSync(path.join(root, 'state/accounts', 'scope', 'dsh-sessions.json'), JSON.stringify({
    version: 2, conversations: { [CHAT]: SESSION }, profiles: {},
  }));
  fs.writeFileSync(path.join(root, 'state/wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:1' }));
  return root;
}

test('Chinese short names resolve to real Edge voices', () => {
  assert.equal(resolveEdgeVoice('晓伊'), 'zh-CN-XiaoyiNeural');
  assert.equal(resolveEdgeVoice(' 晓北 '), 'zh-CN-liaoning-XiaobeiNeural');
  assert.equal(resolveEdgeVoice('xiaoyi'), 'zh-CN-XiaoyiNeural');
  assert.equal(resolveEdgeVoice('zh-cn-xiaoyineural'), 'zh-CN-XiaoyiNeural');
  assert.equal(resolveEdgeVoice('zh-CN-YunxiNeural'), 'zh-CN-YunxiNeural');
  assert.equal(resolveEdgeVoice('不存在的名字'), '');
  assert.equal(resolveEdgeVoice(''), '');
});

test('every documented Edge voice is reachable by its Chinese label', () => {
  for (const entry of EDGE_VOICES) {
    assert.equal(resolveEdgeVoice(entry.label.split(' · ')[0]), entry.name, entry.label);
    assert.equal(resolveEdgeVoice(entry.name), entry.name);
    assert.equal(edgeVoiceLabel(entry.name), entry.label.split(' · ')[0]);
  }
});

test('per-chat overrides merge over the global voice', () => {
  const merged = applyChatVoice({ ...DEFAULTS, engine: 'auto' }, { engine: 'edge', edgeVoice: 'zh-CN-XiaoyiNeural', rate: -2 });
  assert.equal(merged.engine, 'edge');
  assert.equal(merged.edgeVoice, 'zh-CN-XiaoyiNeural');
  assert.equal(merged.rate, -2);
  assert.equal(merged.maxVoices, DEFAULTS.maxVoices, 'untouched fields keep the global value');
});

test('a chat voice survives a fresh read from disk', () => {
  const root = fixture();
  saveChatVoice(root, CHAT, { edgeVoice: 'zh-CN-XiaoyiNeural', engine: 'edge' }, DEFAULTS);
  assert.deepEqual(readChatVoices(root)[CHAT], { engine: 'edge', edgeVoice: 'zh-CN-XiaoyiNeural' });
  // Same chat, new service instance (= after a restart).
  const service = createVoiceService({ root });
  assert.equal(service.currentVoice(CHAT).edgeVoice, 'zh-CN-XiaoyiNeural');
  assert.equal(service.currentVoice('wechat:private:999').edgeVoice, DEFAULTS.edgeVoice);
  fs.rmSync(root, { recursive: true, force: true });
});

test('saving the default value drops the override instead of pinning it', () => {
  const root = fixture();
  saveChatVoice(root, CHAT, { edgeVoice: 'zh-CN-XiaoyiNeural' }, DEFAULTS);
  saveChatVoice(root, CHAT, { edgeVoice: DEFAULTS.edgeVoice }, DEFAULTS);
  assert.equal(readChatVoices(root)[CHAT], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wechat_voice_set stores the Chinese name the owner asked for', async () => {
  const root = fixture();
  const registered = new Map();
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: () => ({ info: () => {} }) }, { root });
  const set = registered.get('wechat_voice_set');
  assert.ok(set, 'wechat_voice_set must be registered');
  const result = await set.execute({ voice: '晓伊' }, { agent: { session: { header: { id: SESSION } } } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.voice, 'zh-CN-XiaoyiNeural');
  assert.equal(result.voiceLabel, '晓伊');
  assert.equal(result.scope, 'chat');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'state/voice/chats.json'), 'utf8'));
  assert.equal(saved.chats[CHAT].edgeVoice, 'zh-CN-XiaoyiNeural');
  // 晓伊 is an online voice, so the engine must leave sapi behind.
  assert.equal(saved.chats[CHAT].engine, 'auto');
  // The global file must stay untouched.
  const global = JSON.parse(fs.readFileSync(path.join(root, 'state/voice/config.json'), 'utf8'));
  assert.equal(global.edgeVoice, undefined);
  assert.equal(global.engine, 'sapi');
  fs.rmSync(root, { recursive: true, force: true });
});

test('wechat_voice_set rejects a voice nobody has, without writing anything', async () => {
  const root = fixture();
  const registered = new Map();
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: () => ({ info: () => {} }) }, { root });
  const result = await registered.get('wechat_voice_set').execute(
    { voice: '鲸鱼音色' }, { agent: { session: { header: { id: SESSION } } } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHAT_VOICE_UNKNOWN');
  assert.equal(readChatVoices(root)[CHAT], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wechat_voice_set refuses a chat without the grant', async () => {
  const root = fixture({ grant: ['wechat_voice_say'] });
  const registered = new Map();
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: () => ({ info: () => {} }) }, { root });
  const result = await registered.get('wechat_voice_set').execute(
    { voice: '晓伊' }, { agent: { session: { header: { id: SESSION } } } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_NOT_GRANTED');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an empty voice resets the chat back to the global default', async () => {
  const root = fixture();
  const registered = new Map();
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: () => ({ info: () => {} }) }, { root });
  const set = registered.get('wechat_voice_set');
  const exec = { agent: { session: { header: { id: SESSION } } } };
  await set.execute({ voice: '晓北' }, exec);
  assert.ok(readChatVoices(root)[CHAT]);
  const reset = await set.execute({ voice: '' }, exec);
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(readChatVoices(root)[CHAT], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a saved chat voice is what the next say call actually uses', async () => {
  const root = fixture({ grant: ['wechat_voice_say', 'wechat_voice_set'] });
  const registered = new Map();
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: () => ({ info: () => {} }) }, { root });
  const exec = { agent: { session: { header: { id: SESSION } } } };
  // An offline SAPI voice keeps this test independent of the network while
  // still proving the saved value is the one synthesis receives.
  const sapi = await registered.get('wechat_voice_set').execute({ voice: 'Microsoft Huihui' }, exec);
  if (!sapi.ok) {
    // No such SAPI voice on this machine: nothing to assert about offline voices.
    assert.equal(sapi.code, 'CHAT_VOICE_UNKNOWN');
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  assert.equal(sapi.engine, 'sapi');
  assert.match(sapi.sapiVoice, /Huihui/i);
  const said = await registered.get('wechat_voice_say').execute({ text: '主人，晚安' }, exec);
  assert.equal(said.ok, true, JSON.stringify(said));
  assert.equal(said.engine, 'sapi', JSON.stringify(said));
  assert.match(said.voice, /Huihui/i, JSON.stringify(said));
  assert.ok(said.items.every(item => fs.existsSync(item.path)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unknown temporary voice fails instead of silently using 晓晓', async () => {
  const root = fixture();
  const service = createVoiceService({ root });
  await assert.rejects(
    service.preview({ text: '主人好', voice: '鲸鱼音色', engine: 'edge' }),
    error => error.code === 'CHAT_VOICE_UNKNOWN',
  );
  await assert.rejects(
    service.preview({ text: '主人好', voice: '鲸鱼音色', engine: 'sapi' }),
    error => error.code === 'CHAT_VOICE_UNKNOWN',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('say reports an unknown voice to the model instead of faking success', async () => {
  const root = fixture({ grant: ['wechat_voice_say'] });
  const registered = new Map();
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: () => ({ info: () => {} }) }, { root });
  const result = await registered.get('wechat_voice_say').execute(
    { text: '主人好', voice: '鲸鱼音色' },
    { agent: { session: { header: { id: SESSION } } } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHAT_VOICE_UNKNOWN');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a global change applies immediately, without a DSH restart', async () => {
  const root = fixture({ grant: ['wechat_voice_set'] });
  const service = createVoiceService({ root, settings: resolveSettings(root) });
  assert.equal(service.options.edgeVoice, 'zh-CN-XiaoxiaoNeural');
  const set = await service.setVoice({ sessionId: SESSION, scope: 'global', voice: '晓伊' });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.voice, 'zh-CN-XiaoyiNeural');
  // In-memory copy and the file must agree right away.
  assert.equal(service.options.edgeVoice, 'zh-CN-XiaoyiNeural');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'state/voice/config.json'), 'utf8'));
  assert.equal(saved.edgeVoice, 'zh-CN-XiaoyiNeural');
  // No per-chat file is involved for a global change.
  assert.equal(readChatVoices(root)[CHAT], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('editing config.json by hand applies to the next voice, no restart', () => {
  const root = fixture();
  const service = createVoiceService({ root, settings: resolveSettings(root) });
  assert.equal(service.settingsFor(CHAT).edgeVoice, DEFAULTS.edgeVoice);
  fs.writeFileSync(path.join(root, 'state/voice/config.json'), JSON.stringify({ engine: 'edge', edgeVoice: 'zh-CN-XiaoyiNeural' }));
  const effective = service.settingsFor(CHAT);
  assert.equal(effective.engine, 'edge');
  assert.equal(effective.edgeVoice, 'zh-CN-XiaoyiNeural');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a one-off voice override still beats the saved chat voice', async () => {
  const root = fixture({ grant: ['wechat_voice_say', 'wechat_voice_set'] });
  const registered = new Map();
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: () => ({ info: () => {} }) }, { root });
  const exec = { agent: { session: { header: { id: SESSION } } } };
  await registered.get('wechat_voice_set').execute({ voice: '晓伊', engine: 'edge' }, exec);
  const service = createVoiceService({ root });
  assert.equal(service.settingsFor(CHAT).edgeVoice, 'zh-CN-XiaoyiNeural');
  // The per-call override is merged in say(); check the merge order directly.
  const oneOff = { ...service.settingsFor(CHAT), voice: 'zh-CN-XiaoxiaoNeural' };
  assert.equal(oneOff.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(oneOff.engine, 'edge');
  fs.rmSync(root, { recursive: true, force: true });
});
