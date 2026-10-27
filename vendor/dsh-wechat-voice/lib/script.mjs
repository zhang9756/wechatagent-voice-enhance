// Turn a model reply into something a speech engine can actually read, and cut
// it into WeChat-sized voice bubbles (a WeChat voice message tops out at 60 s).

// Characters a desktop SAPI voice reads as noise, or that only exist to format.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{E0020}-\u{E007F}]/gu;
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g;
const URL = /\bhttps?:\/\/[^\s<>"'，。！？、；：]+/gi;

/** Strip markup, emoji, zero-width junk and bare links; keep it readable aloud. */
export function sanitizeVoiceText(input, { maxChars = 1200 } = {}) {
  let text = String(input ?? '');
  text = text.replace(/```[\s\S]*?```/g, ' ');            // fenced code reads badly
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');   // markdown links keep the label
  text = text.replace(URL, ' 一个链接 ');                  // never read a URL aloud
  text = text.replace(/[*_~#>|]/g, ' ');                   // markdown emphasis
  text = text.replace(/[[【［]\s*(?:表情|图片|语音|贴纸|STICKER|VOICE|MEME)\s*[:：][^\]】］]*[\]】］]/gi, ' ');
  text = text.replace(/[[【［]\s*[\]】］]/g, ' ');          // empty marker brackets
  text = text.replace(EMOJI, '');
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(/[ \t\u3000]+/g, ' ');
  text = text.replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > maxChars) {
    // Prefer to cut on a sentence boundary rather than mid-clause.
    const slice = text.slice(0, maxChars);
    const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('\n'));
    text = cut > maxChars * 0.5 ? slice.slice(0, cut + 1) : slice;
  }
  return text;
}

/** Rough spoken length in ms. Calibrated for zh-CN SAPI at rate 0. */
export function estimateSpeechMs(text, rate = 0) {
  const value = String(text ?? '');
  let cjk = 0, latinWords = 0, latinLetters = 0, digits = 0;
  for (const char of value) {
    if (/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(char)) cjk++;
    else if (/[A-Za-z]/.test(char)) latinLetters++;
    else if (/[0-9]/.test(char)) digits++;
  }
  latinWords = Math.max(latinWords, Math.ceil(latinLetters / 5));
  const pauses = (value.match(/[。！？；，、,.!?;:]/g) ?? []).length;
  const baseMs = cjk * 235 + latinWords * 320 + digits * 260 + pauses * 110;
  const clamped = Math.max(-10, Math.min(10, Math.round(rate)));
  return Math.round(baseMs / Math.pow(1.12, clamped));
}

const SENTENCE_BREAK = /(?<=[。！？；!?;…])|\n+/u;

/** Pack sentences into chunks that stay under `maxMs` (WeChat's 60 s limit). */
export function splitForVoice(text, { maxMs = 55000, rate = 0 } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  if (estimateSpeechMs(clean, rate) <= maxMs) return [clean];
  const units = clean.split(SENTENCE_BREAK).map(unit => unit.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const unit of units) {
    if (estimateSpeechMs(unit, rate) > maxMs) {
      // A single monster sentence: hard-wrap on characters, then commas.
      flush();
      let rest = unit;
      const perChunk = Math.max(20, Math.floor((maxMs / 235) * Math.pow(1.12, Math.round(rate))) - 4);
      while (rest.length > perChunk) {
        let cut = perChunk;
        const comma = Math.max(rest.lastIndexOf('，', perChunk), rest.lastIndexOf('、', perChunk));
        if (comma > perChunk * 0.6) cut = comma + 1;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    if (estimateSpeechMs(current + unit, rate) > maxMs) flush();
    current += unit;
  }
  flush();
  return chunks.filter(Boolean);
}
