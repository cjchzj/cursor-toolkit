(function () {
  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('token') || '';
  const EMBED = params.get('embed') === '1';
  const PANEL = params.get('panel') === '1';
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const pending = document.getElementById('pending');
  const sendButton = document.getElementById('send');
  const stopButton = document.getElementById('stop');
  const modelSelect = document.getElementById('model');
  const chatSelect = document.getElementById('chat-select');
  const chatMode = document.getElementById('chat-mode');
  const sheet = document.getElementById('sheet');
  const sheetTitle = document.getElementById('sheet-title');
  const sheetChats = document.getElementById('sheet-chats');
  const sheetLibrary = document.getElementById('sheet-library');
  const sheetKeys = document.getElementById('sheet-keys');
  const chatList = document.getElementById('chat-list');
  let since = -1;
  let historyVersion = -1;
  let streaming = false;
  let abort = null;
  let attachmentKey = '';
  let attachments = [];
  let modelKey = '';
  let chatsKey = '';
  let libraryKind = 'skills';
  let library = { plugins: [], skills: [], note: '' };
  if (EMBED) document.body.classList.add('embed');
  else if (PANEL) {
    document.body.classList.add('panel');
  } else {
    document.body.classList.add('float');
  }

  document.getElementById('bar').addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    if (EMBED) {
      const bar = event.currentTarget;
      bar.setPointerCapture(event.pointerId);
      parent.postMessage({ source: 'ctk', type: 'dragstart', sx: event.screenX, sy: event.screenY }, '*');
      function move(next) {
        parent.postMessage({ source: 'ctk', type: 'drag', sx: next.screenX, sy: next.screenY }, '*');
      }
      function up() {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        parent.postMessage({ source: 'ctk', type: 'dragend' }, '*');
      }
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      return;
    }
    if (!PANEL) postJson('/api/window', { action: 'drag' }).catch(() => {});
  });

  document.getElementById('win-min').addEventListener('click', () => postJson('/api/window', { action: 'min' }));
  document.getElementById('win-max').addEventListener('click', async () => {
    const result = await postJson('/api/window', { action: 'max' }).catch(() => ({}));
    document.getElementById('win-max').classList.toggle('restored', Boolean(result.maximized));
  });
  document.getElementById('win-close').addEventListener('click', () => postJson('/api/window', { action: 'close' }));
  document.getElementById('chat-new').addEventListener('click', () => {
    closeSheet();
    changeChat('new');
  });
  document.getElementById('chat-pick').addEventListener('click', () => openSheet('chats'));
  document.getElementById('rail-skills').addEventListener('click', () => openSheet('library', 'skills'));
  document.getElementById('rail-plugins').addEventListener('click', () => openSheet('library', 'plugins'));
  document.getElementById('settings-btn').addEventListener('click', () => openSheet('keys'));
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheet.hidden) {
      event.preventDefault();
      closeSheet();
    }
  });
  chatSelect.addEventListener('change', () => changeChat('select', chatSelect.value));
  document.getElementById('shot').addEventListener('click', () => shot());
  document.getElementById('file').addEventListener('click', () => document.getElementById('picker').click());
  document.getElementById('picker').addEventListener('change', uploadPicked);
  document.getElementById('save-keys').addEventListener('click', saveKeys);
  document.getElementById('library-search').addEventListener('input', renderLibrary);
  stopButton.addEventListener('click', () => abort?.abort());
  document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  });

  watch();

  function api(pathname) {
    const url = new URL(pathname, location.origin);
    url.searchParams.set('token', TOKEN);
    return url;
  }

  async function watch() {
    for (;;) {
      try {
        const data = await getJson(`/api/state?since=${since}`);
        since = data.v;
        applyState(data);
      } catch {
        await sleep(800);
      }
    }
  }

  function applyState(data) {
    renderUsage(data.usage);
    if (data.library) {
      library = data.library;
      renderLibrary();
    }
    if (Array.isArray(data.models)) fillModels(data.models, data.selectedModel);
    if (data.shortcuts) {
      setKey('key-region', data.shortcuts.scroll || 'alt+9');
      setKey('key-float', data.shortcuts.float);
    }
    syncAttachments(data.attachments || []);
    if (data.chats) {
      fillChats(data.chats);
      const fill = document.getElementById('token-fill');
      if (Number(data.chats.tokensUsed) > 0) {
        fill.dataset.lock = '1';
        renderTokenBar(data.chats.tokensUsed, data.chats.tokenLimit);
      } else {
        fill.dataset.lock = '0';
      }
    }
    if (!streaming && data.historyVersion !== historyVersion) {
      historyVersion = data.historyVersion;
      loadHistory();
    }
  }

  function fillChats(chats) {
    const list = Array.isArray(chats.list) ? chats.list : [];
    const key = `${chats.currentId || ''}|${list.map((item) => `${item.id}:${item.origin}:${item.title}:${item.fresh ? 1 : 0}`).join(',')}`;
    if (key === chatsKey) {
      updateChatMode(chats);
      return;
    }
    chatsKey = key;
    const current = chats.currentId || '';
    chatSelect.replaceChildren();
    chatList.replaceChildren();
    if (!list.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '还没有对话';
      chatSelect.append(option);
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '没有读到 Cursor 对话。打开 Cursor 后再试，或点左侧 + 新建工作台会话。';
      chatList.append(empty);
    }
    let lastOrigin = '';
    for (const item of list) {
      if (item.origin !== lastOrigin) {
        lastOrigin = item.origin || 'local';
        const heading = document.createElement('div');
        heading.className = 'library-heading';
        heading.textContent = lastOrigin === 'cursor' ? 'Cursor 对话' : '工作台';
        chatList.append(heading);
      }
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title || '未命名对话';
      chatSelect.append(option);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `chat-item${item.id === current ? ' active' : ''}`;
      row.textContent = item.title || '未命名对话';
      if (item.mode) {
        const mark = document.createElement('small');
        mark.textContent = item.origin === 'cursor' ? (item.mode === 'chat' ? 'Chat' : 'Agent') : '本地';
        row.append(mark);
      }
      row.addEventListener('click', () => {
        changeChat('select', item.id);
        closeSheet();
      });
      chatList.append(row);
    }
    if ([...chatSelect.options].some((option) => option.value === current)) chatSelect.value = current;
    updateChatMode(chats);
  }

  function openSheet(kind, nextKind) {
    libraryKind = nextKind || libraryKind;
    sheet.hidden = false;
    sheetChats.hidden = kind !== 'chats';
    sheetLibrary.hidden = kind !== 'library';
    sheetKeys.hidden = kind !== 'keys';
    sheetTitle.textContent = kind === 'chats' ? '选择对话' : kind === 'library' ? (libraryKind === 'plugins' ? '插件' : '技能') : '设置';
    chatMode.hidden = kind !== 'chats';
    document.getElementById('chat-pick').classList.toggle('active', kind === 'chats');
    document.getElementById('rail-skills').classList.toggle('active', kind === 'library' && libraryKind === 'skills');
    document.getElementById('rail-plugins').classList.toggle('active', kind === 'library' && libraryKind === 'plugins');
    document.getElementById('settings-btn').classList.toggle('active', kind === 'keys');
    if (kind === 'library') renderLibrary();
  }

  function closeSheet() {
    sheet.hidden = true;
    document.getElementById('chat-pick').classList.remove('active');
    document.getElementById('rail-skills').classList.remove('active');
    document.getElementById('rail-plugins').classList.remove('active');
    document.getElementById('settings-btn').classList.remove('active');
  }

  function updateChatMode(chats) {
    const current = (chats.list || []).find((item) => item.id === chats.currentId);
    if (!current) {
      chatMode.textContent = '当前：尚未选择对话。';
      return;
    }
    if (current.origin === 'cursor') {
      chatMode.textContent = `当前：Cursor ${current.mode === 'chat' ? 'Chat' : 'Agent'}「${current.title}」`;
      return;
    }
    if (current.fresh) chatMode.textContent = '当前：工作台本地会话（还没有消息）';
    else chatMode.textContent = `当前：工作台「${current.title}」`;
  }

  async function changeChat(action, id) {
    try {
      const result = await postJson('/api/chats', { action, id });
      if (result.chats) fillChats(result.chats);
      historyVersion = -1;
      await loadHistory();
    } catch (error) {
      chatMode.textContent = error.message || '切换对话失败';
    }
  }

  function renderLibrary() {
    const list = document.getElementById('library-list');
    const note = document.getElementById('library-note');
    const query = document.getElementById('library-search').value.trim().toLowerCase();
    note.textContent = library.note || (libraryKind === 'plugins' ? '插件切换需重启 Cursor。' : '技能在下一次对话生效。');
    list.replaceChildren();
    if (libraryKind === 'plugins') addLibrarySection(list, '插件', library.plugins || [], query);
    else addLibrarySection(list, '技能', library.skills || [], query);
  }

  function addLibrarySection(root, title, items, query) {
    const filtered = items.filter((item) => !query || `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(query));
    if (!filtered.length) return;
    const heading = document.createElement('div');
    heading.className = 'library-heading';
    heading.textContent = title;
    root.append(heading);
    for (const item of filtered) {
      const row = document.createElement('div');
      row.className = 'library-item';
      const copy = document.createElement('div');
      copy.className = 'library-copy';
      const name = document.createElement('b');
      name.textContent = item.name || '未命名';
      const desc = document.createElement('small');
      desc.textContent = [item.source, item.description].filter(Boolean).join(' · ');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'switch';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-label', `${item.enabled ? '关闭' : '开启'} ${item.name}`);
      toggle.setAttribute('aria-checked', String(Boolean(item.enabled)));
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await postJson('/api/library/toggle', { kind: item.kind, id: item.id, enabled: !item.enabled });
        } catch (error) {
          note.textContent = error.message || '切换失败';
        } finally {
          toggle.disabled = false;
        }
      });
      copy.append(name, desc);
      row.append(copy, toggle);
      root.append(row);
    }
  }

  function renderUsage(usage) {
    const meta = document.getElementById('usage-meta');
    setUsageBar('grok', usage?.grok);
    setUsageBar('other', usage?.other);
    if (!usage) {
      meta.textContent = '正在读取额度…';
      return;
    }
    if (!usage.ok) {
      meta.textContent = usage.error || '额度暂时不可用';
      return;
    }
    const parts = [];
    const plan = usage.plan || (usage.unlimited ? '无限额度' : '');
    if (plan) parts.push(plan);
    if (usage.last) {
      const cost = usage.last.cents == null ? '金额未知' : money(usage.last.cents);
      parts.push(`上次 ${usage.last.model || '模型'} · ${cost} · ${tokenText(usage.last)}`);
    } else {
      parts.push('上次对话暂无记录');
    }
    if (usage.resetsAt) parts.push(`重置 ${when(usage.resetsAt)}`);
    else if (usage.updatedAt) parts.push(`更新 ${when(usage.updatedAt)}`);
    meta.textContent = parts.join(' · ');
    meta.title = meta.textContent;
  }

  function renderToken() {
    const fill = document.getElementById('token-fill');
    const label = document.getElementById('token-label');
    if (fill.dataset.lock === '1') return;
    const text = [...log.querySelectorAll('.msg')].map((node) => node.textContent).join('');
    const used = Math.ceil(text.length / 1.5);
    renderTokenBar(used, 256000);
  }

  function renderTokenBar(used, limit) {
    const fill = document.getElementById('token-fill');
    const label = document.getElementById('token-label');
    const cap = Number(limit) > 0 ? Number(limit) : 256000;
    const n = Math.max(0, Number(used) || 0);
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, n / cap))})`;
    label.textContent = `${formatK(n)} / ${formatK(cap).replace(/\.0$/, '') === '256k' ? '256k' : formatK(cap)}`;
    if (cap === 256000) label.textContent = `${formatK(n)} / 256k`;
  }

  function setUsageBar(name, value) {
    const fill = document.getElementById(`usage-${name}`);
    const text = document.getElementById(`usage-${name}-text`);
    const number = value == null || Number.isNaN(Number(value)) ? null : Math.max(0, Math.min(100, Number(value)));
    fill.style.transform = `scaleX(${number == null ? 0 : number / 100})`;
    fill.classList.toggle('warn', number != null && number >= 70 && number < 90);
    fill.classList.toggle('hot', number != null && number >= 90);
    text.textContent = number == null ? '—' : `${Math.round(number)}%`;
  }

  function setKey(id, value) {
    const field = document.getElementById(id);
    if (document.activeElement === field) return;
    const next = value || '';
    if (field.value !== next) field.value = next;
  }

  function fillModels(models, selected) {
    const key = models.map((model) => model.id).join('|');
    if (key === modelKey) return;
    modelKey = key;
    const current = modelSelect.value || selected || '';
    modelSelect.replaceChildren();
    if (!models.length) {
      modelSelect.hidden = true;
      return;
    }
    modelSelect.hidden = true;
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name || model.id;
      modelSelect.append(option);
    }
    if ([...modelSelect.options].some((option) => option.value === current)) modelSelect.value = current;
  }

  async function loadHistory() {
    try {
      const data = await getJson('/api/history');
      if (streaming) return;
      renderMessages(data.messages || []);
    } catch {
      /* the next refresh will try again */
    }
  }

  function renderMessages(messages) {
    log.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '这是 Cursor 里的对话。选左侧列表继续，或点 + 开一个工作台会话。';
      log.append(empty);
      renderToken();
      return;
    }
    for (const message of messages) appendMessage(message.role, message.text);
    renderToken();
    stick();
  }

  function appendMessage(role, text, model) {
    const empty = log.querySelector('.empty');
    if (empty) empty.remove();
    const node = document.createElement('div');
    node.className = `msg ${role === 'user' ? 'user' : 'assistant'}`;
    if (role !== 'user') {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = model || '回复';
      node.append(who);
    }
    const body = document.createElement('span');
    body.textContent = text || '';
    node.append(body);
    log.append(node);
    stick();
    renderToken();
    return body;
  }

  function stick() {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (near || streaming) log.scrollTop = log.scrollHeight;
  }

  async function send() {
    const text = input.value.trim();
    if ((!text && !attachments.length) || streaming) return;
    streaming = true;
    sendButton.disabled = true;
    stopButton.hidden = false;
    input.value = '';
    input.style.height = 'auto';
    const ids = attachments.map((item) => item.id);
    attachmentKey = '';
    attachments = [];
    renderPending();
    appendMessage('user', text || '（附件）');
    const bodyNode = appendMessage('assistant', '', '…');
    abort = new AbortController();
    let got = '';
    try {
      const response = await fetch(api('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, attachmentIds: ids, modelId: modelSelect.value }),
        signal: abort.signal,
      });
      await readSse(response, (message) => {
        if (message.delta) {
          got += message.delta;
          bodyNode.textContent = got;
          stick();
        }
        if (message.error) {
          bodyNode.textContent = message.error;
          bodyNode.classList.add('err');
        }
        if (message.done && message.model) {
          const who = bodyNode.parentElement.querySelector('.who');
          if (who) who.textContent = message.model;
        }
        if (message.done && message.message && !got) bodyNode.textContent = message.message;
      });
    } catch (error) {
      if (error.name !== 'AbortError') bodyNode.textContent = '没有发出去';
    } finally {
      streaming = false;
      sendButton.disabled = false;
      stopButton.hidden = true;
      abort = null;
      loadHistory().catch(() => {});
    }
  }

  async function shot() {
    const button = document.getElementById('shot');
    button.disabled = true;
    try {
      const result = await postJson('/api/shot', { mode: 'region' });
      if (!result.ok) throw new Error(result.error || '截图失败');
    } catch (error) {
      appendMessage('assistant', error.message || '截图失败');
    } finally {
      button.disabled = false;
    }
  }

  async function uploadPicked() {
    const picker = document.getElementById('picker');
    const files = [...picker.files];
    picker.value = '';
    for (const file of files) {
      const data = await fileToBase64(file);
      await postJson('/api/upload', { name: file.name, mime: file.type || 'application/octet-stream', data });
    }
  }

  function syncAttachments(list) {
    const key = list.map((item) => item.id).join(',');
    if (key === attachmentKey) return;
    attachmentKey = key;
    attachments = list;
    renderPending();
  }

  function renderPending() {
    pending.replaceChildren();
    for (const item of attachments) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      if (String(item.mime).startsWith('image/')) {
        const img = document.createElement('img');
        img.src = api(`/api/file?id=${encodeURIComponent(item.id)}`).toString();
        img.alt = '';
        chip.append(img);
      }
      const name = document.createElement('span');
      name.textContent = item.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '移除';
      remove.addEventListener('click', () => postJson('/api/attachment/remove', { id: item.id }));
      chip.append(name, remove);
      pending.append(chip);
    }
  }

  async function saveKeys() {
    const button = document.getElementById('save-keys');
    button.disabled = true;
    try {
      await postJson('/api/shortcuts', {
        region: '',
        scroll: document.getElementById('key-region').value,
        float: document.getElementById('key-float').value,
      });
      button.textContent = '已保存';
      setTimeout(() => { button.textContent = '保存快捷键'; }, 1200);
    } catch (error) {
      button.textContent = error.message || '没保存';
      setTimeout(() => { button.textContent = '保存快捷键'; }, 1600);
    } finally {
      button.disabled = false;
    }
  }

  async function getJson(pathname) {
    const response = await fetch(api(pathname), { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '请求失败');
    return body;
  }

  async function postJson(pathname, payload) {
    const response = await fetch(api(pathname), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '请求失败');
    return body;
  }

  async function readSse(response, onMessage) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const line = raw.split('\n').find((item) => item.startsWith('data: '));
        if (!line) continue;
        try { onMessage(JSON.parse(line.slice(6))); } catch { /* ignore a partial frame */ }
      }
    }
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('读文件失败'));
      reader.readAsDataURL(file);
    });
  }

  function tokenCount(last) {
    if (!last) return 0;
    return [last.inputTokens, last.outputTokens, last.cacheReadTokens, last.cacheWriteTokens]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((sum, value) => sum + value, 0);
  }

  function tokenText(last) {
    const total = tokenCount(last);
    if (!total) return 'token 未知';
    if (total >= 10000) {
      const wan = total / 10000;
      return `${wan >= 10 ? Math.round(wan) : wan.toFixed(1)}万 token`;
    }
    return `${Math.round(total)} token`;
  }

  function formatK(value) {
    const n = Math.max(0, Math.round(Number(value) || 0));
    if (n >= 10000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(n);
  }

  function money(cents) {
    const value = Number(cents);
    if (!Number.isFinite(value)) return '—';
    const dollars = value / 100;
    return `$${dollars.toFixed(Math.abs(dollars) >= 0.01 ? 2 : 3)}`;
  }

  function when(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
