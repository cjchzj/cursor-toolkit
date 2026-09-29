const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Host } = require('./host');
const { startServer } = require('./server');
const { UsageMonitor } = require('./usage');
const { listLibrary, toggleItem } = require('./catalog');

const root = __dirname;
const dataDir = path.join(process.env.LOCALAPPDATA || root, 'MingCursorToolkit', 'data');
const settingsFile = path.join(root, 'settings.json');
const runtimeFile = path.join(root, 'runtime.json');
const dbPath = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const defaults = { region: '', scroll: 'alt+9', float: 'alt+8' };
const state = {
  version: 0,
  usage: null,
  shortcuts: readSettings(),
  library: { plugins: [], skills: [], note: '' },
  attachments: [],
  files: new Map(),
  history: [],
  historyVersion: 0,
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
      history: () => state.history,
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
      chat: async () => ({ ok: false, message: '请直接在 Cursor 对话里提问；工作台负责截图、文件和额度。' }),
      refresh: () => refreshUsage(true),
      shutdown: stop,
    },
  });
  writeRuntime();
  refreshLibrary();
  await host.start(state.shortcuts);
  await refreshUsage(true);
  setInterval(() => refreshUsage(false), 45000);
  setInterval(refreshLibrary, 20000);
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
    historyVersion: state.historyVersion,
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
