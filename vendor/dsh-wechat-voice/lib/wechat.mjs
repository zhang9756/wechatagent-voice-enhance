// WeChat side of the plugin: synthetic conversation id -> wxid, hook capability
// probing, and the two send calls (voice + the text fallback).
//
// The hook contract for voice (implemented in the native DLL next to
// /SendTextMsg and /SendStickerMsg):
//
//   POST /SendVoiceMsg
//   { "wxidorgid": "wxid_xxx", "path": "C:\\...\\x.silk",
//     "duration": 3200, "format": "silk" }
//   -> { "ret": 0, "retmsg": "accepted", "fields": {...} }
//
// `path` is the on-disk WeChat SILK file (0x02 + "#!SILK_V3" + frames). The
// native side rebuilds a type-34 voice message with VoiceFactory and hands it
// to the same dispatcher used by text, stickers and files. Verified on WeChat
// 4.1.10.27: the green bubble appears and plays.
//
// A missing route still makes every probe report unsupported, so the plugin
// never pretends a voice was delivered.

import crypto from 'node:crypto';

const onebotId = value => Number(crypto.createHash('sha256').update(String(value)).digest().readBigUInt64BE(0) % 2147483647n + 1n);

export const conversationId = (wxid, name, mappedId) => {
  if (mappedId !== undefined) {
    if (!/^[1-9]\d*$/.test(String(mappedId)) || !Number.isSafeInteger(Number(mappedId))) throw new Error('INVALID_CONVERSATION_ID');
    return Number(mappedId);
  }
  return onebotId(String(wxid).includes('@chatroom') ? (name || wxid).replace(/\s*\(\d+\)\s*$/, '').trim() : wxid);
};

async function json(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: response.status, ok: response.ok, body: parsed, text: text.slice(0, 400) };
}

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

/** Synthetic conversation id -> the real wxid the hook needs. */
export async function resolveTarget({ ioConfig, kind, id }) {
  const base = String(ioConfig?.reader_base_url ?? '').replace(/\/+$/, '');
  const token = String(ioConfig?.reader_token ?? '');
  if (!base || !token) throw coded('READER_CONFIG_MISSING');
  let result;
  try {
    result = await json(`${base}/api/v1/sessions?limit=500`, { headers: { Authorization: 'Bearer ' + token } });
  } catch (error) {
    throw coded('READER_UNAVAILABLE', { detail: String(error?.message ?? error).slice(0, 200) });
  }
  if (!result.ok || !Array.isArray(result.body?.sessions)) throw coded('READER_RESPONSE_INVALID', { status: result.status });
  const matches = result.body.sessions.filter(session => session?.username
    && (String(session.username).includes('@chatroom') ? 'group' : 'private') === kind
    && String(conversationId(session.username, session.displayName, session.conversationId)) === String(id));
  if (matches.length !== 1) throw coded('TARGET_MAPPING_AMBIGUOUS_OR_MISSING', { matches: matches.length });
  if (matches[0].username === ioConfig?.self_wxid) throw coded('TARGET_IS_SELF');
  return String(matches[0].username);
}

const authHeaders = credential => ({ Authorization: 'Bearer ' + credential.token });

/** Hook identity: account directory + core version, or a coded error. */
export async function hookIdentity({ credential, timeoutMs = 5000 }) {
  if (!credential?.token) throw coded('HOOK_TOKEN_MISSING');
  let result;
  try {
    result = await json(credential.baseUrl + '/WeChatAgent/health', { headers: authHeaders(credential), timeoutMs });
  } catch (error) {
    throw coded('HOOK_NOT_LISTENING', { detail: String(error?.message ?? error).slice(0, 200) });
  }
  if (!result.ok || !result.body) throw coded('HOOK_HEALTH_INVALID_RESPONSE', { status: result.status });
  const accounts = Array.isArray(result.body.databaseAccounts) ? result.body.databaseAccounts : [];
  if (accounts.length !== 1) throw coded('HOOK_ACCOUNT_AMBIGUOUS', { accounts: accounts.length });
  return { account: String(accounts[0]), version: String(result.body.version ?? ''), nativeStickerSend: result.body.nativeStickerSend === true, raw: result.body };
}

/**
 * Does the native sender accept voice? A 404 on the route is the definitive
 * "not implemented yet"; a 4xx/409 means the route exists and only the payload
 * was rejected.
 */
export async function probeVoiceRoute({ credential, timeoutMs = 5000 }) {
  if (!credential?.token) return { supported: false, reason: 'HOOK_TOKEN_MISSING' };
  try {
    const result = await json(credential.baseUrl + '/SendVoiceMsg', {
      method: 'POST', headers: authHeaders(credential), body: {}, timeoutMs,
    });
    if (result.status === 404) return { supported: false, reason: 'HOOK_VOICE_ROUTE_MISSING' };
    if (result.ok) return { supported: true, reason: '' };
    if ([400, 401, 403, 409, 415, 429].includes(result.status)) return { supported: true, reason: '', status: result.status };
    return { supported: false, reason: 'HOOK_VOICE_PROBE_UNEXPECTED', status: result.status };
  } catch (error) {
    return { supported: false, reason: 'HOOK_NOT_LISTENING', detail: String(error?.message ?? error).slice(0, 200) };
  }
}

export async function sendVoice({ credential, account, wxid, file, durationMs, format = 'silk', timeoutMs = 15000 }) {
  if (!/^(\d{1,20})$/.test(String(wxid ?? '').trim()) && !/^[\w@.-]{1,256}$/.test(String(wxid ?? ''))) throw coded('TARGET_INVALID');
  const headers = { ...authHeaders(credential), 'X-WeChatAgent-Account': account };
  let result;
  try {
    result = await json(credential.baseUrl + '/SendVoiceMsg', {
      method: 'POST', headers,
      body: { wxidorgid: wxid, path: file, duration: Math.max(0, Math.round(Number(durationMs) || 0)), format },
      timeoutMs,
    });
  } catch (error) {
    throw coded('VOICE_SEND_UNCONFIRMED', { detail: String(error?.message ?? error).slice(0, 200) });
  }
  if (result.status === 404) throw coded('HOOK_VOICE_ROUTE_MISSING');
  if (result.ok && result.body?.ret === 0) return { accepted: true, retmsg: String(result.body.retmsg ?? 'accepted') };
  throw coded('VOICE_SEND_REJECTED', { status: result.status, ret: result.body?.ret ?? null, text: result.text });
}

export async function sendText({ credential, account, wxid, text, timeoutMs = 10000 }) {
  const headers = { ...authHeaders(credential), 'X-WeChatAgent-Account': account };
  const result = await json(credential.baseUrl + '/SendTextMsg', {
    method: 'POST', headers, body: { wxidorgid: wxid, msg: String(text) }, timeoutMs,
  });
  if (result.ok && result.body?.ret === 0) return { accepted: true };
  throw coded('TEXT_SEND_REJECTED', { status: result.status, ret: result.body?.ret ?? null, text: result.text });
}

/**
 * Does the native sender accept a file (audio) message? Same probe shape as the
 * voice route: 404 means the route was never built, 4xx means it exists and only
 * rejected the empty payload.
 */
export async function probeFileRoute({ credential, timeoutMs = 5000 }) {
  if (!credential?.token) return { supported: false, reason: 'HOOK_TOKEN_MISSING' };
  try {
    const result = await json(credential.baseUrl + '/SendFileMsg', {
      method: 'POST', headers: authHeaders(credential), body: {}, timeoutMs,
    });
    if (result.status === 404) return { supported: false, reason: 'HOOK_FILE_ROUTE_MISSING' };
    if (result.ok) return { supported: true, reason: '' };
    if ([400, 401, 403, 409, 415, 429].includes(result.status)) return { supported: true, reason: '', status: result.status };
    return { supported: false, reason: 'HOOK_FILE_PROBE_UNEXPECTED', status: result.status };
  } catch (error) {
    return { supported: false, reason: 'HOOK_NOT_LISTENING', detail: String(error?.message ?? error).slice(0, 200) };
  }
}

/**
 * Send a staged audio file as a WeChat file message. This is the fallback when
 * the client cannot send a real voice bubble: the recipient taps the file and
 * WeChat plays it, but it is a file card, not a green voice message.
 */
export async function sendFile({ credential, account, wxid, file, timeoutMs = 20000 }) {
  if (!/^[\w@.-]{1,256}$/.test(String(wxid ?? ''))) throw coded('TARGET_INVALID');
  const headers = { ...authHeaders(credential), 'X-WeChatAgent-Account': account };
  let result;
  try {
    result = await json(credential.baseUrl + '/SendFileMsg', {
      method: 'POST', headers, body: { wxidorgid: wxid, path: file }, timeoutMs,
    });
  } catch (error) {
    throw coded('FILE_SEND_UNCONFIRMED', { detail: String(error?.message ?? error).slice(0, 200) });
  }
  if (result.status === 404) throw coded('HOOK_FILE_ROUTE_MISSING');
  if (result.ok && result.body?.ret === 0) return { accepted: true, retmsg: String(result.body.retmsg ?? 'accepted') };
  throw coded('FILE_SEND_REJECTED', { status: result.status, ret: result.body?.ret ?? null, text: result.text });
}
