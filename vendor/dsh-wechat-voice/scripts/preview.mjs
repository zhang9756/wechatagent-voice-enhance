#!/usr/bin/env node
// Local smoke test / listening tool. Nothing here talks to WeChat.
//
//   node scripts/preview.mjs "主人，晚安。"
//   node scripts/preview.mjs "..." --engine auto --play
//   node scripts/preview.mjs "..." --engine edge --voice zh-CN-XiaoyiNeural --play
//   node scripts/preview.mjs "..." --engine baidu --play
//   node scripts/preview.mjs "..." --engine sapi --voice "Microsoft Huihui" --rate -2
//   node scripts/preview.mjs --status

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceService, explainError } from '../lib/voice-service.mjs';
import { resolveSettings } from '../lib/settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');

function parseArgs(argv) {
  const out = { text: [], flags: {} };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--status') { out.flags.status = true; continue; }
    if (arg === '--play') { out.flags.play = true; continue; }
    if (arg.startsWith('--')) { out.flags[arg.slice(2)] = argv[++index]; continue; }
    out.text.push(arg);
  }
  return out;
}

const { text, flags } = parseArgs(process.argv.slice(2));
const service = createVoiceService({ root, settings: resolveSettings(root) });

try {
  if (flags.status) {
    console.log(JSON.stringify(await service.status(), null, 2));
    process.exit(0);
  }
  const content = text.join(' ').trim() || '主人、我是鲸鲸。真语音条链路已经接通了。';
  const result = await service.preview({
    text: content,
    voice: flags.voice,
    engine: flags.engine,
    rate: flags.rate === undefined ? undefined : Number(flags.rate),
    volume: flags.volume === undefined ? undefined : Number(flags.volume),
    play: !!flags.play,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(explainError(error));
  console.error(JSON.stringify({ code: error.code ?? String(error), detail: error.detail }, null, 2));
  process.exit(1);
}
