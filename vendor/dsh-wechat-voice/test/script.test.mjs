import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeVoiceText, estimateSpeechMs, splitForVoice } from '../lib/script.mjs';

test('sanitize strips markup, emoji, links and media markers', () => {
  const input = '主人，我是鲸鲸呀。【表情: 开心】**今晚的声音**都是我的~ https://example.com/x 晚安！[STICKER:S1] 😀';
  const out = sanitizeVoiceText(input);
  assert.ok(!out.includes('表情'), out);
  assert.ok(!out.includes('STICKER'), out);
  assert.ok(!out.includes('http'), out);
  assert.ok(!out.includes('*'), out);
  assert.ok(!/😀/.test(out));
  assert.ok(out.includes('今晚的声音'));
  assert.ok(out.includes('一个链接'));
});

test('sanitize removes fenced code and keeps the surrounding prose', () => {
  const out = sanitizeVoiceText('看这段代码：\n```js\nconsole.log(1)\n```\n就这样。');
  assert.ok(out.includes('看这段代码'));
  assert.ok(!out.includes('console.log'));
  assert.ok(out.includes('就这样'));
});

test('sanitize caps long input on a sentence boundary', () => {
  const out = sanitizeVoiceText('啊。'.repeat(900), { maxChars: 100 });
  assert.ok(out.length <= 101, String(out.length));
  assert.ok(out.endsWith('。'));
});

test('estimateSpeechMs grows with text and shrinks with faster rate', () => {
  const short = estimateSpeechMs('主人晚安');
  const long = estimateSpeechMs('主人晚安'.repeat(10));
  assert.ok(long > short * 5);
  assert.ok(estimateSpeechMs('主人晚安主人晚安', 6) < estimateSpeechMs('主人晚安主人晚安', 0));
});

test('splitForVoice keeps short text as one bubble', () => {
  assert.deepEqual(splitForVoice('主人，晚安。'), ['主人，晚安。']);
});

test('splitForVoice caps every chunk under the WeChat limit', () => {
  const long = '鲸鲸很喜欢主人。'.repeat(200);
  const chunks = splitForVoice(long, { maxMs: 55000 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(estimateSpeechMs(chunk) <= 55000, String(estimateSpeechMs(chunk)));
  const joined = chunks.join('');
  assert.equal(joined.replace(/\s+/g, ''), long.replace(/\s+/g, ''));
});

test('splitForVoice hard-wraps a single monster sentence', () => {
  const monster = '鲸'.repeat(600);
  const chunks = splitForVoice(monster, { maxMs: 20000 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(estimateSpeechMs(chunk) <= 20000);
  assert.equal(chunks.join(''), monster);
});
