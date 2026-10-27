import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';
import { wrapPcm16 } from '../lib/wav.mjs';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-store-'));

function wavFor(seed = 0, ms = 200) {
  const frames = Math.round((16000 * ms) / 1000);
  const pcm = Buffer.alloc(frames * 2, seed);
  return wrapPcm16(pcm, 16000, 1);
}

test('put writes a content addressed wav and records metadata', async () => {
  const root = tempRoot();
  const store = createStore({ root });
  const source = path.join(root, 'source.wav');
  fs.writeFileSync(source, wavFor(1));
  const entry = await store.put({ wavPath: source, text: '主人晚安', voice: 'Microsoft Yaoyao', rate: 0, volume: 100, durationMs: 200 });
  assert.equal(entry.id.length, 64);
  assert.ok(fs.existsSync(entry.path));
  assert.equal(fs.statSync(entry.path).size, fs.statSync(source).size);
  assert.equal(entry.durationMs, 200);
  fs.rmSync(root, { recursive: true, force: true });
});

test('identical text+voice reuses the same staged file', async () => {
  const root = tempRoot();
  const store = createStore({ root });
  const source = path.join(root, 'a.wav');
  fs.writeFileSync(source, wavFor(2));
  const first = await store.put({ wavPath: source, text: '重复的一句', voice: 'v', rate: 0, volume: 100, durationMs: 200 });
  const key = store.cacheKey({ text: '重复的一句', voice: 'v', rate: 0, volume: 100 });
  const reused = store.findReusable(key);
  assert.ok(reused);
  assert.equal(reused.path, first.path);
  const otherKey = store.cacheKey({ text: '另一句', voice: 'v', rate: 0, volume: 100 });
  assert.equal(store.findReusable(otherKey), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('engine is part of the reuse key and recorded on the entry', async () => {
  const root = tempRoot();
  const store = createStore({ root });
  const source = path.join(root, 'edge.wav');
  fs.writeFileSync(source, wavFor(3));
  const edgeKey = store.cacheKey({ text: '同一句', voice: 'zh-CN-XiaoxiaoNeural', rate: 0, volume: 100, engine: 'edge' });
  const autoKey = store.cacheKey({ text: '同一句', voice: 'zh-CN-XiaoxiaoNeural', rate: 0, volume: 100, engine: 'auto' });
  assert.notEqual(edgeKey, autoKey);
  const entry = await store.put({
    wavPath: source, text: '同一句', voice: 'zh-CN-XiaoxiaoNeural', rate: 0, volume: 100, durationMs: 200, engine: 'edge',
  });
  assert.equal(entry.engine, 'edge');
  assert.equal(store.findReusable(edgeKey)?.path, entry.path);
  assert.equal(store.findReusable(autoKey), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a fallback is cached under the requested key but records the actual engine', async () => {
  const root = tempRoot();
  const store = createStore({ root });
  const source = path.join(root, 'fallback.wav');
  fs.writeFileSync(source, wavFor(3));
  const requestedKey = store.cacheKey({ text: '回退的一句', voice: 'zh-CN-XiaoxiaoNeural', rate: 0, volume: 100, engine: 'auto' });
  await store.put({
    wavPath: source, text: '回退的一句', voice: '百度自然女声', rate: 0, volume: 100,
    durationMs: 200, engine: 'baidu', key: requestedKey, extra: { fallbackFrom: 'edge' },
  });
  const reused = store.findReusable(requestedKey);
  assert.ok(reused);
  assert.equal(reused.engine, 'baidu');
  assert.equal(reused.voice, '百度自然女声');
  assert.equal(reused.fallbackFrom, 'edge');
  fs.rmSync(root, { recursive: true, force: true });
});

test('pending queue dedupes by id+chat and resolves', async () => {
  const root = tempRoot();
  const store = createStore({ root });
  store.queuePending({ id: 'a'.repeat(64), chat: 'wechat:private:1', status: 'staged' });
  store.queuePending({ id: 'a'.repeat(64), chat: 'wechat:private:1', status: 'staged' });
  store.queuePending({ id: 'a'.repeat(64), chat: 'wechat:private:2', status: 'staged' });
  assert.equal(store.pending().length, 2);
  store.resolvePending('a'.repeat(64), 'sent');
  assert.ok(store.pending().every(item => item.status === 'sent' || item.chat === 'wechat:private:2'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('prune keeps the pending file and drops stale ones', async () => {
  const root = tempRoot();
  const store = createStore({ root, maxFiles: 1, maxBytes: 1 });
  const write = async (seed, text) => {
    const source = path.join(root, `s${seed}.wav`);
    fs.writeFileSync(source, wavFor(seed));
    const entry = await store.put({ wavPath: source, text, voice: 'v', rate: 0, volume: 100, durationMs: 200 });
    return entry;
  };
  const keep = await write(10, '要留着');
  store.queuePending({ id: keep.id, chat: 'wechat:private:1', status: 'staged' });
  const drop = await write(11, '要删掉');
  await write(12, '也要删掉');
  const result = store.prune();
  assert.ok(result.removed >= 1, JSON.stringify(result));
  assert.ok(fs.existsSync(keep.path), 'pending voice must survive pruning');
  assert.ok(!fs.existsSync(drop.path));
  fs.rmSync(root, { recursive: true, force: true });
});
