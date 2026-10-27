import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  FISH_VOICE, FISH_ENDPOINT, buildFishPayload, fishReferenceId, fishSpeed,
  fishUrl, isFishVoice, normalizeFishModel, synthesizeFish,
} from '../lib/fish.mjs';
import { parseWav } from '../lib/wav.mjs';

const REFERENCE = '7f92f8afb8ec43bf81429cc1c9199cb1';

/** Minimal 16 kHz mono 16-bit WAV carrying a short tone, as a self-hosted server would return. */
function toneWav({ ms = 300, sampleRate = 16000 } = {}) {
  const frames = Math.round((sampleRate * ms) / 1000);
  const pcm = Buffer.allocUnsafe(frames * 2);
  for (let index = 0; index < frames; index++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** A tiny silent MP3 frame is not worth synthesizing, so WAV exercises the decode path
 *  and a separate case asserts the MP3 *sniffing* rules through a stub body. */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1/tts`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('the model travels in a header, never in the URL path', () => {
  // Official contract: POST https://api.fish.audio/v1/tts + `model:` header.
  assert.equal(fishUrl({ model: 's2.1-pro' }), FISH_ENDPOINT);
  assert.equal(fishUrl({ model: 'drama-3' }), FISH_ENDPOINT);
  // A trailing slash on a self-hosted endpoint must not double up.
  assert.equal(fishUrl({ endpoint: 'http://127.0.0.1:8080/v1/tts/', model: 's2.1-pro' }), 'http://127.0.0.1:8080/v1/tts');
  // An old config that still carries /v1/tts/<model> is repaired, not doubled.
  assert.equal(fishUrl({ endpoint: 'https://api.fish.audio/v1/tts/s2-pro', model: 's2.1-pro' }), FISH_ENDPOINT);
  // Unknown names fall back to the default instead of sending a bad model id.
  assert.equal(normalizeFishModel('wat'), 's2.1-pro');
  assert.equal(normalizeFishModel('Drama-3'), 'drama-3');
  assert.equal(normalizeFishModel('s2.1-pro-free'), 's2.1-pro-free');
});

test('isFishVoice accepts a reference id but never an Edge or SAPI name', () => {
  assert.equal(isFishVoice(REFERENCE), true);
  assert.equal(isFishVoice(`fish:${REFERENCE}`), true);
  assert.equal(isFishVoice(FISH_VOICE), true);
  assert.equal(isFishVoice('zh-CN-XiaoyiNeural'), false);
  assert.equal(isFishVoice('晓伊'), false);
  assert.equal(isFishVoice('Microsoft Huihui Desktop'), false);
  assert.equal(isFishVoice(''), false);
  assert.equal(fishReferenceId(`fish:${REFERENCE}`), REFERENCE);
  assert.equal(fishReferenceId(FISH_VOICE), '');
});

test('buildFishPayload matches the documented request body', () => {
  const base = buildFishPayload({ text: '主人晚安', model: 's2.1-pro' });
  assert.equal(base.text, '主人晚安');
  assert.equal(base.format, 'mp3');
  assert.equal(base.latency, 'normal');
  assert.equal(base.normalize, true);
  assert.equal(base.streaming, false);
  assert.equal(base.reference_id, undefined);
  // Real prosody control instead of a text prompt.
  assert.deepEqual(base.prosody, { speed: 1, normalize_loudness: true });

  const cloned = buildFishPayload({ text: '主人晚安', model: 's2.1-pro', referenceId: REFERENCE });
  assert.equal(cloned.reference_id, REFERENCE);
  // Drama 3 only: generate the whole text in one pass.
  assert.equal(buildFishPayload({ text: 'x', model: 'drama-3' }).single_chunk, true);
  assert.equal(buildFishPayload({ text: 'x', model: 's2.1-pro' }).single_chunk, undefined);
});

test('rate maps onto prosody.speed inside the documented 0.5-2.0 band', () => {
  assert.equal(fishSpeed(0), 1);
  assert.equal(fishSpeed(-10), 0.5);
  assert.equal(fishSpeed(10), 1.5);
  assert.equal(fishSpeed(6), 1.3);
  assert.equal(fishSpeed(-6), 0.7);
  // Clamped, never out of range even for nonsense input.
  assert.equal(fishSpeed(999), 1.5);
  assert.equal(fishSpeed(-999), 0.5);
  assert.equal(fishSpeed('nonsense'), 1);
  // The text is no longer polluted with pacing prompts.
  const payload = buildFishPayload({ text: '好', rate: 8 });
  assert.equal(payload.text, '好');
  assert.equal(payload.prosody.speed, 1.4);
});

test('synthesis refuses to run without a key instead of sending a doomed request', async () => {
  const outPath = path.join(os.tmpdir(), 'dsh-voice-fish-nokey.wav');
  await assert.rejects(
    synthesizeFish({ text: '主人晚安', outPath, apiKey: '', apiKeyEnv: 'DSH_VOICE_TEST_NO_SUCH_ENV' }),
    error => error.code === 'TTS_FISH_NO_KEY',
  );
});

test('synthesis validates text and outPath before the network', async () => {
  const outPath = path.join(os.tmpdir(), 'dsh-voice-fish-invalid.wav');
  await assert.rejects(
    synthesizeFish({ text: '   ', outPath, apiKey: 'k' }),
    error => error.code === 'TTS_TEXT_EMPTY',
  );
  await assert.rejects(
    synthesizeFish({ text: '主人晚安', apiKey: 'k' }),
    error => error.code === 'TTS_ARGUMENTS_INVALID',
  );
  await assert.rejects(
    synthesizeFish({ text: '主'.repeat(2100), outPath, apiKey: 'k' }),
    error => error.code === 'TTS_ARGUMENTS_INVALID',
  );
});

test('a self-hosted WAV response is normalized into a WeChat-ready wav', async () => {
  const wav = toneWav({ ms: 300 });
  const seen = {};
  await withServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      seen.model = req.headers.model;
      seen.body = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(wav);
    });
  }, async endpoint => {
    const outPath = path.join(os.tmpdir(), `dsh-voice-fish-ok-${process.pid}.wav`);
    const made = await synthesizeFish({
      text: '主人，晚安', outPath, voice: `fish:${REFERENCE}`, apiKey: 'test-key',
      endpoint, model: 's2.1-pro', volume: 50,
    });
    assert.equal(made.engine, 'fish');
    assert.equal(made.voice, REFERENCE);
    assert.equal(made.model, 's2.1-pro');
    assert.equal(made.channels, 1);
    assert.ok(made.durationMs > 100, `durationMs=${made.durationMs}`);
    assert.equal(parseWav(fs.readFileSync(outPath)).bitsPerSample, 16);
    fs.rmSync(outPath, { force: true });
  });

  assert.equal(seen.method, 'POST');
  // The path carries no model; the header does.
  assert.equal(seen.url, '/v1/tts');
  assert.equal(seen.model, 's2.1-pro');
  assert.equal(seen.auth, 'Bearer test-key');
  assert.equal(seen.body.text, '主人，晚安');
  assert.equal(seen.body.reference_id, REFERENCE);
  assert.equal(seen.body.format, 'mp3');
});

test('API failures carry a distinct code so auto mode can fall through', async () => {
  const outPath = path.join(os.tmpdir(), 'dsh-voice-fish-fail.wav');
  const cases = [
    [401, 'TTS_FISH_AUTH'],
    [402, 'TTS_FISH_QUOTA'],
    [404, 'TTS_FISH_MODEL'],
    [429, 'TTS_FISH_QUOTA'],
    [500, 'TTS_FISH_NETWORK'],
  ];
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      // Carry the status in a query parameter so endpoint normalization cannot
      // eat it.
      const status = Number(new URL(req.url, 'http://x').searchParams.get('s')) || 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{"error":"nope"}');
    });
  }, async endpoint => {
    for (const [status, code] of cases) {
      await assert.rejects(
        synthesizeFish({ text: '主人晚安', outPath, apiKey: 'k', endpoint: `${endpoint}?s=${status}` }),
        error => error.code === code,
        `status ${status} should map to ${code}`,
      );
    }
  });
});

test('a non-audio 200 response is reported as empty, not decoded as speech', async () => {
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"detail":"quota"}');
    });
  }, async endpoint => {
    await assert.rejects(
      synthesizeFish({
        text: '主人晚安', outPath: path.join(os.tmpdir(), 'dsh-voice-fish-empty.wav'),
        apiKey: 'k', endpoint,
      }),
      error => error.code === 'TTS_FISH_EMPTY',
    );
  });
});

test('an unreachable endpoint is a network error, not a crash', async () => {
  await assert.rejects(
    synthesizeFish({
      text: '主人晚安', outPath: path.join(os.tmpdir(), 'dsh-voice-fish-net.wav'),
      apiKey: 'k', endpoint: 'http://127.0.0.1:1/v1/tts', timeoutMs: 9000,
    }),
    error => error.code === 'TTS_FISH_NETWORK' || error.code === 'TTS_FISH_TIMEOUT',
  );
});
