'use strict';
/**
 * x.erp 独立远程访问代理 / 隧道节点（无状态，不存数据库和云备份）
 * - NAS 主动连入 /tunnel (WebSocket)，向主云服务（阿里云）校验设备与密钥
 * - 外部访问 *.xerp.zhaoyoucai.xyz 时，查主云服务获取账号信息（短缓存 15s）后经隧道转发到 NAS
 */
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = +(process.env.TUNNEL_PORT || 8095);
const TUNNEL_DOMAIN = (process.env.TUNNEL_DOMAIN || 'xerp.zhaoyoucai.xyz').toLowerCase();
const CLOUD_API_ORIGIN = (process.env.CLOUD_API_ORIGIN || 'https://www.zhaoyoucai.xyz/xerp-cloud').replace(/\/+$/, '');
const INTERNAL_KEY = process.env.TUNNEL_INTERNAL_KEY || '';
const LOOKUP_TTL_MS = 60000;

const tunnels = new Map();       // account id -> { socket, slug, expires }
const tunnelPending = new Map(); // request id -> { res, timer }
const slugCache = new Map();     // slug -> { data, until }

function now() { return Math.floor(Date.now() / 1000); }
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'hex'), bb = Buffer.from(String(b || ''), 'hex');
    return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}
function body(req, max = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function wsFrame(payload, opcode = 1) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function wsSend(socket, obj) {
  try { socket.write(wsFrame(Buffer.from(JSON.stringify(obj)))); } catch (e) {}
}
function wsRead(socket, onMessage) {
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1], fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 30 * 1024 * 1024) { socket.destroy(); return; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (op === 0x8) { socket.end(); return; }
      if (op === 0x9) { try { socket.write(wsFrame(payload, 0xA)); } catch (e) {} continue; }
      if (op === 0xA) continue;
      if (fin && op === 0x1) onMessage(payload.toString('utf8'));
    }
  });
}

async function lookupSlug(slug) {
  const c = slugCache.get(slug);
  if (c && c.until > Date.now()) return c.data;
  const r = await fetch(`${CLOUD_API_ORIGIN}/api/internal/tunnel/lookup?slug=${encodeURIComponent(slug)}`, {
    headers: { 'X-Tunnel-Key': INTERNAL_KEY },
    signal: AbortSignal.timeout(5000),
  });
  const data = r.ok ? await r.json() : null;
  slugCache.set(slug, { data, until: Date.now() + (data ? LOOKUP_TTL_MS : 3000) });
  return data;
}

async function authTunnel(device, secret) {
  const r = await fetch(`${CLOUD_API_ORIGIN}/api/internal/tunnel/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tunnel-Key': INTERNAL_KEY },
    body: JSON.stringify({ device, secret }),
    signal: AbortSignal.timeout(5000),
  });
  return r.ok ? await r.json() : null;
}

async function remoteProxy(req, res, host) {
  const slug = host.split('.')[0].toLowerCase();
  let a;
  try { a = await lookupSlug(slug); }
  catch (e) { res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1>主服务校验失败</h1>'); }
  if (!a) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1>远程地址不存在</h1>'); }
  if (a.expires < now()) { res.writeHead(402, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1>远程访问已到期</h1><p>请在 x.erp 里续费。</p>'); }
  const tun = tunnels.get(a.id);
  if (!tun) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>远程访问离线</h1><p>NAS 上的 x.erp 没有连上云端。请确认 NAS 开机、x.erp 正在运行、远程访问已开启。</p>');
  }
  let reqBody;
  try { reqBody = await body(req, 25 * 1024 * 1024); }
  catch (e) { res.writeHead(413); return res.end('请求太大'); }
  const id = crypto.randomBytes(8).toString('hex');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive'].includes(k)) continue;
    headers[k] = v;
  }
  const item = { res, timer: null };
  item.timer = setTimeout(() => {
    tunnelPending.delete(id);
    if (!res.headersSent) { res.writeHead(504, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<h1>远程访问超时</h1>'); }
  }, 30000);
  tunnelPending.set(id, item);
  wsSend(tun.socket, { type: 'req', id, method: req.method, path: req.url, headers, body: reqBody.toString('base64') });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  try {
    if (host.endsWith('.' + TUNNEL_DOMAIN)) return await remoteProxy(req, res, host);
    if (req.method === 'GET' && (p === '/api/ping' || p === '/ping')) {
      return json(res, 200, { ok: true, app: 'XERP-TUNNEL', tunnels: tunnels.size });
    }
    if (req.method === 'GET' && p === '/api/tunnel/ask') {
      const domain = String(url.searchParams.get('domain') || '');
      const r = await fetch(`${CLOUD_API_ORIGIN}/api/tunnel/ask?domain=${encodeURIComponent(domain)}`, {
        signal: AbortSignal.timeout(5000),
      });
      res.writeHead(r.status === 200 ? 200 : 403, { 'Content-Type': 'text/plain' });
      return res.end(r.status === 200 ? 'ok' : 'no');
    }
    if (req.method === 'GET' && p === '/internal/online') {
      const k = String(req.headers['x-tunnel-key'] || '');
      if (!INTERNAL_KEY || !safeEqualHex(k, INTERNAL_KEY)) return json(res, 403, { error: 'forbidden' });
      return json(res, 200, { online: [...tunnels.keys()] });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    console.error(new Date().toISOString(), 'ERR', p, e.message);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('error'); }
  }
});

server.on('upgrade', async (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/tunnel') { socket.destroy(); return; }
  const device = String(u.searchParams.get('device') || '');
  const secret = String(u.searchParams.get('secret') || '');
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  let a;
  try { a = await authTunnel(device, secret); } catch (e) { a = null; }
  if (!a) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  if (head && head.length) socket.unshift(head);
  const old = tunnels.get(a.id);
  if (old && old.socket !== socket) { try { old.socket.destroy(); } catch (e) {} }
  tunnels.set(a.id, { socket, slug: a.slug, expires: a.expires });
  console.log(new Date().toISOString(), 'tunnel connected', a.id, a.slug);
  socket.on('error', () => {});
  socket.on('close', (code, reason) => {
    if (tunnels.get(a.id)?.socket === socket) {
      tunnels.delete(a.id);
      console.log(new Date().toISOString(), 'tunnel closed', a.id, code, String(reason || ''));
    }
  });
  wsRead(socket, text => {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.type === 'ping') { wsSend(socket, { type: 'pong' }); return; }
    if (msg.type !== 'res') return;
    const item = tunnelPending.get(msg.id);
    if (!item) return;
    tunnelPending.delete(msg.id);
    clearTimeout(item.timer);
    const res = item.res;
    if (res.writableEnded) return;
    const headers = msg.headers && typeof msg.headers === 'object' ? { ...msg.headers } : {};
    delete headers['transfer-encoding'];
    delete headers['content-length'];
    delete headers['connection'];
    delete headers['keep-alive'];
    let buf = Buffer.from(msg.body || '', 'base64');
    if (msg.gz) {
      try { buf = zlib.gunzipSync(buf); } catch (e) {}
      delete headers['content-encoding'];
    }
    headers['content-length'] = String(buf.length);
    try { res.writeHead(msg.status || 502, headers); res.end(buf); } catch (e) { try { res.end(); } catch (x) {} }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`x.erp tunnel node listening on 127.0.0.1:${PORT}, domain *.${TUNNEL_DOMAIN}, master ${CLOUD_API_ORIGIN}`);
});
