const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class Host {
  constructor(extensionPath, storageDir, onLine) {
    this.extensionPath = extensionPath;
    this.storageDir = storageDir;
    this.onLine = onLine;
    this.child = null;
    this.windowWait = null;
    this.exe = path.join(storageDir, 'CursorToolkitHost.exe');
    this.source = path.join(extensionPath, 'native', 'Host.cs');
    this.shots = path.join(storageDir, 'shots');
  }

  async start(chords) {
    fs.mkdirSync(this.shots, { recursive: true });
    await this.compile();
    if (this.child) this.dispose();
    let buffer = '';
    let sawReady = false;
    let markReady = () => {};
    const ready = new Promise((resolve) => {
      markReady = () => {
        if (sawReady) return;
        sawReady = true;
        resolve();
      };
    });
    const dispatch = (message) => {
      if (message.type === 'ready') markReady();
      if (message.type === 'window' && this.windowWait) this.windowWait(message);
      this.onLine(message);
    };
    this.child = spawn(this.exe, ['--serve', `--out-dir=${this.shots}`], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          dispatch(JSON.parse(line));
        } catch {
          dispatch({ type: 'log', message: line });
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) dispatch({ type: 'log', message });
    });
    this.child.on('exit', () => {
      this.child = null;
      markReady();
    });
    await Promise.race([
      ready,
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    this.rebind(chords);
  }

  send(line) {
    if (!this.child?.stdin.writable) return false;
    this.child.stdin.write(`${line}\n`);
    return true;
  }

  rebind(chords) {
    this.send(`REBIND ${JSON.stringify(chords)}`);
  }

  toggleExternal(url) {
    this.send(`TOGGLE ${url}`);
  }

  windowOp(action) {
    return new Promise((resolve) => {
      const done = (payload) => {
        if (this.windowWait !== done) return;
        this.windowWait = null;
        resolve(payload || { ok: true });
      };
      this.windowWait = done;
      if (!this.send(`WINDOW ${String(action || '').trim()}`)) {
        this.windowWait = null;
        resolve({ ok: false, error: '窗口组件未运行' });
        return;
      }
      setTimeout(() => done({ ok: true }), 400);
    });
  }

  capture(mode) {
    return new Promise((resolve) => {
      if (!fs.existsSync(this.exe)) {
        resolve({ ok: false, error: '截图组件还没有编译好' });
        return;
      }
      const child = spawn(this.exe, ['--capture', mode, `--out-dir=${this.shots}`], {
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (buf) => { out += buf.toString('utf8'); });
      child.stderr.on('data', (buf) => { err += buf.toString('utf8'); });
      child.on('error', (error) => resolve({ ok: false, error: error.message }));
      child.on('close', () => {
        const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
        if (!line) {
          resolve({ ok: false, error: err.trim() || '截图没有返回结果' });
          return;
        }
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, error: line });
        }
      });
    });
  }

  async compile() {
    const sourceTime = fs.statSync(this.source).mtimeMs;
    if (fs.existsSync(this.exe) && fs.statSync(this.exe).mtimeMs >= sourceTime) return;
    const fw = frameworkDir();
    if (!fw) throw new Error('没有找到 .NET Framework 编译器');
    const csc = path.join(fw, 'csc.exe');
    const refs = ['System.Windows.Forms.dll', 'System.Drawing.dll'].map((name) => `/reference:${path.join(fw, name)}`);
    const icon = path.join(this.extensionPath, 'native', 'toolkit.ico');
    await new Promise((resolve, reject) => {
      const child = spawn(csc, [
        '/nologo',
        '/optimize+',
        '/target:winexe',
        ...refs,
        ...(fs.existsSync(icon) ? [`/win32icon:${icon}`] : []),
        `/out:${this.exe}`,
        this.source,
      ], { windowsHide: true });
      let err = '';
      child.stderr.on('data', (buf) => { err += buf.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(this.exe)) resolve();
        else reject(new Error(err.trim() || `csc 退出码 ${code}`));
      });
    });
  }

  dispose() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.write('QUIT\n'); } catch { /* already gone */ }
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 400);
  }
}

function frameworkDir() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'csc.exe'))) || null;
}

module.exports = { Host };
