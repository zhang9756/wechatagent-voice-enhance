import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  EDGE_DEFAULT_VOICE, edgeHandshake, edgeProsody, edgeSsml, escapeSsml, isEdgeVoice,
  pcm16FromFloat, synthesizeEdge, trimFloatSilence,
} from '../lib/edge.mjs';
import { cachedEngineStillPreferred } from '../lib/voice-service.mjs';

test('isEdgeVoice distinguishes neural names from SAPI names', () => {
  assert.equal(isEdgeVoice('zh-CN-XiaoxiaoNeural'), true);
  assert.equal(isEdgeVoice('zh-CN-XiaoyiNeural'), true);
  assert.equal(isEdgeVoice('zh-CN-liaoning-XiaobeiNeural'), true);
  assert.equal(isEdgeVoice('en-US-AvaMultilingualNeural'), true);
  assert.equal(isEdgeVoice('Microsoft Yaoyao'), false);
  assert.equal(isEdgeVoice(''), false);
});

test('edgeProsody maps the -10..10 rate and 0..100 volume into Edge ranges', () => {
  assert.deepEqual(edgeProsody(0, 100), { rate: '+0%', volume: '+0%' });
  assert.deepEqual(edgeProsody(10, 50), { rate: '+100%', volume: '-50%' });
  assert.deepEqual(edgeProsody(-10, 100), { rate: '-100%', volume: '+0%' });
  assert.deepEqual(edgeProsody(99, 0), { rate: '+100%', volume: '-100%' });
  assert.deepEqual(edgeProsody(-99, 150), { rate: '-100%', volume: '+0%' });
});

test('SSML is escaped so punctuation and ampersands cannot break the request', () => {
  const text = '他说：“A&B <ok> & \'x\'”';
  assert.equal(escapeSsml(text), '他说：“A&amp;B &lt;ok&gt; &amp; &apos;x&apos;”');
  const ssml = edgeSsml({ text, voice: EDGE_DEFAULT_VOICE, rate: 10, volume: 50 });
  assert.match(ssml, /<voice name="zh-CN-XiaoxiaoNeural">/);
  assert.match(ssml, /rate="\+100%" volume="-50%"/);
  assert.match(ssml, /A&amp;B &lt;ok&gt;/);
  assert.ok(!ssml.includes('A&B'));
});

test('trimFloatSilence removes Edge room tone but keeps short margins', () => {
  const sampleRate = 1000;
  const samples = new Float32Array(5000);
  for (let index = 1000; index <= 2000; index++) samples[index] = 0.5;
  const trimmed = trimFloatSilence(samples, sampleRate);
  assert.equal(trimmed.length, (2000 + 1 + 160) - (1000 - 60));
  assert.ok(Math.abs(trimmed[0]) < 0.001);
  assert.ok(Math.abs(trimmed[trimmed.length - 1]) < 0.001);
});

test('trimFloatSilence leaves an all-silent clip alone', () => {
  const samples = new Float32Array(1000);
  assert.equal(trimFloatSilence(samples, 24000), samples);
});

test('pcm16FromFloat clips and round-trips sample values', () => {
  const pcm = pcm16FromFloat(new Float32Array([0, 1, -1, 0.5]));
  assert.equal(pcm.readInt16LE(0), 0);
  assert.equal(pcm.readInt16LE(2), 32767);
  assert.equal(pcm.readInt16LE(4), -32768);
  assert.equal(pcm.readInt16LE(6), 16384);
});

test('Edge handshake carries the browser header fingerprint the service requires', () => {
  const { url, options } = edgeHandshake('TESTGEC');
  assert.match(url, /^wss:\/\/api\.msedgeservices\.com\/tts\/cognitiveservices\/websocket\/v1\?/);
  assert.match(url, /Sec-MS-GEC=TESTGEC/);
  assert.match(url, /Sec-MS-GEC-Version=1-/);
  assert.equal(options.origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
  assert.equal(options.headers.Pragma, 'no-cache');
  assert.equal(options.headers['Cache-Control'], 'no-cache');
  assert.match(options.headers['User-Agent'], /Edg\/\d+/);
  assert.match(options.headers['Accept-Encoding'], /gzip/);
  assert.match(options.headers['Accept-Language'], /en-US/);
});

test('auto/edge requests do not reuse cached Baidu or SAPI fallback audio', () => {
  assert.equal(cachedEngineStillPreferred('auto', 'baidu'), false);
  assert.equal(cachedEngineStillPreferred('edge', 'sapi'), false);
  assert.equal(cachedEngineStillPreferred('auto', 'edge'), true);
  assert.equal(cachedEngineStillPreferred('edge', 'edge'), true);
  assert.equal(cachedEngineStillPreferred('auto', undefined), true);
  assert.equal(cachedEngineStillPreferred('baidu', 'baidu'), true);
  assert.equal(cachedEngineStillPreferred('sapi', 'sapi'), true);
});

test('Edge synthesis rejects invalid voices before touching the network', async () => {
  const outPath = path.join(os.tmpdir(), 'dsh-voice-edge-invalid.wav');
  await assert.rejects(
    synthesizeEdge({ text: '主人晚安', outPath, voice: 'Microsoft Yaoyao' }),
    error => error.code === 'TTS_EDGE_VOICE',
  );
  await assert.rejects(
    synthesizeEdge({ text: '   ', outPath, voice: EDGE_DEFAULT_VOICE }),
    error => error.code === 'TTS_TEXT_EMPTY',
  );
});
