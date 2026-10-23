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

const VERSION = '1.0.4';
const RELEASE_DATE = '2026-10-23';  // 本版本发布日期：授权码的免费升级截止日不早于它，专业版功能才可用
// 专业版授权码校验公钥（对应私钥只在发码方本机，见 tools/license.js）
const LICENSE_PUBKEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAlhmiG/CK2MaT2qX7LaziMR2fGn4BfkaXbavU3UeJD3s=\n-----END PUBLIC KEY-----\n';
const TRIAL_DAYS = 15;
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
try { db.exec('ALTER TABLE users ADD COLUMN perms TEXT'); } catch (e) {}  // 细化权限（JSON 数组），NULL 表示旧账号：拥有全部业务权限
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
const round4 = n => Math.round(n * 1e4) / 1e4;
const orderTotal = o => round2(sum(o.items, i => i.qty * i.price));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (msg, status) => { throw new HttpError(msg, status); };
function audit(ctx, action, detail = '') { S.audit.run(new Date().toISOString(), ctx.user ? ctx.user.name : '-', action, String(detail).slice(0, 300), ctx.ip || ''); }

/* ================= 业务常量 ================= */
const COLS = ['products', 'customers', 'suppliers', 'employees', 'sales', 'purchases', 'stockLogs', 'stockDocs', 'checkDocs', 'finance', 'warehouses', 'transferDocs', 'batches'];
const DATED = ['sales', 'purchases', 'stockLogs', 'stockDocs', 'checkDocs', 'finance', 'transferDocs'];
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
    fields: { sku: ['s', '商品编码'], barcode: ['s', '条码'], name: ['s', '商品名称'], spec: ['s'], category: ['s'], unit: ['s'], cost: ['n', '成本价'], price: ['n', '销售价'], stock: ['n', '期初库存'], safety: ['n', '安全库存'],
      batch: ['b'], shelfDays: ['n', '保质期天数'], remark: ['s'] } },
  customers: { name: '客户', required: { name: '客户名称' },
    fields: { name: ['s'], contact: ['s'], phone: ['s'], email: ['s'], level: ['s'], address: ['s'], remark: ['s'] } },
  suppliers: { name: '供应商', required: { name: '供应商名称' },
    fields: { name: ['s'], contact: ['s'], phone: ['s'], email: ['s'], category: ['s'], address: ['s'], remark: ['s'] } },
  employees: { name: '员工', required: { name: '姓名' },
    fields: { no: ['s'], name: ['s'], gender: ['s'], dept: ['s'], position: ['s'], phone: ['s'], salary: ['n', '月薪'], joinDate: ['s'], status: ['s'] } }
};
const DOC_TYPES = { in: ['采购入库', '生产入库', '退货入库', '其他入库'], out: ['领料出库', '销售出库', '报损出库', '其他出库'] };
const DOC = { in: { col: 'stockDocs', prefix: 'RK', title: '入库单' }, out: { col: 'stockDocs', prefix: 'CK', title: '出库单' } };
const TRANSFER = { col: 'transferDocs', prefix: 'DB', title: '调拨单' };
const DEFAULT_WH = 'w1';

/* ================= 专业版授权 ================= */
// 授权码：XERP-<base64url(JSON)>.<base64url(Ed25519 签名)>，JSON 为 { id, to, ed, iat, upd }
// 永久有效；upd（免费升级截止日）早于本版本发布日期时，本版本的专业版功能不可用，可继续使用之前的版本或续费
function parseLicense(key) {
  const m = /^XERP-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(key || '').trim());
  if (!m) return null;
  try {
    if (!crypto.verify(null, Buffer.from(m[1]), LICENSE_PUBKEY, Buffer.from(m[2], 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return p && p.ed === 'pro' && isDate(p.upd) ? p : null;
  } catch (e) { return null; }
}
function licenseStatus() {
  const lic = parseLicense(getMeta('license', ''));
  if (lic) {
    const ok = lic.upd >= RELEASE_DATE;
    return { pro: ok, mode: 'license', id: lic.id, to: lic.to, issued: lic.iat, upd: lic.upd,
      note: ok ? '' : `授权码的免费升级期已于 ${lic.upd} 结束，本版本（${RELEASE_DATE} 发布）的专业版功能不可用。可继续使用 ${lic.upd} 之前发布的版本，或续费升级。` };
  }
  const t = getMeta('trial', null);
  if (t && t.start) {
    const end = fmtDate(new Date(new Date(t.start).getTime() + TRIAL_DAYS * 864e5));
    return { pro: today() <= end, mode: 'trial', trialEnd: end, note: today() <= end ? '' : `试用已于 ${end} 结束` };
  }
  return { pro: false, mode: 'none', trialAvailable: true };
}
const isPro = () => licenseStatus().pro;
const needPro = feature => { if (!isPro()) fail(`「${feature}」是专业版功能，请到 系统设置 → 专业版 激活或试用`, 403); };

/* ================= 模块 / 权限 ================= */
const MODULES = { inventory: '库存管理', products: '商品管理', dashboard: '工作台', sales: '销售管理', purchase: '采购管理', parties: '客户 / 供应商', finance: '财务管理', hr: '人事管理', reports: '统计报表' };
const DEFAULT_MODULES = ['inventory', 'products'];
// [权限键, 名称, 所属模块]
const PERMS = [
  ['inv.view', '查看库存、出入库单与流水', 'inventory'], ['inv.in', '开入库单', 'inventory'], ['inv.out', '开出库单', 'inventory'],
  ['inv.check', '盘点录入（新建盘点单、录实盘数）', 'inventory'], ['inv.checkpost', '盘点审核（确认盘盈盘亏、调整库存）', 'inventory'], ['inv.void', '作废出入库单（冲回库存）', 'inventory'],
  ['inv.print', '打印单据 / 盘点表', 'inventory'], ['inv.export', '导出数据', 'inventory'],
  ['inv.cost', '查看价格与金额', 'inventory'], ['inv.backdate', '单据日期可选非当天（补录）', 'inventory'],
  ['inv.others', '查看 / 处理他人开的单据', 'inventory'], ['inv.transfer', '开调拨单（仓库之间移库）', 'inventory'],
  ['prod.view', '查看商品档案', 'products'], ['prod.edit', '新增 / 编辑商品', 'products'], ['prod.delete', '删除商品', 'products'],
  ['dashboard', '工作台', 'dashboard'], ['sales', '销售管理（全部操作）', 'sales'], ['purchase', '采购管理（全部操作）', 'purchase'],
  ['parties', '客户 / 供应商管理', 'parties'], ['finance', '财务管理', 'finance'], ['hr', '人事管理', 'hr'], ['reports', '统计报表', 'reports']
];
const PERM_KEYS = PERMS.map(p => p[0]);
const PERM_MOD = Object.fromEntries(PERMS.map(p => [p[0], p[2]]));
const PERM_LABEL = Object.fromEntries(PERMS.map(p => [p[0], p[1]]));
const cleanPerms = a => [...new Set((Array.isArray(a) ? a : []).filter(k => PERM_KEYS.includes(k)))];

/* ---------- 角色 ---------- */
// 预置角色：首次启动写入，之后可在「角色管理」里修改、删除，也可新增自定义角色
const DEFAULT_ROLES = [
  ['r_wh_mgr', '仓库主管', '库存全部操作，含作废、盘点审核、调拨、补录和查看金额', ['inv.view', 'inv.in', 'inv.out', 'inv.check', 'inv.checkpost', 'inv.void', 'inv.transfer', 'inv.print', 'inv.export', 'inv.cost', 'inv.backdate', 'inv.others', 'prod.view', 'prod.edit']],
  ['r_wh', '仓管员', '日常收发货：开入库单、出库单、调拨单并打印', ['inv.view', 'inv.in', 'inv.out', 'inv.transfer', 'inv.print', 'prod.view']],
  ['r_in', '入库员', '只负责收货入库', ['inv.view', 'inv.in', 'inv.print', 'prod.view']],
  ['r_out', '出库员', '只负责发货 / 领料出库', ['inv.view', 'inv.out', 'inv.print', 'prod.view']],
  ['r_check', '盘点员', '新建盘点单、录入实盘数（审核由主管完成）', ['inv.view', 'inv.check', 'inv.print', 'inv.others', 'prod.view']],
  ['r_prod', '商品专员', '维护商品档案（编码、规格、安全库存）', ['inv.view', 'prod.view', 'prod.edit']],
  ['r_acct', '成本会计', '查看全部单据与金额，导出对账', ['inv.view', 'inv.cost', 'inv.export', 'inv.print', 'inv.others', 'prod.view', 'finance', 'reports']],
  ['r_read', '只读查询', '只能查看和打印，不能改动库存', ['inv.view', 'inv.print', 'inv.export', 'inv.others', 'prod.view']],
  ['r_staff', '业务员', '旧版「业务员」：全部业务功能（不含用户与数据管理）', PERM_KEYS]
];
db.exec('CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, descr TEXT, perms TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT)');
try { db.exec('ALTER TABLE users ADD COLUMN role_id TEXT'); } catch (e) {}
if (!db.prepare('SELECT COUNT(*) AS n FROM roles').get().n) {
  const ins = db.prepare('INSERT INTO roles (id, name, descr, perms, builtin, sort, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)');
  DEFAULT_ROLES.forEach(([id, name, descr, perms], i) => ins.run(id, name, descr, JSON.stringify(perms), i, new Date().toISOString()));
}
const roleById = db.prepare('SELECT * FROM roles WHERE id = ?');
const rolePerms = r => { try { return cleanPerms(JSON.parse(r.perms)); } catch (e) { return []; } };
// 旧账号迁移到角色：没有逐项权限的 → 业务员；有逐项权限的 → 找权限完全一致的角色，找不到就为其新建一个
for (const u of db.prepare("SELECT * FROM users WHERE role <> 'admin' AND role_id IS NULL").all()) {
  let rid = 'r_staff';
  if (u.perms != null) {
    let own = []; try { own = cleanPerms(JSON.parse(u.perms)); } catch (e) {}
    const key = [...own].sort().join();
    const hit = db.prepare('SELECT * FROM roles').all().find(r => [...rolePerms(r)].sort().join() === key);
    if (hit) rid = hit.id;
    else { rid = 'r' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); db.prepare('INSERT INTO roles (id, name, descr, perms, sort, created_at) VALUES (?, ?, ?, ?, 99, ?)').run(rid, (u.name || u.username) + '的权限', '由旧账号权限迁移', JSON.stringify(own), new Date().toISOString()); }
  }
  db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(rid, u.id);
}
// v1.0.2：盘点拆分为「录入」和「审核」，原来能盘点的角色（预置盘点员除外）补上审核权限
if (getMeta('permsVersion', 1) < 2) {
  for (const r of db.prepare('SELECT * FROM roles').all()) {
    const p = rolePerms(r);
    if (p.includes('inv.check') && !p.includes('inv.checkpost') && r.id !== 'r_check') db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...p, 'inv.checkpost']), r.id);
  }
  db.prepare("UPDATE roles SET descr = '新建盘点单、录入实盘数（审核由主管完成）' WHERE id = 'r_check'").run();
  setMeta('permsVersion', 2);
}
// v1.0.3：新增调拨权限，能同时开入库单和出库单的角色补上调拨
if (getMeta('permsVersion', 1) < 3) {
  for (const r of db.prepare('SELECT * FROM roles').all()) {
    const p = rolePerms(r);
    if (p.includes('inv.in') && p.includes('inv.out') && !p.includes('inv.transfer')) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...p, 'inv.transfer']), r.id);
  }
  setMeta('permsVersion', 3);
}
const rawPerms = u => { if (u.role === 'admin') return PERM_KEYS; const r = u.role_id && roleById.get(u.role_id); return r ? rolePerms(r) : []; };
function enabledModules() { const m = getMeta('settings', {}).modules; return Array.isArray(m) && m.length ? m : DEFAULT_MODULES; }
// 实际生效的权限 = 账号权限 ∩ 已启用模块
const seesPrice = P => ['inv.cost', 'sales', 'purchase', 'finance', 'reports', 'dashboard'].some(k => P.has(k));
function effectivePerms(u) { const mods = new Set(enabledModules()); return new Set(rawPerms(u).filter(k => mods.has(PERM_MOD[k]))); }

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
  ensureWh();
}
// 保证有默认仓库，且每个商品都有分仓库存 p.wh（{仓库id: 数量}，合计等于 p.stock；旧数据全部归入默认仓库）
function ensureWh() {
  if (!get('warehouses', DEFAULT_WH)) put('warehouses', { id: DEFAULT_WH, code: 'W01', name: '主仓库', remark: '', createdAt: today() });
  for (const p of list('products')) {
    const w = p.wh && typeof p.wh === 'object' ? p.wh : null, total = w ? Object.values(w).reduce((s, n) => s + (+n || 0), 0) : null;
    if (w && total === (p.stock || 0)) continue;
    p.wh = w ? { ...w, [DEFAULT_WH]: (w[DEFAULT_WH] || 0) + (p.stock || 0) - total } : { [DEFAULT_WH]: p.stock || 0 };
    put('products', p);
  }
}
const whName = id => (get('warehouses', id) || {}).name || '已删除仓库';
const whQty = (p, w) => (p.wh && p.wh[w]) || 0;
function pickWh(id) {
  id = str(id, 64) || DEFAULT_WH;
  get('warehouses', id) || fail('仓库不存在');
  return id;
}

/* ---------- 批次：{ id, productId, wh, no, prodDate, expDate, qty, inDate, ref } ---------- */
const batchesOf = (pid, wh) => list('batches').filter(b => b.productId === pid && b.wh === wh && b.qty > 0);
// 先到期先出（FEFO）：有效期早的先出，没有有效期的排最后，同有效期按入库先后
const fefo = (a, b) => (a.expDate || '9999-12-31').localeCompare(b.expDate || '9999-12-31') || (a.inDate || '').localeCompare(b.inDate || '') || a.id.localeCompare(b.id);
function addBatch(p, wh, qty, info, ref, date) {
  const no = str(info && info.no, 40) || ref || ('B' + (date || today()).replace(/-/g, ''));
  const prodDate = isDate(info && info.prodDate) ? info.prodDate : '';
  let expDate = isDate(info && info.expDate) ? info.expDate : '';
  if (!expDate && prodDate && p.shelfDays > 0) expDate = fmtDate(new Date(new Date(prodDate).getTime() + p.shelfDays * 864e5));
  const hit = list('batches').find(b => b.productId === p.id && b.wh === wh && b.no === no && (b.expDate || '') === expDate);
  const b = hit || { id: uid(), productId: p.id, wh, no, prodDate, expDate, qty: 0, inDate: date || today(), ref: ref || '' };
  b.qty += qty;
  put('batches', b);
  return { id: b.id, no: b.no, prodDate: b.prodDate, expDate: b.expDate, qty };
}
// 自动分配顺序：未过期的先到期先出 → 无有效期 → 已过期（过期货不应发给客户）；报损出库反过来，先出已过期的
function fefoOrder(list, kind) {
  const t = today(), expired = b => b.expDate && b.expDate < t;
  const ok = list.filter(b => !expired(b)).sort(fefo), bad = list.filter(expired).sort(fefo);
  return kind === '报损出库' ? [...bad, ...ok] : [...ok, ...bad];
}
function takeBatches(p, wh, qty, alloc, kind) {
  const out = [];
  if (alloc) {  // 冲回指定批次（作废入库单 / 调拨单）
    for (const a of alloc) {
      if (!a.id && a.no === '（无批次）') { out.push(a); continue; }
      const byId = get('batches', a.id);
      const b = byId && byId.productId === p.id && byId.wh === wh ? byId : list('batches').find(x => x.productId === p.id && x.wh === wh && x.no === a.no && (x.expDate || '') === (a.expDate || ''));
      if (!b || b.qty < a.qty) fail(`「${p.name}」批次 ${a.no} 已被领用，无法冲回`);
      b.qty -= a.qty; b.qty ? put('batches', b) : del('batches', b.id);
      out.push({ ...a, id: b.id });
    }
    return out;
  }
  let left = qty;
  for (const b of fefoOrder(batchesOf(p.id, wh), kind)) {
    if (!left) break;
    const n = Math.min(left, b.qty);
    b.qty -= n; left -= n;
    b.qty ? put('batches', b) : del('batches', b.id);
    out.push({ id: b.id, no: b.no, prodDate: b.prodDate || '', expDate: b.expDate || '', qty: n });
  }
  if (left) out.push({ id: '', no: '（无批次）', expDate: '', qty: left });  // 批次账与库存不一致时不阻断出库
  return out;
}
// 开启批次管理：现有各仓库存记为「期初」批次；关闭：清掉该商品的批次记录
function setBatchMode(p, on) {
  if (on) for (const [w, q] of Object.entries(p.wh || {})) { if (q > 0 && !batchesOf(p.id, w).length) addBatch(p, w, q, { no: '期初' }, '', today()); }
  else for (const b of list('batches').filter(b => b.productId === p.id)) del('batches', b.id);
}

/* ================= 用户 / 会话 ================= */
function hashPwd(pwd, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(String(pwd), salt, 64).toString('hex') }; }
function checkPwd(u, pwd) {
  const a = Buffer.from(hashPwd(pwd, u.salt).hash, 'hex'), b = Buffer.from(u.hash || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const roleName = u => u.role === 'admin' ? '管理员' : ((u.role_id && roleById.get(u.role_id)) || {}).name || '未分配角色';
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, roleId: u.role === 'admin' ? 'admin' : u.role_id, roleName: roleName(u), perms: rawPerms(u), createdAt: u.created_at, lastLogin: u.last_login });
// roleId 为 'admin' 表示管理员，否则为角色 id
function pickRole(roleId) {
  if (roleId === 'admin') return { role: 'admin', roleId: null };
  if (!roleId || !roleById.get(roleId)) fail('请选择有效的角色');
  return { role: 'user', roleId };
}
function createUser({ username, name, roleId, password }) {
  username = str(username, 32);
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) fail('用户名需为 2-32 位字母、数字或 _ . -');
  if (String(password || '').length < 6) fail('密码至少 6 位');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail('用户名已存在');
  const { salt, hash } = hashPwd(password), id = uid();
  const r = pickRole(roleId);
  db.prepare('INSERT INTO users (id, username, name, role, role_id, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, username, str(name, 32) || username, r.role, r.roleId, salt, hash, new Date().toISOString());
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
function addLog(ctx, productId, kind, qty, ref = '', note = '', date = '', extra = {}) {
  const d = new Date();
  put('stockLogs', { id: uid(), date: date || today(), time: pad(d.getHours()) + ':' + pad(d.getMinutes()), productId, kind, qty, ref, note, operator: ctx.user.name, ...extra });
}
/**
 * 所有库存变动的唯一入口，按「移动加权平均」核算成本：
 * - 入库带单价 price：新成本 = (原结存数量 × 原成本 + 入库数量 × 单价) / 新结存数量；原结存 ≤ 0 时直接取入库单价
 * - 入库不带单价（盘盈等）与出库：按当前成本计价，单位成本不变
 * - 冲回入库（作废入库单）传 reversePrice：按原入库单价把这部分价值减掉
 * 流水上记录本次计价单价 cost 与变动后的单位成本 costAfter，收发存报表据此计算金额
 * 成本按商品整体核算（不分仓库）；数量同时记到仓库 wh 上
 * 启用批次的商品：入库按 batch（{ no, prodDate, expDate }）或 alloc（批次列表，冲回 / 调拨用）入批次；出库按 alloc 冲回指定批次，否则先到期先出
 * 返回 { unit: 计价单价, alloc: 本次涉及的批次 }
 */
function moveStock(ctx, p, qty, kind, ref = '', note = '', { price, reversePrice, date, wh = DEFAULT_WH, batch, alloc } = {}) {
  const before = p.stock || 0, cost0 = p.cost || 0, after = before + qty;
  if (!p.wh) p.wh = { [DEFAULT_WH]: before };
  if (qty < 0 && whQty(p, wh) + qty < 0) fail(`「${p.name}」在${whName(wh)}库存不足（需 ${-qty}，现有 ${whQty(p, wh)}）`);
  let unit = cost0;
  if (qty > 0 && price != null && Number.isFinite(+price)) {
    unit = +price;
    p.cost = before <= 0 || after <= 0 ? round4(unit) : round4((before * cost0 + qty * unit) / after);
  } else if (qty < 0 && reversePrice != null) {
    unit = +reversePrice;
    if (after > 0) p.cost = Math.max(0, round4((before * cost0 + qty * unit) / after));
  }
  p.stock = after;
  p.wh[wh] = whQty(p, wh) + qty;
  let used;
  if (p.batch && qty) {
    if (qty > 0) used = alloc ? alloc.map(a => addBatch(p, wh, a.qty, a, ref, date)) : [addBatch(p, wh, qty, batch, ref, date)];
    else used = takeBatches(p, wh, -qty, alloc, kind);
  }
  put('products', p);
  addLog(ctx, p.id, kind, qty, ref, note, date, { cost: round4(unit), costAfter: p.cost, wh, ...(used ? { batches: used.map(({ no, expDate, qty }) => ({ no, expDate, qty })) } : {}) });
  return { unit, alloc: used };
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
    else if (t === 'b') v[k] = body[k] === true || body[k] === 1 || body[k] === '1';
    else v[k] = str(body[k], 500);
  }
  return v;
}
function saveEntity(ctx, col, id) {
  const E = ENTITY[col] || fail('接口不存在', 404), v = clean(col, ctx.body);
  if (col === 'products' && !seesPrice(ctx.perms)) { delete v.cost; delete v.price; }  // 看不到价格的账号不能改价格
  return tx(() => {
    const rec = id ? (get(col, id) || fail(E.name + '不存在', 404)) : null;
    const r = { ...(rec || {}), ...v };
    for (const [k, l] of Object.entries(E.required)) if (!r[k]) fail('请填写' + l);
    if (col === 'products') {
      const others = list('products').filter(p => p.id !== id);
      if (others.some(p => p.sku === r.sku)) fail('商品编码已存在');
      if (r.barcode && others.some(p => p.barcode === r.barcode || p.sku === r.barcode)) fail('条码已被其他商品使用');
      r.stock = rec ? rec.stock : Math.round(r.stock || 0);
      r.wh = rec ? rec.wh : undefined;
      r.safety = Math.round(r.safety || 0);
      r.shelfDays = Math.round(r.shelfDays || 0);
      if (rec && rec.stock !== 0) r.cost = rec.cost;  // 有库存时成本由移动加权平均自动计算
      if (r.batch && !(rec && rec.batch)) needPro('批次 / 保质期管理');
      if (rec && !!rec.batch !== !!r.batch) setBatchMode(r, r.batch);
    }
    if (col === 'employees' && !r.no) {
      const nos = new Set(list('employees').map(e => e.no));
      let n = 1001 + nos.size; while (nos.has('E' + n)) n++;
      r.no = 'E' + n;
    }
    if (!rec) { r.id = uid(); r.createdAt = today(); }
    const init = !rec && col === 'products' ? r.stock : 0;
    if (!rec && col === 'products') { r.stock = 0; r.wh = { [DEFAULT_WH]: 0 }; }
    put(col, r);
    if (init > 0) moveStock(ctx, r, init, '期初库存', '', '新建商品', { price: r.cost || 0, wh: pickWh(ctx.body.wh), batch: { no: '期初' } });
    audit(ctx, (rec ? '修改' : '新增') + E.name, r.name);
    return r;
  });
}
function deleteEntity(ctx, col, id) {
  const E = ENTITY[col] || fail('接口不存在', 404);
  return tx(() => {
    const rec = get(col, id) || fail(E.name + '不存在', 404);
    const used = col === 'products' ? [...list('sales'), ...list('purchases'), ...list('stockDocs')].some(o => o.items.some(i => i.productId === id)) || list('checkDocs').some(o => o.lines.some(l => l.productId === id))
      : col === 'customers' ? list('sales').some(o => o.customerId === id)
      : col === 'suppliers' ? list('purchases').some(o => o.supplierId === id) : false;
    if (used || col === 'products' && list('transferDocs').some(o => o.items.some(i => i.productId === id))) fail(`该${E.name}已被单据引用，无法删除`);
    del(col, id);
    if (col === 'products') setBatchMode(rec, false);
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
      const wh = pickWh(b.wh), qty = qtyByProduct(o.items);
      const lack = Object.entries(qty).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => !x.p || whQty(x.p, wh) < x.q);
      if (lack.length) fail(`${whName(wh)}库存不足：` + lack.map(x => x.p ? `${x.p.name}（需 ${x.q}，现有 ${whQty(x.p, wh)}）` : '商品已删除').join('、'));
      o.items.forEach(i => { const m = moveStock(ctx, get('products', i.productId), -i.qty, '销售出库', o.no, '', { wh }); i.cost = m.unit; if (m.alloc) i.batches = m.alloc; });
      o.status = '已发货'; o.shipDate = today(); o.wh = wh;
    } else if (action === 'complete' && kind === 'sales') { need('已发货'); o.status = '已完成'; }
    else if (action === 'approve' && kind === 'purchase') { need('待审核'); o.status = '已审核'; o.approver = ctx.user.name; }
    else if (action === 'inbound' && kind === 'purchase') {
      need('已审核');
      const wh = pickWh(b.wh), bi = b.batches && typeof b.batches === 'object' ? b.batches : {};
      o.items.forEach(i => {
        const p = get('products', i.productId); if (!p) return;
        const m = moveStock(ctx, p, i.qty, '采购入库', o.no, '', { price: i.price, wh, batch: { no: o.no, ...(bi[p.id] || {}) } });
        if (m.alloc) i.batches = m.alloc;
      });
      o.status = '已入库'; o.inDate = today(); o.wh = wh;
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
    const p = get('products', id) || fail('商品不存在', 404), wh = pickWh(ctx.body.wh), cur = whQty(p, wh);
    let d;
    if (mode === 'check') { if (qty < 0) fail('数量不能为负'); d = qty - cur; }
    else { if (qty <= 0) fail('数量必须大于 0'); d = mode === 'in' ? qty : -qty; if (cur + d < 0) fail(`${whName(wh)}库存不足，当前仅 ${cur}`); }
    if (d !== 0) { moveStock(ctx, p, d, T, '', str(note), { wh, batch: { no: T, ...(ctx.body.batch || {}) } }); audit(ctx, T, `${p.name} ${whName(wh)} ${d > 0 ? '+' : ''}${d}`); }
    return { delta: d, stock: whQty(p, wh) };
  });
}
/* ---------- 出入库单 ---------- */
const hhmm = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
function ownDoc(ctx, o) { if (o.creatorId !== ctx.user.id && !ctx.perms.has('inv.others')) fail('只能处理自己开的单据', 403); }
function qtyByProduct(items) { const q = {}; items.forEach(i => { q[i.productId] = (q[i.productId] || 0) + i.qty; }); return q; }
function saveStockDoc(ctx) {
  const b = ctx.body, dir = b.dir === 'out' ? 'out' : 'in', D = DOC[dir];
  if (!DOC_TYPES[dir].includes(b.type)) fail('请选择' + D.title.slice(0, 2) + '类型');
  const date = isDate(b.date) ? b.date : today();
  if (date > today()) fail('单据日期不能晚于今天');
  if (date !== today() && !ctx.perms.has('inv.backdate')) fail('没有补录权限，只能开当天的单据', 403);
  const withPrice = ctx.perms.has('inv.cost');
  return tx(() => {
    const wh = pickWh(b.wh);
    const items = (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId).map(i => {
      const p = get('products', i.productId) || fail('商品不存在或已删除');
      const qty = Number(i.qty);
      if (!Number.isInteger(qty) || qty <= 0) fail(`「${p.name}」数量必须为正整数`);
      // 出库一律按移动加权成本计价；入库可填单价（看不到金额的账号按当前成本）
      const price = dir === 'in' && withPrice && i.price !== undefined && i.price !== '' ? Number(i.price) : (p.cost || 0);
      if (!Number.isFinite(price) || price < 0) fail(`「${p.name}」单价不正确`);
      const it = { productId: p.id, qty, price: dir === 'in' ? round4(price) : 0, note: str(i.note, 100) };
      if (dir === 'in' && p.batch) {
        it.batch = { no: str(i.batchNo, 40), prodDate: isDate(i.prodDate) ? i.prodDate : '', expDate: isDate(i.expDate) ? i.expDate : '' };
        if (it.batch.expDate && it.batch.prodDate && it.batch.expDate < it.batch.prodDate) fail(`「${p.name}」有效期早于生产日期`);
      }
      return it;
    });
    if (!items.length) fail('请至少添加一个商品');
    const need = qtyByProduct(items);
    if (dir === 'out') {
      const lack = Object.entries(need).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => whQty(x.p, wh) < x.q);
      if (lack.length) fail(`${whName(wh)}库存不足：` + lack.map(x => `${x.p.name}（需 ${x.q}，现有 ${whQty(x.p, wh)}）`).join('、'));
    }
    const o = { id: uid(), no: nextNo(D), dir, type: b.type, wh, date, time: hhmm(), party: str(b.party, 100), handler: str(b.handler, 32), remark: str(b.remark, 500),
      items, status: '正常', creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), printCount: 0 };
    items.forEach(i => {
      const m = moveStock(ctx, get('products', i.productId), dir === 'in' ? i.qty : -i.qty, o.type, o.no, i.note || o.party, { price: dir === 'in' ? i.price : undefined, date, wh, batch: i.batch });
      if (dir === 'out') i.price = round4(m.unit);
      delete i.batch;
      if (m.alloc) i.batches = m.alloc;
    });
    put('stockDocs', o);
    audit(ctx, '新建' + D.title, `${o.no} ${o.type} ${items.length} 项`);
    return o;
  });
}
function voidStockDoc(ctx, id) {
  return tx(() => {
    const o = get('stockDocs', id) || fail('单据不存在', 404);
    ownDoc(ctx, o);
    if (o.status === '已作废') fail('单据已作废');
    const need = qtyByProduct(o.items), wh = o.wh || DEFAULT_WH;
    if (o.dir === 'in') {  // 入库单作废要把货扣回来
      const lack = Object.entries(need).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => x.p && whQty(x.p, wh) < x.q);
      if (lack.length) fail('库存已被领用，无法作废：' + lack.map(x => `${x.p.name}（需扣回 ${x.q}，${whName(wh)}现有 ${whQty(x.p, wh)}）`).join('、'));
    }
    const reason = str(ctx.body.reason, 200);
    // 入库单作废：按原入库单价冲减；出库单作废：按原出库成本退回；批次原路冲回
    o.items.forEach(i => {
      const p = get('products', i.productId); if (!p) return;
      const alloc = p.batch && i.batches ? i.batches : undefined;
      moveStock(ctx, p, o.dir === 'in' ? -i.qty : i.qty, '作废冲回', o.no, reason, o.dir === 'in' ? { reversePrice: i.price, wh, alloc } : { price: i.price, wh, alloc });
    });
    Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: reason });
    put('stockDocs', o);
    audit(ctx, '作废' + DOC[o.dir].title, o.no + (reason ? ' ' + reason : ''));
    return o;
  });
}
function markPrinted(ctx, id) {
  return tx(() => {
    const o = get('stockDocs', id) || fail('单据不存在', 404);
    ownDoc(ctx, o);
    o.printCount = (o.printCount || 0) + 1; put('stockDocs', o);
    audit(ctx, '打印' + DOC[o.dir].title, `${o.no} 第 ${o.printCount} 次`);
    return { printCount: o.printCount };
  });
}
/* ---------- 盘点单：新建（快照账面）→ 录入实盘 → 审核（按审核时的账面生成盘盈 / 盘亏） ---------- */
const CHECK = { col: 'checkDocs', prefix: 'PD', title: '盘点单' };
function applyCounts(o, lines) {
  const byId = new Map(o.lines.map(l => [l.productId, l]));
  for (const x of Array.isArray(lines) ? lines : []) {
    const l = x && byId.get(x.productId); if (!l) continue;
    if (x.counted === null || x.counted === '' || x.counted === undefined) { l.counted = null; continue; }
    const n = Number(x.counted);
    if (!Number.isInteger(n) || n < 0) fail('实盘数量必须是非负整数');
    l.counted = n;
  }
}
function createCheck(ctx) {
  const b = ctx.body, cat = str(b.category, 50);
  let ps = list('products');
  if (cat) ps = ps.filter(p => p.category === cat);
  if (Array.isArray(b.productIds) && b.productIds.length) { const s = new Set(b.productIds); ps = ps.filter(p => s.has(p.id)); }
  if (!ps.length) fail('没有符合条件的商品');
  ps.sort((x, y) => String(x.sku).localeCompare(String(y.sku)));
  const wh = pickWh(b.wh);
  return tx(() => {
    const o = { id: uid(), no: nextNo(CHECK), wh, date: today(), time: hhmm(), scope: cat ? '分类：' + cat : b.productIds && b.productIds.length ? `指定 ${ps.length} 个商品` : '全部商品',
      remark: str(b.remark, 500), lines: ps.map(p => ({ productId: p.id, book: whQty(p, wh), counted: null })), status: '盘点中',
      creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString() };
    put('checkDocs', o); audit(ctx, '新建盘点单', `${o.no} ${o.scope} ${o.lines.length} 项`);
    return o;
  });
}
function editCheck(ctx, id, fn) {
  return tx(() => {
    const o = get('checkDocs', id) || fail('盘点单不存在', 404);
    ownDoc(ctx, o);
    if (o.status !== '盘点中') fail(`盘点单已${o.status === '已完成' ? '审核' : '作废'}，不能再修改`);
    return fn(o);
  });
}
const saveCheck = (ctx, id) => editCheck(ctx, id, o => {
  applyCounts(o, ctx.body.lines);
  if ('remark' in ctx.body) o.remark = str(ctx.body.remark, 500);
  put('checkDocs', o); audit(ctx, '保存盘点单', `${o.no} 已录 ${o.lines.filter(l => l.counted != null).length}/${o.lines.length}`);
  return o;
});
const postCheck = (ctx, id) => editCheck(ctx, id, o => {
  if (ctx.body.lines) applyCounts(o, ctx.body.lines);
  const counted = o.lines.filter(l => l.counted != null);
  if (!counted.length) fail('还没有录入任何实盘数量');
  let gain = 0, loss = 0;
  const wh = o.wh || DEFAULT_WH;
  for (const l of counted) {
    const p = get('products', l.productId); if (!p) continue;
    const book = whQty(p, wh);
    l.bookAtPost = book; l.diff = l.counted - book; l.cost = p.cost || 0;
    if (l.diff > 0) gain += l.diff; else loss -= l.diff;
    if (l.diff) moveStock(ctx, p, l.diff, l.diff > 0 ? '盘盈' : '盘亏', o.no, '', { wh, batch: { no: '盘盈' + o.no } });
  }
  Object.assign(o, { status: '已完成', poster: ctx.user.name, postedAt: new Date().toISOString(), postDate: today() });
  put('checkDocs', o);
  audit(ctx, '审核盘点单', `${o.no} 盘盈 ${gain} 盘亏 ${loss}`);
  return o;
});
const voidCheck = (ctx, id) => editCheck(ctx, id, o => {
  Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString() });
  put('checkDocs', o); audit(ctx, '作废盘点单', o.no);
  return o;
});

/* ---------- 仓库（专业版：新增仓库） ---------- */
function saveWarehouse(ctx, id) {
  const b = ctx.body, name = str(b.name, 30) || fail('请填写仓库名称'), code = str(b.code, 20);
  return tx(() => {
    const all = list('warehouses');
    if (all.some(w => w.name === name && w.id !== id)) fail('仓库名称已存在');
    if (code && all.some(w => w.code === code && w.id !== id)) fail('仓库编码已存在');
    let w;
    if (id) { w = get('warehouses', id) || fail('仓库不存在', 404); Object.assign(w, { name, code, remark: str(b.remark, 200) }); }
    else { needPro('多仓库'); w = { id: 'w' + uid(), code: code || 'W' + String(all.length + 1).padStart(2, '0'), name, remark: str(b.remark, 200), createdAt: today() }; }
    put('warehouses', w); audit(ctx, (id ? '修改' : '新增') + '仓库', name);
    return w;
  });
}
function deleteWarehouse(ctx, id) {
  return tx(() => {
    const w = get('warehouses', id) || fail('仓库不存在', 404);
    if (id === DEFAULT_WH) fail('默认仓库不能删除，可以改名');
    const left = list('products').filter(p => whQty(p, id) !== 0);
    if (left.length) fail(`仓库里还有 ${left.length} 个商品有库存，请先调拨或出库清空`);
    if (list('stockDocs').some(o => o.wh === id) || list('transferDocs').some(o => o.from === id || o.to === id) || list('checkDocs').some(o => o.wh === id)) fail('该仓库已有单据记录，不能删除，可以改名停用');
    for (const p of list('products')) if (p.wh && id in p.wh) { delete p.wh[id]; put('products', p); }
    del('warehouses', id); audit(ctx, '删除仓库', w.name);
  });
}
/* ---------- 调拨单（专业版）：从一个仓库移到另一个仓库，总库存与成本不变，批次跟着走 ---------- */
function saveTransfer(ctx) {
  needPro('调拨单');
  const b = ctx.body, from = pickWh(b.from), to = pickWh(b.to);
  if (from === to) fail('调出仓库和调入仓库不能相同');
  const date = isDate(b.date) ? b.date : today();
  if (date > today()) fail('单据日期不能晚于今天');
  if (date !== today() && !ctx.perms.has('inv.backdate')) fail('没有补录权限，只能开当天的单据', 403);
  return tx(() => {
    const items = (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId).map(i => {
      const p = get('products', i.productId) || fail('商品不存在或已删除'), qty = Number(i.qty);
      if (!Number.isInteger(qty) || qty <= 0) fail(`「${p.name}」数量必须为正整数`);
      return { productId: p.id, qty, note: str(i.note, 100) };
    });
    if (!items.length) fail('请至少添加一个商品');
    const lack = Object.entries(qtyByProduct(items)).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => whQty(x.p, from) < x.q);
    if (lack.length) fail(`${whName(from)}库存不足：` + lack.map(x => `${x.p.name}（需 ${x.q}，现有 ${whQty(x.p, from)}）`).join('、'));
    const o = { id: uid(), no: nextNo(TRANSFER), from, to, date, time: hhmm(), handler: str(b.handler, 32), remark: str(b.remark, 500), items, status: '正常',
      creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), printCount: 0 };
    items.forEach(i => {
      const out = moveStock(ctx, get('products', i.productId), -i.qty, '调拨出库', o.no, '调往' + whName(to), { date, wh: from });
      moveStock(ctx, get('products', i.productId), i.qty, '调拨入库', o.no, '来自' + whName(from), { date, wh: to, price: out.unit, alloc: out.alloc });
      i.cost = round4(out.unit);
      if (out.alloc) i.batches = out.alloc;
    });
    put('transferDocs', o);
    audit(ctx, '新建调拨单', `${o.no} ${whName(from)} → ${whName(to)} ${items.length} 项`);
    return o;
  });
}
function voidTransfer(ctx, id) {
  return tx(() => {
    const o = get('transferDocs', id) || fail('调拨单不存在', 404);
    ownDoc(ctx, o);
    if (o.status === '已作废') fail('单据已作废');
    const lack = Object.entries(qtyByProduct(o.items)).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => x.p && whQty(x.p, o.to) < x.q);
    if (lack.length) fail(`调入的货已被领用，无法作废：` + lack.map(x => `${x.p.name}（需退回 ${x.q}，${whName(o.to)}现有 ${whQty(x.p, o.to)}）`).join('、'));
    const reason = str(ctx.body.reason, 200);
    o.items.forEach(i => {
      const p = get('products', i.productId); if (!p) return;
      const alloc = p.batch && i.batches ? i.batches : undefined;
      const back = moveStock(ctx, p, -i.qty, '作废冲回', o.no, reason, { wh: o.to, alloc });
      moveStock(ctx, get('products', i.productId), i.qty, '作废冲回', o.no, reason, { wh: o.from, price: back.unit, alloc: back.alloc });
    });
    Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: reason });
    put('transferDocs', o); audit(ctx, '作废调拨单', o.no + (reason ? ' ' + reason : ''));
    return o;
  });
}

/* ---------- 导入商品与期初库存 ---------- */
function importProducts(ctx) {
  const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : fail('没有可导入的数据');
  if (rows.length > 5000) fail('一次最多导入 5000 行');
  const update = ctx.body.update !== false, money = seesPrice(ctx.perms);
  return tx(() => {
    const bySku = new Map(list('products').map(p => [p.sku, p])), seen = new Set(), errors = [];
    let created = 0, updated = 0, skipped = 0;
    rows.forEach((raw, i) => {
      const line = Number.isInteger(raw._row) ? raw._row : i + 2, sku = str(raw.sku, 64), name = str(raw.name, 200);
      const err = m => errors.push(`第 ${line} 行：${m}`);
      if (!sku) return err('商品编码为空');
      if (seen.has(sku)) return err(`商品编码 ${sku} 在表格中重复`);
      seen.add(sku);
      const num = (k, label, int) => {
        if (raw[k] === undefined || raw[k] === null || raw[k] === '') return undefined;
        const n = Number(raw[k]);
        if (!Number.isFinite(n) || n < 0 || (int && !Number.isInteger(n))) { err(`${label}「${raw[k]}」不正确`); return null; }
        return round4(n);
      };
      const cost = num('cost', '成本价'), price = num('price', '销售价'), stock = num('stock', '期初库存', true), safety = num('safety', '安全库存', true);
      if ([cost, price, stock, safety].includes(null)) return;
      const fields = {};
      for (const k of ['name', 'spec', 'category', 'unit', 'remark']) if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') fields[k] = str(raw[k], k === 'remark' ? 500 : 200);
      if (safety !== undefined) fields.safety = safety;
      if (money && price !== undefined) fields.price = round2(price);
      const p = bySku.get(sku);
      if (p) {
        if (!update) { skipped++; return; }
        Object.assign(p, fields);
        if (money && cost !== undefined && p.stock === 0) p.cost = cost;  // 有库存时成本由移动加权决定，不覆盖
        put('products', p); updated++;
        return;
      }
      if (!name) return err('新商品必须填写商品名称');
      const np = { id: uid(), sku, name, spec: '', category: '', unit: '个', price: 0, safety: 0, remark: '', ...fields, cost: money && cost !== undefined ? cost : 0, stock: 0, createdAt: today() };
      put('products', np); bySku.set(sku, np); created++;
      if (stock > 0) moveStock(ctx, np, stock, '期初库存', '', 'Excel 导入', { price: np.cost });
    });
    if (errors.length) fail('导入失败，数据未做任何改动：\n' + errors.slice(0, 20).join('\n') + (errors.length > 20 ? `\n……共 ${errors.length} 处错误` : ''));
    audit(ctx, '导入商品', `新增 ${created}，更新 ${updated}，跳过 ${skipped}`);
    return { created, updated, skipped };
  });
}

// 按权限裁剪下发给前端的数据
function visibleData(ctx) {
  const P = ctx.perms, any = (...k) => k.some(x => P.has(x));
  const want = {
    products: any('inv.view', 'prod.view', 'sales', 'purchase', 'dashboard', 'reports'),
    stockLogs: any('inv.view', 'dashboard'), stockDocs: P.has('inv.view'), checkDocs: P.has('inv.view'),
    sales: any('sales', 'dashboard', 'reports', 'parties'), purchases: any('purchase', 'dashboard', 'reports', 'parties'),
    customers: any('sales', 'parties', 'dashboard', 'reports'), suppliers: any('purchase', 'parties'),
    finance: any('finance', 'sales', 'purchase', 'reports'), employees: P.has('hr'),
    warehouses: true, transferDocs: P.has('inv.view'), batches: any('inv.view', 'prod.view')
  };
  const byDate = (a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || ''));
  const data = {};
  COLS.forEach(c => { data[c] = want[c] ? list(c) : []; if (DATED.includes(c)) data[c].sort(byDate); });
  if (!seesPrice(P)) data.products = data.products.map(({ cost, price, ...p }) => p);
  if (!P.has('inv.others')) for (const c of ['stockDocs', 'checkDocs', 'transferDocs']) data[c] = data[c].filter(o => o.creatorId === ctx.user.id);
  if (!P.has('inv.cost')) {
    data.stockDocs = data.stockDocs.map(o => ({ ...o, items: o.items.map(({ price, ...i }) => i) }));
    data.transferDocs = data.transferDocs.map(o => ({ ...o, items: o.items.map(({ cost, ...i }) => i) }));
    data.stockLogs = data.stockLogs.map(({ cost, costAfter, ...l }) => l);
    data.checkDocs = data.checkDocs.map(o => ({ ...o, lines: o.lines.map(({ cost, ...l }) => l) }));
  }
  return data;
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
tx(ensureWh);  // v1.0.3 升级：补默认仓库与分仓库存
if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  // --admin-password-file：首次启动时从文件读取管理员初始密码（NAS 安装向导填写），读取后删除
  let pwd = '';
  try { if (arg('admin-password-file')) pwd = fs.readFileSync(arg('admin-password-file'), 'utf8').trim(); } catch (e) {}
  if (pwd.length < 6) pwd = 'admin123';
  createUser({ username: 'admin', name: '管理员', roleId: 'admin', password: pwd });
  log(pwd === 'admin123' ? '已创建默认管理员账号 admin / admin123' : '已创建管理员账号 admin（密码为安装时设置的密码）');
}
try { if (arg('admin-password-file')) fs.unlinkSync(arg('admin-password-file')); } catch (e) {}

/* ================= 路由 ================= */
const routes = [];
// opts.perm：所需权限键，或根据请求返回权限键的函数
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, auth: opts.auth !== false, admin: !!opts.admin, perm: opts.perm });

route('GET', '/api/ping', () => ({ ok: true, app: 'XERP', version: VERSION, company: getMeta('settings', {}).company || '' }), { auth: false });
route('POST', '/api/login', ctx => login(ctx, ctx.body), { auth: false });
route('POST', '/api/logout', ctx => { db.prepare('DELETE FROM sessions WHERE token = ?').run(ctx.user.token); });
route('GET', '/api/data', ctx => ({
  version: VERSION, releaseDate: RELEASE_DATE, settings: { ...getMeta('settings', {}), modules: enabledModules() },
  user: { ...publicUser(ctx.user), perms: [...ctx.perms] }, data: visibleData(ctx), license: licenseStatus(),
  meta: { modules: MODULES, perms: PERMS, docTypes: DOC_TYPES, defaultWh: DEFAULT_WH, trialDays: TRIAL_DAYS }
}));
route('POST', '/api/license', ctx => {
  const key = str(ctx.body.key, 2000), lic = parseLicense(key) || fail('授权码无效，请检查是否完整复制（以 XERP- 开头）');
  setMeta('license', key);
  audit(ctx, '激活专业版', `${lic.to}（编号 ${lic.id}，免费升级至 ${lic.upd}）`);
  return licenseStatus();
}, { admin: true });
route('DELETE', '/api/license', ctx => { setMeta('license', ''); audit(ctx, '移除专业版授权'); return licenseStatus(); }, { admin: true });
route('POST', '/api/license/trial', ctx => {
  if (getMeta('trial', null)) fail('每套系统只能试用一次');
  if (parseLicense(getMeta('license', ''))) fail('已激活授权码，无需试用');
  setMeta('trial', { start: today() }); audit(ctx, '开始试用专业版', TRIAL_DAYS + ' 天');
  return licenseStatus();
}, { admin: true });
route('PUT', '/api/settings/expiry', ctx => {
  const n = Math.round(Number(ctx.body.days));
  if (!(n >= 1 && n <= 365)) fail('临期提醒天数需在 1 ~ 365 之间');
  setMeta('settings', { ...getMeta('settings', {}), expiryDays: n }); audit(ctx, '修改设置', '临期提醒 ' + n + ' 天');
}, { perm: 'inv.checkpost' });
route('PUT', '/api/settings', ctx => {
  const s = getMeta('settings', {}), b = ctx.body, changes = [];
  if ('company' in b) { s.company = str(b.company, 100) || fail('公司名称不能为空'); changes.push('公司名称：' + s.company); }
  if (Array.isArray(b.modules)) {
    s.modules = b.modules.filter(m => m in MODULES);
    if (!s.modules.length) fail('至少启用一个模块');
    changes.push('启用模块：' + s.modules.map(m => MODULES[m]).join('、'));
  }
  setMeta('settings', s); audit(ctx, '修改设置', changes.join('；'));
}, { admin: true });

const ENTITY_PERM = { products: { POST: 'prod.edit', PUT: 'prod.edit', DELETE: 'prod.delete' }, customers: 'parties', suppliers: 'parties', employees: 'hr' };
for (const col of Object.keys(ENTITY)) {
  const perm = ctx => typeof ENTITY_PERM[col] === 'string' ? ENTITY_PERM[col] : ENTITY_PERM[col][ctx.method];
  route('POST', `/api/${col}`, ctx => saveEntity(ctx, col, null), { perm });
  route('PUT', `/api/${col}/:id`, ctx => saveEntity(ctx, col, ctx.params.id), { perm });
  route('DELETE', `/api/${col}/:id`, ctx => deleteEntity(ctx, col, ctx.params.id), { perm });
}
const orderPerm = { perm: ctx => ctx.params.kind === 'sales' ? 'sales' : 'purchase' };
route('POST', '/api/orders/:kind', ctx => saveOrder(ctx, ctx.params.kind, null), orderPerm);
route('PUT', '/api/orders/:kind/:id', ctx => saveOrder(ctx, ctx.params.kind, ctx.params.id), orderPerm);
route('DELETE', '/api/orders/:kind/:id', ctx => deleteOrder(ctx, ctx.params.kind, ctx.params.id), orderPerm);
route('POST', '/api/orders/:kind/:id/:action', ctx => orderAction(ctx, ctx.params.kind, ctx.params.id, ctx.params.action), orderPerm);
route('POST', '/api/stock/:id', ctx => adjustStock(ctx, ctx.params.id), { perm: ctx => ({ in: 'inv.in', out: 'inv.out' })[ctx.body.mode] || 'inv.checkpost' });
route('POST', '/api/checkdocs', ctx => createCheck(ctx), { perm: 'inv.check' });
route('PUT', '/api/checkdocs/:id', ctx => saveCheck(ctx, ctx.params.id), { perm: 'inv.check' });
route('POST', '/api/checkdocs/:id/post', ctx => postCheck(ctx, ctx.params.id), { perm: 'inv.checkpost' });
route('POST', '/api/checkdocs/:id/void', ctx => voidCheck(ctx, ctx.params.id), { perm: 'inv.check' });
route('POST', '/api/products/import', ctx => importProducts(ctx), { perm: 'prod.edit' });
route('POST', '/api/stockdocs', ctx => saveStockDoc(ctx), { perm: ctx => ctx.body.dir === 'out' ? 'inv.out' : 'inv.in' });
route('POST', '/api/stockdocs/:id/void', ctx => voidStockDoc(ctx, ctx.params.id), { perm: 'inv.void' });
route('POST', '/api/stockdocs/:id/print', ctx => markPrinted(ctx, ctx.params.id), { perm: 'inv.print' });
route('POST', '/api/transfers', ctx => saveTransfer(ctx), { perm: 'inv.transfer' });
route('POST', '/api/transfers/:id/void', ctx => voidTransfer(ctx, ctx.params.id), { perm: 'inv.void' });
route('POST', '/api/transfers/:id/print', ctx => tx(() => {
  const o = get('transferDocs', ctx.params.id) || fail('调拨单不存在', 404);
  ownDoc(ctx, o); o.printCount = (o.printCount || 0) + 1; put('transferDocs', o);
  audit(ctx, '打印调拨单', `${o.no} 第 ${o.printCount} 次`);
  return { printCount: o.printCount };
}), { perm: 'inv.print' });
route('POST', '/api/warehouses', ctx => saveWarehouse(ctx, null), { admin: true });
route('PUT', '/api/warehouses/:id', ctx => saveWarehouse(ctx, ctx.params.id), { admin: true });
route('DELETE', '/api/warehouses/:id', ctx => deleteWarehouse(ctx, ctx.params.id), { admin: true });
route('POST', '/api/finance', ctx => addFinance(ctx), { perm: 'finance' });
route('DELETE', '/api/finance/:id', ctx => deleteFinance(ctx, ctx.params.id), { perm: 'finance' });

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
  const r = pickRole(b.roleId);
  if (u.role === 'admin' && r.role !== 'admin' && S.adminCount.get().n <= 1) fail('系统至少需要保留一个管理员');
  if (u.id === ctx.user.id && r.role !== 'admin') fail('不能取消自己的管理员身份');
  db.prepare('UPDATE users SET name = ?, role = ?, role_id = ? WHERE id = ?').run(str(b.name, 32) || u.name, r.role, r.roleId, u.id);
  if (b.password) {
    if (String(b.password).length < 6) fail('密码至少 6 位');
    const { salt, hash } = hashPwd(b.password);
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, u.id);
    if (u.id !== ctx.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  audit(ctx, '修改用户', `${u.username} → ${roleName({ role: r.role, role_id: r.roleId })}` + (b.password ? '（重置密码）' : ''));
}, { admin: true });

route('GET', '/api/roles', () => {
  const count = Object.fromEntries(db.prepare("SELECT role_id, COUNT(*) AS n FROM users WHERE role <> 'admin' AND disabled = 0 GROUP BY role_id").all().map(x => [x.role_id, x.n]));
  return db.prepare('SELECT * FROM roles ORDER BY sort, created_at').all()
    .map(r => ({ id: r.id, name: r.name, descr: r.descr || '', perms: rolePerms(r), builtin: !!r.builtin, users: count[r.id] || 0 }));
}, { admin: true });
function saveRole(ctx, id) {
  const b = ctx.body, name = str(b.name, 20) || fail('请填写角色名称');
  if (name === '管理员') fail('「管理员」是系统保留名称');
  const dup = db.prepare('SELECT id FROM roles WHERE name = ?').get(name);
  if (dup && dup.id !== id) fail('角色名称已存在');
  const perms = JSON.stringify(cleanPerms(b.perms)), descr = str(b.descr, 100);
  if (id) {
    roleById.get(id) || fail('角色不存在', 404);
    db.prepare('UPDATE roles SET name = ?, descr = ?, perms = ? WHERE id = ?').run(name, descr, perms, id);
  } else {
    id = 'r' + uid();
    db.prepare('INSERT INTO roles (id, name, descr, perms, sort, created_at) VALUES (?, ?, ?, ?, 50, ?)').run(id, name, descr, perms, new Date().toISOString());
  }
  audit(ctx, (ctx.params.id ? '修改' : '新增') + '角色', `${name}（${JSON.parse(perms).length} 项权限）`);
  return { id };
}
route('POST', '/api/roles', ctx => saveRole(ctx, null), { admin: true });
route('PUT', '/api/roles/:id', ctx => saveRole(ctx, ctx.params.id), { admin: true });
route('DELETE', '/api/roles/:id', ctx => {
  const r = roleById.get(ctx.params.id) || fail('角色不存在', 404);
  const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND role <> \'admin\'').get(r.id).n;
  if (n) fail(`还有 ${n} 个账号使用该角色，请先给他们换角色`);
  db.prepare('DELETE FROM roles WHERE id = ?').run(r.id);
  audit(ctx, '删除角色', r.name);
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
// 前端用到的第三方库随程序一起发布（图表、Excel 导入），不依赖外网
const VENDOR = ['chart.umd.min.js', 'xlsx.full.min.js'], vendorCache = {};
function vendorFile(p) {
  const name = p.startsWith('/vendor/') && p.slice(8);
  if (!VENDOR.includes(name)) return null;
  if (vendorCache[name]) return vendorCache[name];
  try { const sea = require('node:sea'); if (sea.isSea()) return (vendorCache[name] = Buffer.from(sea.getAsset('vendor/' + name))); } catch (e) {}
  try { return (vendorCache[name] = fs.readFileSync(path.join(__dirname, 'vendor', name))); } catch (e) { return null; }
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
    const v = req.method === 'GET' && vendorFile(url.pathname);
    if (v) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800' }); return res.end(v); }
    res.writeHead(404); return res.end();
  }
  const ctx = { ip: String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''), method: req.method, query: url.searchParams, body: {}, user: null, params: {}, perms: new Set() };
  try {
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname)) || fail('接口不存在', 404);
    ctx.params = Object.fromEntries(Object.entries(url.pathname.match(r.re).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    if (r.auth) {
      ctx.user = authUser(req) || fail('登录已过期，请重新登录', 401);
      if (r.admin && ctx.user.role !== 'admin') fail('需要管理员权限', 403);
      ctx.perms = effectivePerms(ctx.user);
    }
    if (req.method === 'POST' || req.method === 'PUT') ctx.body = await readBody(req);
    const need = typeof r.perm === 'function' ? r.perm(ctx) : r.perm;
    if (need && !ctx.perms.has(need)) fail(`没有权限：${PERM_LABEL[need] || need}${enabledModules().includes(PERM_MOD[need]) ? '' : '（该模块未启用）'}`, 403);
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
