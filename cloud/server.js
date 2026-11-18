'use strict';
/**
 * x.erp 云备份服务（部署在作者服务器，不随客户端分发）
 * - 客户在 x.erp 里输入授权码 → 开通容量和有效期
 * - 客户端在本机加密后上传，服务器只存密文，看不到业务数据
 * - 容量、到期、保留份数全部在服务端校验
 *
 * 用法：node server.js
 * 环境变量：CLOUD_DIR、CLOUD_PORT、CLOUD_ADMIN_PASSWORD、CLOUD_TOTAL_QUOTA、CLOUD_BASE
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DIR = process.env.CLOUD_DIR || '/var/lib/xerp-cloud';
const PORT = +(process.env.CLOUD_PORT || 8095);
const BASE = (process.env.CLOUD_BASE || 'https://www.zhaoyoucai.xyz/xerp-cloud').replace(/\/+$/, '');
const TOTAL_QUOTA = +(process.env.CLOUD_TOTAL_QUOTA || 12 * 1024 ** 3);
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || 'xerp.zhaoyoucai.xyz';
const BLOB_DIR = path.join(DIR, 'blobs');
const DB_FILE = path.join(DIR, 'cloud.db');
const PW_FILE = path.join(DIR, 'admin.pw');
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MAX_UPLOAD = 200 * MB;

fs.mkdirSync(BLOB_DIR, { recursive: true });

// 二维码/订单有效期 5 分钟；匹配和作废多给 60 秒宽限，防止到账通知晚到
const ORDER_TTL = 300;
const MATCH_TTL = 360;

const PLANS = {
  basic: { name: '基础版', quota: 1 * GB, days: 30, max: 7, price: 2 },
  plus: { name: '标准版', quota: 5 * GB, days: 30, max: 15, price: 3 },
  pro: { name: '专业版', quota: 10 * GB, days: 30, max: 30, price: 5 },
};

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, device TEXT NOT NULL UNIQUE, name TEXT,
    plan TEXT NOT NULL, quota INTEGER NOT NULL, expires INTEGER NOT NULL,
    created INTEGER NOT NULL, last_seen INTEGER, note TEXT
  );
  CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
    sha256 TEXT, created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_backups_account ON backups (account, created DESC);
  CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY, plan TEXT NOT NULL, days INTEGER NOT NULL, quota INTEGER NOT NULL,
    maxb INTEGER NOT NULL, created INTEGER NOT NULL, used_by TEXT, used_at INTEGER,
    order_no TEXT, note TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, plan TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL,
    created INTEGER NOT NULL, paid INTEGER, channel TEXT, code TEXT, contact TEXT
  );
  CREATE TABLE IF NOT EXISTS relays (
    id TEXT PRIMARY KEY, name TEXT, secret TEXT NOT NULL, created INTEGER NOT NULL,
    last_seen INTEGER, enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS relay_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, relay TEXT, amount INTEGER, source TEXT,
    text TEXT, at INTEGER, matched TEXT
  );
`);
for (const col of ['slug', 'tunnel_hash']) {
  try { db.exec(`ALTER TABLE accounts ADD COLUMN ${col} TEXT`); } catch (e) {}
}
const tunnels = new Map();   // account id -> { socket }
const tunnelPending = new Map(); // request id -> { res, timer }

function now() { return Math.floor(Date.now() / 1000); }
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function fail(res, code, msg) { json(res, code, { error: msg }); }
function fmtBytes(n) {
  if (n >= GB) return (n / GB).toFixed(n % GB ? 1 : 0) + ' GB';
  if (n >= MB) return (n / MB).toFixed(n % MB ? 1 : 0) + ' MB';
  return Math.ceil(n / 1024) + ' KB';
}
function fmtTime(ts) { return ts ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : ''; }

function hashPw(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.pbkdf2Sync(String(pw), Buffer.from(salt, 'hex'), 200000, 32, 'sha256').toString('hex');
  return `pbkdf2$200000$${salt}$${h}`;
}
function checkPw(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 4) return false;
  const h = crypto.pbkdf2Sync(String(pw), Buffer.from(p[2], 'hex'), +p[1], 32, 'sha256');
  const want = Buffer.from(p[3], 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
if (process.argv[2] === 'setpw') {
  let pw = '';
  process.stdin.on('data', d => { pw += d; });
  process.stdin.on('end', () => {
    pw = pw.replace(/\r?\n$/, '');
    if (pw.length < 8) { console.error('密码至少 8 位'); process.exit(1); }
    fs.writeFileSync(PW_FILE, hashPw(pw));
    fs.chmodSync(PW_FILE, 0o600);
    console.log('admin password updated');
  });
  return;
}
if (!fs.existsSync(PW_FILE)) {
  const pw = process.env.CLOUD_ADMIN_PASSWORD;
  if (pw && pw.length >= 8) {
    fs.writeFileSync(PW_FILE, hashPw(pw));
    fs.chmodSync(PW_FILE, 0o600);
  } else {
    console.error('缺少后台密码：先执行 echo 密码 | node server.js setpw，或设置 CLOUD_ADMIN_PASSWORD');
    process.exit(1);
  }
}
const ADMIN_PW = fs.readFileSync(PW_FILE, 'utf8').trim();

function body(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('内容太大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function jsonBody(req) {
  const b = await body(req, 1 * MB);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch (e) { throw Object.assign(new Error('JSON 格式不正确'), { status: 400 }); }
}
async function formBody(req) {
  const b = await body(req, 1 * MB);
  return new URLSearchParams(b.toString('utf8'));
}
function tokenHash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function accountOf(req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const a = db.prepare('SELECT * FROM accounts WHERE token_hash = ?').get(tokenHash(m[1]));
  if (!a) return null;
  db.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(now(), a.id);
  return a;
}
function isAdmin(req) {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const s = Buffer.from(m[1], 'base64').toString('utf8');
  const i = s.indexOf(':');
  return i >= 0 && s.slice(0, i) === 'admin' && checkPw(s.slice(i + 1), ADMIN_PW);
}
function needAdmin(req, res) {
  if (isAdmin(req)) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x.erp cloud"' });
  res.end('需要登录');
  return false;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode() {
  const pick = n => Array.from({ length: n }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  return 'XERP-' + pick(4) + '-' + pick(4) + '-' + pick(4);
}
function accountUsage(account) {
  return db.prepare('SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS n FROM backups WHERE account = ?').get(account);
}
function createCode(planKey, note, orderNo) {
  const p = PLANS[planKey];
  if (!p) throw Object.assign(new Error('套餐不存在'), { status: 400 });
  let code;
  for (let i = 0; i < 10; i++) {
    code = randomCode();
    if (!db.prepare('SELECT 1 FROM codes WHERE code = ?').get(code)) break;
    code = null;
  }
  if (!code) throw new Error('生成授权码失败');
  db.prepare('INSERT INTO codes (code, plan, days, quota, maxb, created, order_no, note) VALUES (?,?,?,?,?,?,?,?)')
    .run(code, planKey, p.days, p.quota, p.max, now(), orderNo || null, note || null);
  return code;
}
function relayHmac(secret, msg) {
  return crypto.createHmac('sha256', String(secret)).update(String(msg)).digest('hex');
}
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex'), y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function relayOnline() {
  const t = db.prepare('SELECT MAX(last_seen) AS t FROM relays WHERE enabled = 1').get().t || 0;
  return { online: now() - t < 180, lastSeen: t || null };
}
function verifyRelay(b) {
  const r = db.prepare('SELECT * FROM relays WHERE id = ? AND enabled = 1').get(String(b.device || ''));
  if (!r) throw Object.assign(new Error('收款助手未注册或已停用'), { status: 403 });
  const at = +b.at;
  if (!at || Math.abs(now() - at) > 300) throw Object.assign(new Error('请求已过期，请检查手机时间'), { status: 400 });
  const want = relayHmac(r.secret, [b.device, b.source || '', b.amount || 0, at, b.nonce || ''].join('\n'));
  if (!safeEqualHex(want, b.sign)) throw Object.assign(new Error('签名不正确'), { status: 403 });
  db.prepare('UPDATE relays SET last_seen = ? WHERE id = ?').run(now(), r.id);
  return r;
}
function uniqueAmount(base) {
  const used = new Set(db.prepare("SELECT amount FROM orders WHERE status = 'pending' AND channel = 'relay' AND created > ?").all(now() - MATCH_TTL).map(r => r.amount));
  for (let i = 1; i <= 99; i++) if (!used.has(base + i)) return base + i;
  return base;
}
function sanitizeName(name) {
  return /^[A-Za-z0-9._-]{1,120}$/.test(name) ? name : null;
}
function accountBackupPath(account, id) { return path.join(BLOB_DIR, account, id + '.bin'); }

function activate(code, device, name, transfer = false) {
  code = String(code || '').trim().toUpperCase();
  device = String(device || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(device)) throw Object.assign(new Error('设备标识不正确'), { status: 400 });
  const c = db.prepare('SELECT * FROM codes WHERE code = ?').get(code);
  if (!c) throw Object.assign(new Error('授权码不存在，请检查是否输错'), { status: 404 });
  const p = PLANS[c.plan];
  if (!p) throw Object.assign(new Error('授权码套餐无效'), { status: 400 });
  let acc = db.prepare('SELECT * FROM accounts WHERE device = ?').get(device);
  let owner = c.used_by ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(c.used_by) : null;
  if (owner && owner.device !== device && !transfer) throw Object.assign(new Error('这个授权码已经绑定其他设备；如果是换机，请勾选“换机恢复”'), { status: 409 });
  const ts = now();
  const token = crypto.randomBytes(32).toString('hex');
  const baseAcc = owner && owner.device !== device ? owner : acc;
  const slug = baseAcc?.slug || crypto.randomBytes(5).toString('hex');
  const tunnelSecret = owner && owner.device !== device ? crypto.randomBytes(24).toString('hex') : (acc?.tunnel_hash ? null : crypto.randomBytes(24).toString('hex'));
  const tunnelHash = tunnelSecret ? crypto.createHash('sha256').update(tunnelSecret).digest('hex') : acc.tunnel_hash;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (owner && owner.device !== device) {
      if (!transfer) throw Object.assign(new Error('这个授权码已经绑定其他设备；如果是换机，请勾选“换机恢复”'), { status: 409 });
      db.prepare('UPDATE accounts SET device = ?, token_hash = ?, name = COALESCE(?, name), last_seen = ?, slug = COALESCE(slug, ?), tunnel_hash = ? WHERE id = ?')
        .run(device, tokenHash(token), String(name || '').slice(0, 60) || null, ts, slug, tunnelHash, owner.id);
      acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(owner.id);
      const oldTunnel = tunnels.get(owner.id);
      if (oldTunnel) { try { oldTunnel.socket.destroy(); } catch (e) {} tunnels.delete(owner.id); }
    } else if (!acc) {
      const id = 'acc_' + crypto.randomBytes(12).toString('hex');
      db.prepare('INSERT INTO accounts (id, token_hash, device, name, plan, quota, expires, created, last_seen, note, slug, tunnel_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, tokenHash(token), device, String(name || '').slice(0, 60) || null, c.plan, c.quota, ts + c.days * 86400, ts, ts, c.note || null, slug, tunnelHash);
      acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    } else {
      const base = Math.max(ts, acc.expires || 0);
      db.prepare('UPDATE accounts SET token_hash = ?, plan = ?, quota = MAX(quota, ?), expires = ?, name = COALESCE(?, name), slug = COALESCE(slug, ?), tunnel_hash = COALESCE(tunnel_hash, ?) WHERE id = ?')
        .run(tokenHash(token), c.plan, c.quota, base + c.days * 86400, String(name || '').slice(0, 60) || null, slug, tunnelHash, acc.id);
    }
    if (!c.used_by) db.prepare('UPDATE codes SET used_by = ?, used_at = ? WHERE code = ?').run(acc.id, ts, code);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const a = db.prepare('SELECT * FROM accounts WHERE device = ?').get(device);
  const u = accountUsage(a.id);
  return {
    token,
    account: {
      plan: a.plan, planName: PLANS[a.plan].name, quota: a.quota, expires: a.expires,
      used: u.used, backups: u.n, maxBackups: PLANS[a.plan].max, device: a.device, name: a.name,
    },
    slug: a.slug,
    tunnelSecret,
    transferred: !!(owner && owner.device !== device),
  };
}

function status(a) {
  const u = accountUsage(a.id);
  const list = db.prepare('SELECT id, name, size, sha256, created FROM backups WHERE account = ? ORDER BY created DESC').all(a.id);
  return {
    account: {
      plan: a.plan, planName: PLANS[a.plan]?.name || a.plan, quota: a.quota, expires: a.expires,
      used: u.used, backups: u.n, maxBackups: PLANS[a.plan]?.max || 10, device: a.device, name: a.name,
    },
    backups: list,
    remote: { url: a.slug ? `https://${a.slug}.${TUNNEL_DOMAIN}` : null, online: tunnels.has(a.id) },
    slug: a.slug,
  };
}

function prune(a) {
  const max = PLANS[a.plan]?.max || 10;
  const old = db.prepare('SELECT id FROM backups WHERE account = ? ORDER BY created DESC LIMIT -1 OFFSET ?').all(a.id, max);
  for (const r of old) {
    try { fs.unlinkSync(accountBackupPath(a.id, r.id)); } catch (e) {}
    db.prepare('DELETE FROM backups WHERE id = ?').run(r.id);
  }
}

async function upload(req, res, a, name) {
  if (!sanitizeName(name)) return fail(res, 400, '文件名不合法');
  if (a.expires < now()) return fail(res, 402, '云备份已到期，请续费后使用');
  const len = +(req.headers['content-length'] || 0);
  if (!len) return fail(res, 411, '缺少内容长度');
  if (len > MAX_UPLOAD) return fail(res, 413, '单个备份不能超过 200MB');
  const u = accountUsage(a.id);
  const old = db.prepare('SELECT id, size FROM backups WHERE account = ? AND name = ?').get(a.id, name);
  const delta = len - (old ? old.size : 0);
  if (u.used + delta > a.quota) return fail(res, 413, `云备份空间不足（已用 ${fmtBytes(u.used)} / ${fmtBytes(a.quota)}），请删除旧备份或升级套餐`);
  const allUsed = db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM backups').get().n;
  if (allUsed + delta > TOTAL_QUOTA) return fail(res, 507, '云端空间已满，请联系作者扩容');
  const buf = await body(req, MAX_UPLOAD);
  if (buf.length !== len) return fail(res, 400, '上传不完整');
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const want = String(req.headers['x-sha256'] || '').toLowerCase();
  if (want && want !== sha) return fail(res, 400, '校验失败，请重试');
  const id = old ? old.id : 'bk_' + crypto.randomBytes(12).toString('hex');
  const dir = path.join(BLOB_DIR, a.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, id + '.tmp');
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, accountBackupPath(a.id, id));
  if (old) {
    db.prepare('UPDATE backups SET size = ?, sha256 = ?, created = ? WHERE id = ?').run(buf.length, sha, now(), id);
  } else {
    db.prepare('INSERT INTO backups (id, account, name, size, sha256, created) VALUES (?,?,?,?,?,?)')
      .run(id, a.id, name, buf.length, sha, now());
  }
  prune(a);
  json(res, 200, { ok: true, id, size: buf.length, sha256: sha, ...status(a) });
}

function adminPage(req, res, flash) {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY created DESC').all().map(a => {
    const u = accountUsage(a.id);
    return { ...a, used: u.used, n: u.n };
  });
  const codes = db.prepare('SELECT * FROM codes ORDER BY created DESC LIMIT 40').all();
  const orders = db.prepare('SELECT * FROM orders ORDER BY created DESC LIMIT 20').all();
  const relays = db.prepare('SELECT * FROM relays ORDER BY created DESC').all();
  const relayLogs = db.prepare('SELECT * FROM relay_log ORDER BY id DESC LIMIT 30').all();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rowsA = accounts.map(a => `<tr><td>${esc(a.name || '未命名')}<br><small>${esc(a.device)}</small></td><td>${esc(PLANS[a.plan]?.name || a.plan)}</td><td>${fmtBytes(a.used)} / ${fmtBytes(a.quota)}</td><td>${esc(fmtTime(a.expires))}</td><td>${a.n}</td><td>${esc(fmtTime(a.last_seen))}</td></tr>`).join('');
  const rowsC = codes.map(c => `<tr><td><code>${esc(c.code)}</code></td><td>${esc(PLANS[c.plan]?.name || c.plan)}</td><td>${esc(c.used_by || '未使用')}</td><td>${esc(fmtTime(c.created))}</td><td>${esc(c.note || '')}</td></tr>`).join('');
  const rowsO = orders.map(o => `<tr><td>${esc(o.id)}</td><td>${esc(PLANS[o.plan]?.name || o.plan)}</td><td>¥${(o.amount / 100).toFixed(2)}</td><td>${esc(o.status)}</td><td>${esc(o.contact || '')}</td><td>${esc(o.code || '')}</td><td>${o.status === 'paid' ? '' : `<form method=post action="admin/order"><input type=hidden name=id value="${esc(o.id)}"><button>标记已付并发码</button></form>`}</td></tr>`).join('');
  const rowsR = relays.map(r => `<tr><td>${esc(r.name || '未命名')}<br><small>${esc(r.id)}</small></td><td>${now() - (r.last_seen || 0) < 180 ? '<b style="color:#16a34a">在线</b>' : '<span class=m>离线</span>'}</td><td>${esc(fmtTime(r.last_seen))}</td><td><form method=post action="admin/relay"><input type=hidden name=id value="${esc(r.id)}"><input type=hidden name=toggle value="1"><button>${r.enabled ? '停用' : '启用'}</button></form></td></tr>`).join('');
  const rowsL = relayLogs.map(l => `<tr><td>${esc(fmtTime(l.at))}</td><td>${esc(l.source || '')}</td><td>¥${((l.amount || 0) / 100).toFixed(2)}</td><td>${esc(l.matched || '未匹配')}</td><td style="max-width:360px;white-space:normal">${esc(l.text || '')}</td></tr>`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>x.erp 云备份后台</title>
<style>body{font:14px/1.6 system-ui,"Microsoft YaHei";margin:0;background:#f6f7fb;color:#1e293b}main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 10px}.m{color:#64748b}.c{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 10px 7px 0;border-bottom:1px solid #e2e8f0;white-space:nowrap}th{color:#64748b;font-weight:500;font-size:12px}code{background:#f1f5f9;padding:2px 5px;border-radius:4px}form.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:center}input,select,button{padding:7px 9px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff}button{background:#4f46e5;border-color:#4f46e5;color:#fff;cursor:pointer}small{color:#94a3b8}.flash{background:#dcfce7;border:1px solid #86efac;padding:10px 12px;border-radius:8px;margin:12px 0;white-space:pre-wrap}</style></head><body><main>
<h1>x.erp 云备份后台</h1><div class=m>当前共 ${accounts.length} 个账号，云端已用 ${fmtBytes(accounts.reduce((n, a) => n + a.used, 0))} / ${fmtBytes(TOTAL_QUOTA)}</div>
${flash ? `<div class=flash>${esc(flash)}</div>` : ''}
<h2>生成授权码</h2><div class=c><form class=inline method=post action="admin/code"><select name=plan>${Object.entries(PLANS).map(([k, p]) => `<option value=${k}>${p.name} · ${fmtBytes(p.quota)} / ${p.days} 天 · ¥${p.price}</option>`).join('')}</select><input name=count type=number value=1 min=1 max=20 style="width:70px"><input name=note placeholder="备注（客户/订单号）" style="min-width:200px"><button>生成</button></form></div>
<h2>授权码</h2><div class=c><table><tr><th>授权码</th><th>套餐</th><th>使用账号</th><th>生成时间</th><th>备注</th></tr>${rowsC || '<tr><td colspan=5 class=m>暂无</td></tr>'}</table></div>
<h2>云备份账号</h2><div class=c><table><tr><th>名称 / 设备</th><th>套餐</th><th>已用 / 容量</th><th>到期</th><th>份数</th><th>最近上报</th></tr>${rowsA || '<tr><td colspan=6 class=m>暂无</td></tr>'}</table></div>
<h2>订单</h2><div class=c><table><tr><th>订单号</th><th>套餐</th><th>金额</th><th>状态</th><th>联系方式</th><th>授权码</th><th></th></tr>${rowsO || '<tr><td colspan=7 class=m>暂无</td></tr>'}</table></div>
<h2>收款助手</h2><div class=c>
<form class=inline method=post action="admin/relay"><input name=name placeholder="设备名，如 收款手机" style="min-width:180px"><button>添加收款助手</button></form>
<p class=m style="font-size:13px">添加后把显示的 ID 和密钥填到安卓 App 里。手机保持联网、微信通知权限打开。</p>
<table><tr><th>名称 / ID</th><th>状态</th><th>最近心跳</th><th></th></tr>${rowsR || '<tr><td colspan=4 class=m>暂无</td></tr>'}</table></div>
<h2>到账通知记录</h2><div class=c><table><tr><th>时间</th><th>来源</th><th>金额</th><th>匹配订单</th><th>通知原文</th></tr>${rowsL || '<tr><td colspan=5 class=m>暂无</td></tr>'}</table></div>
</main></body></html>`);
}

function buyPage() {
  const cards = Object.entries(PLANS).map(([k, p]) => `<div class=plan><h3>${p.name}</h3><div class=price>¥${p.price}<small>/月</small></div><ul><li>${fmtBytes(p.quota)} 加密云备份空间</li><li>保留最近 ${p.max} 份备份</li><li>远程访问（独立域名）</li><li>NAS 故障可下载恢复</li><li>服务器只存密文</li></ul><button onclick="buy('${k}')">购买</button></div>`).join('');
  return `<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>x.erp 云服务</title>
<style>body{font:15px/1.7 system-ui,"Microsoft YaHei";margin:0;background:#0f172a;color:#e2e8f0}main{max-width:960px;margin:0 auto;padding:48px 16px}h1{font-size:30px;margin:0 0 8px}p.sub{color:#94a3b8;margin:0 0 18px}.contact{margin:0 0 24px}.contact input{width:100%;max-width:360px;padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font:inherit}.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.plan{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:22px}.plan h3{margin:0 0 6px;font-size:18px}.price{font-size:30px;font-weight:700;margin-bottom:14px}.price small{font-size:13px;color:#94a3b8;font-weight:400}.plan ul{padding-left:18px;color:#cbd5e1;font-size:13px}.plan button{width:100%;padding:10px;border:0;border-radius:10px;background:#6366f1;color:#fff;font:inherit;cursor:pointer}.note{margin-top:26px;color:#94a3b8;font-size:13px}#msg{margin-top:18px;padding:14px;border-radius:10px;background:#1e293b;display:none;white-space:pre-wrap}#msg.show{display:block}</style></head>
<body><main><h1>x.erp 云服务</h1><p class=sub>加密云备份 + 远程访问。数据在本机加密后上传，服务器看不到你的业务数据；在外面也能打开自己的 ERP。</p><div class=contact><input id=contact placeholder="微信 / 手机号（选填，方便补发授权码）"></div><div id=paystate style="color:#94a3b8;font-size:13px;margin:-14px 0 20px">正在检查收款助手…</div><div class=plans>${cards}</div><div id=msg></div><div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><input id=qno placeholder="订单号（R 或 M 开头）" autocomplete=off style="flex:1;min-width:200px;padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font:inherit"><button onclick="queryOrder()" style="padding:10px 16px;border:0;border-radius:10px;background:#334155;color:#fff;font:inherit;cursor:pointer">查询授权码</button></div>
<p class=note>订单二维码 5 分钟内有效，超时直接作废，需要重新下单。授权码会显示在本页，请截图保存；关掉页面或换了设备也没关系，凭订单号在下面随时查回来，订单号会记在这台浏览器里。授权码在 x.erp「云服务」页面输入即可开通，2 元/月起含云备份和远程访问。</p>
<p style="text-align:center;margin-top:26px;font-size:13px;color:#94a3b8"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener" style="color:inherit">冀ICP备2025136401号-2</a></p>
<script>
var LS='xerp_cloud_order',curOrder='',curPaid=false,curTries=0,TTL=300;
function fmtTime(ts){var d=new Date(ts*1000);var p=function(n){return (n<10?'0':'')+n};return p(d.getHours())+':'+p(d.getMinutes());}
var store={get:function(){try{return localStorage.getItem(LS)||''}catch(e){return ''}},set:function(v){try{localStorage.setItem(LS,v)}catch(e){}},del:function(){try{localStorage.removeItem(LS)}catch(e){}}};
function boxEl(){return document.getElementById('msg');}
function showBox(t){var b=boxEl();b.className='show';b.textContent=t;}
function showHtml(t){var b=boxEl();b.className='show';b.innerHTML=t;}
function showCode(code,no){
  showHtml('支付成功，授权码：<b style="font-size:20px">'+code+'</b><br>订单号 '+no+'<br>打开 x.erp →「云服务」输入即可开通。请截图保存，关掉页面后凭订单号也能查回来。');
}
async function orderInfo(no){
  var r=await fetch('api/order/'+encodeURIComponent(no));
  var d=await r.json();
  if(!r.ok) throw new Error(d.error==='订单不存在'?('订单 '+no+' 不存在，请检查订单号'):(d.error||('订单 '+no+' 不存在')));
  return d;
}
async function checkOnce(){
  if(!curOrder||curPaid) return;
  try{
    var d=await orderInfo(curOrder);
    if(d.status==='paid'&&d.code){curPaid=true;showCode(d.code,curOrder);}
    else if(d.status==='void'){curOrder='';showBox('订单已过期作废（超过 5 分钟未付款）。二维码已失效，请重新选择套餐下单。');}
  }catch(e){if(e.message&&e.message.indexOf('不存在')>=0) showBox(e.message);}
}
function pollOrder(no,keep){
  no=String(no||'').trim().toUpperCase();
  if(!no){showBox('订单号不能为空');return;}
  curOrder=no;curPaid=false;curTries=0;store.set(no);
  var qi=document.getElementById('qno');if(qi) qi.value=no;
  try{history.replaceState(null,'','?order='+no);}catch(e){}
  if(!keep) showBox('正在查询订单 '+no+' …');
  else if(!boxEl().textContent.trim()) showBox('订单 '+no+' 等待支付…');
  checkOnce();
}
setInterval(function(){if(!document.hidden&&curOrder&&!curPaid){curTries++;if(curTries>100){curOrder='';showBox('订单已过期（5 分钟内未付款）。二维码已失效，请重新下单；如果刚刚已经付款，把订单号填到下面查询。');return;}checkOnce();}},3000);
document.addEventListener('visibilitychange',function(){if(!document.hidden) checkOnce();});
async function queryOrder(){
  var qi=document.getElementById('qno');
  var no=String((qi&&qi.value)||'').trim().toUpperCase();
  if(!no){showBox('请先填订单号（R 或 M 开头）');return;}
  showBox('正在查询…');
  try{
    var d=await orderInfo(no);
    pollOrder(no,true);
    if(d.status==='paid'&&d.code){curPaid=true;showCode(d.code,no);}
    else if(d.status==='void') showBox('订单 '+no+' 已过期作废（超过 5 分钟未付款），二维码已失效，请重新下单。');
    else showBox('订单 '+no+' 还没有付款记录（等待支付）。付款后这里会自动显示授权码。');
  }catch(e){showBox(e.message);}
}
let relayOnline=false;
async function refreshStatus(){
  try{
    const r=await fetch('api/relay/status',{cache:'no-store'});const d=await r.json();
    relayOnline=!!d.online;
    const el=document.getElementById('paystate');
    if(el){
      el.textContent=relayOnline?'收款助手在线：付款后自动发授权码':'收款助手离线：先别付款！等这里变回「在线」再买，付款后才能自动发码';
      el.style.color=relayOnline?'#94a3b8':'#f87171';
      el.style.fontWeight=relayOnline?'400':'700';
    }
  }catch(e){}
}
refreshStatus();
setInterval(refreshStatus,10000);
document.addEventListener('visibilitychange',function(){if(!document.hidden) refreshStatus();});
const orderNo=new URLSearchParams(location.search).get('order')||store.get();
if(orderNo){var qi0=document.getElementById('qno');if(qi0) qi0.value=String(orderNo).toUpperCase();pollOrder(orderNo,true);}
async function buy(plan){
  const box=document.getElementById('msg');box.className='show';box.textContent='正在创建订单…';
  try{
    if(relayOnline){
      const m=await fetch('api/order/relay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan,contact:(document.getElementById('contact')||{}).value||''})});
      const o=await m.json();
      if(!m.ok) throw new Error(o.error||'创建订单失败');
      box.innerHTML='订单号 <b>'+o.order+'</b>，应付 <b>¥'+(o.amount/100).toFixed(2)+'</b><br>请在 <b>'+fmtTime(o.expires||Date.now()/1000+TTL)+'</b> 前付款，二维码 5 分钟内有效，超时订单直接作废。<br>金额包含随机尾数，请<b>精确支付</b>这个金额，付款后这里会自动显示授权码。<br><img src="https://www.zhaoyoucai.xyz/xerp/img/wechat-pay-20261115.jpg" alt="微信收款码" style="width:190px;margin-top:10px;border-radius:10px;background:#fff">';
      pollOrder(o.order,true);
      return;
    }
    const r=await fetch('api/pay/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan,contact:(document.getElementById('contact')||{}).value||''})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'创建订单失败');
    if(d.disabled){
      if(!relayOnline&&!confirm('收款助手当前离线：现在付款不能自动发码，要等作者人工确认（可能需要等一会儿）。\\n\\n确定现在下单吗？不着急的话，等上面变回「在线」再买最稳。')) {showBox('已取消。等收款助手恢复在线再买，付款后会自动出码。');return;}
      const m=await fetch('api/order/manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan,contact:(document.getElementById('contact')||{}).value||''})});
      const o=await m.json();
      if(!m.ok) throw new Error(o.error||'创建订单失败');
      box.innerHTML='订单号 <b>'+o.order+'</b>，应付 <b>¥'+(o.amount/100).toFixed(2)+'</b><br>请在 <b>'+fmtTime(o.expires||Date.now()/1000+TTL)+'</b> 前付款，订单 5 分钟内有效，超时作废。<br>请用微信扫码支付，付款后把订单号发给作者；作者确认后这里会自动显示授权码。<br><img src="https://www.zhaoyoucai.xyz/xerp/img/wechat-pay-20261115.jpg" alt="微信收款码" style="width:190px;margin-top:10px;border-radius:10px;background:#fff">';
      pollOrder(o.order,true);
      return;
    }
    location.href=d.url;
  }catch(e){
    var msg=e.message||'创建订单失败';
    if(msg.indexOf('离线')>=0) {msg='收款助手暂时离线，请等十几秒再点一次购买；如果已经付款，请在下面输入订单号查询授权码。';refreshStatus();}
    else msg=msg+'（如果已经付款，请在下面输入订单号查询授权码）';
    box.textContent=msg;
  }
}
</script></main></body></html>`;
}

/* ================= 远程访问隧道（NAS 主动连云，外部访问子域名） ================= */
function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function wsFrame(payload, opcode = 1) {
  const len = payload.length;
  let h;
  if (len < 126) h = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([h, payload]);
}
function wsSend(socket, obj) {
  try { socket.write(wsFrame(Buffer.from(JSON.stringify(obj)))); } catch (e) {}
}
function wsRead(socket, onMessage) {
  let buf = Buffer.alloc(0), parts = [], total = 0;
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1], fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > 30n * 1024n * 1024n) { socket.destroy(); return; }
        len = Number(big); off = 10;
      }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (op === 0x8) { try { socket.end(); } catch (e) {} return; }
      if (op === 0x9) { try { socket.write(wsFrame(payload, 0xA)); } catch (e) {} continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) {
        parts = [payload]; total = payload.length;
        if (fin) { const s = Buffer.concat(parts).toString('utf8'); parts = []; total = 0; onMessage(s); }
      } else if (op === 0x0) {
        parts.push(payload); total += payload.length;
        if (total > 30 * 1024 * 1024) { socket.destroy(); return; }
        if (fin) { const s = Buffer.concat(parts).toString('utf8'); parts = []; total = 0; onMessage(s); }
      }
    }
  });
}
async function remoteProxy(req, res, host) {
  const slug = host.split('.')[0].toLowerCase();
  const a = /^[0-9a-f]{10}$/.test(slug) ? db.prepare('SELECT * FROM accounts WHERE slug = ?').get(slug) : null;
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

// 超过有效期的待付款订单直接作废，避免旧二维码还能被付款匹配
function expireOrders() {
  try {
    const r = db.prepare("UPDATE orders SET status = 'void' WHERE status = 'pending' AND created < ?").run(now() - MATCH_TTL);
    if (r.changes) console.log(new Date().toISOString(), 'ORDER expire', r.changes);
  } catch (e) { console.error(new Date().toISOString(), 'ORDER expire fail', e.message); }
}
setInterval(expireOrders, 30000);
expireOrders();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  try {
    if (host.endsWith('.' + TUNNEL_DOMAIN)) return await remoteProxy(req, res, host);
    if (req.method === 'GET' && (p === '/api/ping' || p === '/ping')) return json(res, 200, { ok: true, app: 'XERP-CLOUD', version: 1, plans: Object.keys(PLANS).length });
    if (req.method === 'GET' && p === '/api/tunnel/ask') {
      const domain = String(url.searchParams.get('domain') || '').split(':')[0].toLowerCase();
      const slug = domain.endsWith('.' + TUNNEL_DOMAIN) ? domain.slice(0, -TUNNEL_DOMAIN.length - 1) : '';
      const a = /^[0-9a-f]{10}$/.test(slug) ? db.prepare('SELECT * FROM accounts WHERE slug = ?').get(slug) : null;
      res.writeHead(a && a.expires >= now() ? 200 : 403, { 'Content-Type': 'text/plain' });
      return res.end(a && a.expires >= now() ? 'ok' : 'no');
    }
    if (req.method === 'GET' && p === '/api/plans') return json(res, 200, { plans: Object.entries(PLANS).map(([k, v]) => ({ key: k, name: v.name, quota: v.quota, days: v.days, max: v.max, price: v.price })), payment: !!process.env.EPAY_URL });
    if (req.method === 'GET' && p === '/api/relay/status') return json(res, 200, relayOnline());
    if (req.method === 'GET' && (p === '/' || p === '/buy')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(buyPage()); }

    if (req.method === 'POST' && p === '/api/activate') {
      const b = await jsonBody(req);
      return json(res, 200, activate(b.code, b.device, b.name, b.transfer === true));
    }
    if (req.method === 'GET' && p === '/api/status') {
      const a = accountOf(req);
      if (!a) return fail(res, 401, '授权已失效，请重新激活');
      return json(res, 200, status(a));
    }
    if (req.method === 'POST' && p === '/api/tunnel/init') {
      const a = accountOf(req);
      if (!a) return fail(res, 401, '授权已失效，请重新激活');
      if (a.expires < now()) return fail(res, 402, '云服务已到期');
      const slug = a.slug || crypto.randomBytes(5).toString('hex');
      const tunnelSecret = crypto.randomBytes(24).toString('hex');
      db.prepare('UPDATE accounts SET slug = ?, tunnel_hash = ? WHERE id = ?')
        .run(slug, crypto.createHash('sha256').update(tunnelSecret).digest('hex'), a.id);
      return json(res, 200, { slug, tunnelSecret, url: `https://${slug}.${TUNNEL_DOMAIN}` });
    }
    if (p.startsWith('/api/backup/') && (req.method === 'PUT' || req.method === 'POST')) {
      const a = accountOf(req);
      if (!a) return fail(res, 401, '授权已失效，请重新激活');
      return await upload(req, res, a, decodeURIComponent(p.slice('/api/backup/'.length)));
    }
    const m = /^\/api\/backup\/(bk_[0-9a-f]+)$/.exec(p);
    if (m) {
      const a = accountOf(req);
      if (!a) return fail(res, 401, '授权已失效，请重新激活');
      const b = db.prepare('SELECT * FROM backups WHERE id = ? AND account = ?').get(m[1], a.id);
      if (!b) return fail(res, 404, '备份不存在');
      const file = accountBackupPath(a.id, b.id);
      if (!fs.existsSync(file)) return fail(res, 410, '备份文件已丢失');
      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fs.statSync(file).size,
          'Content-Disposition': `attachment; filename="${b.name}"`,
        });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(file); } catch (e) {}
        db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
        return json(res, 200, { ok: true, ...status(a) });
      }
    }

    if (req.method === 'POST' && p === '/api/order/relay') {
      const b = await jsonBody(req);
      const plan = PLANS[b.plan];
      if (!plan) return fail(res, 400, '套餐不存在');
      if (!relayOnline().online) {
        console.error(new Date().toISOString(), 'ORDER relay offline, reject plan=' + b.plan + ' contact=' + (b.contact || ''));
        return fail(res, 503, '收款助手离线，请联系作者');
      }
      const no = 'R' + Date.now() + crypto.randomBytes(2).toString('hex').toUpperCase();
      const amount = uniqueAmount(plan.price * 100);
      db.prepare('INSERT INTO orders (id, plan, amount, status, created, channel, contact) VALUES (?,?,?,?,?,?,?)')
        .run(no, b.plan, amount, 'pending', now(), 'relay', String(b.contact || '').slice(0, 100) || null);
      console.log(new Date().toISOString(), 'ORDER create', no, b.plan, amount, 'relay');
      return json(res, 200, { order: no, amount, plan: b.plan, relay: true, expires: now() + ORDER_TTL });
    }
    if (req.method === 'POST' && p === '/api/order/manual') {
      const b = await jsonBody(req);
      const plan = PLANS[b.plan];
      if (!plan) return fail(res, 400, '套餐不存在');
      const no = 'M' + Date.now() + crypto.randomBytes(2).toString('hex').toUpperCase();
      db.prepare('INSERT INTO orders (id, plan, amount, status, created, channel, contact) VALUES (?,?,?,?,?,?,?)')
        .run(no, b.plan, plan.price * 100, 'pending', now(), 'manual', String(b.contact || '').slice(0, 100) || null);
      console.log(new Date().toISOString(), 'ORDER create', no, b.plan, plan.price * 100, 'manual');
      return json(res, 200, { order: no, amount: plan.price * 100, plan: b.plan, expires: now() + ORDER_TTL });
    }
    if (req.method === 'POST' && p === '/api/relay/heartbeat') {
      const b = await jsonBody(req);
      verifyRelay({ ...b, amount: 0, source: 'heartbeat' });
      return json(res, 200, { ok: true, online: true });
    }
    if (req.method === 'POST' && p === '/api/relay/notify') {
      const b = await jsonBody(req);
      let relay;
      try { relay = verifyRelay(b); }
      catch (e) {
        console.error(new Date().toISOString(), 'RELAY verify fail device=' + b.device + ' source=' + b.source + ' amount=' + b.amount + ' err=' + e.message);
        throw e;
      }
      const amount = Math.round(+b.amount || 0);
      let matched = null;
      if (amount > 0) {
        const o = db.prepare("SELECT * FROM orders WHERE status = 'pending' AND amount = ? AND created > ? AND channel IN ('relay', 'manual') ORDER BY CASE WHEN channel = 'relay' THEN 0 ELSE 1 END, created DESC LIMIT 1").get(amount, now() - MATCH_TTL);
        if (o) {
          const code = createCode(o.plan, '收款助手 ' + relay.name, o.id);
          db.prepare('UPDATE orders SET status = ?, paid = ?, code = ? WHERE id = ?').run('paid', now(), code, o.id);
          matched = o.id;
        }
      }
      db.prepare('INSERT INTO relay_log (relay, amount, source, text, at, matched) VALUES (?,?,?,?,?,?)')
        .run(relay.id, amount, String(b.source || '').slice(0, 20), String(b.text || '').slice(0, 500), now(), matched);
      console.log(new Date().toISOString(), 'RELAY notify', relay.id, amount, String(b.source || ''), matched ? ('matched ' + matched) : 'no-match');
      return json(res, 200, { ok: true, matched: !!matched, order: matched });
    }
    if (req.method === 'POST' && p === '/api/pay/create') {
      const b = await jsonBody(req);
      const plan = PLANS[b.plan];
      if (!plan) return fail(res, 400, '套餐不存在');
      if (process.env.EPAY_MOCK === '1') {
        const no = 'T' + Date.now() + crypto.randomBytes(3).toString('hex');
        db.prepare('INSERT INTO orders (id, plan, amount, status, created, channel, contact) VALUES (?,?,?,?,?,?,?)')
          .run(no, b.plan, plan.price * 100, 'pending', now(), 'mock', String(b.contact || '').slice(0, 100) || null);
        return json(res, 200, { url: BASE + '/mock-pay?order=' + no, order: no, expires: now() + ORDER_TTL });
      }
      if (!process.env.EPAY_URL || !process.env.EPAY_PID || !process.env.EPAY_KEY) return json(res, 200, { disabled: true });
      const no = 'X' + Date.now() + crypto.randomBytes(3).toString('hex');
      db.prepare('INSERT INTO orders (id, plan, amount, status, created, channel, contact) VALUES (?,?,?,?,?,?,?)')
        .run(no, b.plan, plan.price * 100, 'pending', now(), b.channel || 'wxpay', String(b.contact || '').slice(0, 100) || null);
      console.log(new Date().toISOString(), 'ORDER create', no, b.plan, plan.price * 100, 'epay');
      const params = {
        pid: process.env.EPAY_PID, type: b.channel || 'wxpay', out_trade_no: no,
        notify_url: BASE + '/api/pay/notify', return_url: BASE + '/buy?order=' + no,
        name: 'x.erp云备份-' + plan.name, money: plan.price.toFixed(2), sitename: 'x.erp',
      };
      const qs = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
      const sign = crypto.createHash('md5').update(qs + process.env.EPAY_KEY).digest('hex');
      return json(res, 200, { url: process.env.EPAY_URL + 'submit.php?' + qs + '&sign=' + sign + '&sign_type=MD5', order: no, expires: now() + ORDER_TTL });
    }
    if (req.method === 'GET' && p.startsWith('/api/order/')) {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(p.slice('/api/order/'.length));
      if (!o) return fail(res, 404, '订单不存在');
      return json(res, 200, { status: o.status, code: o.code || null, plan: o.plan, amount: o.amount, created: o.created, expires: o.created + ORDER_TTL });
    }
    if (req.method === 'GET' && p === '/mock-pay') {
      const no = url.searchParams.get('order') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>模拟支付</title>
<body style="font:16px/1.8 system-ui;background:#0f172a;color:#e2e8f0;max-width:520px;margin:60px auto;padding:0 18px">
<h2>模拟支付（仅测试）</h2><p>订单 ${no}</p><form method=post action="${BASE}/api/pay/mock"><input type=hidden name=order value="${no}"><button style="padding:12px 22px;border:0;border-radius:10px;background:#6366f1;color:#fff;font:inherit;cursor:pointer">模拟支付成功</button></form></body></html>`);
    }
    if (req.method === 'POST' && p === '/api/pay/mock') {
      const f = await formBody(req);
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(f.get('order'));
      if (!o) { res.writeHead(404); return res.end('order not found'); }
      if (o.status !== 'paid') {
        const code = createCode(o.plan, '模拟支付 ' + o.id, o.id);
        db.prepare('UPDATE orders SET status = ?, paid = ?, code = ? WHERE id = ?').run('paid', now(), code, o.id);
      }
      res.writeHead(302, { Location: BASE + '/buy?order=' + encodeURIComponent(o.id) });
      return res.end();
    }
    if (req.method === 'POST' && p === '/api/pay/notify') {
      const f = await formBody(req);
      const obj = Object.fromEntries(f);
      const sign = obj.sign; delete obj.sign; delete obj.sign_type;
      const qs = Object.keys(obj).sort().map(k => `${k}=${obj[k]}`).join('&');
      const want = crypto.createHash('md5').update(qs + process.env.EPAY_KEY).digest('hex');
      if (!sign || sign.toLowerCase() !== want.toLowerCase()) { res.writeHead(400); return res.end('sign error'); }
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(obj.out_trade_no);
      if (!o) { res.writeHead(404); return res.end('order not found'); }
      if (o.status !== 'paid' && obj.trade_status === 'TRADE_SUCCESS') {
        const code = createCode(o.plan, '在线购买 ' + o.id, o.id);
        db.prepare('UPDATE orders SET status = ?, paid = ?, code = ? WHERE id = ?').run('paid', now(), code, o.id);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('success');
    }

    if (p === '/admin' && req.method === 'GET') {
      if (!needAdmin(req, res)) return;
      return adminPage(req, res, url.searchParams.get('msg'));
    }
    if (p === '/admin/code' && req.method === 'POST') {
      if (!needAdmin(req, res)) return;
      const f = await formBody(req);
      const plan = f.get('plan'), count = Math.min(20, Math.max(1, +(f.get('count') || 1))), note = f.get('note') || '';
      const codes = [];
      for (let i = 0; i < count; i++) codes.push(createCode(plan, note));
      return adminPage(req, res, '已生成：\n' + codes.join('\n'));
    }
    if (p === '/admin/relay' && req.method === 'POST') {
      if (!needAdmin(req, res)) return;
      const f = await formBody(req);
      if (f.get('toggle')) {
        const r = db.prepare('SELECT * FROM relays WHERE id = ?').get(f.get('id'));
        if (r) db.prepare('UPDATE relays SET enabled = ? WHERE id = ?').run(r.enabled ? 0 : 1, r.id);
        return adminPage(req, res, r ? `收款助手「${r.name || r.id}」已${r.enabled ? '停用' : '启用'}` : '设备不存在');
      }
      const id = 'rly_' + crypto.randomBytes(6).toString('hex');
      const secret = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO relays (id, name, secret, created) VALUES (?,?,?,?)').run(id, String(f.get('name') || '').slice(0, 40) || '收款手机', secret, now());
      return adminPage(req, res, `收款助手已添加，请把下面两行填到手机 App：\nID: ${id}\n密钥: ${secret}`);
    }
    if (p === '/admin/order' && req.method === 'POST') {
      if (!needAdmin(req, res)) return;
      const f = await formBody(req);
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(f.get('id'));
      if (o && o.status !== 'paid') {
        const code = createCode(o.plan, '人工确认 ' + o.id, o.id);
        db.prepare('UPDATE orders SET status = ?, paid = ?, code = ? WHERE id = ?').run('paid', now(), code, o.id);
      }
      return adminPage(req, res, o ? '订单 ' + o.id + ' 已标记为已付款并生成授权码' : '订单不存在');
    }

    fail(res, 404, '接口不存在');
  } catch (e) {
    const code = e.status || 500;
    if (code >= 500) console.error(new Date().toISOString(), e.stack || e.message);
    else if (p.startsWith('/api/')) console.error(new Date().toISOString(), 'API reject', code, req.method, p, e.message);
    if (!res.headersSent) fail(res, code, e.message || '服务器错误');
  }
});

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/tunnel') { socket.destroy(); return; }
  const device = String(u.searchParams.get('device') || '');
  const secret = String(u.searchParams.get('secret') || '');
  const a = db.prepare('SELECT * FROM accounts WHERE device = ?').get(device);
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  if (!a || !a.tunnel_hash || a.expires < now() || !safeEqualHex(hash, a.tunnel_hash)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  if (head && head.length) socket.unshift(head);
  const old = tunnels.get(a.id);
  if (old && old.socket !== socket) { try { old.socket.destroy(); } catch (e) {} }
  tunnels.set(a.id, { socket });
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
    const buf = Buffer.from(msg.body || '', 'base64');
    headers['content-length'] = String(buf.length);
    try { res.writeHead(msg.status || 502, headers); res.end(buf); } catch (e) { try { res.end(); } catch (x) {} }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`x.erp cloud listening on 127.0.0.1:${PORT}, dir ${DIR}, total quota ${fmtBytes(TOTAL_QUOTA)}`);
});
