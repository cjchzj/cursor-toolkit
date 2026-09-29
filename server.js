const fs = require('fs');
const path = require('path');

function startServer({ token, mediaDir, api }) {
  const server = http();
  function http() {
    return require('http').createServer((req, res) => {
      handle(req, res).catch((error) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        sendJson(res, 500, { error: '服务出错' });
        api.log?.(error.message || String(error));
      });
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      writeHead(res, 204, {});
      res.end();
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/toolkit.ico' || url.pathname === '/favicon.ico')) {
      writeHead(res, 200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
      res.end(fs.readFileSync(path.join(mediaDir, 'toolkit.ico')));
      return;
    }
    if (!authorized(req, url)) {
      sendJson(res, 401, { error: '未授权' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/refresh') {
      await api.refresh();
      sendJson(res, 200, api.state());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => api.shutdown?.(), 50);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/widget-ready') {
      api.widgetReady();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      await api.wait(Number(url.searchParams.get('since') ?? -1));
      sendJson(res, 200, api.state());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      sendJson(res, 200, { messages: api.history() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const file = api.file(url.searchParams.get('id'));
      if (!file) {
        writeHead(res, 404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      writeHead(res, 200, {
        'Content-Type': file.mime || 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
      });
      res.end(file.buffer);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/float') {
      const html = fs.readFileSync(path.join(mediaDir, 'float.html'), 'utf8').replace(/__TOKEN__/g, token);
      writeHead(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/float.css' || url.pathname === '/float.js')) {
      const file = url.pathname === '/float.css' ? 'float.css' : 'float.js';
      const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      writeHead(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(mediaDir, file)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/float') {
      const body = await readJson(req);
      api.setFloat(Boolean(body.open));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/pin') {
      api.pin();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shot') {
      const body = await readJson(req);
      const result = await api.shot(body.mode === 'scroll' ? 'scroll' : 'region');
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const body = await readJson(req, 20 * 1024 * 1024);
      const buffer = Buffer.from(String(body.data || ''), 'base64');
      if (!buffer.length || buffer.length > 15 * 1024 * 1024) {
        sendJson(res, 400, { error: '文件为空或超过 15MB' });
        return;
      }
      const meta = api.upload(String(body.name || 'file'), String(body.mime || 'application/octet-stream'), buffer);
      sendJson(res, 200, meta);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/attachment/remove') {
      const body = await readJson(req);
      api.removeAttachment(String(body.id || ''));
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/library/toggle') {
      const body = await readJson(req);
      const result = await api.toggleLibrary(body);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shortcuts') {
      const body = await readJson(req);
      try {
        await api.shortcuts(body);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error.message || '快捷键没保存' });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readJson(req, 2 * 1024 * 1024);
      writeHead(res, 200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const ac = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      try {
        const result = await api.chat(body, (delta) => {
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }, ac.signal);
        res.write(`data: ${JSON.stringify({ done: true, ...result })}\n\n`);
      } catch (error) {
        const message = error?.message || '对话失败';
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      }
      res.end();
      return;
    }
    sendJson(res, 404, { error: '没有这个接口' });
  }

  function authorized(req, url) {
    const got = String(req.headers['x-toolkit-token'] || url.searchParams.get('token') || '');
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    return a.length === b.length && require('crypto').timingSafeEqual(a, b);
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        close: () => server.close(),
      });
    });
  });
}

function writeHead(res, status, headers) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-toolkit-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function sendJson(res, status, body) {
  writeHead(res, status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit) {
  return readBody(req, limit || 1024 * 1024).then((buf) => JSON.parse(buf.toString('utf8') || '{}'));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('内容太大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = { startServer };
