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
const BLOB_DIR = path.join(DIR, 'blobs');
const DB_FILE = path.join(DIR, 'cloud.db');
const PW_FILE = path.join(DIR, 'admin.pw');
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MAX_UPLOAD = 200 * MB;

fs.mkdirSync(BLOB_DIR, { recursive: true });

const PLANS = {
  basic: { name: '基础版', quota: 1 * GB, days: 365, max: 7, price: 48 },
  plus: { name: '标准版', quota: 5 * GB, days: 365, max: 15, price: 128 },
  pro: { name: '专业版', quota: 10 * GB, days: 365, max: 30, price: 228 },
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
`);

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
function sanitizeName(name) {
  return /^[A-Za-z0-9._-]{1,120}$/.test(name) ? name : null;
}
function accountBackupPath(account, id) { return path.join(BLOB_DIR, account, id + '.bin'); }

function activate(code, device, name) {
  code = String(code || '').trim().toUpperCase();
  device = String(device || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(device)) throw Object.assign(new Error('设备标识不正确'), { status: 400 });
  const c = db.prepare('SELECT * FROM codes WHERE code = ?').get(code);
  if (!c) throw Object.assign(new Error('授权码不存在，请检查是否输错'), { status: 404 });
  const p = PLANS[c.plan];
  if (!p) throw Object.assign(new Error('授权码套餐无效'), { status: 400 });
  let acc = db.prepare('SELECT * FROM accounts WHERE device = ?').get(device);
  const ts = now();
  const token = crypto.randomBytes(32).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (c.used_by && (!acc || c.used_by !== acc.id)) throw Object.assign(new Error('这个授权码已经被其他设备使用'), { status: 409 });
    if (!acc) {
      const id = 'acc_' + crypto.randomBytes(12).toString('hex');
      db.prepare('INSERT INTO accounts (id, token_hash, device, name, plan, quota, expires, created, last_seen, note) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, tokenHash(token), device, String(name || '').slice(0, 60) || null, c.plan, c.quota, ts + c.days * 86400, ts, ts, c.note || null);
      acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    } else {
      const base = Math.max(ts, acc.expires || 0);
      db.prepare('UPDATE accounts SET token_hash = ?, plan = ?, quota = MAX(quota, ?), expires = ?, name = COALESCE(?, name) WHERE id = ?')
        .run(tokenHash(token), c.plan, c.quota, base + c.days * 86400, String(name || '').slice(0, 60) || null, acc.id);
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
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rowsA = accounts.map(a => `<tr><td>${esc(a.name || '未命名')}<br><small>${esc(a.device)}</small></td><td>${esc(PLANS[a.plan]?.name || a.plan)}</td><td>${fmtBytes(a.used)} / ${fmtBytes(a.quota)}</td><td>${esc(fmtTime(a.expires))}</td><td>${a.n}</td><td>${esc(fmtTime(a.last_seen))}</td></tr>`).join('');
  const rowsC = codes.map(c => `<tr><td><code>${esc(c.code)}</code></td><td>${esc(PLANS[c.plan]?.name || c.plan)}</td><td>${esc(c.used_by || '未使用')}</td><td>${esc(fmtTime(c.created))}</td><td>${esc(c.note || '')}</td></tr>`).join('');
  const rowsO = orders.map(o => `<tr><td>${esc(o.id)}</td><td>${esc(PLANS[o.plan]?.name || o.plan)}</td><td>¥${(o.amount / 100).toFixed(2)}</td><td>${esc(o.status)}</td><td>${esc(o.code || '')}</td><td>${o.status === 'paid' ? '' : `<form method=post action="/admin/order"><input type=hidden name=id value="${esc(o.id)}"><button>标记已付并发码</button></form>`}</td></tr>`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>x.erp 云备份后台</title>
<style>body{font:14px/1.6 system-ui,"Microsoft YaHei";margin:0;background:#f6f7fb;color:#1e293b}main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 10px}.m{color:#64748b}.c{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 10px 7px 0;border-bottom:1px solid #e2e8f0;white-space:nowrap}th{color:#64748b;font-weight:500;font-size:12px}code{background:#f1f5f9;padding:2px 5px;border-radius:4px}form.inline{display:flex;gap:8px;flex-wrap:wrap;align-items:center}input,select,button{padding:7px 9px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff}button{background:#4f46e5;border-color:#4f46e5;color:#fff;cursor:pointer}small{color:#94a3b8}.flash{background:#dcfce7;border:1px solid #86efac;padding:10px 12px;border-radius:8px;margin:12px 0;white-space:pre-wrap}</style></head><body><main>
<h1>x.erp 云备份后台</h1><div class=m>当前共 ${accounts.length} 个账号，云端已用 ${fmtBytes(accounts.reduce((n, a) => n + a.used, 0))} / ${fmtBytes(TOTAL_QUOTA)}</div>
${flash ? `<div class=flash>${esc(flash)}</div>` : ''}
<h2>生成授权码</h2><div class=c><form class=inline method=post action="/admin/code"><select name=plan>${Object.entries(PLANS).map(([k, p]) => `<option value=${k}>${p.name} · ${fmtBytes(p.quota)} / ${p.days} 天 · ¥${p.price}</option>`).join('')}</select><input name=count type=number value=1 min=1 max=20 style="width:70px"><input name=note placeholder="备注（客户/订单号）" style="min-width:200px"><button>生成</button></form></div>
<h2>授权码</h2><div class=c><table><tr><th>授权码</th><th>套餐</th><th>使用账号</th><th>生成时间</th><th>备注</th></tr>${rowsC || '<tr><td colspan=5 class=m>暂无</td></tr>'}</table></div>
<h2>云备份账号</h2><div class=c><table><tr><th>名称 / 设备</th><th>套餐</th><th>已用 / 容量</th><th>到期</th><th>份数</th><th>最近上报</th></tr>${rowsA || '<tr><td colspan=6 class=m>暂无</td></tr>'}</table></div>
<h2>订单</h2><div class=c><table><tr><th>订单号</th><th>套餐</th><th>金额</th><th>状态</th><th>授权码</th><th></th></tr>${rowsO || '<tr><td colspan=6 class=m>暂无</td></tr>'}</table></div>
</main></body></html>`);
}

function buyPage() {
  const cards = Object.entries(PLANS).map(([k, p]) => `<div class=plan><h3>${p.name}</h3><div class=price>¥${p.price}<small>/年</small></div><ul><li>${fmtBytes(p.quota)} 加密云备份空间</li><li>保留最近 ${p.max} 份备份</li><li>NAS 故障可下载恢复</li><li>服务器只存密文</li></ul><button onclick="buy('${k}')">购买</button></div>`).join('');
  return `<!doctype html><html lang=zh-CN><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>x.erp 云备份</title>
<style>body{font:15px/1.7 system-ui,"Microsoft YaHei";margin:0;background:#0f172a;color:#e2e8f0}main{max-width:960px;margin:0 auto;padding:48px 16px}h1{font-size:30px;margin:0 0 8px}p.sub{color:#94a3b8;margin:0 0 18px}.contact{margin:0 0 24px}.contact input{width:100%;max-width:360px;padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font:inherit}.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.plan{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:22px}.plan h3{margin:0 0 6px;font-size:18px}.price{font-size:30px;font-weight:700;margin-bottom:14px}.price small{font-size:13px;color:#94a3b8;font-weight:400}.plan ul{padding-left:18px;color:#cbd5e1;font-size:13px}.plan button{width:100%;padding:10px;border:0;border-radius:10px;background:#6366f1;color:#fff;font:inherit;cursor:pointer}.note{margin-top:26px;color:#94a3b8;font-size:13px}#msg{margin-top:18px;padding:14px;border-radius:10px;background:#1e293b;display:none;white-space:pre-wrap}#msg.show{display:block}</style></head>
<body><main><h1>x.erp 云备份</h1><p class=sub>数据在本机加密后上传，服务器看不到你的业务数据。换机、NAS 故障、误删都能恢复。</p><div class=contact><input id=contact placeholder="微信 / 手机号（选填，方便补发授权码）"></div><div class=plans>${cards}</div><div id=msg></div>
<p class=note>购买后授权码会显示在本页，也会稍后发到你留下的联系方式。授权码在 x.erp「云备份」页面输入即可开通。</p>
<script>
async function pollOrder(no){
  const box=document.getElementById('msg');box.className='show';box.textContent='订单 '+no+' 等待支付…';
  for(let i=0;i<200;i++){
    try{
      const r=await fetch('/xerp-cloud/api/order/'+encodeURIComponent(no));
      const d=await r.json();
      if(d.status==='paid'&&d.code){box.innerHTML='支付成功，授权码：<b style="font-size:20px">'+d.code+'</b><br>打开 x.erp →「云备份」输入即可开通。';return;}
    }catch(e){}
    await new Promise(r=>setTimeout(r,3000));
  }
  box.textContent='还没有收到支付结果。如果已经付款，请联系作者补发授权码。';
}
const orderNo=new URLSearchParams(location.search).get('order');
if(orderNo) pollOrder(orderNo);
async function buy(plan){
  const box=document.getElementById('msg');box.className='show';box.textContent='正在创建订单…';
  try{
    const r=await fetch('/xerp-cloud/api/pay/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan,contact:(document.getElementById('contact')||{}).value||''})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'创建订单失败');
    if(d.disabled){box.textContent='在线支付暂未开通，请联系作者购买授权码。';return;}
    location.href=d.url;
  }catch(e){box.textContent=e.message;}
}
</script></main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/api/ping' || p === '/ping')) return json(res, 200, { ok: true, app: 'XERP-CLOUD', version: 1, plans: Object.keys(PLANS).length });
    if (req.method === 'GET' && p === '/api/plans') return json(res, 200, { plans: Object.entries(PLANS).map(([k, v]) => ({ key: k, name: v.name, quota: v.quota, days: v.days, max: v.max, price: v.price })), payment: !!process.env.EPAY_URL });
    if (req.method === 'GET' && (p === '/' || p === '/buy')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(buyPage()); }

    if (req.method === 'POST' && p === '/api/activate') {
      const b = await jsonBody(req);
      return json(res, 200, activate(b.code, b.device, b.name));
    }
    if (req.method === 'GET' && p === '/api/status') {
      const a = accountOf(req);
      if (!a) return fail(res, 401, '授权已失效，请重新激活');
      return json(res, 200, status(a));
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

    if (req.method === 'POST' && p === '/api/pay/create') {
      const b = await jsonBody(req);
      const plan = PLANS[b.plan];
      if (!plan) return fail(res, 400, '套餐不存在');
      if (!process.env.EPAY_URL || !process.env.EPAY_PID || !process.env.EPAY_KEY) return json(res, 200, { disabled: true });
      const no = 'X' + Date.now() + crypto.randomBytes(3).toString('hex');
      db.prepare('INSERT INTO orders (id, plan, amount, status, created, channel, contact) VALUES (?,?,?,?,?,?,?)')
        .run(no, b.plan, plan.price * 100, 'pending', now(), b.channel || 'wxpay', String(b.contact || '').slice(0, 100) || null);
      const params = {
        pid: process.env.EPAY_PID, type: b.channel || 'wxpay', out_trade_no: no,
        notify_url: BASE + '/api/pay/notify', return_url: BASE + '/buy?order=' + no,
        name: 'x.erp云备份-' + plan.name, money: plan.price.toFixed(2), sitename: 'x.erp',
      };
      const qs = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
      const sign = crypto.createHash('md5').update(qs + process.env.EPAY_KEY).digest('hex');
      return json(res, 200, { url: process.env.EPAY_URL + 'submit.php?' + qs + '&sign=' + sign + '&sign_type=MD5', order: no });
    }
    if (req.method === 'GET' && p.startsWith('/api/order/')) {
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(p.slice('/api/order/'.length));
      if (!o) return fail(res, 404, '订单不存在');
      return json(res, 200, { status: o.status, code: o.code || null, plan: o.plan, amount: o.amount });
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
    if (!res.headersSent) fail(res, code, e.message || '服务器错误');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`x.erp cloud listening on 127.0.0.1:${PORT}, dir ${DIR}, total quota ${fmtBytes(TOTAL_QUOTA)}`);
});
