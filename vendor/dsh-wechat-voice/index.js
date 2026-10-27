// DSH host plugin: four WeChat voice tools.
//
//   wechat_voice_say     —— 把这段文字用主人的声音发给当前微信聊天（真语音条）
//   wechat_voice_set     —— 换音色/语速/音量并记住（本聊天专属 或 全局默认）
//   wechat_voice_preview —— 只在本机合成，不发送
//   wechat_voice_status  —— 本机能力体检（Edge/百度/SAPI 音色、hook 身份、/SendVoiceMsg 路由）
//
// Authorization is not re-invented here: the chat must be whitelisted and the
// tool must be granted under wechat.dshAccess.chats[key].tools, the same rule
// the bot core applies to every other tool.
//
// Schema shape matters: ctx.tools.register() runs assertSupportedJsonSchema on
// output.schema, and that subset is only
// type/oneOf/properties/required/additionalProperties/items/enum/const plus
// annotations. `{ type: 'json' }` belongs to the defineTool DSL, and
// maxLength/minimum/maximum are rejected keywords — using either makes apply()
// throw and the plugin card show as failed. Keep every schema to that subset.
// Numeric bounds therefore live in the descriptions, and the service clamps.

import { createVoiceService, explainError } from './lib/voice-service.mjs';
import { defaultRoot } from './lib/context.mjs';
import { resolveSettings, ensureSettingsFile, writeLoadedMarker } from './lib/settings.mjs';

// Keep the plugin name identical to the cordis.yml id (same pattern as dsh-meme):
// a mismatch makes the plugin card hard to match with its config entry.
export const name = 'dsh-wechat-voice';
export const inject = ['tools'];

// Unconstrained JSON output: an annotation-only schema is the accepted form.
const JSON_OUTPUT_SCHEMA = {};
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

const sessionOf = exec =>
  String(exec?.agent?.session?.header?.id ?? exec?.agent?.session?.id ?? exec?.sessionId ?? '').trim();

export function apply(ctx, config = {}) {
  const root = config?.root ? String(config.root) : defaultRoot();
  const settings = resolveSettings(root, config);
  const log = (...args) => {
    try { ctx.logger?.('wechat-voice')?.info?.(...args); } catch { /* logging must never break a send */ }
  };
  if (typeof ctx?.tools?.register !== 'function') {
    // Never take DSH down over a missing service; the tools simply stay absent.
    log('wechat-voice skipped: tools service unavailable');
    writeLoadedMarker(root, { ok: false, reason: 'TOOLS_SERVICE_UNAVAILABLE', name });
    return;
  }
  try { ensureSettingsFile(root); } catch { /* defaults still work */ }
  const service = createVoiceService({ root, settings, cordisConfig: config, log });
  const registered = [];

  const fail = error => ({
    ok: false,
    code: error?.code && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'VOICE_FAILED',
    message: explainError(error),
    ...(error?.detail ? { detail: error.detail } : {}),
    ...(error?.chunks ? { chunks: error.chunks, maxVoices: error.maxVoices } : {}),
  });

  const override = args => ({
    ...(args.voice ? { voice: String(args.voice) } : {}),
    ...(args.engine ? { engine: String(args.engine) } : {}),
    ...(args.rate !== undefined ? { rate: Number(args.rate) } : {}),
    ...(args.volume !== undefined ? { volume: Number(args.volume) } : {}),
    ...(args.maxVoices !== undefined ? { maxVoices: Number(args.maxVoices) } : {}),
  });

  const definitions = [
    {
      name: 'wechat_voice_say',
      description: '把一段文字合成微信语音发到当前聊天（代主人发语音）。音色先看这个聊天保存过的专属音色 '
        + '（state/voice/chats.json），没有就用全局默认：Edge 神经网络语音优先，不可用时改用百度在线语音，'
        + '再不行回退本机 SAPI。只用本机原生发送器的语音路由；路由不可用或该聊天没授权时不会伪报已发。'
        + '语音上限 60 秒，长内容会被切成最多 maxVoices 条；表情符号、链接、Markdown 会被清掉再朗读。'
        + '主人要换音色（"换成晓伊的声音""声音慢一点"）时，先用 wechat_voice_set 保存，再发语音。'
        + '适合：主人明确要求语音、睡前晚安、撒娇、纯情绪短句；不适合：报数据、贴代码、长段落。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要朗读的正文（最多 1200 字），用当前人格的语气，不要带括号动作或表情符号占位' },
          voice: { type: 'string', description: '可选。临时音色（不保存）：中文名如 晓伊 / 晓北 / 晓双，或 Edge 完整名 zh-CN-XiaoyiNeural，或 Fish 的 reference_id（32 位十六进制）；引擎为 baidu 时忽略。长期更换请用 wechat_voice_set' },
          engine: { type: 'string', enum: ['auto', 'edge', 'baidu', 'sapi', 'fish'], description: '可选。auto=Edge→百度→SAPI 自动兜底（默认）；edge=只用 Edge；baidu=只用百度在线女声；sapi=只用本机 SAPI（完全离线）；fish=Fish Audio 在线合成（要配 API key，情绪和克隆更强，支持 [laughing] 这类标签）' },
          rate: { type: 'integer', description: '可选。语速，-10 到 10，负慢正快，默认 0' },
          volume: { type: 'integer', description: '可选。音量，0 到 100，默认 100' },
          maxVoices: { type: 'integer', description: '可选。最多切几条语音，1 到 3，默认 2' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render },
      async execute(args, exec) {
        try {
          return await service.say({ sessionId: sessionOf(exec), text: args?.text, override: override(args ?? {}) });
        } catch (error) { return fail(error); }
      },
    },
    {
      name: 'wechat_voice_preview',
      description: '只在本机把文字合成语音，不发送给任何人（给主人试听、检查音色语速用）。默认自动选择最自然的在线女声。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要试听的内容（最多 1200 字）' },
          voice: { type: 'string', description: '可选。Edge 音色（zh-CN-XiaoxiaoNeural / zh-CN-XiaoyiNeural 等）、本机 SAPI 名，或 Fish 的 reference_id' },
          engine: { type: 'string', enum: ['auto', 'edge', 'baidu', 'sapi', 'fish'], description: '可选。auto（默认，Edge→百度→SAPI）/ edge / baidu / sapi / fish（Fish Audio）' },
          rate: { type: 'integer', description: '可选。语速，-10 到 10' },
          volume: { type: 'integer', description: '可选。音量，0 到 100' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render },
      async execute(args, exec) {
        try {
          return await service.preview({
            text: args?.text, voice: args?.voice, engine: args?.engine, rate: args?.rate, volume: args?.volume,
            // Preview with this chat's saved voice when we can resolve the chat.
            sessionId: sessionOf(exec),
          });
        } catch (error) { return fail(error); }
      },
    },
    {
      name: 'wechat_voice_set',
      description: '换微信语音的音色并记住，不用重启。主人说「换成晓伊的声音」「用晓北吧」「声音再慢一点」时调用。'
        + 'scope=chat（默认）只改当前聊天，scope=global 改所有聊天共用的默认音色。'
        + 'voice 可写中文短名（晓晓 / 晓伊 / 云希 / 云扬 / 云夏 / 晓双 / 晓北 / 晓妮 / 曉曼 / 曉臻）或 Edge 完整名，'
        + '也可以写本机已装的 SAPI 名，或 Fish Audio 的 reference_id（自动切到 fish 引擎）；'
        + 'voice 传空字符串（""）表示清掉本聊天的音色设置、回到全局默认。'
        + 'rate 是语速 -10..10，volume 是音量 0..100。保存后下一步可以直接用新音色发语音。',
      parameters: {
        type: 'object',
        properties: {
          voice: { type: 'string', description: '要用的音色：中文短名（晓伊/晓北/晓双/云希…）、Edge 完整名 zh-CN-XiaoyiNeural、本机 SAPI 名，或 Fish Audio reference_id（32 位，会自动切到 fish 引擎）；传 "" 清掉本聊天的音色回到全局默认' },
          engine: { type: 'string', enum: ['auto', 'edge', 'baidu', 'sapi', 'fish'], description: '可选。auto=Edge→百度→SAPI（推荐）；edge=只用在线神经网络音色；sapi=只用本机离线音色；fish=改用 Fish Audio 在线合成（需 API key）' },
          rate: { type: 'integer', description: '可选。语速，-10 到 10，负慢正快' },
          volume: { type: 'integer', description: '可选。音量，0 到 100' },
          scope: { type: 'string', enum: ['chat', 'global'], description: '可选。chat=只改当前聊天（默认）；global=改全局默认音色' },
        },
        additionalProperties: false,
      },
      output: { schema: JSON_OUTPUT_SCHEMA, render },
      async execute(args, exec) {
        try {
          return await service.setVoice({
            sessionId: sessionOf(exec),
            scope: args?.scope === 'global' ? 'global' : 'chat',
            // An explicit empty string means "forget this chat's voice".
            voice: args?.voice === '' ? null : args?.voice,
            engine: args?.engine,
            rate: args?.rate,
            volume: args?.volume,
          });
        } catch (error) { return fail(error); }
      },
    },
    {
      name: 'wechat_voice_status',
      description: '体检微信语音链路：当前语音引擎与音色、各聊天保存过的专属音色、本机 SAPI 语音、'
        + 'hook 身份与版本、原生 /SendVoiceMsg 路由是否可用、待发语音队列。只读，不发送。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: JSON_OUTPUT_SCHEMA, render },
      async execute() {
        try { return await service.status(); } catch (error) { return fail(error); }
      },
    },
  ];

  try {
    for (const definition of definitions) {
      ctx.tools.register(definition);
      registered.push(definition.name);
    }
  } catch (error) {
    log('wechat-voice registration failed', error?.message);
    writeLoadedMarker(root, {
      ok: false, reason: 'REGISTER_FAILED',
      error: String(error?.message ?? error).slice(0, 400), tools: registered, name,
    });
    return;
  }

  writeLoadedMarker(root, { ok: true, name, tools: registered, settings, configKeys: Object.keys(config ?? {}) });
  log('wechat-voice ready', `root=${root}`, `engine=${settings.engine}`, `edgeVoice=${settings.edgeVoice}`, `baidu=fallback`, `sapi=${settings.voice}`, `fallback=${settings.fallback}`);
}
