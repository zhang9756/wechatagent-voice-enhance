import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapPcm16 } from '../lib/wav.mjs';
import { encodeSilk, encoderPath } from '../lib/silk.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const encoder = encoderPath(root);
const canEncode = fs.existsSync(encoder);

function tone({ sampleRate = 22050, ms = 1500, amplitude = 1200 } = {}) {
  const frames = Math.round((sampleRate * ms) / 1000);
  const pcm = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * amplitude), index * 2);
  }
  return wrapPcm16(pcm, sampleRate, 1);
}

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-voice-silk-'));
}

test('encodeSilk writes the on-disk WeChat SILK header and keeps duration', { skip: !canEncode && 'silk encoder not built' }, async () => {
  const dir = workspace();
  try {
    const wav = path.join(dir, 'tone.wav');
    fs.writeFileSync(wav, tone({ ms: 1500 }));
    const made = await encodeSilk({ root, wavPath: wav });
    assert.equal(made.path, path.join(dir, 'tone.silk'));
    assert.equal(made.durationMs, 1500);
    assert.equal(made.sourceRate, 22050);
    assert.ok(made.bytes > 10 && made.bytes < 16 * 1024 * 1024);
    const silk = fs.readFileSync(made.path);
    assert.equal(silk[0], 0x02);
    assert.equal(silk.toString('ascii', 1, 10), '#!SILK_V3');
    assert.equal(silk.length, made.bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('encodeSilk pads clips shorter than one second', { skip: !canEncode && 'silk encoder not built' }, async () => {
  const dir = workspace();
  try {
    const wav = path.join(dir, 'short.wav');
    fs.writeFileSync(wav, tone({ ms: 320 }));
    const made = await encodeSilk({ root, wavPath: wav });
    assert.equal(made.durationMs, 1000);
    assert.equal(made.sourceMs, 320);
    assert.equal(fs.readFileSync(made.path)[0], 0x02);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('encodeSilk rejects non-WAV input before touching the encoder', async () => {
  const previous = process.env.WECHAT_VOICE_SILK_ENCODER;
  process.env.WECHAT_VOICE_SILK_ENCODER = encoder;
  try {
    await assert.rejects(encodeSilk({ root, wavPath: path.join(os.tmpdir(), 'x.mp3') }),
      error => error.code === 'SILK_INPUT_INVALID');
  } finally {
    if (previous === undefined) delete process.env.WECHAT_VOICE_SILK_ENCODER;
    else process.env.WECHAT_VOICE_SILK_ENCODER = previous;
  }
});

test('encodeSilk reports a missing encoder', async () => {
  const previous = process.env.WECHAT_VOICE_SILK_ENCODER;
  process.env.WECHAT_VOICE_SILK_ENCODER = path.join(os.tmpdir(), 'definitely-missing-silk-encoder.exe');
  try {
    await assert.rejects(encodeSilk({ root, wavPath: path.join(os.tmpdir(), 'x.wav') }),
      error => error.code === 'SILK_ENCODER_MISSING');
  } finally {
    if (previous === undefined) delete process.env.WECHAT_VOICE_SILK_ENCODER;
    else process.env.WECHAT_VOICE_SILK_ENCODER = previous;
  }
});
