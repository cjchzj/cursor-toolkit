const vscode = require('vscode');
const { ensureCompanion, readRuntime, request } = require('./installer');
const { sendChat } = require('./chat');

let runtime = null;
let status = null;
let output = null;
let pumping = false;

async function activate(context) {
  output = vscode.window.createOutputChannel('工作台');
  context.subscriptions.push(output);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
  status.name = '工作台';
  status.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
  status.color = new vscode.ThemeColor('statusBarItem.remoteForeground');
  status.text = '$(tools) 工作台';
  status.tooltip = '打开工作台悬浮窗';
  status.command = 'cursorToolkit.toggleFloat';
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
    vscode.commands.registerCommand('cursorToolkit.openPanel', () => call('POST', '/api/pin', {})),
    vscode.commands.registerCommand('cursorToolkit.openShortcuts', () => call('POST', '/api/pin', {})),
  );

  try {
    runtime = await ensureCompanion(context.extensionPath, context.extension.packageJSON.version, (line) => output.appendLine(line));
    await updateStatus();
  } catch (error) {
    output.appendLine(error.stack || error.message || String(error));
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    status.text = '$(warning) 工作台未启动';
    status.tooltip = error.message || String(error);
    vscode.window.showErrorMessage(`工作台启动失败：${error.message || error}`);
  }

  const usageTimer = setInterval(updateStatus, 45000);
  const jobTimer = setInterval(() => pumpJob().catch((error) => output?.appendLine(error.message || String(error))), 700);
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });
  context.subscriptions.push({ dispose: () => clearInterval(jobTimer) });
}

async function call(method, pathname, body) {
  runtime = runtime || readRuntime();
  if (!runtime) throw new Error('工作台助手未运行');
  let result = await request(runtime, method, pathname, body);
  if (!result.ok) throw new Error(result.body?.error || '工作台请求失败');
  return result.body;
}

async function pumpJob() {
  if (pumping) return;
  pumping = true;
  try {
    const job = await call('GET', '/api/job');
    if (!job?.id) return;
    const result = await sendChat(vscode, {
      modelId: job.modelId,
      prompt: job.prompt,
      history: job.history || [],
      images: [],
      onDelta: (delta) => call('POST', '/api/job/delta', { id: job.id, delta }).catch(() => {}),
    });
    if (!result.ok) {
      await call('POST', '/api/job/done', { id: job.id, error: result.reason === 'no-model' ? 'Cursor 当前没有可用模型' : '对话失败' });
      return;
    }
    await call('POST', '/api/job/done', { id: job.id, text: result.text, model: result.model });
  } catch (error) {
    output?.appendLine(`转接对话失败：${error.message || error}`);
  } finally {
    pumping = false;
  }
}

async function updateStatus() {
  try {
    const state = await call('GET', '/api/state?since=-1');
    const usage = state.usage;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
    status.color = new vscode.ThemeColor('statusBarItem.remoteForeground');
    if (!usage || !usage.ok) {
      status.text = '$(tools) 工作台';
      status.tooltip = usage?.error || '额度正在读取';
      return;
    }
    status.text = `$(tools) 工作台  Grok ${percent(usage.grok)}  其他 ${percent(usage.other)}`;
    status.tooltip = '点击打开工作台悬浮窗';
  } catch (error) {
    output?.appendLine(`状态读取失败：${error.message || error}`);
  }
}

function percent(value) {
  return value == null ? '—' : `${Math.round(Number(value))}%`;
}

function deactivate() {
  // 独立助手继续运行，保证 Agent 窗口和其他应用仍可使用全局快捷键。
}

module.exports = { activate, deactivate };
