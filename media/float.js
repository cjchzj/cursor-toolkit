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
  const pinButton = document.getElementById('pin');
  const closeButton = document.getElementById('close');
  let since = -1;
  let historyVersion = -1;
  let streaming = false;
  let abort = null;
  let attachmentKey = '';
  let attachments = [];
  let modelKey = '';
  let library = { plugins: [], skills: [], note: '' };
  if (EMBED) document.body.classList.add('embed');
  else if (PANEL) {
    document.body.classList.add('panel');
    closeButton.hidden = true;
  } else {
    document.body.classList.add('float');
    pinButton.hidden = true;
  }

  document.getElementById('bar').addEventListener('pointerdown', (event) => {
    if (!EMBED || event.target.closest('button')) return;
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
  });

  closeButton.addEventListener('click', () => {
    if (EMBED) postJson('/api/float', { open: false });
    else postJson('/api/pin', {});
  });
  pinButton.addEventListener('click', () => postJson('/api/pin', {}));
  document.getElementById('shot').addEventListener('click', () => shot());
  document.getElementById('file').addEventListener('click', () => document.getElementById('picker').click());
  document.getElementById('picker').addEventListener('change', uploadPicked);
  document.getElementById('save-keys').addEventListener('click', saveKeys);
  document.getElementById('refresh-usage').addEventListener('click', refreshUsage);
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
    if (!streaming && data.historyVersion !== historyVersion) {
      historyVersion = data.historyVersion;
      loadHistory();
    }
  }

  function renderLibrary() {
    const list = document.getElementById('library-list');
    const note = document.getElementById('library-note');
    const query = document.getElementById('library-search').value.trim().toLowerCase();
    note.textContent = library.note || '技能在下一次对话生效；插件切换需重启 Cursor。';
    list.replaceChildren();
    addLibrarySection(list, '插件', library.plugins || [], query);
    addLibrarySection(list, '技能', library.skills || [], query);
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
    const plan = document.getElementById('usage-plan');
    const meta = document.getElementById('usage-meta');
    setUsageBar('grok', usage?.grok);
    setUsageBar('other', usage?.other);
    plan.textContent = usage?.plan || (usage?.unlimited ? '无限额度' : '');
    if (!usage) {
      meta.textContent = '正在读取额度…';
      return;
    }
    if (!usage.ok) {
      meta.textContent = usage.error || '额度暂时不可用';
      return;
    }
    const parts = [];
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

  function setUsageBar(name, value) {
    const fill = document.getElementById(`usage-${name}`);
    const text = document.getElementById(`usage-${name}-text`);
    const number = value == null || Number.isNaN(Number(value)) ? null : Math.max(0, Math.min(100, Number(value)));
    fill.style.transform = `scaleX(${number == null ? 0 : number / 100})`;
    fill.classList.toggle('warn', number != null && number >= 70 && number < 90);
    fill.classList.toggle('hot', number != null && number >= 90);
    text.textContent = number == null ? '—' : `${Math.round(number)}%`;
  }

  async function refreshUsage() {
    const button = document.getElementById('refresh-usage');
    button.disabled = true;
    button.textContent = '刷新中';
    try {
      const state = await getJson('/api/refresh');
      renderUsage(state.usage || state);
    } catch (error) {
      document.getElementById('usage-meta').textContent = error.message || '刷新失败';
    } finally {
      button.disabled = false;
      button.textContent = '刷新';
    }
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
    modelSelect.hidden = false;
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
      empty.textContent = '可以直接问，也可以先截图或丢进文件。';
      log.append(empty);
      return;
    }
    for (const message of messages) appendMessage(message.role, message.text);
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

  function tokenText(last) {
    const values = [last.inputTokens, last.outputTokens, last.cacheReadTokens, last.cacheWriteTokens]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!values.length) return 'token 未知';
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total >= 10000) {
      const wan = total / 10000;
      return `${wan >= 10 ? Math.round(wan) : wan.toFixed(1)}万 token`;
    }
    return `${Math.round(total)} token`;
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
