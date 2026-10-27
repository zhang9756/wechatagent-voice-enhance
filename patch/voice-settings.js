// 语音音色（本地自定义页面）
// 读取并修改 state/voice/chats.json 与 state/voice/config.json，
// 让每个微信聊天都能单独指定 Fish Audio 音色，不必再去翻 JSON 或命令行。
export function createVoiceUI({api,state,escapeHtml:esc,icon,renderPage,toast}) {
  const FISH = /^[a-f0-9]{32}$/i;
  // 火山引擎使用模型 ID（任意字符串），fish 才要求 32 位十六进制。
  const isValidVoice = (voice, engine) => {
    if (!voice) return true;
    if (engine === 'volc') return true;
    return FISH.test(voice);
  };
  let data = null, sequence = 0, busy = '', logs = [];
  const CHAT_PREFIX = /^wechat:(private|group):([0-9]{1,20})$/;
  const chatKey = (kind, id) => `wechat:${kind === 'group' ? 'group' : 'private'}:${id}`;
  const chatLabel = key => state.names?.get(key) ?? (key.includes(':group:') ? '群聊 · ' : '好友 · ') + key.split(':').pop();
  const engineLabel = value => ({fish:'Fish Audio',volc:'火山引擎',edge:'Edge 语音',baidu:'百度在线',sapi:'本机 SAPI'}[value] ?? value ?? '跟随默认');

  function rows() {
    if (!data) return [];
    const whitelist = state.draft?.wechat?.whitelist ?? state.config?.wechat?.whitelist ?? {private:[],groups:[]};
    const seen = new Set();
    const list = [];
    for (const id of whitelist.private ?? []) { const key = chatKey('private', id); seen.add(key); list.push(key); }
    for (const id of whitelist.groups ?? []) { const key = chatKey('group', id); seen.add(key); list.push(key); }
    for (const key of Object.keys(data.chats ?? {})) if (!seen.has(key) && CHAT_PREFIX.test(key)) { seen.add(key); list.push(key); }
    return list;
  }

  function chatRow(key) {
    const saved = data.chats?.[key] ?? null;
    const voice = saved?.voice ?? '';
    const engine = saved?.engine ?? data.defaults.engine ?? '';
    const effective = voice || data.defaults.voice || '';
    const isDefault = !saved;
    return `<tr data-voice-row="${esc(key)}">
      <td><div class="name-cell"><span class="avatar">${esc(chatLabel(key).slice(0,1))}</span><div><strong>${esc(chatLabel(key))}</strong><small class="mono">${esc(key)}</small></div></div></td>
      <td><span class="status-tag ${isDefault ? '' : 'ok'}">${isDefault ? '跟随全局默认' : '本聊天专属'}</span></td>
      <td><input class="mono" data-voice-input="${esc(key)}" type="text" value="${esc(voice)}" maxlength="64" placeholder="${esc(data.defaults.voice || '留空则跟随默认音色')}" aria-label="${esc(chatLabel(key))} 的音色 ID"></td>
      <td><select data-voice-engine="${esc(key)}" aria-label="${esc(chatLabel(key))} 的语音引擎">${['fish','volc','edge','baidu','sapi'].map(name => `<option value="${name}" ${engine === name ? 'selected' : ''}>${engineLabel(name)}</option>`).join('')}</select></td>
      <td><span class="subtle" data-voice-effective="${esc(key)}">${esc(effective || '尚未设置')}</span></td>
      <td class="row-actions"><div class="button-row"><button class="button small" data-voice-preview="${esc(key)}">${icon('play')}试听</button><button class="button small danger" data-voice-reset="${esc(key)}" ${isDefault ? 'disabled' : ''}>恢复默认</button></div></td>
    </tr>`;
  }

  async function page() {
    const request = ++sequence;
    try {
      data = await api('/api/voice');
      const history = await api('/api/voice/logs');
      logs = history?.lines ?? [];
    }
    catch (error) {
      if (request !== sequence) return '';
      return `<section class="card">${icon('info')}<div class="empty-state"><h3>暂时无法读取语音设置</h3><p>${esc(error.message)}</p><button class="button" data-voice-refresh>重试</button></div></section>`;
    }
    if (request !== sequence) return '';
    const list = rows();
    let volc = { available: false, data: null };
    try { volc = await api('/api/voice/volc'); } catch { volc = { available: false }; }
    if (request !== sequence) return '';
    const route = data.route ?? {};
    const routeTag = route.supported
      ? '<span class="status-tag ok">原生语音条可用</span>'
      : `<span class="status-tag warn">${esc(route.reason || '语音通道不可用')}</span>`;
    const table = list.length
      ? `<div class="table-wrap"><table><thead><tr><th>聊天</th><th>状态</th><th>音色 ID</th><th>引擎</th><th>当前生效</th><th class="row-actions">操作</th></tr></thead><tbody>${list.map(chatRow).join('')}</tbody></table></div>`
      : `<div class="empty-state">${icon('users')}<h3>还没有允许的聊天</h3><p>先在“聊天”里添加好友或群聊，再回来给它们单独指定音色。</p><a class="button" href="#chats">管理聊天</a></div>`;
    return `<div class="section-stack">
      <section class="card">
        <div class="card-header"><div class="section-label"><span class="section-icon">${icon('send')}</span><div><h2>换音色</h2><p class="card-description">选一个聊天，填入音色 ID，点“应用”即可，下一条语音立刻用新音色。</p></div></div></div>
        <div class="form-grid">
          <div class="field"><label for="voice-quick-chat">目标聊天</label><select id="voice-quick-chat">${list.map(key => `<option value="${esc(key)}">${esc(chatLabel(key))}</option>`).join('')}</select><small>只列出已允许的好友和群聊。</small></div>
          <div class="field"><label for="voice-quick-id">音色 ID</label><input id="voice-quick-id" class="mono" type="text" maxlength="64" placeholder="Fish 填 32 位音色 ID / 火山填模型 ID（如 BV001_streaming）"><small>填 Fish Audio 的引用 ID；留空表示这个聊天跟随全局默认。</small></div>
        </div>
        <div class="button-row space-top">
          <button class="button primary" data-voice-quick-apply>${icon('check')}应用</button>
          <button class="button" data-voice-quick-preview>${icon('play')}先试听</button>
          <select id="voice-quick-engine" class="table-select">${['fish','volc','edge','baidu','sapi'].map(name => `<option value="${name}" ${data.defaults.engine === name ? 'selected' : ''}>${engineLabel(name)}</option>`).join('')}</select>
        </div>
      </section>
      <section class="card">
        <div class="card-header"><div class="section-label"><span class="section-icon">${icon('chat')}</span><div><h2>合成语音并发送</h2><p class="card-description">输入文字，选好聊天和音色，直接合成语音条发给对方。</p></div></div></div>
        <div class="field full"><label for="voice-send-text">要说的内容</label><textarea id="voice-send-text" maxlength="300" placeholder="比如：主人，语音条修好了，你听听看。"></textarea><small><span id="voice-send-count">0</span> / 300 字 · 换行会被读成停顿，Markdown 和表情符号不会被朗读。</small></div>
        <div class="form-grid space-top">
          <div class="field"><label for="voice-send-chat">发送给</label><select id="voice-send-chat">${list.map(key => `<option value="${esc(key)}">${esc(chatLabel(key))}</option>`).join('')}</select><small>好友按数字 ID 发送，群聊自动带上 @chatroom。</small></div>
          <div class="field"><label for="voice-send-id">音色 ID</label><input id="voice-send-id" class="mono" type="text" maxlength="64" placeholder="留空 = 用这个聊天已保存的音色"><small>留空就用“按聊天设置”里保存的音色。</small></div>
          <div class="field"><label for="voice-send-engine">引擎</label><select id="voice-send-engine">${['fish','volc','edge','baidu','sapi'].map(name => `<option value="${name}" ${data.defaults.engine === name ? 'selected' : ''}>${engineLabel(name)}</option>`).join('')}</select><small>留空音色时以该聊天记录里的引擎为准。</small></div>
        </div>
        <div class="button-row space-top">
          <button class="button primary" data-voice-send>${icon('send')}合成并发送</button>
          <button class="button" data-voice-send-preview>${icon('play')}先试听</button>
          <span class="subtle" id="voice-send-status" role="status"></span>
        </div>
      </section>
      <section class="card">
        <div class="card-header"><div class="section-label"><span class="section-icon">${icon('sliders')}</span><div><h2>语音通道</h2><p class="card-description">当前引擎：${esc(engineLabel(data.defaults.engine))} · 全局默认音色：<span class="mono">${esc(data.defaults.voice || '未设置')}</span></p></div></div><div class="button-row">${routeTag}<button class="button small" data-voice-refresh>${icon('refresh')}刷新</button></div></div>
        ${data.route?.message ? `<p class="scope-note">${esc(data.route.message)}</p>` : `<p class="scope-note">聊天单独设置的音色优先于全局默认；留空或点“恢复默认”就会回到默认音色。音色 ID 为 Fish Audio 的 32 位十六进制引用 ID。</p>`}
      </section>
      ${volc.available && volc.data?.models?.length ? `<section class="card">
        <div class="card-header"><div class="section-label"><span class="section-icon">${icon('tool')}</span><div><h2>火山引擎模型</h2><p class="card-description">当前合成模型：<strong>${esc(volc.data.model || '未设置')}</strong> · 切换后对所有合成立即生效。</p></div></div></div>
        <div class="form-grid">
          <div class="field"><label for="voice-volc-model">合成模型</label><select id="voice-volc-model">${volc.data.models.map(m => `<option value="${esc(m.id)}" ${m.id === volc.data.model ? 'selected' : ''}>${esc(m.label || m.id)}</option>`).join('')}</select><small>模型定义在代理配置 volc-config.json 的 models 字段中；声音风格仍由“音色 ID → 声音描述”映射决定。</small></div>
        </div>
        <div class="button-row space-top"><button class="button primary" data-voice-volc-save>${icon('check')}保存模型</button></div>
      </section>` : ''}
      <section class="card">
        <div class="card-header"><div class="section-label"><span class="section-icon">${icon('users')}</span><div><h2>按聊天设置音色</h2><p class="card-description">每行填入音色 ID 后保存，下一条语音立即生效，不需要重启服务。</p></div></div><div class="button-row"><button class="button primary" data-voice-save>保存全部</button></div></div>
        ${table}
      </section>
      <section class="card">
        <div class="card-header"><div class="section-label"><span class="section-icon">${icon('info')}</span><div><h2>全局默认音色</h2><p class="card-description">没有单独设置的聊天都会用它。</p></div></div></div>
        <div class="form-grid">
          <div class="field"><label for="voice-default-id">默认音色 ID</label><input id="voice-default-id" class="mono" type="text" maxlength="64" value="${esc(data.defaults.voice || '')}" placeholder="32 位十六进制音色 ID"><small>修改后点“保存默认音色”，对所有未单独设置的聊天生效。</small></div>
          <div class="field"><label for="voice-default-engine">引擎</label><select id="voice-default-engine">${['fish','volc','edge','baidu','sapi'].map(name => `<option value="${name}" ${data.defaults.engine === name ? 'selected' : ''}>${engineLabel(name)}</option>`).join('')}</select><small>换音色前请确认引擎与音色 ID 类型一致。</small></div>
        </div>
        <div class="button-row space-top"><button class="button" data-voice-save-default>保存默认音色</button><button class="button" data-voice-refresh>${icon('refresh')}重新读取</button></div>
      </section>
      <section class="card">
        <div class="card-header"><div class="section-label"><span class="section-icon">${icon('history')}</span><div><h2>最近发送</h2><p class="card-description">从本页面发出去的语音，成功和失败都会记在这里。</p></div></div><div class="button-row"><button class="button small" data-voice-log-refresh>${icon('refresh')}刷新</button></div></div>
        <div id="voice-send-log">${logTable(logs)}</div>
      </section>
    </div>`;
  }

  function logTable(logs) {
    if (!logs?.length) return '<p class="subtle">还没有从这个页面发过语音。</p>';
    const rows = logs.map(line => {
      const m = /^(\S+) (OK|FAIL) key=(\S+) target=(\S+) engine=(\S+) voice=(\S+) (.*)$/.exec(line);
      if (!m) return `<tr><td colspan="6" class="mono">${esc(line.slice(0, 160))}</td></tr>`;
      const rest = m[7] ?? '';
      const ms = /ms=(\d+)/.exec(rest);
      const chars = /chars=(\d+)/.exec(rest);
      const detail = /detail=(.*)$/.exec(rest);
      const at = new Date(m[1]);
      const when = Number.isNaN(at.getTime()) ? m[1] : at.toLocaleString('zh-CN', { hour12: false });
      return `<tr>
        <td><span class="status-tag ${m[2] === 'OK' ? 'ok' : 'error'}">${m[2] === 'OK' ? '已发送' : '失败'}</span></td>
        <td>${esc(chatLabel(m[3]))}<small class="mono"> ${esc(m[4])}</small></td>
        <td>${esc(engineLabel(m[5]))}</td>
        <td class="mono">${esc(m[6].slice(0, 8))}…</td>
        <td>${ms ? (Number(ms[1]) / 1000).toFixed(1) + ' 秒' : '—'}${chars ? ' · ' + chars[1] + ' 字' : ''}</td>
        <td class="subtle">${when}${detail ? ' · ' + esc(detail[1].slice(0, 60)) : ''}</td>
      </tr>`;
    }).join('');
    return `<div class="table-wrap"><table><thead><tr><th>结果</th><th>发送给</th><th>引擎</th><th>音色</th><th>时长</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function mount() {
    const text = document.getElementById('voice-send-text');
    const count = document.getElementById('voice-send-count');
    if (text && count) {
      const paint = () => { count.textContent = String(text.value.length); };
      text.addEventListener('input', paint);
      paint();
    }
  }

  const sendFields = () => ({
    key: document.getElementById('voice-send-chat')?.value ?? '',
    text: document.getElementById('voice-send-text')?.value ?? '',
    voice: document.getElementById('voice-send-id')?.value.trim() ?? '',
    engine: document.getElementById('voice-send-engine')?.value ?? 'fish',
  });

  function sendStatus(message) {
    const el = document.getElementById('voice-send-status');
    if (el) el.textContent = message;
  }

  async function composeAndSend() {
    const { key, text, voice, engine } = sendFields();
    const body = text.trim();
    if (!body) { toast('先写点要说的话'); return; }
    if (voice && !isValidVoice(voice, engine)) { toast(engine === 'volc' ? '火山引擎音色/模型 ID 不能为空' : '音色 ID 应为 32 位十六进制字符'); return; }
    sendStatus('正在合成…');
    try {
      const result = await api('/api/voice/send', { key, text: body, voice, engine });
      sendStatus('已发送 · ' + (result.durationMs / 1000).toFixed(1) + ' 秒 · ' + engineLabel(result.engine));
      toast('语音已发给 ' + chatLabel(key));
      try {
        const history = await api('/api/voice/logs');
        logs = history?.lines ?? logs;
        const box = document.getElementById('voice-send-log');
        if (box) box.innerHTML = logTable(logs);
      } catch { /* 日志刷新失败不影响发送结果 */ }
    } catch (error) {
      sendStatus('发送失败');
      toast(error.message);
    }
  }

  async function composeAndPreview() {
    const { key, text, voice, engine } = sendFields();
    const body = text.trim() || '这是音色试听。';
    if (voice && !FISH.test(voice)) { toast('音色 ID 应为 32 位十六进制字符'); return; }
    sendStatus('正在合成试听…');
    try {
      const result = await api('/api/voice/preview', { key, text: body, voice, engine });
      if (result.url) { const audio = new Audio(result.url); await audio.play().catch(() => {}); sendStatus('试听播放中 · ' + engineLabel(result.engine)); toast(fallbackTip(result)); }
      else { sendStatus('试听失败'); toast('试听完成，但没有返回音频。'); }
    } catch (error) { sendStatus('试听失败'); toast(error.message); }
  }

  async function saveChat(key) {
    const input = document.querySelector(`[data-voice-input="${key}"]`);
    const engine = document.querySelector(`[data-voice-engine="${key}"]`);
    if (!input) return;
    const voice = input.value.trim();
    if (voice && !isValidVoice(voice, engine?.value ?? 'fish')) { input.reportValidity?.(); toast(engine?.value === 'volc' ? '火山引擎音色/模型 ID 不能为空' : '音色 ID 应为 32 位十六进制字符'); return; }
    busy = key; toast('正在保存…');
    try {
      data = await api('/api/voice/chat', { key, voice, engine: engine?.value ?? 'fish' });
      toast(voice ? '这个聊天的音色已保存' : '已恢复跟随默认音色');
      await renderPage();
    } catch (error) { toast(error.message); }
    finally { busy = ''; }
  }

  async function saveDefault() {
    const voice = document.getElementById('voice-default-id')?.value.trim() ?? '';
    const engine = document.getElementById('voice-default-engine')?.value ?? 'fish';
    if (voice && !isValidVoice(voice, engine)) { toast(engine === 'volc' ? '火山引擎音色/模型 ID 不能为空' : '音色 ID 应为 32 位十六进制字符'); return; }
    try {
      data = await api('/api/voice/default', { voice, engine });
      toast('默认音色已保存');
      await renderPage();
    } catch (error) { toast(error.message); }
  }

  const fallbackTip = result => result.fallbackReason
    ? '音色不可用（' + result.fallbackReason.replace(/^HTTP \d+ [^ ]* /, '').slice(0, 60) + '），已用 Edge 试听'
    : '试听已开始';

  async function preview(key) {
    const input = document.querySelector(`[data-voice-input="${key}"]`);
    const engine = document.querySelector(`[data-voice-engine="${key}"]`)?.value ?? 'fish';
    const voice = input?.value.trim() ?? '';
    if (voice && !isValidVoice(voice, engine)) { toast(engine === 'volc' ? '火山引擎音色/模型 ID 不能为空' : '音色 ID 应为 32 位十六进制字符'); return; }
    toast('正在合成试听…');
    try {
      const result = await api('/api/voice/preview', { key, voice, engine: document.querySelector(`[data-voice-engine="${key}"]`)?.value ?? 'fish' });
      if (result.url) { const audio = new Audio(result.url); await audio.play().catch(() => {}); toast(fallbackTip(result)); }
      else toast('试听完成，但没有返回音频地址');
    } catch (error) { toast(error.message); }
  }

  function click(button) {
    if (button.hasAttribute('data-voice-refresh')) { void renderPage(); return true; }
    if (button.hasAttribute('data-voice-save')) {
      const keys = [...document.querySelectorAll('[data-voice-input]')].map(el => el.dataset.voiceInput);
      void (async () => {
        for (const key of keys) {
          const input = document.querySelector(`[data-voice-input="${key}"]`);
          if (!input) continue;
          const voice = input.value.trim();
          const engine = document.querySelector(`[data-voice-engine="${key}"]`)?.value ?? 'fish';
          if (voice && !isValidVoice(voice, engine)) { toast(engine === 'volc' ? '火山引擎音色/模型 ID 不能为空' : '有音色 ID 格式不正确，已停在那一行'); input.focus(); return; }
        }
        for (const key of keys) {
          const input = document.querySelector(`[data-voice-input="${key}"]`);
          if (!input) continue;
          try { await api('/api/voice/chat', { key, voice: input.value.trim(), engine: document.querySelector(`[data-voice-engine="${key}"]`)?.value ?? 'fish' }); }
          catch (error) { toast('保存 ' + chatLabel(key) + ' 失败：' + error.message); return; }
        }
        toast('全部聊天的音色已保存');
        await renderPage();
      })();
      return true;
    }
    if (button.hasAttribute('data-voice-save-default')) { void saveDefault(); return true; }
    if (button.hasAttribute('data-voice-quick-apply')) {
      const key = document.getElementById('voice-quick-chat')?.value ?? '';
      const voice = document.getElementById('voice-quick-id')?.value.trim() ?? '';
      const engine = document.getElementById('voice-quick-engine')?.value ?? 'fish';
      if (voice && !isValidVoice(voice, engine)) { toast(engine === 'volc' ? '火山引擎音色/模型 ID 不能为空' : '音色 ID 应为 32 位十六进制字符'); return true; }
      void (async () => {
        try {
          data = await api('/api/voice/chat', { key, voice, engine });
          toast(voice ? chatLabel(key) + ' 的音色已换好' : chatLabel(key) + ' 已恢复默认音色');
          await renderPage();
        } catch (error) { toast(error.message); }
      })();
      return true;
    }
    if (button.hasAttribute('data-voice-quick-preview')) {
      const key = document.getElementById('voice-quick-chat')?.value ?? '';
      const voice = document.getElementById('voice-quick-id')?.value.trim() ?? '';
      const engine = document.getElementById('voice-quick-engine')?.value ?? 'fish';
      if (!voice) { toast('先填一个音色 ID 再试听'); return true; }
      if (!isValidVoice(voice, engine)) { toast(engine === 'volc' ? '火山引擎音色/模型 ID 不能为空' : '音色 ID 应为 32 位十六进制字符'); return true; }
      void (async () => {
        toast('正在合成试听…');
        try {
          const result = await api('/api/voice/preview', { key, voice, engine, text: '这是新音色的试听。' });
          if (result.url) { const audio = new Audio(result.url); await audio.play().catch(() => {}); toast(fallbackTip(result)); }
          else toast('试听完成，但没有返回音频。');
        } catch (error) { toast(error.message); }
      })();
      return true;
    }
    if (button.hasAttribute('data-voice-log-refresh')) { void renderPage(); return true; }
    if (button.hasAttribute('data-voice-volc-save')) {
      const model = document.getElementById('voice-volc-model')?.value ?? '';
      if (!model) { toast('请选择模型'); return true; }
      void (async () => {
        toast('正在保存模型…');
        try {
          const result = await api('/api/voice/volc', { model });
          if (!result?.available) { toast('火山代理不可用，请先启动 start-volc-proxy.bat'); return; }
          toast('火山引擎模型已切换为 ' + model);
          await renderPage();
        } catch (error) { toast(error.message); }
      })();
      return true;
    }
    if (button.hasAttribute('data-voice-send')) { void composeAndSend(); return true; }
    if (button.hasAttribute('data-voice-send-preview')) { void composeAndPreview(); return true; }
    if (button.dataset.voicePreview) { void preview(button.dataset.voicePreview); return true; }
    if (button.dataset.voiceReset) { const input = document.querySelector(`[data-voice-input="${button.dataset.voiceReset}"]`); if (input) input.value = ''; void saveChat(button.dataset.voiceReset); return true; }
    return false;
  }

  return {page, mount, click};
}
