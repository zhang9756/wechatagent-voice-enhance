// Orchestration: chat resolution -> authorization -> synthesis -> delivery.
// One place decides what "send a voice message" means right now, so the tools
// stay thin and the failure modes stay explicit.

import fs from 'node:fs';
import path from 'node:path';
import { defaultRoot, readConfig, readIoConfig, chatForSession, hookCredential } from './context.mjs';
import { assertAccess } from './auth.mjs';
import { sanitizeVoiceText, splitForVoice, estimateSpeechMs } from './script.mjs';
import { synthesize, pickVoice, listVoices, shellInUse, BAIDU_VOICE, isFishVoice, FISH_VOICE } from './tts.mjs';
import { FISH_MODELS, FISH_DEFAULT_MODEL, normalizeFishModel } from './fish.mjs';
import {
  isEdgeVoice, resolveEdgeVoice, edgeVoiceLabel, EDGE_DEFAULT_VOICE, EDGE_VOICES,
} from './edge.mjs';
import {
  DEFAULTS, saveSettings, resolveSettings,
  readChatVoices, saveChatVoice, applyChatVoice,
} from './settings.mjs';
import { createStore } from './store.mjs';
import { encodeSilk } from './silk.mjs';
import { resolveTarget, hookIdentity, probeVoiceRoute, probeFileRoute, sendVoice, sendFile, sendText } from './wechat.mjs';

export { DEFAULTS };

export const ERROR_TEXT = {
  CHAT_UNRESOLVED: '当前 DSH 会话没有绑定微信聊天，语音不能代发。',
  CHAT_NOT_ALLOWED: '这个聊天不在微信白名单里，不能发语音。',
  TOOL_NOT_GRANTED: '这个聊天还没授权 wechat_voice_say，去 WeChatAgent「聊天范围 → 技能与工具」勾上。',
  CONFIG_UNAVAILABLE: '读不到 config/wechatagent.json，先确认插件装在 WeChatAgent 项目目录里。',
  HOOK_VOICE_ROUTE_MISSING: '原生发送器还没有 /SendVoiceMsg 路由，语音只生成不发；要真语音条得先给 hook 加这条路由。',
  HOOK_TOKEN_MISSING: '找不到 hook 的 Bearer token（state/hook/.../wechatagent-hook.token）。',
  HOOK_NOT_LISTENING: 'hook 的本地 HTTP 服务没响应，微信或注入的 version.dll 没起来。',
  HOOK_ACCOUNT_AMBIGUOUS: 'hook 报出来的微信账号不是唯一一个，拒绝发送。',
  VOICE_SEND_UNCONFIRMED: '语音已提交但没拿到确认，按未确认处理，不重复发。',
  VOICE_SEND_REJECTED: '原生发送器拒绝了这条语音（参数或账号校验不过）。',
  SILK_ENCODER_MISSING: '找不到 SILK 编码器 state/silk/bin/silk_encoder.exe，先按 docs/VOICE_BUBBLE_RE.md 编译。',
  SILK_INPUT_INVALID: '待编码的 WAV 路径或格式不对。',
  SILK_TOO_LONG: '这段音频超过 60 秒，微信语音条放不下。',
  SILK_ENCODE_FAILED: 'SILK 编码失败（编码器没跑通）。',
  SILK_OUTPUT_INVALID: 'SILK 编码结果不是微信可识别的格式。',
  TTS_SHELL_UNAVAILABLE: '找不到 PowerShell，没法调本机 SAPI 合成。',
  TTS_ENGINE_UNAVAILABLE: '没有可用的语音引擎（Edge / 百度在线语音和 SAPI 都不可用）。',
  TTS_VOICE_NOT_INSTALLED: '本机没装这个 SAPI 语音，换 Microsoft Yaoyao / Huihui。',
  TTS_SYNTHESIS_FAILED: '合成失败（文本可能过长或含引擎读不了的字符）。',
  TTS_TEXT_EMPTY: '没有可朗读的文字。',
  TTS_ARGUMENTS_INVALID: '语音参数不完整。',
  TTS_EDGE_NETWORK: 'Edge 在线自然语音连不上（网络或代理问题）。',
  TTS_EDGE_TIMEOUT: 'Edge 在线自然语音超时。',
  TTS_EDGE_VOICE: 'Edge 音色名不对，换 zh-CN-XiaoxiaoNeural / zh-CN-XiaoyiNeural。',
  TTS_EDGE_EMPTY: 'Edge 没有返回音频。',
  TTS_EDGE_PROTOCOL: 'Edge 语音协议返回了意料之外的响应。',
  TTS_EDGE_DEPENDENCY: '语音依赖不完整（ws / mpg123-decoder），先 npm install。',
  TTS_EDGE_DECODE_FAILED: 'Edge 返回的音频解码失败。',
  TTS_BAIDU_NETWORK: '百度在线语音连不上（网络问题）。',
  TTS_BAIDU_TIMEOUT: '百度在线语音超时。',
  TTS_BAIDU_EMPTY: '百度在线语音没有返回音频。',
  TTS_BAIDU_DECODE_FAILED: '百度返回的音频解码失败。',
  TTS_BAIDU_DEPENDENCY: '语音依赖不完整（mpg123-decoder），先 npm install。',
  TTS_FISH_NO_KEY: '没配 Fish Audio 的 API key。去 state/voice/config.json 填 fishApiKey，或设环境变量 FISH_AUDIO_API_KEY。',
  TTS_FISH_AUTH: 'Fish Audio 拒绝了这个 API key（401/403），检查 key 是否有效或已过期。',
  TTS_FISH_QUOTA: 'Fish Audio 额度不够或限流了（402/429），充值或稍后再试。',
  TTS_FISH_NETWORK: '连不上 Fish Audio 服务器（网络或代理问题）。',
  TTS_FISH_TIMEOUT: 'Fish Audio 合成超时。',
  TTS_FISH_MODEL: 'Fish Audio 不认识这个模型名，换 s2-pro / s2.1-pro / drama-3。',
  TTS_FISH_EMPTY: 'Fish Audio 没有返回音频。',
  TTS_FISH_DECODE_FAILED: 'Fish Audio 返回的音频解码失败。',
  TTS_FISH_DEPENDENCY: '语音依赖不完整（mpg123-decoder），先 npm install。',
  VOICE_TEXT_EMPTY: '清掉表情和链接后没有可朗读的文字了。',
  VOICE_TOO_MANY_CHUNKS: '内容太长，切出来的语音条数超过上限，请缩短或拆成两次。',
  READER_CONFIG_MISSING: '没有读取服务配置（state/wechat-io-config.json）。',
  READER_UNAVAILABLE: '读取服务没起来，解析不到对方 wxid。',
  READER_RESPONSE_INVALID: '读取服务返回的会话列表格式不对。',
  TARGET_MAPPING_AMBIGUOUS_OR_MISSING: '会话号对不上 wxid，先确认对方还在会话列表里。',
  TARGET_IS_SELF: '目标是本机账号自己，拒绝发送。',
  CHAT_VOICE_KEY_INVALID: '聊天标识不合法，不能保存这个聊天的音色。',
  CHAT_VOICE_UNKNOWN: '不认识这个音色名，可以说中文名（晓伊 / 晓晓 / 晓北）或 Edge 完整名。',
  VOICE_SETTINGS_UNWRITABLE: '写不进 state/voice/config.json，音色没保存成功。',
};

export function explainError(error) {
  const code = error?.code ?? '';
  const text = ERROR_TEXT[code] ?? `语音发送失败（${code || 'VOICE_FAILED'}）`;
  return error?.detail ? `${text}：${String(error.detail).slice(0, 200)}` : text;
}

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

function fallbackNote(engine, fallbackFrom) {
  if (!fallbackFrom) return '';
  const fromFish = String(fallbackFrom).includes('fish');
  if (engine === 'baidu') {
    return fromFish
      ? 'Fish Audio 和 Edge 都不可用，已改用百度在线自然语音。'
      : 'Edge 在线语音不可用，已改用百度在线自然语音。';
  }
  if (engine === 'sapi') {
    return fromFish
      ? 'Fish Audio 和在线语音都不可用，已自动回退本机 SAPI。'
      : '在线自然语音不可用，已自动回退本机 SAPI。';
  }
  if (engine === 'edge' && fromFish) return 'Fish Audio 合成失败，已回退 Edge 在线语音。';
  return '';
}

/**
 * A cached Baidu/SAPI fallback must not mask a recovered Edge path for
 * auto/edge requests; those entries are re-synthesized and overwritten.
 */
export function cachedEngineStillPreferred(requestedEngine, cachedEngine) {
  if (requestedEngine !== 'edge' && requestedEngine !== 'auto') return true;
  return !cachedEngine || cachedEngine === 'edge';
}

export function createVoiceService({ root = defaultRoot(), settings = {}, cordisConfig = {}, log = () => {} } = {}) {
  const options = { ...DEFAULTS, ...settings };
  const store = createStore({ root });

  /**
   * Re-read the global config so an edit made by hand (or by another DSH
   * window) applies to the next voice without a restart. Precedence is the same
   * as at load time: defaults < config.json < cordis config.
   */
  function refreshGlobal() {
    try { Object.assign(options, resolveSettings(root, cordisConfig)); } catch { /* keep what we have */ }
    return options;
  }

  /**
   * Settings for one chat: the global ones, then this chat's saved overrides.
   * Re-read on every call so a voice changed a second ago is already in use —
   * no restart, no stale in-memory copy.
   */
  function settingsFor(chatKey) {
    refreshGlobal();
    if (!chatKey) return options;
    try {
      const overrides = readChatVoices(root)[chatKey] ?? {};
      return Object.keys(overrides).length ? applyChatVoice(options, overrides) : options;
    } catch { return options; }
  }

  /**
   * Pick the voice for one synthesis.
   *
   * `requested` is ONLY a voice the caller explicitly asked for (a tool
   * argument); a voice stored in the configuration is never passed here — it
   * arrives as `base`. Mixing the two is what would make auto mode silently fall
   * back to SAPI: the configured SAPI fallback name would look like a request.
   */
  async function resolveVoice(requested, engine = options.engine, base = options) {
    const mode = ['auto', 'edge', 'baidu', 'sapi', 'fish', 'volc'].includes(String(engine)) ? String(engine) : base.engine;
    const raw = String(requested ?? '').trim();
    // `晓伊` is what the owner types; Edge only understands `zh-CN-XiaoyiNeural`.
    const wanted = raw ? (resolveEdgeVoice(raw) || raw) : '';
    const asked = !!raw;
    // A Fish voice is a reference_id (or the default-voice label), so all of the
    // Edge/SAPI name resolution below must be skipped for it.
    const fishVoice = isFishVoice(wanted) ? wanted : '';
    const sapiPick = async preferred => pickVoice(preferred).catch(error => ({
      name: '', fellBack: false, note: error?.code ?? 'TTS_ENGINE_UNAVAILABLE',
    }));
    if (mode === 'volc') {
      // 火山引擎：voice 直接作为火山模型/声音 ID 透传（不要求 32 位 hex）。
      const voice = wanted || String(base.voice ?? '').trim();
      return { name: voice, engine: 'volc', sapiVoice: base.voice, fellBack: false, note: '' };
    }
    if (mode === 'fish') {
      const voice = fishVoice || (isFishVoice(base.voice) ? base.voice : FISH_VOICE);
      return {
        name: voice, engine: 'fish', sapiVoice: base.voice, fellBack: false,
        note: wanted && !fishVoice ? `Fish 引擎按 reference_id 选音色，已忽略 voice=${wanted}` : '',
      };
    }
    if (mode === 'baidu') {
      return {
        name: BAIDU_VOICE, engine: 'baidu', sapiVoice: base.voice, fellBack: false,
        note: wanted && wanted !== BAIDU_VOICE ? `百度引擎只有一种女声，已忽略 voice=${wanted}` : '',
      };
    }
    if (mode === 'sapi') {
      const picked = await sapiPick(wanted || base.voice);
      // An explicitly requested voice that this machine does not have must fail
      // loudly: silently speaking with another voice looks like success.
      if (asked && picked.fellBack) throw coded('CHAT_VOICE_UNKNOWN', { detail: raw });
      if (!picked.name) throw coded('TTS_ENGINE_UNAVAILABLE', { detail: picked.note });
      return { ...picked, engine: 'sapi', sapiVoice: picked.name };
    }
    // In auto mode an explicitly requested SAPI voice is an escape hatch to the
    // offline engine; everything else uses the natural Edge voice.
    if (mode === 'auto' && fishVoice) {
      return { name: fishVoice, engine: 'auto', sapiVoice: base.voice, fellBack: false, note: '' };
    }
    if (mode === 'auto' && asked && !isEdgeVoice(wanted)) {
      const picked = await sapiPick(wanted);
      if (picked.name && !picked.fellBack) return { ...picked, engine: 'sapi', sapiVoice: picked.name };
    }
    // Neither an Edge name nor an installed SAPI voice: refuse instead of
    // quietly using 晓晓.
    if (asked && !isEdgeVoice(wanted)) throw coded('CHAT_VOICE_UNKNOWN', { detail: raw });
    const edgeVoice = isEdgeVoice(wanted) ? wanted : (base.edgeVoice || EDGE_DEFAULT_VOICE);
    const note = !isEdgeVoice(edgeVoice)
      ? `Edge 音色名无效：${edgeVoice}，将尝试本机 SAPI`
      : '';
    return { name: edgeVoice, engine: mode, sapiVoice: base.voice, fellBack: false, note };
  }

  function plan(text, { rate = options.rate, maxChars = options.maxChars, maxVoiceMs = options.maxVoiceMs } = {}) {
    const clean = sanitizeVoiceText(text, { maxChars });
    if (!clean) throw coded('VOICE_TEXT_EMPTY', { detail: ERROR_TEXT.VOICE_TEXT_EMPTY });
    const chunks = splitForVoice(clean, { maxMs: maxVoiceMs, rate });
    return { clean, chunks, estimatedMs: estimateSpeechMs(clean, rate) };
  }

  /** The Fish Audio half of the settings, read fresh so a key edit needs no restart. */
  function fishOptions(scope = options) {
    return {
      fishApiKey: String(scope.fishApiKey ?? ''),
      fishApiKeyEnv: String(scope.fishApiKeyEnv || 'FISH_AUDIO_API_KEY'),
      fishEndpoint: String(scope.fishEndpoint ?? ''),
      fishProxy: String(scope.fishProxy ?? ''),
      fishModel: normalizeFishModel(scope.fishModel),
      fishLatency: scope.fishLatency === 'balanced' ? 'balanced' : 'normal',
      fallbackOnFishError: scope.fishFallback !== false,
    };
  }

  /** Turn text into staged wav files (never sends). */
  async function synthesizeChunks({ text, voiceName, sapiVoice, engine, rate, volume, maxChars, maxVoiceMs, scope = options }) {
    const { clean, chunks } = plan(text, { rate, maxChars, maxVoiceMs });
    const items = [];
    for (const chunk of chunks) {
      const key = store.cacheKey({ text: chunk, voice: voiceName, rate, volume, engine });
      const reusable = store.findReusable(key);
      if (reusable && cachedEngineStillPreferred(engine, reusable.engine)) {
        items.push({
          text: chunk, path: reusable.path, durationMs: reusable.durationMs, bytes: reusable.bytes, cached: true,
          engine: reusable.engine || engine, voice: reusable.voice || voiceName, fallbackFrom: reusable.fallbackFrom || '',
        });
        continue;
      }
      const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const temp = path.join(store.outgoing, `.synth-${stamp}.wav`);
      try {
        const made = await synthesize({
          text: chunk, outPath: temp, voice: voiceName, engine, sapiVoice, rate, volume,
          ...fishOptions(scope),
        });
        const actualEngine = made.engine ?? engine;
        const actualVoice = made.voice || voiceName;
        const stored = await store.put({
          wavPath: temp, text: chunk, voice: actualVoice, rate, volume,
          durationMs: made.durationMs, engine: actualEngine, key,
          extra: made.fallbackFrom ? { fallbackFrom: made.fallbackFrom } : {},
        });
        items.push({
          text: chunk, path: stored.path, durationMs: stored.durationMs, bytes: stored.bytes, cached: false,
          engine: actualEngine, voice: actualVoice, fallbackFrom: made.fallbackFrom || '',
        });
      } finally {
        try { fs.unlinkSync(temp); } catch { /* already moved */ }
      }
    }
    return { clean, items };
  }

  async function status() {
    refreshGlobal();
    const config = readConfig(root);
    const ioConfig = readIoConfig(root);
    const credential = hookCredential(root, config);
    const voices = await listVoices().catch(() => []);
    const [identity, probe, fileRoute] = await Promise.all([
      hookIdentity({ credential }).catch(error => ({ error: error.code ?? String(error) })),
      probeVoiceRoute({ credential }),
      probeFileRoute({ credential }),
    ]);
    const nativeFileSend = identity?.raw?.nativeFileSend === true;
    const nativeVoiceSend = identity?.raw?.nativeVoiceSend === true;
    return {
      root,
      ok: true,
      tts: {
        engine: options.engine,
        engines: ['auto', 'edge', 'baidu', 'sapi', 'fish', 'volc'],
        edgeVoice: options.edgeVoice,
        edgeVoiceLabel: edgeVoiceLabel(options.edgeVoice),
        baiduVoice: BAIDU_VOICE,
        fish: {
          voice: FISH_VOICE,
          model: normalizeFishModel(options.fishModel),
          models: FISH_MODELS,
          endpoint: options.fishEndpoint || 'https://api.fish.audio/v1/tts',
          proxy: options.fishProxy || '',
          // Report only whether a key exists: status must never leak the secret.
          keyPresent: !!String(options.fishApiKey || '').trim()
            || !!String(process.env[options.fishApiKeyEnv || 'FISH_AUDIO_API_KEY'] || '').trim(),
          keySource: String(options.fishApiKey || '').trim()
            ? 'config.json'
            : (process.env[options.fishApiKeyEnv || 'FISH_AUDIO_API_KEY'] ? 'env' : ''),
          selfHosted: !!options.fishEndpoint,
          fallback: options.fishFallback !== false,
        },
        shell: shellInUse(),
        configured: String(options.voice ?? ''),
        edgeVoices: EDGE_VOICES.map(item => ({ ...item, short: item.label.split(' · ')[0] })),
        zhVoices: voices.filter(item => /^zh/i.test(item.culture)).map(item => ({ name: item.name, culture: item.culture, gender: item.gender })),
        anyVoice: voices.length > 0,
      },
      hook: { url: credential.baseUrl, tokenPresent: !!credential.token, ...identity },
      voiceRoute: { ...probe, nativeVoiceSend },
      fileRoute: { ...fileRoute, nativeFileSend },
      reader: { configured: !!ioConfig.reader_base_url },
      staged: { pending: store.pending().filter(item => item.status !== 'sent').length },
      settings: options,
      chatVoices: readChatVoices(root),
      note: probe.supported && nativeVoiceSend
        ? '原生语音路由可用，可以发真语音条。'
        : probe.supported
          ? '语音路由在，但原生语音对象布局不可用；先看 voice-probe。'
          : fileRoute.supported
          ? '语音条路由还没有，但文件通道在：音频会以「文件」发出（对方点开能听）。'
          : '语音与文件路由都没上：语音只会生成并停在 state/voice，本机可试听。',
    };
  }

  /** Public helper: which voice does this chat actually use right now? */
  function currentVoice(chatKey) {
    const effective = settingsFor(chatKey);
    return {
      engine: effective.engine,
      edgeVoice: effective.edgeVoice,
      edgeVoiceLabel: edgeVoiceLabel(effective.edgeVoice),
      sapiVoice: effective.voice,
      rate: effective.rate,
      volume: effective.volume,
      ...(chatKey ? { overrides: readChatVoices(root)[chatKey] ?? {} } : {}),
    };
  }

  /**
   * Change the voice the owner hears, durably.
   *
   * `scope: 'chat'` saves it for the current WeChat conversation only,
   * `scope: 'global'` saves it into state/voice/config.json for every chat.
   * Fields left out keep their current value; `null` deletes a chat override
   * so the chat falls back to the global voice again.
   *
   * The value is validated before anything is written: an unknown voice name
   * must fail loudly instead of silently falling back to 晓晓.
   */
  async function setVoice({ sessionId, scope = 'chat', voice, engine, rate, volume, tool = 'wechat_voice_set' } = {}) {
    refreshGlobal();
    const config = readConfig(root);
    const chat = chatForSession(root, sessionId);
    // Both scopes need a bound conversation and the same grant: the grant is for
    // "changing the voice", and scope only says which layer it changes.
    assertAccess({ config, chat, tool });

    const patch = {};
    let normalizedVoice = '';
    // The engine has to follow the voice type, otherwise "用晓伊的声音" would be
    // stored next to engine=sapi and come out as a robot anyway.
    const currentEngine = (scope === 'chat' ? settingsFor(chat.key) : options).engine;
    const implicitEngine = edge => {
      if (edge) return ['auto', 'edge'].includes(currentEngine) ? undefined : 'auto';
      return 'sapi';
    };
    if (voice !== undefined && voice !== null && String(voice).trim() !== '') {
      const raw = String(voice).trim().slice(0, 64);
      const edge = resolveEdgeVoice(raw);
      if (isFishVoice(raw)) {
        // A Fish reference_id: the engine has to follow, or the id would sit in
        // `voice` while Edge keeps speaking.
        normalizedVoice = raw;
        patch.voice = raw;
        if (currentEngine !== 'fish') patch.engine = 'fish';
      } else if (edge) {
        normalizedVoice = edge;
        patch.edgeVoice = edge;
        const engine = implicitEngine(true);
        if (engine) patch.engine = engine;
      } else {
        // Not an Edge name: accept it only if this machine really has that SAPI voice.
        const picked = await pickVoice(raw).catch(() => ({ name: '', fellBack: true, note: '' }));
        if (!picked.name || picked.fellBack) throw coded('CHAT_VOICE_UNKNOWN', { detail: raw });
        normalizedVoice = picked.name;
        patch.voice = picked.name;
        const engine = implicitEngine(false);
        if (engine) patch.engine = engine;
      }
    } else if (voice === null) {
      patch.edgeVoice = null;
      patch.voice = null;
      patch.engine = null;
      patch.rate = null;
      patch.volume = null;
    }
    if (engine !== undefined && engine !== null) {
      const mode = String(engine);
      if (!['auto', 'edge', 'baidu', 'sapi', 'fish', 'volc'].includes(mode)) {
        throw coded('TTS_ARGUMENTS_INVALID', { detail: `engine=${mode}` });
      }
      patch.engine = mode;
    }
    if (rate !== undefined && rate !== null) patch.rate = Number(rate);
    if (volume !== undefined && volume !== null) patch.volume = Number(volume);
    if (!Object.keys(patch).length) throw coded('TTS_ARGUMENTS_INVALID', { detail: '没有要保存的音色或参数' });

    const saved = scope === 'global'
      ? saveSettings(root, patch)
      : saveChatVoice(root, chat.key, patch, options);
    // A global change has to take effect now, not at the next DSH restart: the
    // in-memory copy is rebuilt with the same precedence as at load time, so
    // cordis config still wins over the file and the reply stays truthful.
    if (scope === 'global') Object.assign(options, resolveSettings(root, cordisConfig));
    const effective = scope === 'global' ? { ...options } : saved;
    const overriddenByCordis = scope === 'global'
      && Object.keys(patch).filter(key => key !== 'engine' && options[key] !== (saved[key] ?? options[key]));
    log(`[voice] set scope=${scope} chat=${scope === 'global' ? '*' : chat.key} voice=${effective.edgeVoice} engine=${effective.engine}`);
    return {
      ok: true,
      scope,
      chat: scope === 'global' ? null : { key: chat.key, kind: chat.kind, id: chat.id },
      voice: effective.edgeVoice,
      voiceLabel: edgeVoiceLabel(effective.edgeVoice),
      sapiVoice: effective.voice,
      engine: effective.engine,
      rate: effective.rate,
      volume: effective.volume,
      changed: Object.keys(patch),
      ...(normalizedVoice ? { requested: normalizedVoice } : {}),
      file: scope === 'global' ? 'state/voice/config.json' : 'state/voice/chats.json',
      note: scope === 'global'
        ? '已保存为全局默认音色，所有聊天下次发语音就用它。'
          + (overriddenByCordis.length
            ? `注意 cordis.yml 里还写死了 ${overriddenByCordis.join('、')}，那一层优先级更高，要改得动它才生效。`
            : '')
        : '已保存这个聊天的专属音色，下一条语音立即生效，不用重启。',
    };
  }

  /**
   * The real thing. Returns a plain object that the tool renders as JSON.
   * `mode` is deliberately explicit: 'voice' only when the hook accepted it.
   */
  async function say({ sessionId, text, tool = 'wechat_voice_say', override = {} }) {
    const config = readConfig(root);
    const chat = chatForSession(root, sessionId);
    assertAccess({ config, chat, tool });
    // The chat's own saved voice wins over the global default, and the caller's
    // per-call override wins over both — that order is what makes "换成晓伊"
    // stick for later messages while one-off overrides still work.
    const chatSettings = settingsFor(chat.key);
    const merged = { ...chatSettings, ...override };
    const ioConfig = readIoConfig(root);
    const credential = hookCredential(root, config);
    // A dead hook must not throw the audio away: generate first, then report why
    // it could not be delivered, so the file is still there for a later flush.
    let identity = null, hookError = null;
    try { identity = await hookIdentity({ credential }); } catch (error) { hookError = error; }
    const probe = identity
      ? await probeVoiceRoute({ credential })
      : { supported: false, reason: hookError?.code ?? 'HOOK_UNAVAILABLE', detail: hookError?.detail };
    // The route can exist while the native layout behind it does not (an older
    // DLL, or WX layout drift). Trust the health flag when the hook reports it.
    const nativeVoiceSend = identity?.raw?.nativeVoiceSend !== false;
    const voiceReady = probe.supported && nativeVoiceSend;
    const engine = ['auto', 'edge', 'baidu', 'sapi'].includes(String(merged.engine)) ? String(merged.engine) : chatSettings.engine;
    // Only `override.voice` is an explicit request; the chat's configured voice
    // travels as `chatSettings`.
    const picked = await resolveVoice(override.voice, engine, chatSettings);
    const voiceName = picked.name;
    const { clean, items } = await synthesizeChunks({
      text, voiceName, sapiVoice: picked.sapiVoice, engine: picked.engine,
      rate: Number(merged.rate) || 0,
      volume: Number(merged.volume) || 100,
      maxChars: Number(merged.maxChars) || chatSettings.maxChars,
      maxVoiceMs: Number(merged.maxVoiceMs) || chatSettings.maxVoiceMs,
      scope: chatSettings,
    });
    if (items.length > merged.maxVoices) {
      throw coded('VOICE_TOO_MANY_CHUNKS', { chunks: items.length, maxVoices: merged.maxVoices });
    }
    const actualEngine = items[0]?.engine ?? picked.engine;
    const actualVoice = items[0]?.voice ?? voiceName;
    const fallbackFrom = items.find(item => item.fallbackFrom)?.fallbackFrom;
    const voiceNote = [picked.note, fallbackNote(actualEngine, fallbackFrom)].filter(Boolean).join(' ');
    const result = {
      ok: true,
      mode: 'staged',
      chat: { key: chat.key, kind: chat.kind, id: chat.id },
      engine: actualEngine,
      voice: actualVoice,
      voiceLabel: edgeVoiceLabel(actualVoice),
      ...(fallbackFrom ? { fallbackFrom } : {}),
      text: clean,
      items: items.map(item => ({ text: item.text.slice(0, 120), durationMs: item.durationMs, path: item.path, status: 'staged' })),
      ...(voiceNote ? { voiceNote } : {}),
      note: '',
    };
    if (!voiceReady) {
      // No voice bubble available: if the sender can at least carry a file, the
      // audio still reaches the recipient as a playable file card.
      const fileProbe = identity ? await probeFileRoute({ credential }) : { supported: false, reason: probe.reason };
      if (fileProbe.supported) {
        const wxid = await resolveTarget({ ioConfig, kind: chat.kind, id: chat.id });
        const sentFiles = [];
        for (const item of items) {
          // The staged file is content-addressed, so its name is a sha256 hash.
          // Recipients deserve a readable name: copy to a speakable one first.
          const display = readableVoiceFile(item, clean);
          const sent = await sendFile({ credential, account: identity.account, wxid, file: display });
          sentFiles.push({ path: display, accepted: true, retmsg: sent.retmsg });
        }
        result.mode = 'file';
        result.items = items.map(item => ({ ...item, text: item.text.slice(0, 120), status: 'sent' }));
        result.delivered = sentFiles;
        result.voiceRoute = probe;
        result.fileRoute = fileProbe;
        result.note = (probe.supported
          ? '原生语音路由在，但语音对象布局不可用（nativeVoiceSend=false），音频改为「文件」发出：对方点开能听，但不是绿色语音条。'
          : '原生语音路由还没有，音频改为「文件」发出：对方点开能听，但不是绿色语音条。')
          + '注意微信对同一份音频会去重，同一句话短时间内重复发可能不出现。';
        log(`[voice] ${chat.key} sent ${items.length} audio file(s)`);
        return result;
      }
      if (merged.fallback === 'error' && probe.reason === 'HOOK_VOICE_ROUTE_MISSING') throw coded('HOOK_VOICE_ROUTE_MISSING');
      for (const item of items) store.queuePending({ ...item, chat: chat.key, sessionId: String(sessionId), status: 'staged', createdAt: Date.now() });
      result.note = hookError
        ? explainError(hookError)
        : probe.supported && !nativeVoiceSend
          ? '原生语音路由在，但语音对象布局不可用（nativeVoiceSend=false），语音只生成不发。'
          : ERROR_TEXT.HOOK_VOICE_ROUTE_MISSING;
      result.voiceRoute = probe;
      result.fileRoute = fileProbe;
      return result;
    }
    // Real bubbles need the on-disk WeChat format. Encode after the fallback
    // decision so a missing encoder only affects the voice route.
    for (const item of items) {
      const made = await encodeSilk({ root, wavPath: item.path });
      item.silkPath = made.path;
      item.silkBytes = made.bytes;
      item.durationMs = made.durationMs;
    }
    const wxid = await resolveTarget({ ioConfig, kind: chat.kind, id: chat.id });
    const delivered = [];
    for (const item of items) {
      try {
        const sent = await sendVoice({ credential, account: identity.account, wxid, file: item.silkPath, durationMs: item.durationMs, format: 'silk' });
        delivered.push({ path: item.silkPath, accepted: true, retmsg: sent.retmsg });
      } catch (error) {
        if (error.code === 'HOOK_VOICE_ROUTE_MISSING') {
          for (const staged of items) store.queuePending({ ...staged, chat: chat.key, sessionId: String(sessionId), status: 'staged', createdAt: Date.now() });
          result.note = ERROR_TEXT.HOOK_VOICE_ROUTE_MISSING;
          return result;
        }
        throw error;
      }
    }
    result.mode = 'voice';
    result.items = items.map(item => ({ text: item.text.slice(0, 120), durationMs: item.durationMs, path: item.path, silkPath: item.silkPath, silkBytes: item.silkBytes, status: 'sent' }));
    result.delivered = delivered;
    result.note = '原生发送器已接受，应显示为绿色语音条；送达仍以会话里的消息为准。';
    log(`[voice] ${chat.key} sent ${items.length} voice item(s), ${items.reduce((sum, item) => sum + item.durationMs, 0)} ms`);
    return result;
  }

  /** Local-only preview: synthesize, optionally play, never touch WeChat. */
  async function preview({ text, voice, rate, volume, engine, play = false, sessionId }) {
    // A bound chat previews with its own saved voice, so what the owner hears
    // here is exactly what the next message will sound like.
    const chat = sessionId ? chatForSession(root, sessionId) : null;
    const base = chat ? settingsFor(chat.key) : refreshGlobal();
    const mode = ['auto', 'edge', 'baidu', 'sapi', 'fish', 'volc'].includes(String(engine)) ? String(engine) : base.engine;
    const picked = await resolveVoice(voice, mode, base);
    const voiceName = picked.name;
    const { clean, items } = await synthesizeChunks({
      text, voiceName, sapiVoice: picked.sapiVoice, engine: picked.engine,
      rate: Number(rate ?? base.rate) || 0,
      volume: Number(volume ?? base.volume) || 100,
      maxChars: base.maxChars,
      maxVoiceMs: base.maxVoiceMs,
      scope: base,
    });
    if (play && items[0]?.path) playWav(items[0].path);
    const actualEngine = items[0]?.engine ?? picked.engine;
    const fallbackFrom = items.find(item => item.fallbackFrom)?.fallbackFrom;
    const voiceNote = [picked.note, fallbackNote(actualEngine, fallbackFrom)].filter(Boolean).join(' ');
    return {
      ok: true, mode: 'preview',
      engine: actualEngine,
      voice: items[0]?.voice ?? voiceName,
      voiceLabel: edgeVoiceLabel(items[0]?.voice ?? voiceName),
      ...(chat ? { chat: { key: chat.key } } : {}),
      ...(fallbackFrom ? { fallbackFrom } : {}),
      text: clean, items,
      ...(voiceNote ? { voiceNote } : {}),
      note: '只在本机生成，没有发给任何人。',
    };
  }

  return { say, preview, status, setVoice, currentVoice, settingsFor, plan, store, root, options };
}

/**
 * Copy a staged (content-addressed) clip to a speakable file name inside the
 * same staging directory, because the sender only accepts files from there and
 * the recipient should not see a sha256 hash.
 */
export function readableVoiceFile(item, text) {
  const stem = String(text ?? '').replace(/[\\/:*?"<>|\s]+/g, '').replace(/[，。！？、；：,.]/g, '').slice(0, 10) || '鲸鲸语音';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = `${stem}-${stamp}-${String(item.path).split(/[\\/]/).pop().slice(0, 6)}.wav`;
  const target = path.join(path.dirname(item.path), name);
  try {
    if (!fs.existsSync(target)) fs.copyFileSync(item.path, target);
    return target;
  } catch { return item.path; }
}

/** Fire and forget playback through the Windows media player (no console window). */
export function playWav(file) {
  try {
    const { spawn } = process.getBuiltinModule('node:child_process');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `(New-Object Media.SoundPlayer '${String(file).replace(/'/g, "''")}').PlaySync()`],
      { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    return true;
  } catch { return false; }
}

export { sendText };
