import test from 'node:test';
import assert from 'node:assert/strict';
import { assignableTool, conversationAllowed, grantedTools, assertAccess } from '../lib/auth.mjs';

const config = {
  wechat: {
    whitelist: { groups: ['1242663321'], private: ['1769324077'] },
    dshAccess: {
      chats: {
        'wechat:private:1769324077': { skills: [], tools: ['wechat_voice_say', 'wechat_voice_preview', 'send_meme', 'bash'] },
        'wechat:group:1242663321': { skills: [], tools: [] },
      },
    },
  },
};

test('whitelist separates private and group ids', () => {
  assert.equal(conversationAllowed(config, 'private', '1769324077'), true);
  assert.equal(conversationAllowed(config, 'private', 1769324077), true);
  assert.equal(conversationAllowed(config, 'group', '1769324077'), false);
  assert.equal(conversationAllowed(config, 'group', '1242663321'), true);
  assert.equal(conversationAllowed({}, 'private', '1'), false);
});

test('grantedTools drops reserved and control tools', () => {
  assert.deepEqual(grantedTools(config, 'wechat:private:1769324077'), ['wechat_voice_say', 'wechat_voice_preview']);
  assert.equal(assignableTool('send_meme'), false);
  assert.equal(assignableTool('bash'), false);
  assert.equal(assignableTool('wechat_voice_say'), true);
  assert.equal(assignableTool('../etc/passwd'), false);
});

test('assertAccess accepts a granted chat and explains refusals', () => {
  const chat = { key: 'wechat:private:1769324077', kind: 'private', id: '1769324077' };
  assert.equal(assertAccess({ config, chat, tool: 'wechat_voice_say' }), chat);
  assert.throws(() => assertAccess({ config, chat: null, tool: 'wechat_voice_say' }), error => error.code === 'CHAT_UNRESOLVED');
  assert.throws(() => assertAccess({ config, chat: { key: 'wechat:private:999', kind: 'private', id: '999' }, tool: 'wechat_voice_say' }),
    error => error.code === 'CHAT_NOT_ALLOWED');
  assert.throws(() => assertAccess({ config, chat: { key: 'wechat:group:1242663321', kind: 'group', id: '1242663321' }, tool: 'wechat_voice_say' }),
    error => error.code === 'TOOL_NOT_GRANTED');
  assert.throws(() => assertAccess({ config: null, chat, tool: 'wechat_voice_say' }), error => error.code === 'CONFIG_UNAVAILABLE');
});
