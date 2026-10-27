import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { BAIDU_VOICE, baiduSpeed, baiduUrl, synthesizeBaidu } from '../lib/baidu.mjs';

test('baiduSpeed maps the plugin rate onto the spd range the service accepts', () => {
  assert.equal(baiduSpeed(0), 5);
  assert.equal(baiduSpeed(-10), 3);
  assert.equal(baiduSpeed(-5), 4);
  assert.equal(baiduSpeed(5), 6);
  assert.equal(baiduSpeed(10), 7);
  assert.equal(baiduSpeed(99), 7);
  assert.equal(baiduSpeed(-99), 3);
  assert.equal(baiduSpeed('nonsense'), 5);
});

test('baiduUrl encodes the text and keeps the service parameters', () => {
  const url = new URL(baiduUrl({ text: '主人，晚安 & 明天见', rate: 0 }));
  assert.equal(url.origin + url.pathname, 'https://fanyi.baidu.com/gettts');
  assert.equal(url.searchParams.get('lan'), 'zh');
  assert.equal(url.searchParams.get('text'), '主人，晚安 & 明天见');
  assert.equal(url.searchParams.get('spd'), '5');
  assert.equal(url.searchParams.get('source'), 'web');
});

test('Baidu synthesis rejects bad input before touching the network', async () => {
  const outPath = path.join(os.tmpdir(), 'dsh-voice-baidu-invalid.wav');
  await assert.rejects(
    synthesizeBaidu({ text: '   ', outPath }),
    error => error.code === 'TTS_TEXT_EMPTY',
  );
  await assert.rejects(
    synthesizeBaidu({ text: '主'.repeat(700), outPath }),
    error => error.code === 'TTS_ARGUMENTS_INVALID',
  );
  await assert.rejects(
    synthesizeBaidu({ text: '主人晚安' }),
    error => error.code === 'TTS_ARGUMENTS_INVALID',
  );
  assert.equal(BAIDU_VOICE, '百度自然女声');
});
