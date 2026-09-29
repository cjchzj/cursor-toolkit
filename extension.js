const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { UsageMonitor } = require('./usage');
const { Host } = require('./host');
const { startServer } = require('./server');
const { listModels, sendChat, openCursorChat, normalizeChord, validChord } = require('./chat');
const { listLibrary, toggleItem } = require('./catalog');

const BINDING_COMMANDS = {
  region: 'cursorToolkit.captureRegion',
  scroll: 'cursorToolkit.captureScroll',
  float: 'cursorToolkit.toggleFloat',
};

let host;
let server;
let status;
let output;
const lastFire = new Map();

const ctx = {
  version: 0,
  floatOpen: false,
  externalOpen: false,
  usage: null,
  attachments: [],
  files: new Map(),
  shortcuts: { region: 'alt+0', scroll: 'alt+9', float: 'alt+8' },
  library: { plugins: [], skills: [], note: '' },
  history: [],
  historyVersion: 0,
  models: [],
  selectedModel: '',
  waiters: new Set(),
};

function activate(context) {
  output = vscode.window.createOutputChannel('工作台');
  context.subscriptions.push(output);
  const storage = context.globalStorageUri.fsPath;
  fs.mkdirSync(storage, { recursive: true });
  const dbPath = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  usageRef = new UsageMonitor(dbPath);
  const token = crypto.randomBytes(24).toString('hex');
  activeToken = token;
  ctx.shortcuts = readChords();

  host = new Host(context.extensionPath, storage, onHostLine);
  const panel = new ToolkitViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('cursorToolkit.panel', panel));
  const api = {
    log: (message) => output.appendLine(message),
    widgetReady: () => {},
    state: publicState,
    history: () => ctx.history,
    wait: waitFor,
    setFloat: (open) => {
      ctx.floatOpen = open;
      bump();
    },
    pin: () => pinWindow(token),
    shot: (mode) => capture(mode),
    upload: (name, mime, buffer) => {
      const meta = addFile(name, mime, buffer);
      ctx.attachments.push(meta);
      bump();
      return meta;
    },
    removeAttachment: (id) => {
      ctx.attachments = ctx.attachments.filter((item) => item.id !== id);
      bump();
    },
    file: (id) => ctx.files.get(id) || null,
    shortcuts: (body) => saveShortcuts(body),
    toggleLibrary: (body) => changeLibrary(body),
    chat: (body, onDelta, signal) => talk(body, onDelta, signal),
    refresh: () => refreshUsage(true),
  };

  const boot = (async () => {
    const started = await startServer({
      token,
      mediaDir: path.join(context.extensionPath, 'media'),
      api,
    });
    server = started;
    panel.connect(`http://127.0.0.1:${started.port}/float?token=${token}&panel=1`);
    if (!context.globalState.get('cursorToolkit.altDigits')) {
      try {
        await saveShortcuts({ region: 'alt+0', scroll: 'alt+9', float: 'alt+8' });
        await context.globalState.update('cursorToolkit.altDigits', true);
      } catch (error) {
        output.appendLine(`快捷键没改成 Alt 数字键：${error.message || error}`);
      }
    }
    refreshLibrary();
    try {
      await host.start(ctx.shortcuts);
    } catch (error) {
      output.appendLine(`截图组件不可用：${error.message || error}`);
      vscode.window.showWarningMessage('截图组件没有编译成功，对话和额度仍可使用。');
    }
    await refreshModels();
    await refreshUsage(true);
  })().catch((error) => {
    output.appendLine(error.stack || error.message || String(error));
    vscode.window.showErrorMessage(`工作台启动失败：${error.message || error}`);
  });

  context.subscriptions.push(
    { dispose: () => host?.dispose() },
    { dispose: () => server?.close() },
    vscode.commands.registerCommand('cursorToolkit.captureRegion', () => guard('region', () => capture('region'))),
    vscode.commands.registerCommand('cursorToolkit.captureScroll', () => guard('scroll', () => capture('scroll'))),
    vscode.commands.registerCommand('cursorToolkit.toggleFloat', () => guard('float', () => toggleFloat(token))),
    vscode.commands.registerCommand('cursorToolkit.refreshUsage', () => refreshUsage(true)),
    vscode.commands.registerCommand('cursorToolkit.openPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.cursorToolkit');
      await vscode.commands.executeCommand('cursorToolkit.panel.focus');
    }),
    vscode.commands.registerCommand('cursorToolkit.openShortcuts', () => {
      vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'cursorToolkit');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('cursorToolkit')) return;
      ctx.shortcuts = readChords();
      host?.rebind(ctx.shortcuts);
      bump();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) refreshUsage(false);
    }),
  );

  const usageTimer = setInterval(() => refreshUsage(false), 45000);
  const libraryTimer = setInterval(() => refreshLibrary(), 20000);
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });
  context.subscriptions.push({ dispose: () => clearInterval(libraryTimer) });
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
  status.text = '$(tools) 工作台';
  status.command = 'cursorToolkit.openPanel';
  status.tooltip = '打开工作台';
  status.show();
  context.subscriptions.push(status);
  watchKeybindings(context);
  return boot;
}

function deactivate() {
  host?.dispose();
  server?.close();
}

function onHostLine(message) {
  if (message.type === 'hotkey') {
    if (message.action === 'region') guard('region', () => capture('region'));
    else if (message.action === 'scroll') guard('scroll', () => capture('scroll'));
    else if (message.action === 'float') guard('float', () => toggleFloat(currentToken()));
    return;
  }
  if (message.type === 'hotkey-error') {
    output.appendLine(`${message.action}: ${message.error}`);
    vscode.window.showWarningMessage(`快捷键 ${message.action}：${message.error}`);
    return;
  }
  if (message.type === 'external') {
    ctx.externalOpen = Boolean(message.open);
    if (message.error) vscode.window.showWarningMessage(message.error);
    bump();
    return;
  }
  if (message.type === 'log' && message.message) output.appendLine(message.message);
}

let activeToken = '';
function currentToken() {
  return activeToken;
}

function pinWindow(token) {
  activeToken = token;
  if (!server) return;
  host?.toggleExternal(`http://127.0.0.1:${server.port}/float?token=${token}`);
}

async function toggleFloat(token) {
  activeToken = token;
  if (vscode.window.state.focused && widgetReady) {
    ctx.floatOpen = !ctx.floatOpen;
    bump();
    return;
  }
  pinWindow(token);
}

async function guard(name, fn) {
  const now = Date.now();
  if (now - (lastFire.get(name) || 0) < 700) return;
  lastFire.set(name, now);
  try {
    await fn();
  } catch (error) {
    const message = error?.message || String(error);
    output.appendLine(message);
    vscode.window.showErrorMessage(message);
  }
}

async function capture(mode) {
  const result = await host.capture(mode);
  if (!result?.ok || !result.path) throw new Error(result?.error || '截图失败');
  const buffer = fs.readFileSync(result.path);
  const meta = addFile(path.basename(result.path), 'image/png', buffer);
  ctx.attachments.push(meta);
  bump();
  vscode.window.setStatusBarMessage(`截图已复制 · ${meta.name}`, 2500);
  return { ok: true, id: meta.id, name: meta.name };
}

function addFile(name, mime, buffer) {
  const id = crypto.randomBytes(8).toString('hex');
  const meta = { id, name: path.basename(name || 'file'), mime: mime || 'application/octet-stream' };
  ctx.files.set(id, { ...meta, buffer });
  while (ctx.files.size > 40) {
    const oldest = ctx.files.keys().next().value;
    ctx.files.delete(oldest);
    ctx.attachments = ctx.attachments.filter((item) => item.id !== oldest);
  }
  return meta;
}

async function talk(body, onDelta, signal) {
  const text = String(body.text || '').slice(0, 100000);
  const ids = Array.isArray(body.attachmentIds) ? body.attachmentIds : ctx.attachments.map((item) => item.id);
  const images = [];
  const notes = [];
  for (const id of ids) {
    const file = ctx.files.get(id);
    if (!file) continue;
    if (String(file.mime).startsWith('image/')) images.push({ bytes: new Uint8Array(file.buffer), mime: file.mime });
    else if (isText(file.mime, file.name) && file.buffer.length <= 200000) notes.push(`【附件 ${file.name}】\n${file.buffer.toString('utf8')}`);
    else notes.push(`【附件 ${file.name}】`);
  }
  const prompt = [text, ...notes].filter(Boolean).join('\n\n').trim();
  if (!prompt && !images.length) throw new Error('先写点内容，或附上一张图');
  ctx.history.push({ role: 'user', text: (text || '（附件）').slice(0, 4000) });
  ctx.attachments = [];
  ctx.historyVersion += 1;
  if (ctx.history.length > 40) ctx.history.splice(0, ctx.history.length - 40);
  bump();
  try {
    const result = await sendChat(vscode, {
      modelId: body.modelId || ctx.selectedModel,
      prompt: prompt || '请看附图',
      images,
      token: signal,
      onDelta,
    });
    if (!result.ok) {
      await openCursorChat(vscode, prompt || '请看附图');
      const message = '悬浮窗现在不能直接调用模型，内容已复制，并已尝试打开 Cursor 对话。';
      ctx.history.push({ role: 'assistant', text: message });
      ctx.historyVersion += 1;
      bump();
      return { ok: false, message };
    }
    ctx.history.push({ role: 'assistant', text: result.text });
    ctx.historyVersion += 1;
    if (body.modelId) ctx.selectedModel = body.modelId;
    if (ctx.history.length > 40) ctx.history.splice(0, ctx.history.length - 40);
    bump();
    setTimeout(() => refreshUsage(true), 4000);
    setTimeout(() => refreshUsage(true), 16000);
    return { ok: true, model: result.model };
  } catch (error) {
    const message = error?.message || '对话失败';
    ctx.history.push({ role: 'assistant', text: message });
    ctx.historyVersion += 1;
    bump();
    throw error;
  }
}

async function refreshModels() {
  try {
    ctx.models = await listModels(vscode);
    if (!ctx.selectedModel && ctx.models[0]) ctx.selectedModel = ctx.models[0].id;
    bump();
  } catch (error) {
    output.appendLine(`模型列表不可用：${error.message || error}`);
  }
}

async function refreshUsage(force) {
  try {
    ctx.usage = await usageMonitor().refresh(force);
  } catch (error) {
    ctx.usage = { ok: false, error: error.message || '额度读取失败', grok: null, other: null, last: null, recent: [] };
  }
  updateStatus();
  bump();
}

let usageRef;
function usageMonitor() {
  return usageRef;
}

function updateStatus() {
  if (!status || !ctx.usage) return;
  if (!ctx.usage.ok) {
    status.text = ctx.usage.error || '额度不可用';
    return;
  }
  const last = ctx.usage.last ? `上次 ${money(ctx.usage.last.cents)}` : '上次 —';
  status.text = `Grok ${pct(ctx.usage.grok)} · 其他 ${pct(ctx.usage.other)} · ${last}`;
}

let libraryJson = '';

function refreshLibrary(note) {
  const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [];
  try {
    ctx.library = listLibrary(folders, stateDbPath());
  } catch (error) {
    ctx.library = { plugins: [], skills: [], note: error.message || '读不到插件和 Skills' };
  }
  if (note) ctx.library.note = note;
  const next = JSON.stringify(ctx.library);
  if (next === libraryJson) return;
  libraryJson = next;
  bump();
}

function changeLibrary(body) {
  const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [];
  const result = toggleItem(body, folders, stateDbPath());
  const note = !result.ok
    ? (result.error || '没有切换')
    : (result.reload ? '扩展已切换，完全退出 Cursor 再打开后生效。' : '');
  refreshLibrary(note);
  return result;
}

function stateDbPath() {
  return path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function publicState() {
  return {
    v: ctx.version,
    floatOpen: ctx.floatOpen,
    externalOpen: ctx.externalOpen,
    usage: ctx.usage,
    attachments: ctx.attachments.map(({ id, name, mime }) => ({ id, name, mime })),
    shortcuts: ctx.shortcuts,
    library: ctx.library,
    historyVersion: ctx.historyVersion,
    models: ctx.models,
    selectedModel: ctx.selectedModel,
  };
}

function waitFor(since) {
  if (since !== ctx.version) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      ctx.waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, 20000);
    ctx.waiters.add(finish);
  });
}

function bump() {
  ctx.version += 1;
  const pending = [...ctx.waiters];
  ctx.waiters.clear();
  for (const waiter of pending) waiter();
}

async function saveShortcuts(body) {
  const next = {
    region: normalizeChord(body.region),
    scroll: normalizeChord(body.scroll),
    float: normalizeChord(body.float),
  };
  for (const value of Object.values(next)) {
    if (!validChord(value)) throw new Error(`快捷键无效：${value || '空'}`);
  }
  const config = vscode.workspace.getConfiguration('cursorToolkit');
  await config.update('shortcut.region', next.region, true);
  await config.update('shortcut.scroll', next.scroll, true);
  await config.update('shortcut.float', next.float, true);
  writeKeybindings(next);
  ctx.shortcuts = next;
  host?.rebind(next);
  bump();
}

function readChords() {
  const config = vscode.workspace.getConfiguration('cursorToolkit');
  const next = {
    region: normalizeChord(config.get('shortcut.region') || 'alt+0'),
    scroll: normalizeChord(config.get('shortcut.scroll') || 'alt+9'),
    float: normalizeChord(config.get('shortcut.float') || 'alt+8'),
  };
  const file = keybindingsPath();
  if (!fs.existsSync(file)) return next;
  let entries = [];
  try {
    entries = parseJsonc(fs.readFileSync(file, 'utf8'));
  } catch {
    return next;
  }
  if (!Array.isArray(entries)) return next;
  const reverse = Object.fromEntries(Object.entries(BINDING_COMMANDS).map(([slot, command]) => [command, slot]));
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const command = String(item.command || '');
    if (command.startsWith('-')) continue;
    const slot = reverse[command];
    const chord = normalizeChord(item.key || '');
    if (slot && validChord(chord)) next[slot] = chord;
  }
  return next;
}

function writeKeybindings(chords) {
  const file = keybindingsPath();
  let entries = [];
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      entries = parseJsonc(raw);
    } catch {
      return;
    }
    const backup = `${file}.ctk-bak`;
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
  }
  if (!Array.isArray(entries)) entries = [];
  const ours = new Set(Object.values(BINDING_COMMANDS));
  entries = entries.filter((item) => item && !ours.has(String(item.command || '').replace(/^-/, '')));
  for (const [slot, command] of Object.entries(BINDING_COMMANDS)) {
    entries.push({ key: chords[slot], command });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

function watchKeybindings(context) {
  const file = keybindingsPath();
  if (!fs.existsSync(file)) return;
  let timer;
  try {
    const watcher = fs.watch(file, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        ctx.shortcuts = readChords();
        host?.rebind(ctx.shortcuts);
        bump();
      }, 200);
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    /* the shortcuts file can be missing on a fresh profile */
  }
}

function keybindingsPath() {
  return path.join(process.env.APPDATA || '', 'Cursor', 'User', 'keybindings.json');
}

function parseJsonc(text) {
  if (!String(text).trim()) return [];
  try {
    return JSON.parse(text);
  } catch {
    /* comments or trailing commas */
  }
  let out = '';
  let string = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (string) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') {
      string = true;
      out += char;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return JSON.parse(out.replace(/,\s*([\]}])/g, '$1'));
}

function isText(mime, name) {
  if (/^text\//.test(mime) || /json|javascript|xml|yaml|svg/.test(String(mime))) return true;
  return /\.(txt|md|json|js|ts|tsx|jsx|py|css|html|xml|ya?ml|cs|sql|log|csv|gd|godot)$/i.test(name || '');
}

function pct(value) {
  return value == null ? '—' : `${Math.round(value)}%`;
}

function money(cents) {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(Math.abs(dollars) >= 0.01 ? 2 : 3)}`;
}

class ToolkitViewProvider {
  constructor() {
    this.view = null;
    this.url = '';
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.render();
  }

  connect(url) {
    this.url = url;
    this.render();
  }

  render() {
    if (!this.view) return;
    if (!this.url) {
      this.view.webview.html = '<!doctype html><html><body style="font:13px sans-serif;color:#aaa;padding:16px">工作台正在启动…</body></html>';
      return;
    }
    const src = escapeHtml(this.url);
    this.view.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline';">
  <style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}body{background:var(--vscode-sideBar-background)}</style>
</head>
<body><iframe src="${src}" title="工作台"></iframe></body>
</html>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

module.exports = { activate, deactivate };
