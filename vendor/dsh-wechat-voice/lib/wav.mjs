// Minimal RIFF/WAVE inspection and 16 kHz mono normalisation.
// WeChat voice bubbles are 16-bit mono; the model never sees raw samples, so
// everything here stays dependency free and bounded.

const PCM = 1;

function readChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('WAV_TOO_SHORT');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV_NOT_RIFF');
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    chunks.push({ id, start, size, end: Math.min(end, buffer.length) });
    offset = end + (size % 2); // RIFF pads odd-sized chunks
    if (size === 0) break;
  }
  return chunks;
}

export function parseWav(buffer) {
  const chunks = readChunks(buffer);
  const fmt = chunks.find(chunk => chunk.id === 'fmt ');
  const data = chunks.find(chunk => chunk.id === 'data');
  if (!fmt || fmt.size < 16 || !data) throw new Error('WAV_LAYOUT_UNSUPPORTED');
  const audioFormat = buffer.readUInt16LE(fmt.start);
  const channels = buffer.readUInt16LE(fmt.start + 2);
  const sampleRate = buffer.readUInt32LE(fmt.start + 4);
  const byteRate = buffer.readUInt32LE(fmt.start + 8);
  const bitsPerSample = buffer.readUInt16LE(fmt.start + 14);
  if (audioFormat !== PCM || bitsPerSample !== 16 || ![1, 2].includes(channels) || !sampleRate) {
    throw new Error('WAV_FORMAT_UNSUPPORTED');
  }
  const frames = byteRate > 0 ? Math.floor(data.size / (channels * 2)) : 0;
  const durationMs = sampleRate > 0 ? Math.round((frames / sampleRate) * 1000) : 0;
  return { audioFormat, channels, sampleRate, byteRate, bitsPerSample, dataStart: data.start, dataSize: data.size, frames, durationMs };
}

/** Downmix + linear resample to 16-bit mono at `targetRate` (default 16000). */
export function toMono16k(buffer, targetRate = 16000) {
  const info = parseWav(buffer);
  const bytes = info.dataSize - (info.dataSize % (info.channels * 2));
  const frames = bytes / (info.channels * 2);
  if (frames === 0) throw new Error('WAV_EMPTY');
  const outFrames = Math.max(1, Math.floor((frames * targetRate) / info.sampleRate));
  const out = Buffer.alloc(outFrames * 2);
  const ratio = info.sampleRate / targetRate;
  const read = index => {
    const base = info.dataStart + index * info.channels * 2;
    if (info.channels === 1) return buffer.readInt16LE(base);
    const left = buffer.readInt16LE(base);
    const right = buffer.readInt16LE(base + 2);
    return Math.round((left + right) / 2);
  };
  for (let index = 0; index < outFrames; index++) {
    const position = index * ratio;
    const before = Math.floor(position);
    const after = Math.min(frames - 1, before + 1);
    const weight = position - before;
    const value = Math.round(read(before) * (1 - weight) + read(after) * weight);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, value)), index * 2);
  }
  return { pcm: out, sampleRate: targetRate, channels: 1, bitsPerSample: 16, durationMs: Math.round((outFrames / targetRate) * 1000) };
}

/** Wrap raw 16-bit mono PCM back into a canonical 44-byte-header WAV file. */
export function wrapPcm16(pcm, sampleRate = 16000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
