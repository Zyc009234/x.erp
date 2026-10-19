'use strict';
/**
 * x.erp 服务端
 * - 仅依赖 Node.js 内置模块，数据库使用内置 SQLite（node:sqlite）
 * - 用法：erp-server.exe [--data <数据目录>] [--port <端口>]
 */
const _emitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (/SQLite/i.test(String((w && w.message) || w))) return;
  return _emitWarning.call(process, w, ...rest);
};

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const VERSION = '1.0.0';
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

/* ================= 目录 / 日志 / 配置 ================= */
const DATA_DIR = path.resolve(arg('data', process.env.ERP_DATA || path.join(process.env.ProgramData || os.homedir(), 'XERP')));
const LOG_DIR = path.join(DATA_DIR, 'logs');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(LOG_DIR, { recursive: true });

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { d = new Date(d); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { return fmtDate(new Date()); }
function log(...msg) {
  const line = new Date().toLocaleString('zh-CN', { hour12: false }) + '  ' + msg.join(' ');
  try { console.log(line); } catch (e) {}
  try { fs.appendFileSync(path.join(LOG_DIR, 'server-' + today().slice(0, 7) + '.log'), line + '\n'); } catch (e) {}
}

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const config = { port: 8686, host: '0.0.0.0', sessionDays: 7 };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''))); }
catch (e) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
if (arg('port')) config.port = +arg('port');

/* ================= 数据库 ================= */
const db = new DatabaseSync(path.join(DATA_DIR, 'erp.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (col, id));
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'user',
    salt TEXT, hash TEXT, created_at TEXT, last_login TEXT, disabled INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT, username TEXT, action TEXT, detail TEXT, ip TEXT);
`);
const S = {
  list: db.prepare('SELECT data FROM docs WHERE col = ? ORDER BY rowid DESC'),
  get: db.prepare('SELECT data FROM docs WHERE col = ? AND id = ?'),
  put: db.prepare('INSERT INTO docs (col, id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
  del: db.prepare('DELETE FROM docs WHERE col = ? AND id = ?'),
  noExists: db.prepare("SELECT 1 FROM docs WHERE col = ? AND json_extract(data, '$.no') = ?"),
  metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
  metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  audit: db.prepare('INSERT INTO audit (time, username, action, detail, ip) VALUES (?, ?, ?, ?, ?)'),
  userById: db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0'),
  adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")
};
const list = col => S.list.all(col).map(r => JSON.parse(r.data));
const get = (col, id) => { const r = S.get.get(col, String(id)); return r ? JSON.parse(r.data) : null; };
const put = (col, obj) => S.put.run(col, String(obj.id), JSON.stringify(obj), new Date().toISOString());
const del = (col, id) => S.del.run(col, String(id));
const getMeta = (k, d) => { const r = S.metaGet.get(k); return r ? JSON.parse(r.value) : d; };
const setMeta = (k, v) => S.metaSet.run(k, JSON.stringify(v));
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ================= 通用工具 ================= */
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
const round2 = n => Math.round(n * 100) / 100;
const orderTotal = o => round2(sum(o.items, i => i.qty * i.price));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (msg, status) => { throw new HttpError(msg, status); };
function audit(ctx, action, detail = '') { S.audit.run(new Date().toISOString(), ctx.user ? ctx.user.name : '-', action, String(detail).slice(0, 300), ctx.ip || ''); }

/* ================= 业务常量 ================= */
const COLS = ['products', 'customers', 'suppliers', 'employees', 'sales', 'purchases', 'stockLogs', 'finance'];
const DATED = ['sales', 'purchases', 'stockLogs', 'finance'];
const CATS = ['电子产品', '办公用品', '家居用品', '食品饮料'];
const LEVELS = ['VIP', 'A级', 'B级', 'C级'];
const METHODS = ['银行转账', '现金', '支付宝', '微信', '承兑汇票'];
const FIN_CATS = { income: ['其他收入', '投资收益', '退款'], expense: ['工资', '房租', '水电', '办公费', '差旅', '营销推广', '其他支出'] };
const ORD = {
  sales: { col: 'sales', prefix: 'SO', title: '销售单', party: 'customers', partyKey: 'customerId', partyLabel: '客户', paidKey: 'received', payWord: '收款', statuses: ['待发货', '已发货', '已完成', '已作废'] },
  purchase: { col: 'purchases', prefix: 'PO', title: '采购单', party: 'suppliers', partyKey: 'supplierId', partyLabel: '供应商', paidKey: 'paid', payWord: '付款', statuses: ['待审核', '已审核', '已入库', '已作废'] }
};
const ENTITY = {
  products: { name: '商品', required: { sku: '商品编码', name: '商品名称' },
    fields: { sku: ['s', '商品编码'], name: ['s', '商品名称'], category: ['s'], unit: ['s'], cost: ['n', '成本价'], price: ['n', '销售价'], stock: ['n', '期初库存'], safety: ['n', '安全库存'], remark: ['s'] } },
  customers: { name: '客户', required: { name: '客户名称' },
    fields: { name: ['s'], contact: ['s'], phone: ['s'], email: ['s'], level: ['s'], address: ['s'], remark: ['s'] } },
  suppliers: { name: '供应商', required: { name: '供应商名称' },
    fields: { name: ['s'], contact: ['s'], phone: ['s'], email: ['s'], category: ['s'], address: ['s'], remark: ['s'] } },
  employees: { name: '员工', required: { name: '姓名' },
    fields: { no: ['s'], name: ['s'], gender: ['s'], dept: ['s'], position: ['s'], phone: ['s'], salary: ['n', '月薪'], joinDate: ['s'], status: ['s'] } }
};

/* ================= 演示数据 ================= */
function seed() {
  let s = 20261012;
  const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = a => a[Math.floor(rnd() * a.length)];
  const phone = () => '1' + pick(['38', '39', '58', '86', '77', '35']) + String(ri(10000000, 99999999));
  const dayAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return fmtDate(d); };
  const P = [
    ['无线蓝牙耳机', '电子产品', '个', 89, 199], ['机械键盘', '电子产品', '个', 159, 329], ['27寸4K显示器', '电子产品', '台', 899, 1499],
    ['静音无线鼠标', '电子产品', '个', 35, 89], ['USB-C 扩展坞', '电子产品', '个', 120, 259], ['移动电源 20000mAh', '电子产品', '个', 65, 149],
    ['A4 复印纸', '办公用品', '箱', 95, 145], ['中性笔', '办公用品', '盒', 12, 25], ['文件收纳盒', '办公用品', '个', 18, 39],
    ['人体工学办公椅', '办公用品', '把', 420, 899], ['电动升降桌', '办公用品', '张', 980, 1899], ['LED 护眼台灯', '家居用品', '个', 55, 129],
    ['不锈钢保温杯', '家居用品', '个', 38, 89], ['静音加湿器', '家居用品', '台', 79, 179], ['空气净化器', '家居用品', '台', 650, 1299],
    ['精品咖啡豆 1kg', '食品饮料', '袋', 68, 138], ['有机绿茶礼盒', '食品饮料', '盒', 85, 188], ['天然矿泉水', '食品饮料', '箱', 18, 32],
    ['每日坚果礼盒', '食品饮料', '盒', 56, 118], ['进口干红葡萄酒', '食品饮料', '瓶', 120, 268]
  ];
  const products = P.map((p, i) => ({ id: 'p' + (i + 1), sku: 'SKU' + (1001 + i), name: p[0], category: p[1], unit: p[2], cost: p[3], price: p[4], stock: ri(30, 280), safety: ri(20, 40), remark: '', createdAt: dayAgo(200) }));
  products[2].stock = 8; products[9].stock = 12; products[14].stock = 0; products[19].stock = 15;
  const names = ['星辰科技有限公司', '蓝海贸易有限公司', '远航物流集团', '恒信商贸有限公司', '青松教育科技', '金桥实业有限公司', '云图数据服务', '和美家居连锁', '乐享餐饮管理', '启明管理咨询'];
  const people = ['张伟', '李娜', '王强', '刘洋', '陈静', '杨帆', '赵磊', '黄敏', '周杰', '吴芳', '徐鹏', '孙丽', '马超', '朱婷', '胡斌', '郭琳'];
  const cities = ['北京市朝阳区', '上海市浦东新区', '深圳市南山区', '杭州市西湖区', '广州市天河区', '成都市高新区', '南京市鼓楼区', '武汉市洪山区'];
  const customers = names.map((n, i) => ({ id: 'c' + (i + 1), name: n, contact: people[i], phone: phone(), email: 'contact' + (i + 1) + '@example.com', level: pick(LEVELS), address: pick(cities) + ri(1, 300) + '号', remark: '', createdAt: dayAgo(220) }));
  const suppliers = [['鼎盛电子供应链', '电子产品'], ['华泰办公用品厂', '办公用品'], ['美居家居制造', '家居用品'], ['绿源食品贸易', '食品饮料'], ['迅捷数码配件', '电子产品'], ['优选综合供应商', '综合']]
    .map((x, i) => ({ id: 's' + (i + 1), name: x[0], category: x[1], contact: people[10 + i], phone: phone(), email: 'sales' + (i + 1) + '@example.com', address: pick(cities) + ri(1, 300) + '号', remark: '', createdAt: dayAgo(230) }));
  const emp = [['林晓', '女', '销售部', '销售总监', 18000], ['陈浩', '男', '销售部', '销售经理', 12000], ['王悦', '女', '销售部', '销售专员', 7000], ['赵刚', '男', '采购部', '采购经理', 11000], ['孙倩', '女', '采购部', '采购专员', 6500],
    ['周磊', '男', '仓储部', '仓库主管', 8000], ['吴迪', '男', '仓储部', '仓管员', 5500], ['郑爽', '女', '财务部', '财务经理', 13000], ['冯雪', '女', '财务部', '会计', 7500], ['何平', '男', '行政部', '行政主管', 8500], ['许杰', '男', '技术部', 'IT 工程师', 14000], ['邓佳', '女', '销售部', '销售专员', 6800]];
  const employees = emp.map((e, i) => ({ id: 'e' + (i + 1), no: 'E' + (1001 + i), name: e[0], gender: e[1], dept: e[2], position: e[3], phone: phone(), salary: e[4], joinDate: dayAgo(ri(60, 1500)), status: i === 11 ? '试用期' : '在职' }));
  const sales = [], purchases = [], stockLogs = [], finance = [];
  const items = (priceKey, qmin, qmax) => {
    const n = ri(1, 3), used = new Set(), r = [];
    while (r.length < n) { const p = pick(products); if (used.has(p.id)) continue; used.add(p.id); r.push({ productId: p.id, qty: ri(qmin, qmax), price: p[priceKey], cost: p.cost }); }
    return r;
  };
  const t = () => pad(ri(8, 18)) + ':' + pad(ri(0, 59));
  for (let i = 0; i < 80; i++) {
    const age = ri(0, 178), date = dayAgo(age), its = items('price', 1, 15);
    const status = age > 20 ? (rnd() < .05 ? '已作废' : '已完成') : age > 6 ? pick(['已发货', '已完成']) : pick(['待发货', '待发货', '已发货']);
    const total = sum(its, x => x.qty * x.price);
    let received = status === '已完成' ? total : status === '已发货' ? pick([0, Math.round(total * .5), total]) : 0;
    if (status === '已完成' && age < 45 && rnd() < .3) received = Math.round(total * .4);
    const o = { id: 'so' + i, no: 'SO' + date.replace(/-/g, '') + String(i + 1).padStart(3, '0'), customerId: pick(customers).id, date, items: its, status, received, remark: '', createdAt: date };
    sales.push(o);
    if (received > 0) finance.push({ id: 'fs' + i, date: dayAgo(Math.max(0, age - ri(0, 6))), type: 'income', category: '销售收款', amount: received, method: pick(METHODS), ref: o.no, note: '' });
    if (status === '已发货' || status === '已完成') its.forEach((x, k) => stockLogs.push({ id: 'ls' + i + '_' + k, date: dayAgo(Math.max(0, age - 1)), time: t(), productId: x.productId, kind: '销售出库', qty: -x.qty, ref: o.no, note: '', operator: '周磊' }));
  }
  for (let i = 0; i < 26; i++) {
    const age = ri(0, 180), date = dayAgo(age), its = items('cost', 20, 80);
    const status = age > 10 ? '已入库' : pick(['待审核', '已审核']);
    const total = sum(its, x => x.qty * x.price);
    const paid = status === '已入库' ? (age > 30 ? total : pick([0, Math.round(total * .5), total])) : 0;
    const o = { id: 'po' + i, no: 'PO' + date.replace(/-/g, '') + String(i + 1).padStart(3, '0'), supplierId: pick(suppliers).id, date, items: its, status, paid, remark: '', createdAt: date };
    purchases.push(o);
    if (paid > 0) finance.push({ id: 'fp' + i, date: dayAgo(Math.max(0, age - ri(0, 5))), type: 'expense', category: '采购付款', amount: paid, method: '银行转账', ref: o.no, note: '' });
    if (status === '已入库') its.forEach((x, k) => stockLogs.push({ id: 'lp' + i + '_' + k, date: dayAgo(Math.max(0, age - 2)), time: t(), productId: x.productId, kind: '采购入库', qty: x.qty, ref: o.no, note: '', operator: '吴迪' }));
  }
  const salaryTotal = sum(employees, e => e.salary), now = new Date();
  for (let m = 5; m >= 0; m--) {
    const d0 = new Date(now.getFullYear(), now.getMonth() - m, 1), mk = d0.getFullYear() + '-' + pad(d0.getMonth() + 1);
    [['房租', 18000, 5], ['工资', salaryTotal, 10], ['水电', ri(1800, 3200), 15], ['办公费', ri(800, 2500), 18], ['营销推广', ri(3000, 9000), 20]].forEach(([c, a, d], k) => {
      const date = mk + '-' + pad(d);
      if (date <= today()) finance.push({ id: 'fe' + mk + k, date, type: 'expense', category: c, amount: a, method: '银行转账', ref: '', note: mk + ' ' + c });
    });
  }
  return { products, customers, suppliers, employees, sales, purchases, stockLogs, finance };
}
function writeAll(data) {
  db.exec('DELETE FROM docs');
  for (const col of COLS) {
    const arr = Array.isArray(data[col]) ? data[col] : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const r = arr[i];
      if (!r || typeof r !== 'object') continue;
      if (!r.id) r.id = uid();
      put(col, r);
    }
  }
}

/* ================= 用户 / 会话 ================= */
function hashPwd(pwd, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(String(pwd), salt, 64).toString('hex') }; }
function checkPwd(u, pwd) {
  const a = Buffer.from(hashPwd(pwd, u.salt).hash, 'hex'), b = Buffer.from(u.hash || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.created_at, lastLogin: u.last_login });
function createUser({ username, name, role, password }) {
  username = str(username, 32);
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) fail('用户名需为 2-32 位字母、数字或 _ . -');
  if (String(password || '').length < 6) fail('密码至少 6 位');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail('用户名已存在');
  const { salt, hash } = hashPwd(password), id = uid();
  db.prepare('INSERT INTO users (id, username, name, role, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, username, str(name, 32) || username, role === 'admin' ? 'admin' : 'user', salt, hash, new Date().toISOString());
  return id;
}
function authUser(req) {
  const m = /^Bearer\s+([0-9a-f]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(m[1]);
  if (!s || s.expires < Date.now()) return null;
  const u = S.userById.get(s.user_id);
  return u ? Object.assign(u, { token: m[1] }) : null;
}
const loginFails = new Map();
function login(ctx, body) {
  const f = loginFails.get(ctx.ip) || { n: 0, t: 0 };
  if (f.n >= 10 && Date.now() - f.t < 10 * 60e3) fail('登录失败次数过多，请 10 分钟后再试', 429);
  const u = S.userByName.get(str(body.username, 32));
  if (!u || !checkPwd(u, body.password)) { loginFails.set(ctx.ip, { n: f.n + 1, t: Date.now() }); fail('用户名或密码错误', 401); }
  loginFails.delete(ctx.ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run(token, u.id, Date.now() + config.sessionDays * 864e5);
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), u.id);
  audit({ user: u, ip: ctx.ip }, '登录');
  return { token, user: publicUser(u) };
}

/* ================= 业务逻辑 ================= */
function addLog(ctx, productId, kind, qty, ref = '', note = '') {
  const d = new Date();
  put('stockLogs', { id: uid(), date: today(), time: pad(d.getHours()) + ':' + pad(d.getMinutes()), productId, kind, qty, ref, note, operator: ctx.user.name });
}
function nextNo(C) {
  const k = C.prefix + today().replace(/-/g, ''), counters = getMeta('counters', {});
  let n = counters[k] || 0, no;
  do { n++; no = k + String(n).padStart(3, '0'); } while (S.noExists.get(C.col, no));
  counters[k] = n; setMeta('counters', counters);
  return no;
}
function clean(col, body) {
  const v = {};
  for (const [k, [t, label]] of Object.entries(ENTITY[col].fields)) {
    if (!(k in body)) continue;
    if (t === 'n') { const n = Number(body[k]); if (!Number.isFinite(n) || n < 0) fail((label || k) + '必须是非负数字'); v[k] = round2(n); }
    else v[k] = str(body[k], 500);
  }
  return v;
}
function saveEntity(ctx, col, id) {
  const E = ENTITY[col] || fail('接口不存在', 404), v = clean(col, ctx.body);
  return tx(() => {
    const rec = id ? (get(col, id) || fail(E.name + '不存在', 404)) : null;
    const r = { ...(rec || {}), ...v };
    for (const [k, l] of Object.entries(E.required)) if (!r[k]) fail('请填写' + l);
    if (col === 'products') {
      if (list('products').some(p => p.sku === r.sku && p.id !== id)) fail('商品编码已存在');
      r.stock = rec ? rec.stock : Math.round(r.stock || 0);
      r.safety = Math.round(r.safety || 0);
    }
    if (col === 'employees' && !r.no) {
      const nos = new Set(list('employees').map(e => e.no));
      let n = 1001 + nos.size; while (nos.has('E' + n)) n++;
      r.no = 'E' + n;
    }
    if (!rec) { r.id = uid(); r.createdAt = today(); }
    put(col, r);
    if (!rec && col === 'products' && r.stock > 0) addLog(ctx, r.id, '期初库存', r.stock, '', '新建商品');
    audit(ctx, (rec ? '修改' : '新增') + E.name, r.name);
    return r;
  });
}
function deleteEntity(ctx, col, id) {
  const E = ENTITY[col] || fail('接口不存在', 404);
  return tx(() => {
    const rec = get(col, id) || fail(E.name + '不存在', 404);
    const used = col === 'products' ? [...list('sales'), ...list('purchases')].some(o => o.items.some(i => i.productId === id))
      : col === 'customers' ? list('sales').some(o => o.customerId === id)
      : col === 'suppliers' ? list('purchases').some(o => o.supplierId === id) : false;
    if (used) fail(`该${E.name}已被单据引用，无法删除`);
    del(col, id);
    audit(ctx, '删除' + E.name, rec.name);
  });
}
function saveOrder(ctx, kind, id) {
  const C = ORD[kind] || fail('接口不存在', 404), b = ctx.body;
  return tx(() => {
    const party = str(b.partyId, 64);
    if (!get(C.party, party)) fail('请选择有效的' + C.partyLabel);
    if (!isDate(b.date)) fail('日期格式不正确');
    const items = (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId).map(i => {
      const p = get('products', i.productId) || fail('商品不存在或已删除');
      const qty = Number(i.qty), price = Number(i.price);
      if (!Number.isInteger(qty) || qty <= 0) fail('数量必须为正整数');
      if (!Number.isFinite(price) || price < 0) fail('单价不正确');
      return { productId: p.id, qty, price: round2(price), cost: p.cost };
    });
    if (!items.length) fail('请至少添加一个商品');
    const data = { [C.partyKey]: party, date: b.date, remark: str(b.remark, 500), items };
    if (id) {
      const o = get(C.col, id) || fail('单据不存在', 404);
      if (o.status !== C.statuses[0]) fail(`单据状态为「${o.status}」，不能编辑`);
      items.forEach(it => { const old = o.items.find(x => x.productId === it.productId); if (old && old.cost != null) it.cost = old.cost; });
      Object.assign(o, data);
      put(C.col, o); audit(ctx, '修改' + C.title, o.no);
      return o;
    }
    const o = { id: uid(), no: nextNo(C), ...data, status: C.statuses[0], [C.paidKey]: 0, createdAt: today(), creator: ctx.user.name };
    put(C.col, o); audit(ctx, '新建' + C.title, `${o.no} ${orderTotal(o)}`);
    return o;
  });
}
function orderAction(ctx, kind, id, action) {
  const C = ORD[kind] || fail('接口不存在', 404), b = ctx.body || {};
  return tx(() => {
    const o = get(C.col, id) || fail('单据不存在', 404);
    const need = st => { if (o.status !== st) fail(`单据当前状态为「${o.status}」，无法执行此操作`); };
    if (action === 'ship' && kind === 'sales') {
      need('待发货');
      const qty = {};
      o.items.forEach(i => { qty[i.productId] = (qty[i.productId] || 0) + i.qty; });
      const lack = Object.entries(qty).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => !x.p || x.p.stock < x.q);
      if (lack.length) fail('库存不足：' + lack.map(x => x.p ? `${x.p.name}（需 ${x.q}，现有 ${x.p.stock}）` : '商品已删除').join('、'));
      Object.entries(qty).forEach(([pid, q]) => { const p = get('products', pid); p.stock -= q; put('products', p); });
      o.items.forEach(i => addLog(ctx, i.productId, '销售出库', -i.qty, o.no));
      o.status = '已发货'; o.shipDate = today();
    } else if (action === 'complete' && kind === 'sales') { need('已发货'); o.status = '已完成'; }
    else if (action === 'approve' && kind === 'purchase') { need('待审核'); o.status = '已审核'; o.approver = ctx.user.name; }
    else if (action === 'inbound' && kind === 'purchase') {
      need('已审核');
      o.items.forEach(i => { const p = get('products', i.productId); if (p) { p.stock += i.qty; put('products', p); addLog(ctx, p.id, '采购入库', i.qty, o.no); } });
      o.status = '已入库'; o.inDate = today();
    } else if (action === 'cancel') {
      const ok = kind === 'sales' ? ['待发货'] : ['待审核', '已审核'];
      if (!ok.includes(o.status)) fail(`单据当前状态为「${o.status}」，不能作废`);
      if (o[C.paidKey] > 0) fail(`单据已有${C.payWord}记录，不能作废`);
      o.status = '已作废';
    } else if (action === 'pay') {
      if (o.status === '已作废') fail(`已作废单据不能${C.payWord}`);
      const unpaid = round2(orderTotal(o) - (o[C.paidKey] || 0)), amount = round2(Number(b.amount));
      if (!(amount > 0) || amount > unpaid + 0.001) fail(`${C.payWord}金额需在 0 ~ ${unpaid} 之间`);
      o[C.paidKey] = round2((o[C.paidKey] || 0) + amount);
      put('finance', { id: uid(), date: isDate(b.date) ? b.date : today(), type: kind === 'sales' ? 'income' : 'expense', category: kind === 'sales' ? '销售收款' : '采购付款',
        amount, method: METHODS.includes(b.method) ? b.method : '银行转账', ref: o.no, note: str(b.note), operator: ctx.user.name });
    } else fail('不支持的操作', 404);
    put(C.col, o);
    audit(ctx, { ship: '发货', complete: '完成订单', approve: '审核采购', inbound: '采购入库', cancel: '作废单据', pay: C.payWord }[action], o.no + (action === 'pay' ? ' ' + b.amount : ''));
    return o;
  });
}
function deleteOrder(ctx, kind, id) {
  const C = ORD[kind] || fail('接口不存在', 404);
  return tx(() => {
    const o = get(C.col, id) || fail('单据不存在', 404);
    if (o.status !== '已作废') fail('只能删除已作废的单据');
    del(C.col, id); audit(ctx, '删除' + C.title, o.no);
  });
}
function adjustStock(ctx, id) {
  const { mode, note } = ctx.body, qty = Number(ctx.body.qty);
  const T = { in: '手工入库', out: '手工出库', check: '盘点调整' }[mode] || fail('不支持的操作');
  if (!Number.isInteger(qty)) fail('数量必须为整数');
  return tx(() => {
    const p = get('products', id) || fail('商品不存在', 404);
    let d;
    if (mode === 'check') { if (qty < 0) fail('数量不能为负'); d = qty - p.stock; }
    else { if (qty <= 0) fail('数量必须大于 0'); d = mode === 'in' ? qty : -qty; if (p.stock + d < 0) fail('库存不足，当前仅 ' + p.stock); }
    if (d !== 0) { p.stock += d; put('products', p); addLog(ctx, p.id, T, d, '', str(note)); audit(ctx, T, `${p.name} ${d > 0 ? '+' : ''}${d}`); }
    return { delta: d, stock: p.stock };
  });
}
function addFinance(ctx) {
  const b = ctx.body, type = b.type === 'income' ? 'income' : b.type === 'expense' ? 'expense' : fail('收支类型不正确');
  if (!FIN_CATS[type].includes(b.category)) fail('科目不正确');
  const amount = round2(Number(b.amount));
  if (!(amount > 0)) fail('金额必须大于 0');
  if (!isDate(b.date)) fail('日期格式不正确');
  const r = { id: uid(), date: b.date, type, category: b.category, amount, method: METHODS.includes(b.method) ? b.method : '银行转账', ref: '', note: str(b.note), operator: ctx.user.name };
  tx(() => { put('finance', r); audit(ctx, '记账', `${type === 'income' ? '收入' : '支出'} ${r.category} ${amount}`); });
  return r;
}
function deleteFinance(ctx, id) {
  return tx(() => {
    const f = get('finance', id) || fail('记录不存在', 404);
    if (f.ref) fail('由单据生成的收付款记录不能直接删除');
    del('finance', id); audit(ctx, '删除流水', `${f.category} ${f.amount}`);
  });
}
function backup() {
  const data = {};
  COLS.forEach(c => { data[c] = list(c); });
  return { app: 'XERP', version: VERSION, exportedAt: new Date().toISOString(), settings: getMeta('settings', {}), counters: getMeta('counters', {}), data };
}
function restore(ctx) {
  const b = ctx.body || {};
  const src = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : b;  // 同时兼容单机版备份
  if (!Array.isArray(src.products) || !Array.isArray(src.sales)) fail('备份文件格式不正确');
  tx(() => {
    writeAll(src);
    const company = b.settings && b.settings.company;
    if (company) setMeta('settings', { ...getMeta('settings', {}), company: str(company, 100) });
    setMeta('counters', b.counters && typeof b.counters === 'object' ? b.counters : {});
    audit(ctx, '导入备份', `商品 ${src.products.length}，销售单 ${src.sales.length}`);
  });
}
function autoBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, 'erp-' + today().replace(/-/g, '') + '.db');
    if (!fs.existsSync(f)) { db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); log('自动备份完成：' + f); }
    fs.readdirSync(BACKUP_DIR).filter(n => /^erp-\d{8}\.db$/.test(n)).sort().slice(0, -30).forEach(n => fs.unlinkSync(path.join(BACKUP_DIR, n)));
  } catch (e) { log('自动备份失败：' + e.message); }
}

/* ================= 初始化 ================= */
if (!getMeta('initialized', false)) {
  tx(() => { writeAll(seed()); setMeta('settings', { company: '示例科技有限公司' }); setMeta('counters', {}); setMeta('initialized', true); });
  log('首次启动：已写入演示数据');
}
if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  // --admin-password-file：首次启动时从文件读取管理员初始密码（NAS 安装向导填写），读取后删除
  let pwd = '';
  try { if (arg('admin-password-file')) pwd = fs.readFileSync(arg('admin-password-file'), 'utf8').trim(); } catch (e) {}
  if (pwd.length < 6) pwd = 'admin123';
  createUser({ username: 'admin', name: '管理员', role: 'admin', password: pwd });
  log(pwd === 'admin123' ? '已创建默认管理员账号 admin / admin123' : '已创建管理员账号 admin（密码为安装时设置的密码）');
}
try { if (arg('admin-password-file')) fs.unlinkSync(arg('admin-password-file')); } catch (e) {}

/* ================= 路由 ================= */
const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, auth: opts.auth !== false, admin: !!opts.admin });

route('GET', '/api/ping', () => ({ ok: true, app: 'XERP', version: VERSION, company: getMeta('settings', {}).company || '' }), { auth: false });
route('POST', '/api/login', ctx => login(ctx, ctx.body), { auth: false });
route('POST', '/api/logout', ctx => { db.prepare('DELETE FROM sessions WHERE token = ?').run(ctx.user.token); });
route('GET', '/api/data', ctx => {
  const data = {};
  const byDate = (a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || ''));
  COLS.forEach(c => { data[c] = list(c); if (DATED.includes(c)) data[c].sort(byDate); });
  return { version: VERSION, settings: getMeta('settings', {}), user: publicUser(ctx.user), data };
});
route('PUT', '/api/settings', ctx => {
  const company = str(ctx.body.company, 100) || fail('公司名称不能为空');
  setMeta('settings', { ...getMeta('settings', {}), company }); audit(ctx, '修改设置', '公司名称：' + company);
}, { admin: true });

for (const col of Object.keys(ENTITY)) {
  route('POST', `/api/${col}`, ctx => saveEntity(ctx, col, null));
  route('PUT', `/api/${col}/:id`, ctx => saveEntity(ctx, col, ctx.params.id));
  route('DELETE', `/api/${col}/:id`, ctx => deleteEntity(ctx, col, ctx.params.id));
}
route('POST', '/api/orders/:kind', ctx => saveOrder(ctx, ctx.params.kind, null));
route('PUT', '/api/orders/:kind/:id', ctx => saveOrder(ctx, ctx.params.kind, ctx.params.id));
route('DELETE', '/api/orders/:kind/:id', ctx => deleteOrder(ctx, ctx.params.kind, ctx.params.id));
route('POST', '/api/orders/:kind/:id/:action', ctx => orderAction(ctx, ctx.params.kind, ctx.params.id, ctx.params.action));
route('POST', '/api/stock/:id', ctx => adjustStock(ctx, ctx.params.id));
route('POST', '/api/finance', ctx => addFinance(ctx));
route('DELETE', '/api/finance/:id', ctx => deleteFinance(ctx, ctx.params.id));

route('POST', '/api/password', ctx => {
  const { oldPassword, newPassword } = ctx.body;
  if (!checkPwd(ctx.user, oldPassword)) fail('当前密码不正确');
  if (String(newPassword || '').length < 6) fail('新密码至少 6 位');
  const { salt, hash } = hashPwd(newPassword);
  db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, ctx.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(ctx.user.id, ctx.user.token);
  audit(ctx, '修改密码');
});
route('GET', '/api/users', () => db.prepare('SELECT * FROM users WHERE disabled = 0 ORDER BY created_at').all().map(publicUser), { admin: true });
route('POST', '/api/users', ctx => { createUser(ctx.body); audit(ctx, '新增用户', ctx.body.username); }, { admin: true });
route('PUT', '/api/users/:id', ctx => {
  const u = S.userById.get(ctx.params.id) || fail('用户不存在', 404), b = ctx.body;
  const role = b.role === 'admin' ? 'admin' : 'user';
  if (u.role === 'admin' && role !== 'admin' && S.adminCount.get().n <= 1) fail('系统至少需要保留一个管理员');
  db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').run(str(b.name, 32) || u.name, role, u.id);
  if (b.password) {
    if (String(b.password).length < 6) fail('密码至少 6 位');
    const { salt, hash } = hashPwd(b.password);
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, u.id);
    if (u.id !== ctx.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  audit(ctx, '修改用户', u.username + (b.password ? '（重置密码）' : ''));
}, { admin: true });
route('DELETE', '/api/users/:id', ctx => {
  if (ctx.params.id === ctx.user.id) fail('不能删除当前登录的账号');
  const u = S.userById.get(ctx.params.id) || fail('用户不存在', 404);
  if (u.role === 'admin' && S.adminCount.get().n <= 1) fail('系统至少需要保留一个管理员');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  audit(ctx, '删除用户', u.username);
}, { admin: true });
route('GET', '/api/audit', ctx => db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(1000, +ctx.query.get('limit') || 200)), { admin: true });
route('GET', '/api/backup', ctx => { audit(ctx, '导出备份'); return backup(); }, { admin: true });
route('POST', '/api/restore', ctx => restore(ctx), { admin: true });
route('POST', '/api/reset-demo', ctx => tx(() => { writeAll(seed()); setMeta('counters', {}); audit(ctx, '重置演示数据'); }), { admin: true });
route('POST', '/api/clear', ctx => tx(() => { writeAll({}); setMeta('counters', {}); audit(ctx, '清空业务数据'); }), { admin: true });

/* ================= HTTP 服务 ================= */
let INDEX_HTML = null;
function indexHtml() {
  if (INDEX_HTML) return INDEX_HTML;
  try { const sea = require('node:sea'); if (sea.isSea()) return (INDEX_HTML = sea.getAsset('index.html', 'utf8')); } catch (e) {}
  try { return (INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')); } catch (e) {}
  return '<h1>x.erp 服务端运行中</h1>';
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 50 * 1024 * 1024) { reject(new HttpError('请求数据过大', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(new HttpError('请求数据格式错误')); }
    });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(indexHtml());
    }
    res.writeHead(404); return res.end();
  }
  const ctx = { ip: String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''), query: url.searchParams, body: {}, user: null, params: {} };
  try {
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname)) || fail('接口不存在', 404);
    ctx.params = Object.fromEntries(Object.entries(url.pathname.match(r.re).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    if (r.auth) {
      ctx.user = authUser(req) || fail('登录已过期，请重新登录', 401);
      if (r.admin && ctx.user.role !== 'admin') fail('需要管理员权限', 403);
    }
    if (req.method === 'POST' || req.method === 'PUT') ctx.body = await readBody(req);
    const out = r.handler(ctx);
    send(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) log('错误', req.method, url.pathname, e.stack || e.message);
    send(res, status, { error: status === 500 ? '服务器内部错误：' + e.message : e.message });
  }
});
server.on('error', e => {
  log(e.code === 'EADDRINUSE' ? `启动失败：端口 ${config.port} 已被占用，请修改 ${CONFIG_FILE} 中的 port` : '启动失败：' + e.message);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  log(`x.erp 服务端 v${VERSION} 已启动`);
  log('数据目录：' + DATA_DIR);
  log('访问地址：' + ['127.0.0.1', ...ips].map(ip => `http://${ip}:${config.port}`).join('  '));
  setTimeout(autoBackup, 10e3);
  setInterval(autoBackup, 3600e3);
});
const shutdown = () => { log('服务端停止'); try { db.close(); } catch (e) {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
