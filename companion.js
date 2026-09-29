const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Host } = require('./host');
const { startServer } = require('./server');
const { UsageMonitor } = require('./usage');
const { listLibrary, toggleItem } = require('./catalog');
const { listCursorChats, readCursorThread } = require('./composers');

const root = __dirname;
const dataDir = path.join(process.env.LOCALAPPDATA || root, 'MingCursorToolkit', 'data');
const settingsFile = path.join(root, 'settings.json');
const runtimeFile = path.join(root, 'runtime.json');
const dbPath = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const defaults = { region: '', scroll: 'alt+9', float: 'alt+8' };
const chatsFile = path.join(dataDir, 'chats.json');
const savedChats = loadChats();
const state = {
  version: 0,
  usage: null,
  shortcuts: readSettings(),
  library: { plugins: [], skills: [], note: '' },
  attachments: [],
  files: new Map(),
  chats: { currentId: savedChats.currentId, version: savedChats.version, sessions: savedChats.sessions },
  cursorChats: [],
  overlays: savedChats.overlays || {},
  job: null,
  models: [],
  selectedModel: '',
  floatOpen: false,
  externalOpen: false,
  waiters: new Set(),
};
const monitor = new UsageMonitor(dbPath);
const token = crypto.randomBytes(24).toString('hex');
let host;
let server;
let stopping = false;

main().catch((error) => {
  log(error.stack || error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  host = new Host(root, dataDir, onHostLine);
  server = await startServer({
    token,
    mediaDir: path.join(root, 'media'),
    api: {
      log,
      widgetReady() {},
      state: publicState,
      history,
      chats: selectChat,
      async window(action) {
        const result = await host.windowOp(action);
        if (String(action || '') === 'close') {
          state.externalOpen = false;
          bump();
        }
        return result;
      },
      wait: waitFor,
      setFloat(open) { state.floatOpen = Boolean(open); bump(); },
      pin: toggleWindow,
      shot: capture,
      upload: addFile,
      removeAttachment(id) {
        state.attachments = state.attachments.filter((item) => item.id !== id);
        bump();
      },
      file: (id) => state.files.get(id) || null,
      shortcuts: saveShortcuts,
      toggleLibrary: changeLibrary,
      chat: talk,
      takeJob,
      jobDelta,
      jobDone,
      refresh: () => refreshUsage(true),
      shutdown: stop,
    },
  });
  writeRuntime();
  refreshLibrary();
  refreshCursorChats();
  await host.start(state.shortcuts);
  await refreshUsage(true);
  setInterval(() => refreshUsage(false), 45000);
  setInterval(refreshLibrary, 20000);
  setInterval(refreshCursorChats, 12000);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log(`工作台助手已启动，端口 ${server.port}`);
}

function onHostLine(message) {
  if (message.type === 'hotkey') {
    if (message.action === 'region' || message.action === 'scroll') capture('region').catch((error) => log(error.message));
    else if (message.action === 'float') toggleWindow();
  } else if (message.type === 'tray') {
    if (message.action === 'open') toggleWindow(true);
    else if (message.action === 'region' || message.action === 'scroll') capture('region').catch((error) => log(error.message));
    else if (message.action === 'exit') stop();
  } else if (message.type === 'external') {
    state.externalOpen = Boolean(message.open);
    bump();
  } else if (message.message) {
    log(message.message);
  }
}

async function capture(mode) {
  const result = await host.capture(mode === 'scroll' ? 'scroll' : 'region');
  if (!result || !result.ok || !result.path) return result || { ok: false, error: '截图失败' };
  const buffer = fs.readFileSync(result.path);
  const meta = addFile(path.basename(result.path), 'image/png', buffer);
  state.attachments.push(meta);
  bump();
  return { ok: true, id: meta.id, name: meta.name, path: result.path };
}

function toggleWindow(forceOpen) {
  if (!server) return;
  if (forceOpen && state.externalOpen) return;
  host.toggleExternal(`http://127.0.0.1:${server.port}/float?token=${token}`);
}

function addFile(name, mime, buffer) {
  const id = crypto.randomBytes(8).toString('hex');
  const meta = { id, name: path.basename(name || 'file'), mime: mime || 'application/octet-stream' };
  state.files.set(id, { ...meta, buffer });
  while (state.files.size > 40) state.files.delete(state.files.keys().next().value);
  return meta;
}

async function refreshUsage(force) {
  state.usage = await monitor.refresh(force);
  bump();
  return state.usage;
}

function refreshLibrary(note) {
  try {
    state.library = listLibrary([], dbPath);
  } catch (error) {
    state.library = { plugins: [], skills: [], note: error.message || '读取插件和技能失败' };
  }
  if (note) state.library.note = note;
  bump();
}

function changeLibrary(body) {
  const result = toggleItem(body, [], dbPath);
  refreshLibrary(result.reload ? '扩展状态将在下次完全启动 Cursor 后生效。' : result.error);
  return result;
}

function saveShortcuts(body) {
  const next = {
    region: '',
    scroll: normalizeChord(body.scroll || defaults.scroll),
    float: normalizeChord(body.float || defaults.float),
  };
  if (![next.scroll, next.float].every(validChord)) throw new Error('快捷键格式无效');
  fs.writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
  state.shortcuts = next;
  host.rebind(next);
  bump();
}

function refreshCursorChats() {
  try {
    state.cursorChats = listCursorChats(dbPath);
  } catch (error) {
    log(`读取 Cursor 对话失败：${error.message || error}`);
    state.cursorChats = state.cursorChats || [];
  }
  if (!state.chats.currentId && state.cursorChats.length) {
    state.chats.currentId = state.cursorChats[0].id;
  }
  if (state.chats.currentId && isCursorId(state.chats.currentId)) state.chats.version += 1;
  bump();
}

function isCursorId(id) {
  return String(id || '').startsWith('c:');
}

function composerIdOf(id) {
  return String(id || '').replace(/^c:/, '');
}

function currentChat() {
  const id = state.chats.currentId;
  if (isCursorId(id)) {
    if (!state.overlays[id]) state.overlays[id] = { id, title: '', messages: [] };
    return state.overlays[id];
  }
  const chats = state.chats;
  let session = chats.sessions.find((item) => item.id === id);
  if (!session) {
    session = makeChat('工作台对话');
    chats.sessions.unshift(session);
    chats.currentId = session.id;
    saveChats();
  }
  return session;
}

function publicChats() {
  const locals = state.chats.sessions
    .filter((item) => item.messages.length || item.id === state.chats.currentId)
    .map((item) => ({
      id: item.id,
      title: item.title,
      origin: 'local',
      fresh: !item.messages.length,
    }));
  const list = [...state.cursorChats, ...locals];
  const current = list.find((item) => item.id === state.chats.currentId) || list[0] || null;
  const tokens = current && current.origin === 'cursor'
    ? { tokensUsed: current.tokensUsed || 0, tokenLimit: current.tokenLimit || 256000 }
    : { tokensUsed: 0, tokenLimit: 256000 };
  return {
    currentId: current ? current.id : '',
    list,
    ...tokens,
  };
}

function selectChat(body) {
  const action = String(body.action || '');
  if (action === 'new') {
    state.chats.sessions = state.chats.sessions.filter((item) => item.messages.length);
    const session = makeChat('工作台对话');
    state.chats.sessions.unshift(session);
    state.chats.currentId = session.id;
  } else if (action === 'select') {
    const id = String(body.id || '');
    const known = publicChats().list.some((item) => item.id === id);
    if (!known) throw new Error('没有这个对话');
    state.chats.currentId = id;
  } else {
    throw new Error('请选择已有对话，或新建对话');
  }
  state.chats.version += 1;
  saveChats();
  bump();
  return { ok: true, chats: publicChats() };
}

function history() {
  const id = state.chats.currentId;
  if (isCursorId(id)) {
    const thread = readCursorThread(dbPath, composerIdOf(id), 40);
    const extra = (state.overlays[id] && state.overlays[id].messages) || [];
    return [...thread.messages, ...extra];
  }
  return currentChat().messages;
}

function makeChat(title) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    title,
    createdAt: Date.now(),
    messages: [],
  };
}

function loadChats() {
  try {
    const saved = JSON.parse(fs.readFileSync(chatsFile, 'utf8'));
    if (saved && Array.isArray(saved.sessions)) {
      const sessions = saved.sessions.filter((item) => item && item.id && Array.isArray(item.messages) && item.messages.length).slice(0, 40);
      let currentId = saved.currentId || '';
      if (currentId && !String(currentId).startsWith('c:') && !sessions.some((item) => item.id === currentId)) currentId = '';
      return {
        currentId,
        version: Number(saved.version) || 1,
        sessions,
        overlays: saved.overlays && typeof saved.overlays === 'object' ? saved.overlays : {},
      };
    }
  } catch {}
  return { currentId: '', version: 1, sessions: [], overlays: {} };
}

function saveChats() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(chatsFile, `${JSON.stringify({
    currentId: state.chats.currentId,
    version: state.chats.version,
    sessions: state.chats.sessions.slice(0, 40),
    overlays: Object.keys(state.overlays).length ? state.overlays : undefined,
  }, null, 2)}\n`);
}

function talk(body, onDelta, signal) {
  const session = currentChat();
  const text = String(body.text || '').trim();
  const userText = text || '（附件）';
  session.messages.push({ role: 'user', text: userText });
  if (text && (!session.title || session.title === '工作台对话' || session.title === '新对话')) {
    session.title = text.slice(0, 28);
  }
  const transcript = history().slice(-16);
  return dispatchJob({
    prompt: userText,
    history: transcript.slice(0, -1),
    modelId: body.modelId,
  }, onDelta, signal).then((result) => {
    const reply = result.message || result.text || '';
    if (reply) session.messages.push({ role: 'assistant', text: reply });
    state.chats.version += 1;
    saveChats();
    bump();
    return { ok: true, message: reply, model: result.model || '' };
  }).catch((error) => {
    const message = error.message || '对话失败';
    session.messages.push({ role: 'assistant', text: message });
    state.chats.version += 1;
    saveChats();
    bump();
    return { ok: false, message };
  });
}

function dispatchJob(payload, onDelta, signal) {
  if (state.job && state.job.reject) {
    try { state.job.reject(new Error('已取消上一轮')); } catch {}
  }
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(6).toString('hex');
    let pickup;
    let timer;
    const finish = (fn) => (value) => {
      clearTimeout(timer);
      clearTimeout(pickup);
      if (signal) signal.removeEventListener?.('abort', abort);
      fn(value);
    };
    const abort = () => {
      if (state.job && state.job.id === id) state.job = null;
      finish(reject)(new Error('已停止'));
    };
    pickup = setTimeout(() => {
      if (state.job && state.job.id === id && !state.job.taken) {
        state.job = null;
        finish(reject)(new Error('Cursor 没有接上这段对话。请确认本机已安装并启用工作台扩展。'));
      }
    }, 5000);
    timer = setTimeout(() => {
      if (state.job && state.job.id === id) {
        state.job = null;
        finish(reject)(new Error('对话超时'));
      }
    }, 120000);
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort);
    }
    state.job = {
      id,
      taken: false,
      payload,
      onDelta: onDelta || (() => {}),
      resolve: finish(resolve),
      reject: finish(reject),
    };
    bump();
  });
}

function takeJob() {
  const job = state.job;
  if (!job || job.taken) return null;
  job.taken = true;
  return { id: job.id, ...job.payload };
}

function jobDelta(body) {
  if (state.job && state.job.id === body.id && body.delta) state.job.onDelta(body.delta);
  return { ok: true };
}

function jobDone(body) {
  const job = state.job;
  if (!job || job.id !== body.id) return { ok: false };
  state.job = null;
  if (body.error) job.reject(new Error(body.error));
  else job.resolve({ text: body.text || body.message || '', model: body.model || '' });
  return { ok: true };
}

function readSettings() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')), region: '' };
  } catch {
    return { ...defaults };
  }
}

function normalizeChord(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function validChord(value) {
  return /^(?=.*(?:ctrl|alt|shift|win)\+)(?:(?:ctrl|alt|shift|win)\+)+(?:[a-z0-9]|f(?:[1-9]|1[0-2])|space|enter|tab)$/.test(value);
}

function publicState() {
  return {
    v: state.version,
    usage: state.usage,
    shortcuts: state.shortcuts,
    library: state.library,
    attachments: state.attachments,
    historyVersion: state.chats.version,
    chats: publicChats(),
    models: [],
    selectedModel: '',
    floatOpen: state.floatOpen,
    externalOpen: state.externalOpen,
  };
}

function waitFor(since) {
  if (since !== state.version) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      state.waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, 20000);
    state.waiters.add(done);
  });
}

function bump() {
  state.version += 1;
  for (const waiter of [...state.waiters]) waiter();
  state.waiters.clear();
}

function writeRuntime() {
  const body = { pid: process.pid, port: server.port, token, version: require('./package.json').version };
  const temp = `${runtimeFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(body));
  fs.copyFileSync(temp, runtimeFile);
  fs.rmSync(temp, { force: true });
}

function log(message) {
  try {
    fs.appendFileSync(path.join(dataDir, 'companion.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function stop() {
  if (stopping) return;
  stopping = true;
  try { host?.dispose(); } catch {}
  try { server?.close(); } catch {}
  try { fs.rmSync(runtimeFile, { force: true }); } catch {}
  setTimeout(() => process.exit(0), 150);
}
