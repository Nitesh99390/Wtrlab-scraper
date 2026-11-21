// Tiny fake Telegram Bot API used for offline smoke tests:  node scripts/mock-telegram.mjs [port]
import http from 'node:http';
const port = Number(process.argv[2] || 8081);
const updates = [];
const sent = [];
let uid = 1;
const send = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url;
    if (url === '/_inject') { const u = JSON.parse(body); u.update_id = uid++; updates.push(u); return send(res, { ok: true }); }
    if (url === '/_sent') return send(res, sent);
    const method = url.split('/').pop();
    let data = {};
    try { data = body.startsWith('{') ? JSON.parse(body) : { multipart: true, size: body.length }; } catch {}
    if (method !== 'getUpdates') sent.push({ method, ...data, multipart: undefined });
    if (method === 'getMe') return send(res, { ok: true, result: { id: 1, username: 'mock_bot' } });
    if (method === 'getUpdates') {
      const off = data.offset || 0;
      const out = updates.filter((u) => u.update_id >= off);
      if (out.length) return send(res, { ok: true, result: out });
      return setTimeout(() => send(res, { ok: true, result: [] }), 1500);
    }
    if (method === 'sendMessage' || method === 'sendPhoto') return send(res, { ok: true, result: { message_id: uid++ } });
    return send(res, { ok: true, result: true });
  });
}).listen(port, () => console.log('mock telegram on', port));
