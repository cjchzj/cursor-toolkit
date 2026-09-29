const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function listCursorChats(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  try {
    return withDb(dbPath, (db) => readList(db));
  } catch (error) {
    if (!/node:sqlite|Cannot find module/.test(String(error && error.message))) return [];
    return listPython(dbPath);
  }
}

function readCursorThread(dbPath, composerId, limit) {
  if (!dbPath || !composerId || !fs.existsSync(dbPath)) {
    return { messages: [], tokensUsed: 0, tokenLimit: 256000, title: '' };
  }
  try {
    return withDb(dbPath, (db) => readThread(db, composerId, limit || 40));
  } catch (error) {
    if (!/node:sqlite|Cannot find module/.test(String(error && error.message))) {
      return { messages: [], tokensUsed: 0, tokenLimit: 256000, title: '' };
    }
    return threadPython(dbPath, composerId, limit || 40);
  }
}

function withDb(dbPath, fn) {
  const { DatabaseSync } = require('node:sqlite');
  try {
    const db = new DatabaseSync(dbPath, { timeout: 2500 });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return withCopy(dbPath, fn);
  }
}

function withCopy(dbPath, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctk-chats-'));
  const target = path.join(dir, 'state.vscdb');
  fs.copyFileSync(dbPath, target);
  for (const suffix of ['-wal', '-shm']) {
    const side = `${dbPath}${suffix}`;
    if (fs.existsSync(side)) fs.copyFileSync(side, `${target}${suffix}`);
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(target, { timeout: 3000 });
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function readList(db) {
  const rows = [];
  if (tableExists(db, 'composerHeaders')) {
    const found = db.prepare(`
      SELECT composerId, workspaceId, createdAt, lastUpdatedAt, recency, value
      FROM composerHeaders
      WHERE IFNULL(isArchived, 0) = 0 AND IFNULL(isSubagent, 0) = 0
      ORDER BY IFNULL(lastUpdatedAt, recency) DESC
      LIMIT 60
    `).all();
    rows.push(...found);
  }
  const seen = new Set();
  const list = [];
  for (const row of rows) {
    const id = String(row.composerId || '');
    if (!id || id === 'empty-state-draft' || seen.has(id)) continue;
    let head = {};
    try { head = JSON.parse(row.value || '{}'); } catch { head = {}; }
    if (head.isDraft || head.isEphemeral) continue;
    const data = kvJson(db, `composerData:${id}`);
    const title = String(head.name || data.name || '').trim();
    const count = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly.length : 0;
    if (!title && !count) continue;
    seen.add(id);
    list.push({
      id: `c:${id}`,
      composerId: id,
      title: title || '未命名对话',
      origin: 'cursor',
      mode: head.unifiedMode || data.unifiedMode || 'agent',
      fresh: count === 0,
      updatedAt: Number(row.lastUpdatedAt || row.recency || data.lastUpdatedAt || 0),
      tokensUsed: asNumber(data.contextTokensUsed),
      tokenLimit: asNumber(data.contextTokenLimit) || 256000,
    });
  }
  return list.slice(0, 40);
}

function readThread(db, composerId, limit) {
  const id = String(composerId || '').replace(/^c:/, '');
  const data = kvJson(db, `composerData:${id}`);
  const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  const messages = [];
  const start = Math.max(0, headers.length - 250);
  for (let i = headers.length - 1; i >= start && messages.length < limit; i -= 1) {
    const header = headers[i] || {};
    let text = headerPreview(header);
    if (!text) {
      const bubble = kvJson(db, `bubbleId:${id}:${header.bubbleId}`);
      text = bubbleText(bubble);
    }
    if (!text) continue;
    const role = Number(header.type) === 2 ? 'assistant' : 'user';
    messages.unshift({ role, text });
  }
  return {
    title: String(data.name || '').trim(),
    messages,
    tokensUsed: asNumber(data.contextTokensUsed) || 0,
    tokenLimit: asNumber(data.contextTokenLimit) || 256000,
  };
}

function kvJson(db, key) {
  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key);
    if (!row || row.value == null) return {};
    return typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  } catch {
    return {};
  }
}

function headerPreview(header) {
  if (!header || typeof header !== 'object') return '';
  const preview = header.grouping && header.grouping.textPreview;
  if (typeof preview === 'string' && preview.trim()) return preview.trim();
  if (typeof header.textPreview === 'string' && header.textPreview.trim()) return header.textPreview.trim();
  return '';
}

function bubbleText(bubble) {
  if (!bubble || typeof bubble !== 'object') return '';
  const direct = [bubble.text, bubble.richText, bubble.rawText, bubble.content]
    .find((value) => typeof value === 'string' && value.trim());
  if (direct) return String(direct).trim();
  const parts = bubble.parts || bubble.messages || [];
  if (Array.isArray(parts)) {
    const text = parts.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n').trim();
    if (text) return text;
  }
  return '';
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function listPython(dbPath) {
  const script = [
    'import json, sqlite3, sys',
    'con = sqlite3.connect(sys.argv[1])',
    'rows = []',
    'try:',
    '  cur = con.execute("SELECT composerId, lastUpdatedAt, recency, value FROM composerHeaders WHERE IFNULL(isArchived,0)=0 AND IFNULL(isSubagent,0)=0 ORDER BY IFNULL(lastUpdatedAt, recency) DESC LIMIT 60")',
    '  rows = cur.fetchall()',
    'except Exception:',
    '  rows = []',
    'out = []',
    'seen = set()',
    'for cid, updated, recency, raw in rows:',
    '  if not cid or cid == "empty-state-draft" or cid in seen: continue',
    '  try: head = json.loads(raw or "{}")',
    '  except Exception: head = {}',
    '  if head.get("isDraft") or head.get("isEphemeral"): continue',
    '  row = con.execute("SELECT value FROM cursorDiskKV WHERE key=?", ("composerData:"+cid,)).fetchone()',
    '  data = {}',
    '  if row and row[0]:',
    '    try: data = json.loads(row[0])',
    '    except Exception: data = {}',
    '  title = (head.get("name") or data.get("name") or "").strip()',
    '  count = len(data.get("fullConversationHeadersOnly") or [])',
    '  if not title and not count: continue',
    '  seen.add(cid)',
    '  out.append({"id": "c:"+cid, "composerId": cid, "title": title or "未命名对话", "origin": "cursor", "mode": head.get("unifiedMode") or "agent", "fresh": count == 0, "updatedAt": int(updated or recency or 0), "tokensUsed": data.get("contextTokensUsed") or 0, "tokenLimit": data.get("contextTokenLimit") or 256000})',
    'sys.stdout.write(json.dumps(out[:40], ensure_ascii=False))',
  ].join('\n');
  const result = runPython(script, [dbPath]);
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function threadPython(dbPath, composerId, limit) {
  const script = [
    'import json, sqlite3, sys',
    'con = sqlite3.connect(sys.argv[1])',
    'cid, limit = sys.argv[2], int(sys.argv[3])',
    'row = con.execute("SELECT value FROM cursorDiskKV WHERE key=?", ("composerData:"+cid,)).fetchone()',
    'data = json.loads(row[0]) if row and row[0] else {}',
    'headers = data.get("fullConversationHeadersOnly") or []',
    'messages = []',
    'i = len(headers) - 1',
    'while i >= 0 and len(messages) < limit:',
    '  header = headers[i]; i -= 1',
    '  bid = header.get("bubbleId")',
    '  brow = con.execute("SELECT value FROM cursorDiskKV WHERE key=?", ("bubbleId:%s:%s" % (cid, bid),)).fetchone()',
    '  bubble = json.loads(brow[0]) if brow and brow[0] else {}',
    '  text = bubble.get("text") or bubble.get("richText") or ""',
    '  if not str(text).strip(): continue',
    '  role = "assistant" if int(bubble.get("type") or header.get("type") or 0) == 2 else "user"',
    '  messages.insert(0, {"role": role, "text": str(text).strip()})',
    'sys.stdout.write(json.dumps({"title": (data.get("name") or "").strip(), "messages": messages, "tokensUsed": data.get("contextTokensUsed") or 0, "tokenLimit": data.get("contextTokenLimit") or 256000}, ensure_ascii=False))',
  ].join('\n');
  const result = runPython(script, [dbPath, String(composerId).replace(/^c:/, ''), String(limit)]);
  if (!result.ok) return { messages: [], tokensUsed: 0, tokenLimit: 256000, title: '' };
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    return { messages: [], tokensUsed: 0, tokenLimit: 256000, title: '' };
  }
}

function runPython(script, args) {
  const file = path.join(os.tmpdir(), `cursor-toolkit-chats-${process.pid}.py`);
  fs.writeFileSync(file, script);
  const commands = [['py', '-3'], ['python'], ['python3']];
  try {
    for (const command of commands) {
      const result = spawnSync(command[0], [...command.slice(1), file, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      if (result.status === 0) return { ok: true, stdout: result.stdout };
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  return { ok: false, stdout: '' };
}

module.exports = { listCursorChats, readCursorThread };
