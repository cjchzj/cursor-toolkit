const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PY = `
import json, shutil, sqlite3, sys, tempfile
from pathlib import Path

db = Path(sys.argv[1])
keys = ("cursorAuth/accessToken", "cursorAuth/refreshToken", "cursorAuth/cachedEmail")

def query(path):
    uri = "file:" + Path(path).resolve().as_posix() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    try:
        out = {}
        for key in keys:
            row = con.execute("SELECT value FROM ItemTable WHERE key = ?", (key,)).fetchone()
            if row and row[0]:
                out[key] = row[0]
        return out
    finally:
        con.close()

def main():
    data = {}
    tmp = Path(tempfile.mkdtemp(prefix="ctk-"))
    try:
        try:
            target = tmp / "state.vscdb"
            shutil.copy2(db, target)
            for suffix in ("-wal", "-shm"):
                side = Path(str(db) + suffix)
                if side.exists():
                    shutil.copy2(side, tmp / ("state.vscdb" + suffix))
            data = query(target)
        except Exception:
            data = query(db)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    token = data.get("cursorAuth/accessToken") or ""
    if not token:
        sys.exit(2)
    sys.stdout.write(json.dumps({
        "accessToken": token,
        "email": data.get("cursorAuth/cachedEmail") or ""
    }))

if __name__ == "__main__":
    main()
`;

function pythonCandidates() {
  const home = process.env.USERPROFILE || os.homedir();
  return [
    { cmd: 'py', args: ['-3'] },
    { cmd: 'python', args: [] },
    { cmd: 'python3', args: [] },
    { cmd: path.join(home, 'anaconda3', 'python.exe'), args: [] },
    { cmd: path.join(home, 'miniconda3', 'python.exe'), args: [] },
    { cmd: path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'), args: [] },
    { cmd: path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'), args: [] },
    { cmd: path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'), args: [] },
  ];
}

function runPython(dbPath) {
  const candidates = pythonCandidates().filter((item) => !item.cmd.includes('\\') || fs.existsSync(item.cmd));
  return new Promise((resolve) => {
    const next = () => {
      const item = candidates.shift();
      if (!item) {
        resolve(null);
        return;
      }
      let out = '';
      let child;
      try {
        child = spawn(item.cmd, [...item.args, '-c', PY, dbPath], { windowsHide: true });
      } catch {
        next();
        return;
      }
      child.stdout.on('data', (buf) => { out += buf.toString('utf8'); });
      child.on('error', () => next());
      child.on('close', (code) => {
        if (code !== 0 || !out.trim()) {
          next();
          return;
        }
        try {
          resolve(JSON.parse(out));
        } catch {
          next();
        }
      });
    };
    next();
  });
}

function decodeJwt(token) {
  const part = String(token).split('.')[1];
  if (!part) return null;
  try {
    const pad = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function sessionFromToken(token) {
  const payload = decodeJwt(token);
  const sub = String(payload?.sub || '');
  const userId = sub.includes('|') ? sub.split('|').pop() : sub;
  if (!userId) return null;
  return {
    token,
    userId,
    cookie: `${userId}%3A%3A${token}`,
  };
}

function scanToken(dbPath) {
  let fd;
  try {
    fd = fs.openSync(dbPath, 'r');
    const size = fs.fstatSync(fd).size;
    const step = 1024 * 1024;
    let carry = '';
    let best = null;
    let bestScore = -1;
    const key = 'cursorAuth/accessToken';
    for (let off = 0; off < size; off += step) {
      const len = Math.min(step, size - off);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      const text = carry + buf.toString('latin1');
      const keyAt = text.indexOf(key);
      const re = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
      let match;
      while ((match = re.exec(text))) {
        const token = match[0];
        const payload = decodeJwt(token);
        const sub = String(payload?.sub || '');
        if (!sub) continue;
        let score = 1;
        if (/user_/i.test(sub) || /cursor/i.test(sub)) score += 5;
        if (keyAt >= 0) score += Math.max(0, 8 - Math.abs(match.index - keyAt) / 500);
        if (score > bestScore) {
          bestScore = score;
          best = token;
        }
      }
      carry = text.slice(-8000);
    }
    return best;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

async function readSession(dbPath) {
  const fromPy = await runPython(dbPath);
  const token = fromPy?.accessToken || scanToken(dbPath);
  if (!token) return null;
  const session = sessionFromToken(token);
  if (!session) return null;
  session.email = fromPy?.email || '';
  return session;
}

module.exports = { readSession };
