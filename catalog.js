const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DISABLED_KEY = 'extensionsIdentifiers/disabled';
const SELF_ID = 'ming.cursor-toolkit';

function listLibrary(workspaceFolders, dbPath) {
  const plugins = [...listCursorPlugins(workspaceFolders), ...listExtensions(dbPath)];
  plugins.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const skills = listSkills(workspaceFolders);
  return { plugins, skills, note: '' };
}

function toggleItem(body, workspaceFolders, dbPath) {
  const kind = String(body.kind || '');
  const id = String(body.id || '');
  const enabled = Boolean(body.enabled);
  if (kind === 'skill') return toggleSkill(id, enabled, workspaceFolders);
  if (kind === 'plugin') return togglePlugin(id, enabled, workspaceFolders);
  if (kind === 'extension') return toggleExtension(id, enabled, dbPath);
  return { ok: false, error: '不认识这个开关' };
}

function listSkills(workspaceFolders) {
  const items = [];
  for (const root of skillRoots(workspaceFolders)) {
    if (!fs.existsSync(root.dir)) continue;
    let names = [];
    try {
      names = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root.dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const meta = parseFrontmatter(text);
      items.push({
        kind: 'skill',
        id: file,
        name: clip(meta.name || entry.name, 48),
        description: clip(meta.description || '', 80),
        source: root.source,
        enabled: !isTrue(meta['disable-model-invocation']),
      });
    }
  }
  const rank = { 我的: 0, 项目: 1, 内置: 2 };
  items.sort((a, b) => (rank[a.source] - rank[b.source]) || a.name.localeCompare(b.name, 'zh'));
  return items;
}

function listCursorPlugins(workspaceFolders) {
  const items = [];
  for (const root of pluginRoots(workspaceFolders)) {
    collectPluginDir(path.join(root, 'local'), true, items);
    collectPluginDir(path.join(root, 'disabled'), false, items);
  }
  return items;
}

function collectPluginDir(dir, enabled, items) {
  if (!fs.existsSync(dir)) return;
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = path.join(dir, entry.name);
    const meta = readPluginMeta(folder);
    items.push({
      kind: 'plugin',
      id: folder,
      name: clip(meta.name, 48),
      description: clip(meta.description, 80),
      source: '本地',
      enabled,
    });
  }
}

function listExtensions(dbPath) {
  const root = path.join(os.homedir(), '.cursor', 'extensions');
  if (!fs.existsSync(root)) return [];
  const disabled = new Set(readDisabled(dbPath).map((item) => String(item.id || '').toLowerCase()));
  const installed = readInstalled(root);
  const seen = new Set();
  const items = [];
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders = names.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const preferred = new Map();
  for (const item of installed) {
    if (item.relativeLocation) preferred.set(item.id.toLowerCase(), item.relativeLocation);
  }
  for (const folder of folders) {
    const pkgPath = path.join(root, folder, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.publisher || !pkg.name) continue;
    const id = `${pkg.publisher}.${pkg.name}`;
    if (id.toLowerCase() === SELF_ID) continue;
    const chosen = preferred.get(id.toLowerCase());
    if (chosen && chosen !== folder) continue;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const uuid = installed.find((item) => item.id.toLowerCase() === id.toLowerCase())?.uuid || '';
    items.push({
      kind: 'extension',
      id,
      uuid,
      name: clip(textValue(pkg.displayName) || pkg.name, 48),
      description: clip(textValue(pkg.description), 80),
      source: '扩展',
      enabled: !disabled.has(id.toLowerCase()),
    });
  }
  return items;
}

function toggleSkill(file, enabled, workspaceFolders) {
  const target = path.resolve(file);
  const allowed = skillRoots(workspaceFolders).some((root) => isInside(target, root.dir) && path.basename(target) === 'SKILL.md');
  if (!allowed) return { ok: false, error: '这个技能不在可管理的目录里' };
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (error) {
    return { ok: false, error: error.message || '读不到技能文件' };
  }
  try {
    writeAtomic(target, setDisableModelInvocation(text, !enabled));
  } catch (error) {
    return { ok: false, error: error.message || '写不了技能文件' };
  }
  return { ok: true };
}

function togglePlugin(folder, enabled, workspaceFolders) {
  const target = path.resolve(folder);
  const roots = pluginRoots(workspaceFolders);
  const parent = path.dirname(target);
  const parentName = path.basename(parent);
  const base = path.dirname(parent);
  const allowed = roots.some((root) => path.resolve(root) === path.resolve(base) && (parentName === 'local' || parentName === 'disabled'));
  if (!allowed) return { ok: false, error: '这个插件不在可管理的目录里' };
  const destParent = path.join(base, enabled ? 'local' : 'disabled');
  const dest = path.join(destParent, path.basename(target));
  if (path.resolve(dest) === target) return { ok: true };
  try {
    fs.mkdirSync(destParent, { recursive: true });
    if (fs.existsSync(dest)) return { ok: false, error: '目标位置已经有同名插件' };
    fs.renameSync(target, dest);
  } catch (error) {
    return { ok: false, error: error.message || '移动插件失败' };
  }
  return { ok: true };
}

function toggleExtension(id, enabled, dbPath) {
  const clean = String(id || '').trim();
  if (!clean || clean.toLowerCase() === SELF_ID) return { ok: false, error: '这个扩展不能从这里关' };
  if (!dbPath || !fs.existsSync(dbPath)) return { ok: false, error: '找不到 Cursor 的扩展状态' };
  const current = readDisabled(dbPath);
  const exists = current.some((item) => String(item.id || '').toLowerCase() === clean.toLowerCase());
  let next = current;
  if (enabled && exists) next = current.filter((item) => String(item.id || '').toLowerCase() !== clean.toLowerCase());
  if (!enabled && !exists) {
    const uuid = uuidFor(clean);
    next = current.concat([uuid ? { id: clean, uuid } : { id: clean }]);
  }
  try {
    writeDisabled(dbPath, next);
  } catch (error) {
    return { ok: false, error: error.message || '写不了扩展状态' };
  }
  return { ok: true, reload: true };
}

function skillRoots(workspaceFolders) {
  const home = path.join(os.homedir(), '.cursor');
  const roots = [
    { dir: path.join(home, 'skills'), source: '我的' },
    { dir: path.join(home, 'skills-cursor'), source: '内置' },
  ];
  for (const folder of workspaceFolders || []) {
    roots.push({ dir: path.join(folder, '.cursor', 'skills'), source: '项目' });
    roots.push({ dir: path.join(folder, '.agents', 'skills'), source: '项目' });
  }
  return roots;
}

function pluginRoots(workspaceFolders) {
  const roots = [path.join(os.homedir(), '.cursor', 'plugins')];
  for (const folder of workspaceFolders || []) roots.push(path.join(folder, '.cursor', 'plugins'));
  return roots;
}

function readPluginMeta(folder) {
  const files = [
    path.join(folder, '.cursor-plugin', 'plugin.json'),
    path.join(folder, 'plugin.json'),
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        name: textValue(json.displayName) || textValue(json.name) || path.basename(folder),
        description: textValue(json.description),
      };
    } catch {
      break;
    }
  }
  return { name: path.basename(folder), description: '' };
}

function readInstalled(root) {
  const file = path.join(root, 'extensions.json');
  if (!fs.existsSync(file)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.map((item) => ({
      id: item?.identifier?.id || '',
      uuid: item?.identifier?.uuid || '',
      relativeLocation: item?.relativeLocation || '',
    })).filter((item) => item.id);
  } catch {
    return [];
  }
}

function uuidFor(id) {
  const root = path.join(os.homedir(), '.cursor', 'extensions');
  return readInstalled(root).find((item) => item.id.toLowerCase() === id.toLowerCase())?.uuid || '';
}

function readDisabled(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  try {
    return openDb(dbPath, (db) => {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(DISABLED_KEY);
      if (!row || row.value == null) return [];
      const text = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
      const parsed = JSON.parse(text || '[]');
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.id) : [];
    });
  } catch {
    return readDisabledPython(dbPath);
  }
}

function writeDisabled(dbPath, items) {
  const payload = JSON.stringify(items.map((item) => (item.uuid ? { id: item.id, uuid: item.uuid } : { id: item.id })));
  try {
    openDb(dbPath, (db) => {
      const existing = db.prepare('SELECT key FROM ItemTable WHERE key = ?').get(DISABLED_KEY);
      if (!items.length) {
        if (existing) db.prepare('DELETE FROM ItemTable WHERE key = ?').run(DISABLED_KEY);
        return;
      }
      if (existing) db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(payload, DISABLED_KEY);
      else db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(DISABLED_KEY, payload);
    });
  } catch (error) {
    if (!/node:sqlite|Cannot find module/.test(String(error && error.message))) throw error;
    writeDisabledPython(dbPath, payload, items.length === 0);
  }
}

function openDb(dbPath, fn) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { timeout: 3000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readDisabledPython(dbPath) {
  const script = [
    'import sqlite3, sys',
    'con = sqlite3.connect(sys.argv[1])',
    'row = con.execute("SELECT value FROM ItemTable WHERE key = ?", (sys.argv[2],)).fetchone()',
    'sys.stdout.write(row[0] if row and row[0] is not None else "[]")',
  ].join('\n');
  const result = runPython(script, [dbPath, DISABLED_KEY]);
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.id) : [];
  } catch {
    return [];
  }
}

function writeDisabledPython(dbPath, payload, remove) {
  const script = [
    'import sqlite3, sys',
    'con = sqlite3.connect(sys.argv[1])',
    'key, mode, payload = sys.argv[2], sys.argv[3], sys.argv[4]',
    'if mode == "delete":',
    '    con.execute("DELETE FROM ItemTable WHERE key = ?", (key,))',
    'elif con.execute("SELECT 1 FROM ItemTable WHERE key = ?", (key,)).fetchone():',
    '    con.execute("UPDATE ItemTable SET value = ? WHERE key = ?", (payload, key))',
    'else:',
    '    con.execute("INSERT INTO ItemTable (key, value) VALUES (?, ?)", (key, payload))',
    'con.commit()',
  ].join('\n');
  const result = runPython(script, [dbPath, DISABLED_KEY, remove ? 'delete' : 'write', payload]);
  if (!result.ok) throw new Error('写不了扩展状态');
}

function runPython(script, args) {
  const file = path.join(os.tmpdir(), `cursor-toolkit-${process.pid}.py`);
  fs.writeFileSync(file, script);
  const commands = [['py', '-3'], ['python'], ['python3']];
  try {
    for (const command of commands) {
      const result = spawnSync(command[0], [...command.slice(1), file, ...args], { encoding: 'utf8' });
      if (result.status === 0) return { ok: true, stdout: result.stdout };
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  return { ok: false, stdout: '' };
}

function parseFrontmatter(text) {
  const match = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i += 1) {
    const found = lines[i].match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (!found) continue;
    let value = found[2].trim();
    if (value === '>' || value === '>-' || value === '|' || value === '|-') {
      const folded = [];
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
        i += 1;
        folded.push(lines[i].trim());
      }
      value = folded.join(' ').trim();
    } else {
      value = value.replace(/^['"]|['"]$/g, '');
    }
    data[found[1]] = value;
  }
  return data;
}

function setDisableModelInvocation(text, disabled) {
  const normalized = String(text).replace(/^\uFEFF/, '');
  const nl = normalized.includes('\r\n') ? '\r\n' : '\n';
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    if (!disabled) return normalized;
    return `---${nl}disable-model-invocation: true${nl}---${nl}${nl}${normalized}`;
  }
  const lines = match[1].split(/\r?\n/).filter((line) => !/^\s*disable-model-invocation\s*:/.test(line));
  if (disabled) lines.push('disable-model-invocation: true');
  const front = `---${nl}${lines.join(nl)}${nl}---`;
  return front + normalized.slice(match[0].length);
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.copyFileSync(tmp, file);
  fs.rmSync(tmp, { force: true });
}

function isInside(file, root) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isTrue(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function textValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value['zh-cn'] || value.zh || value.en || Object.values(value).find((item) => typeof item === 'string') || '';
  return '';
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

module.exports = {
  listLibrary,
  toggleItem,
  parseFrontmatter,
  setDisableModelInvocation,
};
