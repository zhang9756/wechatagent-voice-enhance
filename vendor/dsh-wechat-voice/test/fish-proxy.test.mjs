import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { synthesizeFish } from '../lib/fish.mjs';

function toneWav({ ms = 400, sampleRate = 16000 } = {}) {
  const frames = Math.round((sampleRate * ms) / 1000);
  const pcm = Buffer.allocUnsafe(frames * 2);
  for (let index = 0; index < frames; index++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 11000), index * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * A real CONNECT proxy in front of a real origin server. Traffic through it is
 * counted, which is how the test proves the proxy path was actually taken
 * rather than silently bypassed.
 */
async function withProxyAndOrigin(handler, fn) {
  const origin = http.createServer(handler);
  await new Promise(r => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;

  const tunnelled = [];
  const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (req, clientSocket, head) => {
    tunnelled.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port) || originPort, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  try {
    return await fn({ proxyUrl, originPort, endpoint: `http://127.0.0.1:${originPort}/v1/tts`, tunnelled });
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => origin.close(r));
  }
}

test('a proxied synthesis tunnels through the proxy and still returns audio', async () => {
  const wav = toneWav();
  await withProxyAndOrigin((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wav);
    });
  }, async ({ proxyUrl, endpoint, originPort, tunnelled }) => {
    const outPath = path.join(os.tmpdir(), `dsh-fish-proxy-${process.pid}.wav`);
    const made = await synthesizeFish({
      text: '主人，走代理也要能说话。', outPath, apiKey: 'proxy-key', endpoint,
      model: 's2-pro', proxy: proxyUrl,
    });
    assert.equal(made.engine, 'fish');
    assert.ok(made.durationMs > 100, `durationMs=${made.durationMs}`);
    assert.ok(fs.existsSync(outPath));
    // The tunnel really was used, and it targeted the origin.
    assert.deepEqual(tunnelled, [`127.0.0.1:${originPort}`]);
    fs.rmSync(outPath, { force: true });
  });
});

test('a bare host:port proxy is accepted, not just a full URL', async () => {
  const wav = toneWav({ ms: 200 });
  await withProxyAndOrigin((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wav);
    });
  }, async ({ proxyUrl, endpoint, tunnelled }) => {
    const bare = proxyUrl.replace(/^http:\/\//, '');
    const outPath = path.join(os.tmpdir(), `dsh-fish-proxy-bare-${process.pid}.wav`);
    const made = await synthesizeFish({
      text: '裸地址也行', outPath, apiKey: 'k', endpoint, proxy: bare,
    });
    assert.equal(made.engine, 'fish');
    assert.equal(tunnelled.length, 1);
    fs.rmSync(outPath, { force: true });
  });
});

test('a proxy that refuses CONNECT is reported as a network error', async () => {
  const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (req, clientSocket) => {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  try {
    await assert.rejects(
      synthesizeFish({
        text: '主人晚安', outPath: path.join(os.tmpdir(), 'dsh-fish-proxy-deny.wav'),
        apiKey: 'k', endpoint: 'http://example.invalid/v1/tts', proxy: proxyUrl, timeoutMs: 9000,
      }),
      error => error.code === 'TTS_FISH_NETWORK',
    );
  } finally {
    await new Promise(r => proxy.close(r));
  }
});

test('an unreachable proxy is a network error, not a hang', async () => {
  await assert.rejects(
    synthesizeFish({
      text: '主人晚安', outPath: path.join(os.tmpdir(), 'dsh-fish-proxy-dead.wav'),
      apiKey: 'k', endpoint: 'http://127.0.0.1:1/v1/tts', proxy: 'http://127.0.0.1:1', timeoutMs: 9000,
    }),
    error => error.code === 'TTS_FISH_NETWORK' || error.code === 'TTS_FISH_TIMEOUT',
  );
});
