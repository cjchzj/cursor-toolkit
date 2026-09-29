const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const installRoot = path.join(process.env.LOCALAPPDATA || '', 'MingCursorToolkit');
const runtimeFile = path.join(installRoot, 'runtime.json');
const startupFile = path.join(installRoot, 'launch.vbs');
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const runtimeFiles = [
  'package.json',
  'companion.js',
  'server.js',
  'usage.js',
  'auth.js',
  'catalog.js',
  'host.js',
  'native/Host.cs',
  'media/float.html',
  'media/float.css',
  'media/float.js',
  'media/toolkit.svg',
  'media/toolkit.ico',
];

async function ensureCompanion(sourceRoot, version, log) {
  const report = typeof log === 'function' ? log : () => {};
  const current = readRuntime();
  if (current && current.version === version && await healthy(current)) return current;
  if (current) await shutdown(current);
  copyRuntime(sourceRoot);
  const node = findNode();
  if (!node) throw new Error('没有找到 Node.js，无法启动工作台助手');
  writeStartup(node);
  launch(node);
  const ready = await waitReady(version, 12000);
  if (!ready) throw new Error('工作台助手没有在 12 秒内启动');
  report(`独立助手已运行：${ready.port}`);
  return ready;
}

function copyRuntime(sourceRoot) {
  fs.mkdirSync(installRoot, { recursive: true });
  for (const relative of runtimeFiles) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(installRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function findNode() {
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
  ];
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
  const found = spawnSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true });
  if (found.status === 0) {
    const first = String(found.stdout || '').split(/\r?\n/).find(Boolean);
    if (first && fs.existsSync(first.trim())) return first.trim();
  }
  return null;
}

function writeStartup(node) {
  fs.mkdirSync(installRoot, { recursive: true });
  const launchExpression = `${quoteVbs(node)} & " " & ${quoteVbs(path.join(installRoot, 'companion.js'))}`;
  const body = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${launchExpression}, 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(startupFile, body);
  const runCommand = `wscript.exe "${startupFile}"`;
  const result = spawnSync('reg.exe', ['ADD', runKey, '/v', 'MingCursorToolkit', '/t', 'REG_SZ', '/d', runCommand, '/f'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || '无法设置登录启动').trim());
}

function quoteVbs(value) {
  return `Chr(34) & "${String(value).replace(/"/g, '""')}" & Chr(34)`;
}

function launch(node) {
  const child = spawn(node, [path.join(installRoot, 'companion.js')], {
    cwd: installRoot,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

function readRuntime() {
  try {
    const value = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    return value && value.port && value.token ? value : null;
  } catch {
    return null;
  }
}

async function waitReady(version, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const current = readRuntime();
    if (current && current.version === version && await healthy(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function healthy(runtime) {
  return request(runtime, 'GET', '/api/health').then((result) => result.ok).catch(() => false);
}

async function shutdown(runtime) {
  try { await request(runtime, 'POST', '/api/shutdown', {}); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function request(runtime, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const timeout = pathname.startsWith('/api/shot') ? 10 * 60 * 1000 : 5000;
    const req = http.request({
      host: '127.0.0.1',
      port: runtime.port,
      path: `${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(runtime.token)}`,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let value = {};
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: value });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function removeStartup() {
  spawnSync('reg.exe', ['DELETE', runKey, '/v', 'MingCursorToolkit', '/f'], { windowsHide: true });
  fs.rmSync(startupFile, { force: true });
}

module.exports = { ensureCompanion, readRuntime, request, installRoot, startupFile, removeStartup };
