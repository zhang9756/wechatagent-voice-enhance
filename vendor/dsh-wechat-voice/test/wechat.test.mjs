import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationId, resolveTarget, probeVoiceRoute, probeFileRoute, sendVoice, sendFile, hookIdentity } from '../lib/wechat.mjs';

const withFetch = async (stub, run) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return stub(String(url), options); };
  try { return await run(calls); } finally { globalThis.fetch = original; }
};

const response = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('conversationId is the same synthetic id the bridge uses', () => {
  // sha256("wxid_a") mod 2147483647 + 1, mirrored from scripts/hook-onebot.mjs
  assert.equal(conversationId('wxid_a'), conversationId('wxid_a'));
  assert.equal(typeof conversationId('wxid_a'), 'number');
  assert.notEqual(conversationId('wxid_a'), conversationId('wxid_b'));
  assert.equal(conversationId('123@chatroom', '摸鱼群'), conversationId('other@chatroom', '摸鱼群'));
  assert.equal(conversationId('123@chatroom', '随便', '42'), 42);
  assert.throws(() => conversationId('x', 'y', '0'), /INVALID_CONVERSATION_ID/);
});

test('resolveTarget finds exactly one matching session', async () => {
  const target = conversationId('wxid_target');
  const ioConfig = { reader_base_url: 'http://127.0.0.1:5031/', reader_token: 't' };
  await withFetch(() => response(200, { sessions: [
    { username: 'wxid_target', displayName: '张炎' },
    { username: 'wxid_other', displayName: '别人' },
  ] }), async calls => {
    const wxid = await resolveTarget({ ioConfig, kind: 'private', id: String(target) });
    assert.equal(wxid, 'wxid_target');
    assert.equal(calls[0].url, 'http://127.0.0.1:5031/api/v1/sessions?limit=500');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer t');
  });
});

test('resolveTarget refuses ambiguous and missing targets', async () => {
  const ioConfig = { reader_base_url: 'http://127.0.0.1:5031', reader_token: 't' };
  await withFetch(() => response(200, { sessions: [{ username: 'wxid_only', displayName: 'x' }] }), async () => {
    await assert.rejects(resolveTarget({ ioConfig, kind: 'private', id: '12345' }), error => error.code === 'TARGET_MAPPING_AMBIGUOUS_OR_MISSING');
  });
});

test('probeVoiceRoute treats 404 as unsupported and 400 as supported', async () => {
  const credential = { baseUrl: 'http://127.0.0.1:30001', token: 'a'.repeat(64) };
  await withFetch(() => response(404, {}), async () => {
    const probe = await probeVoiceRoute({ credential });
    assert.equal(probe.supported, false);
    assert.equal(probe.reason, 'HOOK_VOICE_ROUTE_MISSING');
  });
  await withFetch(() => response(400, { ret: 1 }), async () => {
    assert.equal((await probeVoiceRoute({ credential })).supported, true);
  });
  assert.equal((await probeVoiceRoute({ credential: { baseUrl: 'x', token: '' } })).supported, false);
});

test('sendVoice reports the missing route instead of pretending success', async () => {
  const credential = { baseUrl: 'http://127.0.0.1:30001', token: 'a'.repeat(64) };
  await withFetch(() => response(404, {}), async () => {
    await assert.rejects(sendVoice({ credential, account: 'acc', wxid: 'wxid_x', file: 'C:\\x.wav', durationMs: 1000 }),
      error => error.code === 'HOOK_VOICE_ROUTE_MISSING');
  });
  await withFetch(() => response(200, { ret: 0, retmsg: 'accepted' }), async calls => {
    const result = await sendVoice({ credential, account: 'acc', wxid: 'wxid_x', file: 'C:\\x.silk', durationMs: 1234 });
    assert.deepEqual(result, { accepted: true, retmsg: 'accepted' });
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body, { wxidorgid: 'wxid_x', path: 'C:\\x.silk', duration: 1234, format: 'silk' });
    assert.equal(calls[0].options.headers['X-WeChatAgent-Account'], 'acc');
  });
});

test('hookIdentity requires exactly one database account', async () => {
  const credential = { baseUrl: 'http://127.0.0.1:30001', token: 'a'.repeat(64) };
  await withFetch(() => response(200, { version: '4.1.10.27', databaseAccounts: ['acc'], nativeStickerSend: true }), async () => {
    const identity = await hookIdentity({ credential });
    assert.equal(identity.account, 'acc');
    assert.equal(identity.version, '4.1.10.27');
  });
  await withFetch(() => response(200, { databaseAccounts: ['a', 'b'] }), async () => {
    await assert.rejects(hookIdentity({ credential }), error => error.code === 'HOOK_ACCOUNT_AMBIGUOUS');
  });
});

test('probeFileRoute reports the file channel separately from the voice channel', async () => {
  const credential = { baseUrl: 'http://127.0.0.1:30001', token: 'a'.repeat(64) };
  await withFetch(() => response(404, {}), async () => {
    const probe = await probeFileRoute({ credential });
    assert.equal(probe.supported, false);
    assert.equal(probe.reason, 'HOOK_FILE_ROUTE_MISSING');
  });
  await withFetch(() => response(409, { ret: 1 }), async () => {
    assert.equal((await probeFileRoute({ credential })).supported, true);
  });
});

test('sendFile posts the staged audio path and honours rejections', async () => {
  const credential = { baseUrl: 'http://127.0.0.1:30001', token: 'a'.repeat(64) };
  await withFetch(() => response(200, { ret: 0, retmsg: 'accepted' }), async calls => {
    const result = await sendFile({ credential, account: 'acc', wxid: 'wxid_filehelper', file: 'C:\\v\\x.wav' });
    assert.equal(result.accepted, true);
    assert.deepEqual(JSON.parse(calls[0].options.body), { wxidorgid: 'wxid_filehelper', path: 'C:\\v\\x.wav' });
    assert.equal(calls[0].url, 'http://127.0.0.1:30001/SendFileMsg');
  });
  await withFetch(() => response(404, {}), async () => {
    await assert.rejects(sendFile({ credential, account: 'acc', wxid: 'wxid_x', file: 'C:\\v\\x.wav' }),
      error => error.code === 'HOOK_FILE_ROUTE_MISSING');
  });
  await withFetch(() => response(409, { ret: 1 }), async () => {
    await assert.rejects(sendFile({ credential, account: 'acc', wxid: 'wxid_x', file: 'C:\\v\\x.wav' }),
      error => error.code === 'FILE_SEND_REJECTED');
  });
});
