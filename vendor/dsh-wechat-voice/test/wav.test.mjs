import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWav, wrapPcm16, toMono16k } from '../lib/wav.mjs';

function tone({ sampleRate = 22050, channels = 1, ms = 1000, amplitude = 1000 } = {}) {
  const frames = Math.round((sampleRate * ms) / 1000);
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let index = 0; index < frames; index++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * amplitude);
    for (let channel = 0; channel < channels; channel++) pcm.writeInt16LE(value, (index * channels + channel) * 2);
  }
  return wrapPcm16(pcm, sampleRate, channels);
}

test('parseWav reports format and duration', () => {
  const info = parseWav(tone({ ms: 1500 }));
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.durationMs, 1500);
});

test('parseWav rejects non-RIFF input', () => {
  assert.throws(() => parseWav(Buffer.from('not a wav file at all, really not')), /WAV_/);
});

test('parseWav rejects non-PCM payloads', () => {
  const wav = tone({ ms: 100 });
  wav.writeUInt16LE(3, 20); // IEEE float instead of PCM
  assert.throws(() => parseWav(wav), /WAV_FORMAT_UNSUPPORTED/);
});

test('toMono16k resamples and downmixes without changing duration', () => {
  const stereo = tone({ sampleRate: 44100, channels: 2, ms: 800 });
  const mono = toMono16k(stereo, 16000);
  assert.equal(mono.sampleRate, 16000);
  assert.equal(mono.channels, 1);
  assert.equal(mono.pcm.length, 16000 * 0.8 * 2);
  assert.ok(Math.abs(mono.durationMs - 800) <= 1, String(mono.durationMs));
  const round = parseWav(wrapPcm16(mono.pcm, 16000, 1));
  assert.equal(round.durationMs, 800);
});
