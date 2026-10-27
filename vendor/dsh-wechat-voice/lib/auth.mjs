// Per-chat authorization, mirroring what the bot core already enforces:
// the chat must be in the account whitelist AND the tool must be granted for
// that conversation under wechat.dshAccess.chats[key].tools.

const RESERVED = new Set([
  'skill', 'web_search', 'web_reader_read', 'run_code', 'send_meme', 'learn_meme',
  'wechat_member_memory_read', 'wechat_member_memory_update', 'wechat_history_search',
]);
const CONTROL = /^(?:bash|shell|pwsh|powershell|terminal|exec_command|apply_patch|file|read_file|write_file|edit_file|agent|task|config|plugin|session|schedule|automation)(?:$|[_.:-])/i;

export const assignableTool = name =>
  typeof name === 'string' && name.length > 0 && name.length <= 120 && !RESERVED.has(name) && !CONTROL.test(name) && /^[\w.:-]{1,120}$/.test(name);

/** Whitelist check. Group and private ids are stored as decimal strings. */
export function conversationAllowed(config, kind, id) {
  const whitelist = config?.wechat?.whitelist ?? {};
  const list = kind === 'group' ? whitelist.groups : whitelist.private;
  if (!Array.isArray(list)) return false;
  return list.some(item => String(item) === String(id));
}

export function grantedTools(config, key) {
  const tools = config?.wechat?.dshAccess?.chats?.[key]?.tools;
  return Array.isArray(tools) ? tools.filter(assignableTool) : [];
}

const deny = (code, detail) => Object.assign(new Error(code), { code, detail });

/**
 * Throws a coded error when this tool must not run for the chat.
 * `strict` defaults to true: unlisted chats are refused rather than guessed.
 */
export function assertAccess({ config, chat, tool }) {
  if (!config) throw deny('CONFIG_UNAVAILABLE', 'config/wechatagent.json 读取失败');
  if (!chat) throw deny('CHAT_UNRESOLVED', '当前 DSH 会话没有绑定微信聊天，语音不能代发');
  if (!conversationAllowed(config, chat.kind, chat.id)) throw deny('CHAT_NOT_ALLOWED', `${chat.key} 不在聊天范围白名单内`);
  if (!assignableTool(tool)) throw deny('TOOL_NAME_INVALID', tool);
  const tools = grantedTools(config, chat.key);
  if (!tools.includes(tool)) throw deny('TOOL_NOT_GRANTED', `${chat.key} 未授权 ${tool}（WeChatAgent → 聊天范围 → 技能与工具）`);
  return chat;
}
