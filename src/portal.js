// x.erp 多账套网关：全局账号 + 账套（每家公司一个独立实例/数据库）+ 登录后切换
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DATA_DIR = path.resolve(arg('data', process.env.ERP_DATA || path.join(process.env.ProgramData || os.homedir(), 'XERP')));
const PORT = +arg('port', process.env.ERP_PORTAL_PORT || 8686);
const BASE_PORT = Math.max(1, +arg('base-port', process.env.ERP_BASE_PORT || 9001));
const SERVER = path.resolve(__dirname, 'server.js');
const SESSION_DAYS = 7;
fs.mkdirSync(DATA_DIR, { recursive: true });
const log = (...m) => console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...m);

const reg = new DatabaseSync(path.join(DATA_DIR, 'registry.db'));
reg.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dir TEXT NOT NULL, port INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created TEXT);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT, salt TEXT, hash TEXT, admin INTEGER NOT NULL DEFAULT 0, created TEXT);
  CREATE TABLE IF NOT EXISTS members (user_id TEXT NOT NULL, company_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', PRIMARY KEY (user_id, company_id));
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, company_id TEXT NOT NULL, company_token TEXT NOT NULL, expires INTEGER NOT NULL);
`);
const now = () => Math.floor(Date.now() / 1000);
const uid = p => p + crypto.randomBytes(8).toString('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const hashPwd = (pwd, salt = rnd(16)) => ({ salt, hash: crypto.scryptSync(String(pwd), salt, 64).toString('hex') });

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok, bad) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 2e6) { bad(new Error('请求太大')); req.destroy(); } });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(new Error('请求格式不正确')); } });
    req.on('error', bad);
  });
}
const companyById = id => reg.prepare('SELECT * FROM companies WHERE id = ?').get(id);
const companyByCode = code => reg.prepare('SELECT * FROM companies WHERE code = ? AND enabled = 1').get(code);
const userByName = name => reg.prepare('SELECT * FROM users WHERE username = ?').get(name);
const memberOf = (uid, cid) => reg.prepare('SELECT * FROM members WHERE user_id = ? AND company_id = ?').get(uid, cid);
const canManage = (u, cid) => !!u.admin || (memberOf(u.id, cid) || {}).role === 'admin';
const memberships = uid => reg.prepare('SELECT c.* FROM members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = ? AND c.enabled = 1').all(uid);
const companyDb = c => new DatabaseSync(path.join(c.dir, 'erp.db'));
const childOf = new Map();
let stopping = false;

function ensureCompanyUser(c, u, role) {
  const db = companyDb(c);
  try {
    const wantRole = role === 'admin' ? 'admin' : 'user';
    let row = db.prepare('SELECT * FROM users WHERE username = ?').get(u.username);
    if (!row) {
      const id = uid('u');
      const p = (u.salt && u.hash) ? { salt: u.salt, hash: u.hash } : hashPwd(rnd(12));
      const staff = db.prepare("SELECT id FROM roles WHERE id = 'r_staff'").get();
      db.prepare('INSERT INTO users (id, username, name, role, role_id, salt, hash, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, u.username, u.name || u.username, wantRole, wantRole === 'admin' ? null : (staff ? 'r_staff' : null), p.salt, p.hash, new Date().toISOString());
      row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else {
      if (u.salt && u.hash && (row.salt !== u.salt || row.hash !== u.hash)) {
        db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(u.salt, u.hash, row.id);
        row.salt = u.salt; row.hash = u.hash;
      }
      if (row.role !== wantRole || row.disabled) {
        const staff = wantRole === 'admin' ? null : (row.role_id || (db.prepare("SELECT id FROM roles WHERE id = 'r_staff'").get() || {}).id || null);
        db.prepare('UPDATE users SET role = ?, role_id = ?, disabled = 0 WHERE id = ?').run(wantRole, staff, row.id);
        row.role = wantRole; row.role_id = staff; row.disabled = 0;
      }
    }
    if (row.role !== 'admin' && !row.role_id) {
      const staff = db.prepare("SELECT id FROM roles WHERE id = 'r_staff'").get();
      if (staff) { db.prepare("UPDATE users SET role_id = 'r_staff' WHERE id = ?").run(row.id); row.role_id = 'r_staff'; }
    }
    return row;
  } finally { db.close(); }
}
function syncCompanyMember(c, u, role, { disable = false, revoke = false } = {}) {
  if (!c || !u || !fs.existsSync(path.join(c.dir, 'erp.db'))) return;
  const db = companyDb(c);
  try {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(u.username);
    if (!row) return;
    if (disable) {
      db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
      return;
    }
    const wantRole = role === 'admin' ? 'admin' : 'user';
    const nextRoleId = wantRole === 'admin' ? null : (row.role_id || (db.prepare("SELECT id FROM roles WHERE id = 'r_staff'").get() || {}).id || null);
    db.prepare('UPDATE users SET role = ?, role_id = ?, disabled = 0 WHERE id = ?').run(wantRole, nextRoleId, row.id);
    if (revoke) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  } catch (e) { log('同步账套成员权限失败', c.code, e.message); }
  finally { db.close(); }
}
function revokeCompanyToken(c, token) {
  if (!c || !token || !fs.existsSync(path.join(c.dir, 'erp.db'))) return;
  const db = companyDb(c);
  try { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
  catch (e) {}
  finally { db.close(); }
}
function mintCompanyToken(c, userId) {
  const db = companyDb(c);
  try {
    const t = rnd(32), exp = Date.now() + SESSION_DAYS * 864e5;
    db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)').run(t, userId, exp);
    return t;
  } finally { db.close(); }
}
function startCompany(c) {
  if (!c || !c.enabled || stopping) return;
  if (childOf.has(c.id)) return;
  const child = spawn(process.execPath, [SERVER, '--data', c.dir, '--port', String(c.port), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XERP_PORTAL_CHILD: '1', XERP_PORTAL_PARENT: String(process.pid) },
  });
  child.stdout.on('data', d => process.stdout.write(`[${c.code}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${c.code}] ${d}`));
  child.on('exit', code => { childOf.delete(c.id); log('账套进程退出', c.code, code); setTimeout(() => startCompany(c), 3000).unref?.(); });
  childOf.set(c.id, child);
}
function stopChildren() {
  stopping = true;
  for (const child of childOf.values()) {
    try { child.kill(); } catch (e) {}
  }
  childOf.clear();
}
function waitCompany(port, timeout = 15000) {
  const deadline = Date.now() + timeout;
  return new Promise(resolve => {
    const attempt = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        sock.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 120);
      };
      sock.setTimeout(700);
      sock.once('connect', () => {
        if (settled) return;
        settled = true;
        sock.end();
        resolve(true);
      });
      sock.once('error', fail);
      sock.once('timeout', fail);
    };
    attempt();
  });
}
function initCompany(c, adminPwd) {
  fs.mkdirSync(c.dir, { recursive: true });
  const r = spawnSync(process.execPath, [SERVER, '--data', c.dir, '--port', String(c.port), '--init'], {
    stdio: 'ignore', env: { ...process.env, XERP_NO_DEMO: '1', XERP_COMPANY: c.name, ...(adminPwd ? { XERP_ADMIN_PASSWORD: adminPwd } : {}) },
  });
  if (r.status !== 0) log('账套初始化失败', c.code);
}
function portFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
async function nextPort(exceptId, preferredPort) {
  const used = new Set(reg.prepare('SELECT id, port FROM companies WHERE enabled = 1').all()
    .filter(c => c.id !== exceptId).map(c => c.port));
  if (preferredPort >= BASE_PORT && !used.has(preferredPort) && await portFree(preferredPort)) return preferredPort;
  const max = reg.prepare('SELECT MAX(port) AS p FROM companies').get().p || 0;
  let port = Math.max(BASE_PORT, max + 1);
  for (let i = 0; i < 500; i++, port++) {
    if (used.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error('没有可用端口，请调整 --base-port');
}
function ensureDefaultCompany() {
  let c = reg.prepare("SELECT * FROM companies WHERE code = 'default'").get();
  if (!c) {
    const id = uid('co');
    reg.prepare('INSERT INTO companies (id, code, name, dir, port, enabled, created) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'default', '默认公司', DATA_DIR, 9001, 1, new Date().toISOString());
    c = companyById(id);
  }
  return c;
}
function migrateDefaultUsers(c) {
  if (reg.prepare('SELECT COUNT(*) AS n FROM users').get().n) return;
  let db;
  try { db = companyDb(c); } catch (e) { return; }
  try {
    const users = db.prepare('SELECT * FROM users WHERE disabled = 0').all();
    for (const u of users) {
      const id = uid('gu');
      reg.prepare('INSERT INTO users (id, username, name, salt, hash, admin, created) VALUES (?,?,?,?,?,?,?)')
        .run(id, u.username, u.name || u.username, u.salt, u.hash, u.role === 'admin' ? 1 : 0, u.created_at || new Date().toISOString());
      reg.prepare('INSERT INTO members (user_id, company_id, role) VALUES (?,?,?)').run(id, c.id, u.role === 'admin' ? 'admin' : 'user');
    }
    if (users.length) log('已迁移全局账号', users.length, '个');
  } finally { db.close(); }
}
function syncCompanyUsers(c, liveMutation = false) {
  let db;
  try { db = companyDb(c); } catch (e) { return; }
  try {
    const rows = db.prepare('SELECT * FROM users WHERE disabled = 0').all();
    const keep = new Set();
    for (const u of rows) {
      keep.add(u.username);
      const role = u.role === 'admin' ? 'admin' : 'user';
      let g = userByName(u.username);
      if (!g) {
        const id = uid('gu');
        reg.prepare('INSERT INTO users (id, username, name, salt, hash, admin, created) VALUES (?,?,?,?,?,?,?)')
          .run(id, u.username, u.name || u.username, u.salt, u.hash, (c.code === 'default' && role === 'admin') ? 1 : 0, u.created_at || new Date().toISOString());
        g = { id };
      } else if (liveMutation) {
        const changed = g.salt !== u.salt || g.hash !== u.hash;
        reg.prepare('UPDATE users SET name = ?, salt = ?, hash = ? WHERE id = ?')
          .run(u.name || g.name || u.username, u.salt, u.hash, g.id);
        if (changed) {
          // 密码变化时同步给其他已加入账套（如有）
        }
      }
      reg.prepare('INSERT INTO members (user_id, company_id, role) VALUES (?,?,?) ON CONFLICT(user_id, company_id) DO UPDATE SET role = excluded.role')
        .run(g.id, c.id, role);
    }
    if (liveMutation) {
      const ms = reg.prepare('SELECT m.user_id, u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ?').all(c.id);
      for (const m of ms) {
        if (!keep.has(m.username)) {
          reg.prepare('DELETE FROM members WHERE user_id = ? AND company_id = ?').run(m.user_id, c.id);
          reg.prepare('DELETE FROM sessions WHERE user_id = ? AND company_id = ?').run(m.user_id, c.id);
        }
      }
    }
  } catch (e) { log('同步账套账号失败', c.code, e.message); }
  finally { db.close(); }
}
function proxy(req, res, company, companyToken, onOk) {
  const headers = { ...req.headers, host: '127.0.0.1:' + company.port };
  if (companyToken) headers.authorization = 'Bearer ' + companyToken;
  const pr = http.request({ host: '127.0.0.1', port: company.port, path: req.url, method: req.method, headers }, r => {
    if (onOk && r.statusCode >= 200 && r.statusCode < 300) {
      try { onOk(); } catch (e) {}
    }
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  pr.on('error', () => { if (!res.headersSent) json(res, 502, { error: '账套服务未启动，请稍后重试' }); else res.end(); });
  req.pipe(pr);
}
function sessionOf(req) {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const s = reg.prepare('SELECT * FROM sessions WHERE token = ?').get(t);
  if (!s || s.expires < now()) return null;
  return s;
}
function loginPayload(user, c) {
  const list = memberships(user.id).map(x => ({ code: x.code, name: x.name }));
  return { token: '', company: { code: c.code, name: c.name }, user: { username: user.username, name: user.name || user.username, admin: !!user.admin }, companies: list };
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad url'); }
  const p = url.pathname;
  try {
    if (p === '/api/portal/info') {
      const list = reg.prepare('SELECT code, name FROM companies WHERE enabled = 1 ORDER BY created').all();
      return json(res, 200, { portal: true, multi: list.length > 1, companies: list });
    }
    if (p === '/api/portal/login' && req.method === 'POST') {
      const b = await body(req);
      const user = userByName(String(b.username || '').trim());
      if (!user) return json(res, 401, { error: '用户名或密码不正确' });
      const a = Buffer.from(hashPwd(String(b.password || ''), user.salt).hash, 'hex'), h = Buffer.from(user.hash || '', 'hex');
      if (a.length !== h.length || !crypto.timingSafeEqual(a, h)) return json(res, 401, { error: '用户名或密码不正确' });
      let c;
      if (b.company) {
        c = companyByCode(String(b.company));
        if (!c) return json(res, 404, { error: '公司不存在或已停用' });
      } else {
        const ms = memberships(user.id);
        c = ms.length === 1 ? ms[0] : companyByCode('default');
      }
      if (!c) return json(res, 400, { error: '请选择公司' });
      const m = memberOf(user.id, c.id);
      if (!m && !user.admin) return json(res, 403, { error: '这个账号没有加入该公司' });
      const cu = ensureCompanyUser(c, user, m ? m.role : 'admin');
      const ct = mintCompanyToken(c, cu.id);
      const t = rnd(32);
      reg.prepare('INSERT INTO sessions (token, user_id, company_id, company_token, expires) VALUES (?,?,?,?,?)').run(t, user.id, c.id, ct, now() + SESSION_DAYS * 86400);
      const out = loginPayload(user, c);
      out.token = t;
      return json(res, 200, out);
    }
    const sess = sessionOf(req);
    if (p === '/api/portal/switch' && req.method === 'POST') {
      if (!sess) return json(res, 401, { error: '登录已失效' });
      const b = await body(req);
      const user = reg.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
      const c = companyByCode(String(b.company || ''));
      if (!c) return json(res, 404, { error: '公司不存在' });
      const m = memberOf(user.id, c.id);
      if (!m && !user.admin) return json(res, 403, { error: '这个账号没有加入该公司' });
      const oldCompany = companyById(sess.company_id);
      if (oldCompany) revokeCompanyToken(oldCompany, sess.company_token);
      const cu = ensureCompanyUser(c, user, m ? m.role : 'admin');
      const ct = mintCompanyToken(c, cu.id);
      reg.prepare('UPDATE sessions SET company_id = ?, company_token = ? WHERE token = ?').run(c.id, ct, sess.token);
      const out = loginPayload(user, c);
      out.token = sess.token;
      return json(res, 200, out);
    }
    if (p === '/api/portal/logout' && req.method === 'POST') {
      if (sess) {
        revokeCompanyToken(companyById(sess.company_id), sess.company_token);
        reg.prepare('DELETE FROM sessions WHERE token = ?').run(sess.token);
      }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/portal/companies' && req.method === 'GET') {
      if (!sess) return json(res, 401, { error: '登录已失效' });
      const me = reg.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
      const mine = memberOf(me.id, sess.company_id);
      if (!me.admin && (!mine || mine.role !== 'admin')) return json(res, 403, { error: '只有管理员能管理公司' });
      return json(res, 200, { companies: reg.prepare('SELECT id, code, name, enabled, created FROM companies ORDER BY created').all() });
    }
    if (p === '/api/portal/companies' && req.method === 'POST') {
      if (!sess) return json(res, 401, { error: '登录已失效' });
      const me = reg.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
      const mine = memberOf(me.id, sess.company_id);
      if (!me.admin && (!mine || mine.role !== 'admin')) return json(res, 403, { error: '只有管理员能新建公司' });
      const b = await body(req);
      const name = String(b.name || '').trim(), code = String(b.code || '').trim().toLowerCase();
      if (!name) return json(res, 400, { error: '请填写公司名称' });
      if (!/^[a-z0-9_-]{2,20}$/.test(code)) return json(res, 400, { error: '公司编码只能是 2-20 位字母、数字、- 或 _' });
      if (companyByCode(code) || reg.prepare('SELECT 1 FROM companies WHERE code = ?').get(code)) return json(res, 409, { error: '公司编码已存在' });
      const id = uid('co'), dir = path.join(DATA_DIR, 'companies', code), port = await nextPort();
      reg.prepare('INSERT INTO companies (id, code, name, dir, port, enabled, created) VALUES (?,?,?,?,?,?,?)').run(id, code, name, dir, port, 1, new Date().toISOString());
      const c = companyById(id);
      initCompany(c);
      reg.prepare('INSERT INTO members (user_id, company_id, role) VALUES (?,?,?)').run(me.id, id, 'admin');
      startCompany(c);
      if (!await waitCompany(c.port)) return json(res, 500, { error: '新公司已创建，但账套服务启动失败，请查看服务器日志' });
      return json(res, 200, { ok: true, company: { id, code, name }, companies: memberships(me.id).map(x => ({ code: x.code, name: x.name })) });
    }
    if (p === '/api/portal/members' && req.method === 'GET') {
      if (!sess) return json(res, 401, { error: '登录已失效' });
      const me = reg.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
      const c = companyByCode(String(url.searchParams.get('company') || ''));
      if (!c) return json(res, 404, { error: '公司不存在' });
      if (!canManage(me, c.id)) return json(res, 403, { error: '只有管理员能管理成员' });
      const rows = reg.prepare('SELECT u.username, u.name, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? ORDER BY m.rowid').all(c.id);
      return json(res, 200, { members: rows });
    }
    if (p === '/api/portal/members' && req.method === 'POST') {
      if (!sess) return json(res, 401, { error: '登录已失效' });
      const me = reg.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
      const b = await body(req);
      const c = companyByCode(String(b.company || ''));
      if (!c) return json(res, 404, { error: '公司不存在' });
      if (!canManage(me, c.id)) return json(res, 403, { error: '只有管理员能管理成员' });
      const username = String(b.username || '').trim();
      if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) return json(res, 400, { error: '用户名只能是 2-32 位字母、数字、. _ -' });
      let user = userByName(username);
      if (!user) {
        const pwd = String(b.password || '');
        if (pwd.length < 6) return json(res, 400, { error: '新账号需要设置至少 6 位密码' });
        const p = hashPwd(pwd);
        reg.prepare('INSERT INTO users (id, username, name, salt, hash, admin, created) VALUES (?,?,?,?,?,0,?)')
          .run(uid('gu'), username, String(b.name || '').trim() || username, p.salt, p.hash, new Date().toISOString());
        user = userByName(username);
      }
      const role = b.role === 'admin' ? 'admin' : 'user';
      const prev = memberOf(user.id, c.id);
      if (prev && prev.role === 'admin' && role !== 'admin') {
        const admins = reg.prepare("SELECT COUNT(*) AS n FROM members WHERE company_id = ? AND role = 'admin'").get(c.id).n;
        if (admins <= 1) return json(res, 400, { error: '公司至少要保留一个管理员' });
      }
      reg.prepare('INSERT INTO members (user_id, company_id, role) VALUES (?,?,?) ON CONFLICT(user_id, company_id) DO UPDATE SET role = excluded.role').run(user.id, c.id, role);
      const demoted = !!(prev && prev.role === 'admin' && role !== 'admin');
      syncCompanyMember(c, user, role, { revoke: demoted });
      if (demoted) reg.prepare('DELETE FROM sessions WHERE user_id = ? AND company_id = ?').run(user.id, c.id);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/portal/members' && req.method === 'DELETE') {
      if (!sess) return json(res, 401, { error: '登录已失效' });
      const me = reg.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
      const c = companyByCode(String(url.searchParams.get('company') || ''));
      if (!c) return json(res, 404, { error: '公司不存在' });
      if (!canManage(me, c.id)) return json(res, 403, { error: '只有管理员能管理成员' });
      const u = userByName(String(url.searchParams.get('username') || ''));
      if (!u) return json(res, 404, { error: '账号不存在' });
      const target = memberOf(u.id, c.id);
      if (target && target.role === 'admin') {
        const admins = reg.prepare("SELECT COUNT(*) AS n FROM members WHERE company_id = ? AND role = 'admin'").get(c.id).n;
        if (admins <= 1) return json(res, 400, { error: '公司至少要保留一个管理员' });
      }
      reg.prepare('DELETE FROM members WHERE user_id = ? AND company_id = ?').run(u.id, c.id);
      reg.prepare('DELETE FROM sessions WHERE user_id = ? AND company_id = ?').run(u.id, c.id);
      syncCompanyMember(c, u, 'user', { disable: true, revoke: true });
      return json(res, 200, { ok: true });
    }
    const company = sess ? companyById(sess.company_id) : null;
    if (p.startsWith('/api/')) {
      if (p === '/api/ping') return proxy(req, res, company || ensureDefaultCompany(), null);
      if (!sess || !company) return json(res, 401, { error: '登录已失效，请重新登录' });
      const me = reg.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
      const m = me && memberOf(me.id, company.id);
      if (!me || (!m && !me.admin)) {
        revokeCompanyToken(company, sess.company_token);
        reg.prepare('DELETE FROM sessions WHERE token = ?').run(sess.token);
        return json(res, 401, { error: '登录已失效，请重新登录' });
      }
      const syncAuth = req.method !== 'GET' && (p === '/api/users' || p.startsWith('/api/users/') || p === '/api/password');
      return proxy(req, res, company, sess.company_token, syncAuth ? () => syncCompanyUsers(company, true) : null);
    }
    return proxy(req, res, ensureDefaultCompany(), null);
  } catch (e) {
    json(res, 500, { error: e.message || '服务器错误' });
  }
});

function resetAdminPassword(pwd) {
  if (!pwd || pwd.length < 6) return;
  const p = hashPwd(pwd);
  const adm = userByName('admin');
  let changed = false;
  if (adm) {
    reg.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(p.salt, p.hash, adm.id);
    reg.prepare('DELETE FROM sessions WHERE user_id = ?').run(adm.id);
    changed = true;
  }
  for (const c of reg.prepare('SELECT * FROM companies WHERE enabled = 1').all()) {
    if (!fs.existsSync(path.join(c.dir, 'erp.db'))) continue;
    const db = companyDb(c);
    try {
      const row = db.prepare("SELECT id FROM users WHERE username = 'admin' AND disabled = 0").get();
      if (row) {
        db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(p.salt, p.hash, row.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
        changed = true;
      }
    } catch (e) { log('重置账套管理员密码失败', c.code, e.message); }
    finally { db.close(); }
  }
  if (changed) log('已按安装向导重置管理员 admin 密码');
}

async function boot() {
  const def = ensureDefaultCompany();
  let adminPwd = '';
  const pwdFiles = [arg('admin-password-file'), path.join(DATA_DIR, 'admin-password'), path.join(DATA_DIR, 'admin-password.txt')];
  for (const f of pwdFiles) {
    if (f && fs.existsSync(f)) { try { adminPwd = fs.readFileSync(f, 'utf8').trim(); } catch (e) {} break; }
  }
  initCompany(def, adminPwd);
  migrateDefaultUsers(def);
  if (adminPwd.length >= 6) resetAdminPassword(adminPwd);
  for (const f of pwdFiles) { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} }
  for (const c of reg.prepare('SELECT * FROM companies WHERE enabled = 1').all()) {
    if (c.id !== def.id) initCompany(c);
    if (!fs.existsSync(path.join(c.dir, 'erp.db'))) continue;
    const port = await nextPort(c.id, c.port);
    if (port !== c.port) {
      reg.prepare('UPDATE companies SET port = ? WHERE id = ?').run(port, c.id);
      c.port = port;
    }
    startCompany(c);
    await waitCompany(c.port);
    syncCompanyUsers(c, false);
  }
  let listenHost = '::';
  server.on('error', e => {
    if (listenHost === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code)) {
      log('本机没有启用 IPv6，网关改为只监听 IPv4');
      listenHost = '0.0.0.0';
      return server.listen(PORT, listenHost);
    }
    log(e.code === 'EADDRINUSE' ? `启动失败：网关端口 ${PORT} 已被占用` : '启动失败：' + e.message);
    process.exit(1);
  });
  server.listen(PORT, listenHost, () => log('x.erp 网关已启动（' + (listenHost === '::' ? 'IPv4/IPv6 双栈' : 'IPv4') + '），端口 ' + PORT + '，账套端口从 ' + BASE_PORT + ' 起'));
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      log('网关停止');
      stopChildren();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
  } catch (e) {}
}
boot().catch(e => { log('启动失败：' + e.message); process.exit(1); });
