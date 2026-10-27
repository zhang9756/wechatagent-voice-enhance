import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeSettings } from '../lib/settings.mjs';

test('natural Edge voice is the default engine', () => {
  assert.equal(DEFAULTS.engine, 'auto');
  assert.equal(DEFAULTS.edgeVoice, 'zh-CN-XiaoxiaoNeural');
  const settings = normalizeSettings({});
  assert.equal(settings.engine, 'auto');
  assert.equal(settings.edgeVoice, 'zh-CN-XiaoxiaoNeural');
});

test('engine and edgeVoice are validated without throwing', () => {
  const picked = normalizeSettings({ engine: 'edge', edgeVoice: '  zh-CN-XiaoyiNeural  ' });
  assert.equal(picked.engine, 'edge');
  assert.equal(picked.edgeVoice, 'zh-CN-XiaoyiNeural');

  const fallback = normalizeSettings({ engine: 'cloud', edgeVoice: '' });
  assert.equal(fallback.engine, 'auto');
  assert.equal(fallback.edgeVoice, 'zh-CN-XiaoxiaoNeural');

  const badType = normalizeSettings({ edgeVoice: 42 });
  assert.equal(badType.edgeVoice, 'zh-CN-XiaoxiaoNeural');
});
