const vscode = require('vscode');
const { ensureCompanion, readRuntime, request } = require('./installer');

let runtime = null;
let status = null;
let output = null;

async function activate(context) {
  output = vscode.window.createOutputChannel('工作台');
  context.subscriptions.push(output);
  const panel = new ToolkitViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('cursorToolkit.panel', panel));

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
  status.text = '$(tools) 工作台';
  status.tooltip = '打开工作台';
  status.command = 'cursorToolkit.openPanel';
  status.show();
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorToolkit.captureRegion', () => call('POST', '/api/shot', { mode: 'region' })),
    vscode.commands.registerCommand('cursorToolkit.captureScroll', () => call('POST', '/api/shot', { mode: 'scroll' })),
    vscode.commands.registerCommand('cursorToolkit.toggleFloat', () => call('POST', '/api/pin', {})),
    vscode.commands.registerCommand('cursorToolkit.refreshUsage', async () => {
      await call('GET', '/api/refresh');
      await updateStatus();
    }),
    vscode.commands.registerCommand('cursorToolkit.openPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.cursorToolkit');
      await vscode.commands.executeCommand('cursorToolkit.panel.focus');
    }),
    vscode.commands.registerCommand('cursorToolkit.openShortcuts', async () => {
      await vscode.commands.executeCommand('cursorToolkit.openPanel');
    }),
  );

  try {
    runtime = await ensureCompanion(context.extensionPath, context.extension.packageJSON.version, (line) => output.appendLine(line));
    panel.connect(urlFor('/float?panel=1'));
    await updateStatus();
  } catch (error) {
    output.appendLine(error.stack || error.message || String(error));
    status.text = '$(warning) 工作台未启动';
    status.tooltip = error.message || String(error);
    vscode.window.showErrorMessage(`工作台启动失败：${error.message || error}`);
  }

  const timer = setInterval(updateStatus, 45000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

async function call(method, pathname, body) {
  runtime = runtime || readRuntime();
  if (!runtime) throw new Error('工作台助手未运行');
  let result = await request(runtime, method, pathname, body);
  if (!result.ok) throw new Error(result.body?.error || '工作台请求失败');
  return result.body;
}

async function updateStatus() {
  try {
    const state = await call('GET', '/api/state?since=-1');
    const usage = state.usage;
    if (!usage || !usage.ok) {
      status.text = '$(tools) 工作台';
      status.tooltip = usage?.error || '额度正在读取';
      return;
    }
    status.text = `Grok ${percent(usage.grok)} · 其他 ${percent(usage.other)}`;
    status.tooltip = '点击打开工作台';
  } catch (error) {
    output?.appendLine(`状态读取失败：${error.message || error}`);
  }
}

function urlFor(pathname) {
  const url = new URL(`http://127.0.0.1:${runtime.port}${pathname}`);
  url.searchParams.set('token', runtime.token);
  return url.toString();
}

function percent(value) {
  return value == null ? '—' : `${Math.round(Number(value))}%`;
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
    this.view.webview.html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:*; style-src 'unsafe-inline';">
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}body{background:var(--vscode-sideBar-background)}</style>
</head><body><iframe src="${escapeHtml(this.url)}" title="工作台"></iframe></body></html>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function deactivate() {
  // 独立助手继续运行，保证 Agent 窗口和其他应用仍可使用全局快捷键。
}

module.exports = { activate, deactivate };
