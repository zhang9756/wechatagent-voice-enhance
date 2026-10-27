import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, name, inject } from '../index.js';
import { createVoiceService } from '../lib/voice-service.mjs';

/** Fixture project: config + whitelist + granted tool + session map. */
function fixture({ grantVoice = true, allowChat = true, engine = 'sapi' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-plugin-'));
  const account = 'scope';
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'accounts', account), { recursive: true });
  if (engine) {
    fs.mkdirSync(path.join(root, 'state', 'voice'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'voice', 'config.json'), JSON.stringify({ engine }));
  }
  fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify({
    hook: { baseUrl: 'http://127.0.0.1:1', expectedVersion: '4.1.10.27' },
    wechat: {
      whitelist: { groups: [], private: allowChat ? ['1769324077'] : [] },
      dshAccess: { chats: { 'wechat:private:1769324077': { skills: [], tools: grantVoice ? ['wechat_voice_say', 'wechat_voice_preview'] : [] } } },
    },
  }));
  fs.writeFileSync(path.join(root, 'state/accounts', account, 'dsh-sessions.json'), JSON.stringify({
    version: 2,
    conversations: { 'wechat:private:1769324077': 'social-abc' },
    profiles: {},
  }));
  fs.writeFileSync(path.join(root, 'state/wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:1', reader_token: 't' }));
  return { root, sessionId: 'social-abc' };
}

function fakeCtx() {
  const registered = new Map();
  const logs = [];
  return {
    tools: { register: definition => { registered.set(definition.name, definition); return definition; } },
    logger: () => ({ info: (...args) => logs.push(args.join(' ')) }),
    registered,
    logs,
  };
}

const execWith = sessionId => ({ agent: { session: { header: { id: sessionId } } } });

test('plugin declares its cordis identity', () => {
  assert.equal(name, 'dsh-wechat-voice');
  assert.deepEqual(inject, ['tools']);
});

test('apply writes a durable config file and a load marker', () => {
  const { root } = fixture({ engine: null });
  const context = fakeCtx();
  apply(context, { root });
  const configFile = path.join(root, 'state', 'voice', 'config.json');
  const markerFile = path.join(root, 'state', 'voice', 'loaded.json');
  assert.ok(fs.existsSync(configFile), 'config.json should be created');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(config.maxVoices, 2);
  assert.equal(config.engine, 'auto');
  assert.equal(config.edgeVoice, 'zh-CN-XiaoxiaoNeural');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert.equal(marker.ok, true);
  assert.equal(marker.name, 'dsh-wechat-voice');
  assert.deepEqual([...marker.tools].sort(), ['wechat_voice_preview', 'wechat_voice_say', 'wechat_voice_set', 'wechat_voice_status']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fresh install defaults to the natural Edge voice with SAPI fallback', () => {
  const { root } = fixture({ engine: null });
  const context = fakeCtx();
  apply(context, { root });
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'state', 'voice', 'loaded.json'), 'utf8'));
  assert.equal(marker.settings.engine, 'auto');
  assert.equal(marker.settings.edgeVoice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(marker.settings.voice, 'Microsoft Yaoyao');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the say tool accepts an engine override in its schema', () => {
  const context = fakeCtx();
  apply(context, { root: '/nonexistent' });
  const say = context.registered.get('wechat_voice_say');
  assert.deepEqual(say.parameters.properties.engine.enum, ['auto', 'edge', 'baidu', 'sapi', 'fish']);
  const preview = context.registered.get('wechat_voice_preview');
  assert.deepEqual(preview.parameters.properties.engine.enum, ['auto', 'edge', 'baidu', 'sapi', 'fish']);
  const set = context.registered.get('wechat_voice_set');
  assert.deepEqual(set.parameters.properties.engine.enum, ['auto', 'edge', 'baidu', 'sapi', 'fish']);
});

test('config.json survives even when cordis strips the config block', () => {
  const { root } = fixture();
  fs.mkdirSync(path.join(root, 'state', 'voice'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'voice', 'config.json'), JSON.stringify({ voice: 'Microsoft Huihui Desktop', rate: -2, maxVoices: 1 }));
  const context = fakeCtx();
  apply(context, { root }); // cordis config missing after DSH rewrote cordis.yml
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'state', 'voice', 'loaded.json'), 'utf8'));
  assert.equal(marker.settings.voice, 'Microsoft Huihui Desktop');
  assert.equal(marker.settings.rate, -2);
  assert.equal(marker.settings.maxVoices, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing tools service degrades instead of throwing', () => {
  const { root } = fixture();
  assert.doesNotThrow(() => apply({ logger: () => ({ info: () => {} }) }, { root }));
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'state', 'voice', 'loaded.json'), 'utf8'));
  assert.equal(marker.ok, false);
  assert.equal(marker.reason, 'TOOLS_SERVICE_UNAVAILABLE');
  fs.rmSync(root, { recursive: true, force: true });
});

test('apply registers the voice tools', () => {
  const context = fakeCtx();
  apply(context, { root: '/nonexistent' });
  assert.deepEqual([...context.registered.keys()].sort(), ['wechat_voice_preview', 'wechat_voice_say', 'wechat_voice_set', 'wechat_voice_status']);
  const say = context.registered.get('wechat_voice_say');
  assert.deepEqual(say.parameters.required, ['text']);
  assert.equal(typeof say.execute, 'function');
});

test('say refuses a chat that is not whitelisted', async () => {
  const { root, sessionId } = fixture({ allowChat: false });
  const context = fakeCtx();
  apply(context, { root });
  const result = await context.registered.get('wechat_voice_say').execute({ text: '主人晚安' }, execWith(sessionId));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHAT_NOT_ALLOWED');
  fs.rmSync(root, { recursive: true, force: true });
});

test('say refuses a chat without the tool grant', async () => {
  const { root, sessionId } = fixture({ grantVoice: false });
  const context = fakeCtx();
  apply(context, { root });
  const result = await context.registered.get('wechat_voice_say').execute({ text: '主人晚安' }, execWith(sessionId));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_NOT_GRANTED');
  fs.rmSync(root, { recursive: true, force: true });
});

test('say stages the voice honestly when the hook is unreachable', async () => {
  const { root, sessionId } = fixture();
  const context = fakeCtx();
  apply(context, { root });
  const result = await context.registered.get('wechat_voice_say').execute({ text: '主人晚安' }, execWith(sessionId));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, 'staged');
  assert.ok(['HOOK_TOKEN_MISSING', 'HOOK_NOT_LISTENING'].includes(result.voiceRoute.reason), JSON.stringify(result.voiceRoute));
  assert.ok(result.note.length > 0);
  assert.ok(result.items.every(item => fs.existsSync(item.path)), 'audio must be kept for a later flush');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unresolved session never guesses a chat', async () => {
  const { root } = fixture();
  const service = createVoiceService({ root });
  await assert.rejects(service.say({ sessionId: 'social-unknown', text: '主人晚安' }), error => error.code === 'CHAT_UNRESOLVED');
  fs.rmSync(root, { recursive: true, force: true });
});

test('preview synthesizes locally with the installed SAPI voice', async t => {
  const { root } = fixture();
  const context = fakeCtx();
  apply(context, { root });
  const result = await context.registered.get('wechat_voice_preview').execute({ text: '主人，我是鲸鲸。' });
  if (!result.ok && ['TTS_SHELL_UNAVAILABLE', 'TTS_ENGINE_UNAVAILABLE'].includes(result.code)) {
    t.skip(`no local SAPI: ${result.code}`);
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.items.length >= 1);
  const item = result.items[0];
  assert.ok(item.durationMs > 300, String(item.durationMs));
  assert.ok(fs.existsSync(item.path));
  assert.equal(path.extname(item.path), '.wav');
  fs.rmSync(root, { recursive: true, force: true });
});
