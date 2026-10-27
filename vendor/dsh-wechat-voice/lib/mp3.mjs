// MP3 -> mono PCM16 samples through a pure-WASM mpg123 build. Both online
// engines (Edge Read Aloud and Baidu) only return MP3, so the decoding and
// silence-trimming live here instead of inside either client.

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

export function pcm16FromFloat(samples) {
  const pcm = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, Number(samples[index]) || 0));
    pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), index * 2);
  }
  return pcm;
}

/**
 * Online voices pad the tail with room tone. Trimming it makes the WeChat
 * bubble duration match the speech, while keeping a short natural margin.
 */
export function trimFloatSilence(samples, sampleRate, { threshold = 0, leadMs = 60, tailMs = 160 } = {}) {
  if (!samples?.length || !sampleRate) return samples;
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = Math.abs(samples[index]);
    if (value > peak) peak = value;
  }
  if (peak < 0.001) return samples;
  const gate = threshold > 0 ? threshold : Math.max(0.002, Math.min(0.012, peak * 0.02));
  let first = 0;
  let last = samples.length - 1;
  while (first <= last && Math.abs(samples[first]) < gate) first++;
  while (last >= first && Math.abs(samples[last]) < gate) last--;
  if (last <= first) return samples;
  const leadKeep = Math.round((leadMs / 1000) * sampleRate);
  const tailKeep = Math.round((tailMs / 1000) * sampleRate);
  const start = Math.max(0, first - leadKeep);
  const end = Math.min(samples.length, last + 1 + tailKeep);
  return samples.subarray(start, end);
}

let decoderPromise;
async function loadDecoder() {
  if (!decoderPromise) {
    decoderPromise = import('mpg123-decoder').catch(error => {
      decoderPromise = undefined;
      throw coded('TTS_MP3_DEPENDENCY', { detail: `mpg123-decoder: ${error?.message ?? error}` });
    });
  }
  return decoderPromise;
}

/** Decode an MP3 buffer into `{samples, sampleRate}` with the tail trimmed. */
export async function decodeMp3ToMono(mp3) {
  const { MPEGDecoder } = await loadDecoder();
  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const decoded = decoder.decode(new Uint8Array(mp3));
    if (!decoded?.samplesDecoded || !decoded.channelData?.length) {
      throw coded('TTS_MP3_EMPTY', { detail: 'decoder returned no samples' });
    }
    const channels = decoded.channelData.length;
    const samples = decoded.samplesDecoded;
    const mono = new Float32Array(samples);
    for (let index = 0; index < samples; index++) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel++) sum += decoded.channelData[channel][index];
      mono[index] = sum / channels;
    }
    return { samples: trimFloatSilence(mono, decoded.sampleRate), sampleRate: decoded.sampleRate };
  } catch (error) {
    if (error?.code) throw error;
    throw coded('TTS_MP3_DECODE_FAILED', { detail: String(error?.message ?? error) });
  } finally {
    try { decoder.free(); } catch { /* already freed */ }
  }
}

/** Apply a 0..1 gain to decoded samples, used for the plugin's volume knob. */
export function applyGain(samples, volume = 100) {
  const gain = Math.max(0, Math.min(1, (Number(volume) || 0) / 100));
  if (gain === 1) return samples;
  return Float32Array.from(samples, value => value * gain);
}
