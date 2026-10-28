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

const VERSION = '2.0.6';
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
const round3 = n => Math.round(n * 1e3) / 1e3;
const round4 = n => Math.round(n * 1e4) / 1e4;
const orderTotal = o => round2(sum(o.items, i => i.qty * i.price));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (msg, status) => { throw new HttpError(msg, status); };
function audit(ctx, action, detail = '') { S.audit.run(new Date().toISOString(), ctx.user ? ctx.user.name : '-', action, String(detail).slice(0, 300), ctx.ip || ''); }

/* ================= 业务常量 ================= */
const COLS = ['products', 'customers', 'suppliers', 'employees', 'sales', 'purchases', 'salesReturns', 'purchaseReturns', 'stockLogs', 'stockDocs', 'checkDocs', 'finance', 'warehouses', 'transferDocs', 'batches', 'serials', 'carriers', 'shipments', 'shipBills', 'shipLabels'];
const DATED = ['sales', 'purchases', 'salesReturns', 'purchaseReturns', 'stockLogs', 'stockDocs', 'checkDocs', 'finance', 'transferDocs', 'shipments', 'shipBills'];
const CATS = ['电子产品', '办公用品', '家居用品', '食品饮料'];
const LEVELS = ['VIP', 'A级', 'B级', 'C级'];
const METHODS = ['银行转账', '现金', '支付宝', '微信', '承兑汇票'];
const FIN_CATS = { income: ['其他收入', '投资收益', '退款'], expense: ['工资', '房租', '水电', '办公费', '差旅', '营销推广', '快递费', '其他支出'] };
const ORD = {
  sales: { col: 'sales', prefix: 'SO', title: '销售单', party: 'customers', partyKey: 'customerId', partyLabel: '客户', paidKey: 'received', payWord: '收款', statuses: ['待发货', '已发货', '已完成', '已作废'], perm: 'sales', fin: ['income', '销售收款'] },
  purchase: { col: 'purchases', prefix: 'PO', title: '采购单', party: 'suppliers', partyKey: 'supplierId', partyLabel: '供应商', paidKey: 'paid', payWord: '付款', statuses: ['待审核', '已审核', '已入库', '已作废'], perm: 'purchase', fin: ['expense', '采购付款'] },
  // 退货单：可关联原单（限退原单数量减去已退的）；销售退货入库、采购退货出库；退款走现金，或冲抵原单没结清的款
  salesReturn: { col: 'salesReturns', prefix: 'XT', title: '销售退货单', party: 'customers', partyKey: 'customerId', partyLabel: '客户', paidKey: 'refunded', payWord: '退款', statuses: ['待入库', '已入库', '已作废'], perm: 'sales', fin: ['expense', '销售退款'], src: 'sales', srcOk: ['已发货', '已完成'] },
  purchaseReturn: { col: 'purchaseReturns', prefix: 'CT', title: '采购退货单', party: 'suppliers', partyKey: 'supplierId', partyLabel: '供应商', paidKey: 'refunded', payWord: '退款', statuses: ['待出库', '已出库', '已作废'], perm: 'purchase', fin: ['income', '采购退款'], src: 'purchase', srcOk: ['已入库'] }
};
const ENTITY = {
  products: { name: '商品', required: { sku: '商品编码', name: '商品名称' },
    fields: { sku: ['s', '商品编码'], barcode: ['s', '条码'], name: ['s', '商品名称'], spec: ['s'], category: ['s'], unit: ['s'], cost: ['n', '成本价'], price: ['n', '销售价'], stock: ['n', '期初库存'], safety: ['n', '安全库存'],
      batch: ['b'], serial: ['b'], shelfDays: ['n', '保质期天数'], weight: ['w', '重量'], size: ['z'], remark: ['s'] } },
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

/* ================= 模块 / 权限 ================= */
const MODULES = { inventory: '库存管理', products: '商品管理', dashboard: '工作台', sales: '销售管理', purchase: '采购管理', parties: '客户 / 供应商', finance: '财务管理', hr: '人事管理', reports: '统计报表', shipping: '物流运费' };
const DEFAULT_MODULES = ['inventory', 'products'];
// [权限键, 名称, 所属模块]
const PERMS = [
  ['inv.view', '查看库存、出入库单与流水', 'inventory'], ['inv.in', '开入库单', 'inventory'], ['inv.out', '开出库单', 'inventory'],
  ['inv.check', '盘点录入（新建盘点单、录实盘数）', 'inventory'], ['inv.checkpost', '盘点审核（确认盘盈盘亏、调整库存）', 'inventory'], ['inv.void', '作废出入库单（冲回库存）', 'inventory'],
  ['inv.approve', '审核出入库单（开启审核后，审核通过才改库存）', 'inventory'],
  ['inv.print', '打印单据 / 盘点表', 'inventory'], ['inv.export', '导出数据', 'inventory'],
  ['inv.cost', '查看价格与金额', 'inventory'], ['inv.backdate', '单据日期可选非当天（补录）', 'inventory'],
  ['inv.others', '查看 / 处理他人开的单据', 'inventory'], ['inv.transfer', '开调拨单（仓库之间移库）', 'inventory'],
  ['prod.view', '查看商品档案', 'products'], ['prod.edit', '新增 / 编辑商品', 'products'], ['prod.delete', '删除商品', 'products'],
  ['dashboard', '工作台', 'dashboard'], ['sales', '销售管理（全部操作）', 'sales'], ['purchase', '采购管理（全部操作）', 'purchase'],
  ['parties', '客户 / 供应商管理', 'parties'], ['finance', '财务管理', 'finance'], ['hr', '人事管理', 'hr'], ['reports', '统计报表', 'reports'],
  ['ship.view', '查看运单、快递账单与运费统计', 'shipping'], ['ship.edit', '登记运单（快递单号、称重）', 'shipping'],
  ['ship.rate', '维护快递公司与报价', 'shipping'], ['ship.bill', '导入快递账单、对账确认', 'shipping']
];
const PERM_KEYS = PERMS.map(p => p[0]);
const PERM_MOD = Object.fromEntries(PERMS.map(p => [p[0], p[2]]));
const PERM_LABEL = Object.fromEntries(PERMS.map(p => [p[0], p[1]]));
const cleanPerms = a => [...new Set((Array.isArray(a) ? a : []).filter(k => PERM_KEYS.includes(k)))];

/* ---------- 角色 ---------- */
// 预置角色：首次启动写入，之后可在「角色管理」里修改、删除，也可新增自定义角色
const DEFAULT_ROLES = [
  ['r_wh_mgr', '仓库主管', '库存全部操作，含审核、作废、盘点审核、调拨、补录和查看金额', ['inv.view', 'inv.in', 'inv.out', 'inv.check', 'inv.checkpost', 'inv.void', 'inv.approve', 'inv.transfer', 'inv.print', 'inv.export', 'inv.cost', 'inv.backdate', 'inv.others', 'prod.view', 'prod.edit', 'ship.view', 'ship.edit', 'ship.rate', 'ship.bill']],
  ['r_wh', '仓管员', '日常收发货：开入库单、出库单、调拨单并打印', ['inv.view', 'inv.in', 'inv.out', 'inv.transfer', 'inv.print', 'prod.view', 'ship.view', 'ship.edit']],
  ['r_in', '入库员', '只负责收货入库', ['inv.view', 'inv.in', 'inv.print', 'prod.view']],
  ['r_out', '出库员', '只负责发货 / 领料出库', ['inv.view', 'inv.out', 'inv.print', 'prod.view', 'ship.view', 'ship.edit']],
  ['r_check', '盘点员', '新建盘点单、录入实盘数（审核由主管完成）', ['inv.view', 'inv.check', 'inv.print', 'inv.others', 'prod.view']],
  ['r_prod', '商品专员', '维护商品档案（编码、规格、安全库存）', ['inv.view', 'prod.view', 'prod.edit']],
  ['r_acct', '成本会计', '查看全部单据与金额，导出对账', ['inv.view', 'inv.cost', 'inv.export', 'inv.print', 'inv.others', 'prod.view', 'finance', 'reports', 'ship.view', 'ship.bill']],
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
// v1.0.7：新增出入库单审核权限，能作废出入库单的角色补上审核
if (getMeta('permsVersion', 1) < 4) {
  for (const r of db.prepare('SELECT * FROM roles').all()) {
    const p = rolePerms(r);
    if (p.includes('inv.void') && !p.includes('inv.approve')) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...p, 'inv.approve']), r.id);
  }
  db.prepare("UPDATE roles SET descr = '库存全部操作，含审核、作废、盘点审核、调拨、补录和查看金额' WHERE id = 'r_wh_mgr' AND descr = '库存全部操作，含作废、盘点审核、调拨、补录和查看金额'").run();
  setMeta('permsVersion', 4);
}
// v2.0.3：新增物流运费模块，按原有职责补上运费权限（模块默认不启用，启用前这些权限不生效）
if (getMeta('permsVersion', 1) < 5) {
  for (const r of db.prepare('SELECT * FROM roles').all()) {
    const p = rolePerms(r), add = [];
    if (p.includes('inv.void')) add.push('ship.view', 'ship.edit', 'ship.rate', 'ship.bill');
    if (p.includes('inv.out')) add.push('ship.view', 'ship.edit');
    if (p.includes('finance')) add.push('ship.view', 'ship.bill');
    const next = [...new Set([...p, ...add])];
    if (next.length > p.length) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify(next), r.id);
  }
  setMeta('permsVersion', 5);
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
  const W = [0.15, 1.1, 6.5, 0.1, 0.3, 0.45, 12.5, 0.3, 0.5, 18, 35, 0.9, 0.4, 1.6, 8, 1.05, 1.2, 9, 0.9, 1.4];  // 演示重量（kg / 基本单位）
  const products = P.map((p, i) => ({ id: 'p' + (i + 1), sku: 'SKU' + (1001 + i), name: p[0], category: p[1], unit: p[2], cost: p[3], price: p[4], stock: ri(30, 280), safety: ri(20, 40), weight: W[i], remark: '', createdAt: dayAgo(200) }));
  // 演示多单位：鼠标、中性笔、葡萄酒可按箱进出
  Object.assign(products[3], { units: [{ name: '箱', rate: 20 }] }); Object.assign(products[7], { units: [{ name: '箱', rate: 40 }] }); Object.assign(products[19], { units: [{ name: '箱', rate: 6 }] });
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
  // 演示快递报价：一家按重量段（电商件常见），一家按首重 + 续重
  const zone = (name, provinces, extra) => ({ name, provinces, first: 1, firstFee: 0, addStep: 1, addFee: 0, bands: [], extra: 0, min: 0, ...extra });
  const bands = (...f) => [0.5, 1, 2, 3].map((upTo, i) => ({ upTo, fee: f[i] }));
  const carriers = [
    { id: 'k1', name: '中通快递', code: 'ZTO', enabled: true, step: 0.1, volDiv: 8000, pack: 0.1, insureRate: 0, insureMin: 0, tol: 0.5, remark: '演示报价，请按合同改成自己的价格', createdAt: dayAgo(200), zones: [
      zone('江浙沪', ['上海', '江苏', '浙江'], { bands: bands(2.8, 3.2, 4, 5), addFee: 1 }),
      zone('一区', ['安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '北京', '天津', '河北'], { bands: bands(3.2, 3.8, 5.5, 7.5), addFee: 2 }),
      zone('二区（其余省份）', [], { bands: bands(4, 5, 7.5, 10), addFee: 3 }),
      zone('偏远', ['新疆', '西藏'], { firstFee: 15, addFee: 12 })] },
    { id: 'k2', name: '顺丰速运', code: 'SF', enabled: true, step: 0.1, volDiv: 6000, pack: 0.1, insureRate: 0.5, insureMin: 1, tol: 0.5, remark: '演示报价', createdAt: dayAgo(200), zones: [
      zone('江浙沪', ['上海', '江苏', '浙江'], { firstFee: 13, addFee: 2 }),
      zone('其余省份', [], { firstFee: 18, addFee: 6 }),
      zone('偏远', ['新疆', '西藏'], { firstFee: 23, addFee: 15 })] }
  ];
  return { products, customers, suppliers, employees, sales, purchases, stockLogs, finance, carriers };
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
/* ---------- 序列号：启用的商品一件一个号，出入库单 / 调拨单逐件登记，可追溯每一件的来龙去脉 ---------- */
// 记录 { id, sn, productId, status: 在库 / 已出库, wh, hist: [{ ref, kind, date, status, wh, party }] }，当前状态 = hist 最后一条
const serialsOf = pid => list('serials').filter(r => r.productId === pid);
function cleanSerials(p, raw, qty) {
  const a = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,，;；]+/)).map(x => str(x, 64)).filter(Boolean);
  if (new Set(a).size < a.length) fail(`「${p.name}」序列号有重复`);
  if (a.length !== qty) fail(`「${p.name}」数量 ${qty}，需要登记 ${qty} 个序列号（现在 ${a.length} 个）`);
  return a;
}
// 只校验不改动：入库的号不能已经在库，出库的号必须在这个仓库
function checkSerials(p, sns, qty, wh) {
  const map = new Map(serialsOf(p.id).map(r => [r.sn, r]));
  for (const sn of sns) {
    const r = map.get(sn);
    if (qty > 0 && r && r.status === '在库') fail(`「${p.name}」序列号 ${sn} 已在库（${whName(r.wh)}），不能重复入库`);
    if (qty < 0 && (!r || r.status !== '在库' || r.wh !== wh)) fail(`「${p.name}」序列号 ${sn} ${!r ? '不存在' : r.status !== '在库' ? '已出库' : '不在' + whName(wh)}`);
  }
}
function moveSerials(p, qty, wh, { serials, undo, ref, kind, date, party }) {
  if (undo) {  // 作废冲回：撤掉本单写入的那一步
    const hit = serialsOf(p.id).filter(r => { const h = r.hist[r.hist.length - 1]; return h && h.ref === undo && (qty < 0 ? h.status === '在库' && r.wh === wh : h.status === '已出库'); });
    if (hit.length < Math.abs(qty)) fail(`「${p.name}」本单登记的序列号有 ${Math.abs(qty) - hit.length} 个已经变动过（例如已出库），不能作废`);
    for (const r of hit.slice(0, Math.abs(qty))) {
      r.hist.pop();
      const h = r.hist[r.hist.length - 1];
      if (!h) { del('serials', r.id); continue; }
      r.status = h.status; r.wh = h.wh; put('serials', r);
    }
    return;
  }
  if (!serials) fail(`「${p.name}」启用了序列号管理，只能用出入库单或调拨单变动库存，并逐件登记序列号`);
  checkSerials(p, serials, qty, wh);
  const map = new Map(serialsOf(p.id).map(r => [r.sn, r]));
  const status = qty > 0 ? '在库' : '已出库';
  for (const sn of serials) {
    const r = map.get(sn) || { id: uid(), sn, productId: p.id, hist: [] };
    r.hist.push({ ref, kind, date: date || today(), status, wh, party: str(party, 100) });
    r.status = status; r.wh = wh; put('serials', r);
  }
}
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
function moveStock(ctx, p, qty, kind, ref = '', note = '', { price, reversePrice, date, wh = DEFAULT_WH, batch, alloc, serials, undo } = {}) {
  const before = p.stock || 0, cost0 = p.cost || 0, after = before + qty;
  if (!p.wh) p.wh = { [DEFAULT_WH]: before };
  if (qty < 0 && whQty(p, wh) + qty < 0) fail(`「${p.name}」在${whName(wh)}库存不足（需 ${-qty}，现有 ${whQty(p, wh)}）`);
  if (p.serial && qty) moveSerials(p, qty, wh, { serials, undo, ref, kind, date, party: note });
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
  addLog(ctx, p.id, kind, qty, ref, note, date, { cost: round4(unit), costAfter: p.cost, wh, ...(used ? { batches: used.map(({ no, expDate, qty }) => ({ no, expDate, qty })) } : {}), ...(p.serial && serials ? { serials } : {}) });
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
    else if (t === 'w') { const n = Number(body[k] || 0); if (!Number.isFinite(n) || n < 0 || n > 100000) fail((label || k) + '必须是 0 ~ 100000 的数字（kg）'); v[k] = round3(n); }
    else if (t === 'z') { const s = str(body[k], 40), d = parseSize(s); if (s && !d) fail('包装尺寸格式应为 长×宽×高（厘米），例如 30×20×15'); v[k] = d ? d.join('×') : ''; }
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
      r.units = cleanUnits('units' in ctx.body ? ctx.body.units : (rec && rec.units) || [], r.unit || '个');
      const mine = [r.barcode, ...r.units.map(u => u.barcode)].filter(Boolean), used = new Set(others.flatMap(codesOf));
      if (new Set(mine).size < mine.length) fail('条码重复：商品条码和各单位条码不能相同');
      if (mine.some(c => used.has(c))) fail('条码已被其他商品使用');
      r.stock = rec ? rec.stock : Math.round(r.stock || 0);
      r.wh = rec ? rec.wh : undefined;
      r.safety = Math.round(r.safety || 0);
      r.shelfDays = Math.round(r.shelfDays || 0);
      if (rec && rec.stock !== 0) r.cost = rec.cost;  // 有库存时成本由移动加权平均自动计算
      if (rec && !!rec.batch !== !!r.batch) setBatchMode(r, r.batch);
      if (r.serial && !(rec && rec.serial)) {
        if (rec && rec.stock) fail('开启序列号管理需要先把库存清零（例如出库或盘点为 0），之后用入库单逐件登记序列号入库');
        if (!rec && r.stock > 0) fail('启用序列号的商品不能直接填期初库存，请建好后用入库单逐件登记序列号');
      }
      if (rec && rec.serial && !r.serial) serialsOf(r.id).filter(x => x.status === '在库').forEach(x => del('serials', x.id));  // 关闭后不再跟踪在库的号
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
    const used = col === 'products' ? [...list('sales'), ...list('purchases'), ...list('salesReturns'), ...list('purchaseReturns'), ...list('stockDocs')].some(o => o.items.some(i => i.productId === id)) || list('checkDocs').some(o => o.lines.some(l => l.productId === id))
      : col === 'customers' ? [...list('sales'), ...list('salesReturns')].some(o => o.customerId === id)
      : col === 'suppliers' ? [...list('purchases'), ...list('purchaseReturns')].some(o => o.supplierId === id) : false;
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
    const src = C.src && b.srcId ? returnSrc(C, str(b.srcId, 64), party) : null;
    const items = (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId).map(i => {
      const p = get('products', i.productId) || fail('商品不存在或已删除');
      const l = unitQty(p, i), price = Number(i.price);
      if (!Number.isFinite(price) || price < 0) fail('单价不正确');
      // 退货的 cost：销售退货按原单发货成本入库，采购退货按原采购价冲减库存价值；没关联原单按当前成本
      const sl = src && src.items.find(x => x.productId === p.id);
      const cost = !C.src ? p.cost : C.src === 'sales' ? (sl && sl.cost != null ? sl.cost : p.cost) : sl ? sl.price : null;
      return { productId: p.id, ...l, price: basePrice(round2(price), l), ...(l.rate ? { uprice: round2(price) } : {}), cost };
    });
    if (!items.length) fail('请至少添加一个商品');
    if (src) {
      const left = returnable(src, id);
      for (const [pid, q] of Object.entries(qtyByProduct(items))) {
        const p = get('products', pid);
        if (!(pid in left)) fail(`「${p.name}」不在原单 ${src.no} 里`);
        if (q > left[pid]) fail(`「${p.name}」最多还能退 ${left[pid]}（原单 ${src.no}）`);
      }
    }
    const data = { [C.partyKey]: party, date: b.date, remark: str(b.remark, 500), items, ...(C.src ? { srcId: src ? src.id : '', srcNo: src ? src.no : '' } : {}) };
    if (id) {
      const o = get(C.col, id) || fail('单据不存在', 404);
      if (o.status !== C.statuses[0]) fail(`单据状态为「${o.status}」，不能编辑`);
      if (!C.src) items.forEach(it => { const old = o.items.find(x => x.productId === it.productId); if (old && old.cost != null) it.cost = old.cost; });
      if ((o.offset || 0) > 0 && o.srcId !== data.srcId) fail('已冲抵过原单的退货单不能改关联原单');
      if ((o[C.paidKey] || 0) > orderTotal({ items }) + 0.001) fail(`已${C.payWord} ${o[C.paidKey]} 元，修改后的合计不能少于这个数`);
      Object.assign(o, data);
      put(C.col, o); audit(ctx, '修改' + C.title, o.no);
      return o;
    }
    const o = { id: uid(), no: nextNo(C), ...data, status: C.statuses[0], [C.paidKey]: 0, createdAt: today(), creator: ctx.user.name };
    put(C.col, o); audit(ctx, '新建' + C.title, `${o.no} ${orderTotal(o)}`);
    return o;
  });
}
// 退货关联的原单：同一往来单位，已发货 / 已入库
function returnSrc(C, srcId, party) {
  const S0 = ORD[C.src], src = get(S0.col, srcId) || fail('原单不存在');
  if (src[S0.partyKey] !== party) fail(`原单 ${src.no} 不是这个${C.partyLabel}的`);
  if (!C.srcOk.includes(src.status)) fail(`原单 ${src.no} 状态为「${src.status}」，${C.src === 'sales' ? '发货' : '入库'}后才能退货`);
  return src;
}
// 原单每个商品还能退多少（基本单位）= 原单数量 - 其他没作废的退货单已退的
function returnable(src, exceptId) {
  const left = qtyByProduct(src.items), col = src.supplierId ? 'purchaseReturns' : 'salesReturns';
  list(col).filter(r => r.srcId === src.id && r.id !== exceptId && r.status !== '已作废').forEach(r => r.items.forEach(i => { if (i.productId in left) left[i.productId] -= i.qty; }));
  for (const k in left) left[k] = Math.max(0, left[k]);
  return left;
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
    } else if (action === 'post' && C.src) {
      need(C.statuses[0]);
      const wh = pickWh(b.wh), bi = b.batches && typeof b.batches === 'object' ? b.batches : {}, pname = (get(C.party, o[C.partyKey]) || {}).name || '';
      if (kind === 'purchaseReturn') { const lack = lackOf(o.items, wh); if (lack.length) fail(lackText(lack, wh)); }
      o.items.forEach(i => {
        const p = get('products', i.productId) || fail('商品不存在或已删除');
        const m = kind === 'salesReturn'
          ? moveStock(ctx, p, i.qty, '销售退货', o.no, pname, { price: i.cost != null ? i.cost : p.cost || 0, wh, batch: { no: o.no, ...(bi[p.id] || {}) } })
          : moveStock(ctx, p, -i.qty, '采购退货', o.no, pname, { reversePrice: i.cost != null ? i.cost : undefined, wh });
        i.cost = round4(m.unit);
        if (m.alloc) i.batches = m.alloc;
      });
      o.status = C.statuses[1]; o.postDate = today(); o.wh = wh;
    } else if (action === 'offset' && C.src) {
      // 冲抵：对方原单还有没结清的款，退货款直接抵掉，不走现金
      if (o.status === '已作废') fail('已作废单据不能冲抵');
      const S0 = ORD[C.src], src = o.srcId && get(S0.col, o.srcId) || fail('这张退货单没有关联原单，不能冲抵');
      const max = round2(Math.min(orderTotal(o) - (o.refunded || 0), orderTotal(src) - (src[S0.paidKey] || 0))), amount = round2(Number(b.amount));
      if (!(amount > 0) || amount > max + 0.001) fail(`冲抵金额需在 0 ~ ${max} 之间`);
      o.refunded = round2((o.refunded || 0) + amount); o.offset = round2((o.offset || 0) + amount);
      src[S0.paidKey] = round2((src[S0.paidKey] || 0) + amount); src.offset = round2((src.offset || 0) + amount);
      put(S0.col, src);
    } else if (action === 'cancel') {
      const ok = C.src ? [C.statuses[0]] : kind === 'sales' ? ['待发货'] : ['待审核', '已审核'];
      if (!ok.includes(o.status)) fail(`单据当前状态为「${o.status}」，不能作废`);
      if (o[C.paidKey] > 0) fail(`单据已有${C.payWord}记录，不能作废`);
      o.status = '已作废';
    } else if (action === 'pay') {
      if (o.status === '已作废') fail(`已作废单据不能${C.payWord}`);
      const unpaid = round2(orderTotal(o) - (o[C.paidKey] || 0)), amount = round2(Number(b.amount));
      if (!(amount > 0) || amount > unpaid + 0.001) fail(`${C.payWord}金额需在 0 ~ ${unpaid} 之间`);
      o[C.paidKey] = round2((o[C.paidKey] || 0) + amount);
      put('finance', { id: uid(), date: isDate(b.date) ? b.date : today(), type: C.fin[0], category: C.fin[1],
        amount, method: METHODS.includes(b.method) ? b.method : '银行转账', ref: o.no, note: str(b.note), operator: ctx.user.name });
    } else fail('不支持的操作', 404);
    put(C.col, o);
    audit(ctx, { ship: '发货', complete: '完成订单', approve: '审核采购', inbound: '采购入库', post: kind === 'salesReturn' ? '销售退货入库' : '采购退货出库', offset: '退货冲抵', cancel: '作废单据', pay: C.payWord }[action], o.no + (action === 'pay' || action === 'offset' ? ' ' + b.amount : ''));
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
  if (mode !== 'check' && needApprove(mode)) fail(`已开启${DOC[mode].title}审核，请开${DOC[mode].title}`);
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
// 出入库审核：系统设置里按入库 / 出库分别开启；开启后新单据为「待审核」，审核通过才改库存，驳回的单据不影响库存
const needApprove = dir => !!(getMeta('settings', {}).docApprove || {})[dir];
function lackOf(items, wh) {
  return Object.entries(qtyByProduct(items)).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => !x.p || whQty(x.p, wh) < x.q);
}
const lackText = (lack, wh) => `${whName(wh)}库存不足：` + lack.map(x => x.p ? `${x.p.name}（需 ${x.q}，现有 ${whQty(x.p, wh)}）` : '商品已删除').join('、');
// 单据入账：逐行改库存，出库行回填成本单价，批次写回明细
function postStockDoc(ctx, o) {
  o.items.forEach(i => {
    const m = moveStock(ctx, get('products', i.productId), o.dir === 'in' ? i.qty : -i.qty, o.type, o.no, i.note || o.party, { price: o.dir === 'in' ? i.price : undefined, date: o.date, wh: o.wh, batch: i.batch, serials: i.serials });
    if (o.dir === 'out') { i.price = round4(m.unit); if (i.rate) i.uprice = round4(m.unit * i.rate); }
    delete i.batch;
    if (m.alloc) i.batches = m.alloc;
  });
}
function qtyByProduct(items) { const q = {}; items.forEach(i => { q[i.productId] = (q[i.productId] || 0) + i.qty; }); return q; }
/* ---------- 多单位：商品可设辅助单位（如 1 箱 = 12 个），开单可按辅助单位录入；库存、成本一律按基本单位核算 ---------- */
function cleanUnits(raw, base) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 5) fail('辅助单位最多 5 个');
  const seen = new Set([base]);
  return raw.map(u => {
    const name = str(u && u.name, 10), rate = Number(u && u.rate), barcode = str(u && u.barcode, 64);
    if (!name) fail('辅助单位名称不能为空');
    if (seen.has(name)) fail(`单位「${name}」重复（不能和基本单位相同）`);
    if (!Number.isInteger(rate) || rate < 2 || rate > 100000) fail(`「1 ${name} = ? ${base}」的换算数需为 2 ~ 100000 的整数`);
    seen.add(name);
    return barcode ? { name, rate, barcode } : { name, rate };
  });
}
const codesOf = p => [p.sku, p.barcode, ...(p.units || []).map(u => u.barcode)].filter(Boolean);
// 「箱=12/条码；盒=6」→ [{ name, rate, barcode }]，和商品档案里的写法一致
function parseUnitsText(t) {
  return String(t || '').split(/[;；,，\n]+/).map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^1?\s*([^=＝\s\/／\d][^=＝\s\/／]*)\s*[=＝]\s*(\d+)\s*[^\d\/／]*?(?:[\/／]\s*(\S+))?$/.exec(x);
    if (!m) fail('辅助单位格式不对：「' + x + '」，应写成 箱=12');
    return { name: m[1], rate: +m[2], barcode: m[3] || '' };
  });
}
// 明细数量按所选单位录入，换算成基本单位：返回 { qty: 基本单位数量, unit, rate, uqty: 录入数量 }
function unitQty(p, i) {
  const n = Number(i.qty), name = str(i.unit, 10);
  if (!Number.isInteger(n) || n <= 0) fail(`「${p.name}」数量必须为正整数`);
  if (!name || name === p.unit) return { qty: n };
  const u = (p.units || []).find(x => x.name === name) || fail(`「${p.name}」没有单位「${name}」，请先在商品档案里设置`);
  return { qty: n * u.rate, unit: u.name, rate: u.rate, uqty: n };
}
// 录入的是所选单位的单价，按基本单位保存且不取整，保证 数量 × 单价 等于录入金额
const basePrice = (price, l) => (l.rate ? price / l.rate : price);
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
      const l = unitQty(p, i);
      // 出库一律按移动加权成本计价；入库可填单价（所选单位的单价；看不到金额的账号按当前成本）
      const price = dir === 'in' && withPrice && i.price !== undefined && i.price !== '' ? Number(i.price) : (p.cost || 0) * (l.rate || 1);
      if (!Number.isFinite(price) || price < 0) fail(`「${p.name}」单价不正确`);
      const it = { productId: p.id, ...l, price: dir === 'in' ? basePrice(round4(price), l) : 0, ...(dir === 'in' && l.rate ? { uprice: round4(price) } : {}), note: str(i.note, 100) };
      if (p.serial) it.serials = cleanSerials(p, i.serials, l.qty);
      if (dir === 'in' && p.batch) {
        it.batch = { no: str(i.batchNo, 40), prodDate: isDate(i.prodDate) ? i.prodDate : '', expDate: isDate(i.expDate) ? i.expDate : '' };
        if (it.batch.expDate && it.batch.prodDate && it.batch.expDate < it.batch.prodDate) fail(`「${p.name}」有效期早于生产日期`);
      }
      return it;
    });
    if (!items.length) fail('请至少添加一个商品');
    if (dir === 'out') { const lack = lackOf(items, wh); if (lack.length) fail(lackText(lack, wh)); }
    const sn = items.flatMap(i => i.serials || []);
    if (new Set(sn).size < sn.length) fail('同一张单据里序列号有重复');
    items.forEach(i => { if (i.serials) checkSerials(get('products', i.productId), i.serials, dir === 'in' ? 1 : -1, wh); });
    const pending = needApprove(dir);
    const o = { id: uid(), no: nextNo(D), dir, type: b.type, wh, date, time: hhmm(), party: str(b.party, 100), handler: str(b.handler, 32), remark: str(b.remark, 500),
      ...(dir === 'out' && str(b.address, 200) ? { address: str(b.address, 200) } : {}), items, status: pending ? '待审核' : '正常', creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), printCount: 0 };
    if (!pending) postStockDoc(ctx, o);
    put('stockDocs', o);
    audit(ctx, (pending ? '提交' : '新建') + D.title, `${o.no} ${o.type} ${items.length} 项`);
    return o;
  });
}
function approveStockDoc(ctx, id, pass) {
  return tx(() => {
    const o = get('stockDocs', id) || fail('单据不存在', 404);
    if (o.status !== '待审核') fail(`单据当前状态为「${o.status}」，不能审核`);
    const wh = o.wh || DEFAULT_WH, now = new Date().toISOString();
    if (pass) {
      if (o.items.some(i => !get('products', i.productId))) fail('单据里有商品已被删除，不能审核通过，请驳回');
      if (o.dir === 'out') { const lack = lackOf(o.items, wh); if (lack.length) fail(lackText(lack, wh)); }
      postStockDoc(ctx, o);
      Object.assign(o, { status: '正常', approver: ctx.user.name, approvedAt: now });
    } else Object.assign(o, { status: '已驳回', approver: ctx.user.name, approvedAt: now, rejectReason: str(ctx.body.reason, 200) || fail('请填写驳回原因') });
    put('stockDocs', o);
    audit(ctx, (pass ? '审核' : '驳回') + DOC[o.dir].title, o.no + (pass ? '' : ' ' + o.rejectReason));
    return o;
  });
}
function voidStockDoc(ctx, id) {
  return tx(() => {
    const o = get('stockDocs', id) || fail('单据不存在', 404);
    ownDoc(ctx, o);
    if (o.status === '已作废') fail('单据已作废');
    if (o.status === '待审核' || o.status === '已驳回') {  // 还没改过库存，作废只改状态；制单人可以作废自己的
      if (!ctx.perms.has('inv.void') && o.creatorId !== ctx.user.id) fail('没有权限：' + PERM_LABEL['inv.void'], 403);
      Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: str(ctx.body.reason, 200) });
      put('stockDocs', o);
      voidShipmentsOf('out', o.id);
      audit(ctx, '作废' + DOC[o.dir].title, o.no + (o.voidReason ? ' ' + o.voidReason : ''));
      return o;
    }
    if (!ctx.perms.has('inv.void')) fail('没有权限：' + PERM_LABEL['inv.void'], 403);
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
      moveStock(ctx, p, o.dir === 'in' ? -i.qty : i.qty, '作废冲回', o.no, reason, o.dir === 'in' ? { reversePrice: i.price, wh, alloc, undo: o.no } : { price: i.price, wh, alloc, undo: o.no });
    });
    Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: reason });
    put('stockDocs', o);
    voidShipmentsOf('out', o.id);
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

/* ---------- 仓库 ---------- */
function saveWarehouse(ctx, id) {
  const b = ctx.body, name = str(b.name, 30) || fail('请填写仓库名称'), code = str(b.code, 20);
  return tx(() => {
    const all = list('warehouses');
    if (all.some(w => w.name === name && w.id !== id)) fail('仓库名称已存在');
    if (code && all.some(w => w.code === code && w.id !== id)) fail('仓库编码已存在');
    let w;
    if (id) { w = get('warehouses', id) || fail('仓库不存在', 404); Object.assign(w, { name, code, remark: str(b.remark, 200) }); }
    else { w = { id: 'w' + uid(), code: code || 'W' + String(all.length + 1).padStart(2, '0'), name, remark: str(b.remark, 200), createdAt: today() }; }
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
/* ---------- 调拨单：从一个仓库移到另一个仓库，总库存与成本不变，批次跟着走 ---------- */
function saveTransfer(ctx) {
  const b = ctx.body, from = pickWh(b.from), to = pickWh(b.to);
  if (from === to) fail('调出仓库和调入仓库不能相同');
  const date = isDate(b.date) ? b.date : today();
  if (date > today()) fail('单据日期不能晚于今天');
  if (date !== today() && !ctx.perms.has('inv.backdate')) fail('没有补录权限，只能开当天的单据', 403);
  return tx(() => {
    const items = (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId).map(i => {
      const p = get('products', i.productId) || fail('商品不存在或已删除');
      const l = unitQty(p, i);
      return { productId: p.id, ...l, note: str(i.note, 100), ...(p.serial ? { serials: cleanSerials(p, i.serials, l.qty) } : {}) };
    });
    if (!items.length) fail('请至少添加一个商品');
    const lack = Object.entries(qtyByProduct(items)).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => whQty(x.p, from) < x.q);
    if (lack.length) fail(`${whName(from)}库存不足：` + lack.map(x => `${x.p.name}（需 ${x.q}，现有 ${whQty(x.p, from)}）`).join('、'));
    const o = { id: uid(), no: nextNo(TRANSFER), from, to, date, time: hhmm(), handler: str(b.handler, 32), remark: str(b.remark, 500), items, status: '正常',
      creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), printCount: 0 };
    items.forEach(i => {
      const out = moveStock(ctx, get('products', i.productId), -i.qty, '调拨出库', o.no, '调往' + whName(to), { date, wh: from, serials: i.serials });
      moveStock(ctx, get('products', i.productId), i.qty, '调拨入库', o.no, '来自' + whName(from), { date, wh: to, price: out.unit, alloc: out.alloc, serials: i.serials });
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
      const back = moveStock(ctx, p, -i.qty, '作废冲回', o.no, reason, { wh: o.to, alloc, undo: o.no });
      moveStock(ctx, get('products', i.productId), i.qty, '作废冲回', o.no, reason, { wh: o.from, price: back.unit, alloc: back.alloc, undo: o.no });
    });
    Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: reason });
    put('transferDocs', o); audit(ctx, '作废调拨单', o.no + (reason ? ' ' + reason : ''));
    return o;
  });
}

/* ================= 物流运费：快递报价、运费估算、运单登记、快递账单对账 ================= */
const PROVINCES = ['北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
  '广东', '广西', '海南', '重庆', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆', '台湾', '香港', '澳门'];
// 报价表里常用的省份分组，前端选省份时一键勾选
const REGIONS = { 江浙沪: ['上海', '江苏', '浙江'], 华东: ['安徽', '福建', '江西', '山东'], 华南: ['广东', '广西', '海南'], 华北: ['北京', '天津', '河北', '山西', '内蒙古'],
  华中: ['河南', '湖北', '湖南'], 西南: ['重庆', '四川', '贵州', '云南'], 西北: ['陕西', '甘肃', '青海', '宁夏'], 东北: ['辽宁', '吉林', '黑龙江'], 偏远: ['新疆', '西藏'], 港澳台: ['香港', '澳门', '台湾'] };
// 地级市（含常见县级市）→ 省份：地址没写省份时按城市识别
const CITIES = {
  河北: '石家庄 唐山 秦皇岛 邯郸 邢台 保定 张家口 承德 沧州 廊坊 衡水 雄安', 山西: '太原 大同 阳泉 长治 晋城 朔州 晋中 运城 忻州 临汾 吕梁',
  内蒙古: '呼和浩特 包头 乌海 赤峰 通辽 鄂尔多斯 呼伦贝尔 巴彦淖尔 乌兰察布 兴安盟 锡林郭勒 阿拉善', 辽宁: '沈阳 大连 鞍山 抚顺 本溪 丹东 锦州 营口 阜新 辽阳 盘锦 铁岭 朝阳 葫芦岛',
  吉林: '长春 吉林 四平 辽源 通化 白山 松原 白城 延边', 黑龙江: '哈尔滨 齐齐哈尔 鸡西 鹤岗 双鸭山 大庆 伊春 佳木斯 七台河 牡丹江 黑河 绥化 大兴安岭',
  江苏: '南京 无锡 徐州 常州 苏州 南通 连云港 淮安 盐城 扬州 镇江 泰州 宿迁 昆山 江阴 张家港 常熟', 浙江: '杭州 宁波 温州 嘉兴 湖州 绍兴 金华 衢州 舟山 台州 丽水 义乌 慈溪 余姚 乐清 瑞安',
  安徽: '合肥 芜湖 蚌埠 淮南 马鞍山 淮北 铜陵 安庆 黄山 滁州 阜阳 宿州 六安 亳州 池州 宣城', 福建: '福州 厦门 莆田 三明 泉州 漳州 南平 龙岩 宁德 晋江 石狮',
  江西: '南昌 景德镇 萍乡 九江 新余 鹰潭 赣州 吉安 宜春 抚州 上饶', 山东: '济南 青岛 淄博 枣庄 东营 烟台 潍坊 济宁 泰安 威海 日照 临沂 德州 聊城 滨州 菏泽',
  河南: '郑州 开封 洛阳 平顶山 安阳 鹤壁 新乡 焦作 濮阳 许昌 漯河 三门峡 南阳 商丘 信阳 周口 驻马店 济源', 湖北: '武汉 黄石 十堰 宜昌 襄阳 鄂州 荆门 孝感 荆州 黄冈 咸宁 随州 恩施 仙桃 潜江 天门 神农架',
  湖南: '长沙 株洲 湘潭 衡阳 邵阳 岳阳 常德 张家界 益阳 郴州 永州 怀化 娄底 湘西', 广东: '广州 韶关 深圳 珠海 汕头 佛山 江门 湛江 茂名 肇庆 惠州 梅州 汕尾 河源 阳江 清远 东莞 中山 潮州 揭阳 云浮',
  广西: '南宁 柳州 桂林 梧州 北海 防城港 钦州 贵港 玉林 百色 贺州 河池 来宾 崇左', 海南: '海口 三亚 三沙 儋州 琼海 万宁 文昌 五指山',
  四川: '成都 自贡 攀枝花 泸州 德阳 绵阳 广元 遂宁 内江 乐山 南充 眉山 宜宾 广安 达州 雅安 巴中 资阳 阿坝 甘孜 凉山', 贵州: '贵阳 六盘水 遵义 安顺 毕节 铜仁 黔西南 黔东南 黔南',
  云南: '昆明 曲靖 玉溪 保山 昭通 丽江 普洱 临沧 楚雄 红河 文山 西双版纳 大理 德宏 怒江 迪庆', 西藏: '拉萨 日喀则 昌都 林芝 山南 那曲 阿里',
  陕西: '西安 铜川 宝鸡 咸阳 渭南 延安 汉中 榆林 安康 商洛', 甘肃: '兰州 嘉峪关 金昌 白银 天水 武威 张掖 平凉 酒泉 庆阳 定西 陇南 临夏 甘南',
  青海: '西宁 海东 海北 黄南 海南藏族自治州 海南州 果洛 玉树 海西', 宁夏: '银川 石嘴山 吴忠 固原 中卫',
  新疆: '乌鲁木齐 克拉玛依 吐鲁番 哈密 昌吉 博尔塔拉 巴音郭楞 阿克苏 克孜勒苏 喀什 和田 伊犁 塔城 阿勒泰 石河子'
};
const CITY_PROV = new Map(Object.entries(CITIES).flatMap(([p, t]) => t.split(' ').map(c => [c, p])));
// 城市名后面紧跟这些字时其实是区县 / 路名（如「北京朝阳区」「上海南京路」），不当城市
const NOT_CITY = /^[区县路街道镇乡村巷里弄大]/;
function cityAt(s, i) {
  let best = '';
  for (const c of CITY_PROV.keys()) if (c.length > best.length && s.startsWith(c, i) && !NOT_CITY.test(s.slice(i + c.length))) best = c;
  return best;
}
// 从地址里识别省份和城市：先看开头的省份 / 城市，再找地址中间的「X省」「X市」
function parseAddr(addr) {
  const s = String(addr || '').replace(/[\s,，、]+/g, '').replace(/^(中华人民共和国|中国)/, '');
  if (!s) return { province: '', city: '' };
  const p = PROVINCES.find(x => s.startsWith(x)), c0 = cityAt(s, 0);
  if (p && !(c0 && c0.length > p.length)) {
    const rest = s.slice(p.length).replace(/^(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)/, ''), c = cityAt(s, s.length - rest.length);
    return { province: p, city: c && CITY_PROV.get(c) === p ? c : '' };
  }
  if (c0) return { province: CITY_PROV.get(c0), city: c0 };
  let hit = null;
  const take = (i, province, city) => { if (i >= 0 && (!hit || i < hit.i)) hit = { i, province, city }; };
  for (const x of PROVINCES) for (const suf of ['省', '市', '自治区', '壮族', '回族', '维吾尔']) take(s.indexOf(x + suf), x, '');
  for (const [c, x] of CITY_PROV) take(s.indexOf(c + '市'), x, c);
  return hit ? { province: hit.province, city: hit.city } : { province: '', city: '' };
}
const normProv = x => { x = str(x, 30); return PROVINCES.includes(x) ? x : parseAddr(x).province; };
function parseSize(t) {
  const m = /^(\d+(?:\.\d+)?)\s*[x×*Xｘ✕]\s*(\d+(?:\.\d+)?)\s*[x×*Xｘ✕]\s*(\d+(?:\.\d+)?)$/.exec(String(t || '').trim().replace(/(cm|厘米)$/i, ''));
  return m && +m[1] > 0 && +m[2] > 0 && +m[3] > 0 ? [+m[1], +m[2], +m[3]] : null;
}
// 按商品重量 / 包装尺寸估算一票货：weight 实重 kg（不含包材），vol 体积 cm³；没填重量的商品列在 missing
function itemsWeight(items) {
  let weight = 0, vol = 0; const missing = new Set();
  for (const i of items) {
    const p = get('products', i.productId); if (!p) continue;
    if (!(p.weight > 0)) missing.add(p.name);
    weight += i.qty * (p.weight || 0);
    const d = parseSize(p.size); if (d) vol += i.qty * d[0] * d[1] * d[2];
  }
  return { weight: round3(weight), vol: Math.round(vol), missing: [...missing] };
}
const ceilTo = (x, step) => step > 0 ? round3(Math.ceil(round4(x / step) - 1e-9) * step) : round3(x);
const zoneOf = (c, prov) => (c.zones || []).find(z => z.provinces.includes(prov)) || (c.zones || []).find(z => !z.provinces.length);
// 分区运费：有重量段先按段取价，超过最高一段按续重加价；没有重量段按首重 + 续重
function zoneFee(z, cw) {
  const steps = over => Math.ceil(round4(over / (z.addStep || 1)) - 1e-9);
  if (z.bands.length) {
    const b = z.bands.find(x => cw <= x.upTo + 1e-9); if (b) return b.fee;
    const last = z.bands[z.bands.length - 1];
    return z.addFee > 0 ? last.fee + steps(cw - last.upTo) * z.addFee : null;
  }
  return cw <= z.first + 1e-9 ? z.firstFee : z.firstFee + steps(cw - z.first) * z.addFee;
}
/**
 * 一家快递发往某省的运费
 * - weight：实重 kg；packed 为真表示已经含包材（称重得到的），否则加上快递公司设置的包材重量
 * - vol：体积 cm³，按抛比折算体积重，计费重 = max(实重, 体积重) 按进位规则取整
 * - charge：直接指定计费重量（对账时按账单重量反算用）
 */
function quoteCarrier(c, prov, { weight = 0, vol = 0, declared = 0, packed = false, charge } = {}) {
  const head = { carrierId: c.id, name: c.name };
  const z = prov && zoneOf(c, prov);
  if (!z) return { ...head, error: prov ? `没有发往${prov}的报价` : '缺少收件省份' };
  const real = round3(weight + (packed ? 0 : c.pack || 0)), volWeight = c.volDiv > 0 && vol > 0 ? round3(vol / c.volDiv) : 0;
  const chargeWeight = charge != null ? round3(charge) : ceilTo(Math.max(real, volWeight), c.step);
  const base = zoneFee(z, chargeWeight);
  if (base == null) return { ...head, error: `超出报价表最高重量 ${z.bands[z.bands.length - 1].upTo}kg，且没有设续重价` };
  const insure = declared > 0 && c.insureRate > 0 ? Math.max(c.insureMin || 0, declared * c.insureRate / 100) : 0;
  return { ...head, zone: z.name, weight: real, volWeight, chargeWeight, base: round2(base), extra: z.extra || 0, insure: round2(insure), fee: round2(Math.max(base + (z.extra || 0), z.min || 0) + insure) };
}

/* ---------- 快递公司与报价 ---------- */
function cleanZones(raw) {
  if (!Array.isArray(raw) || !raw.length) fail('请至少设置一个分区的报价');
  if (raw.length > 40) fail('分区最多 40 个');
  const used = new Map(); let rest = 0;
  return raw.map((z, n) => {
    z = z && typeof z === 'object' ? z : {};
    const name = str(z.name, 20) || `分区${n + 1}`;
    const provinces = [...new Set((Array.isArray(z.provinces) ? z.provinces : []).map(normProv).filter(Boolean))];
    for (const p of provinces) { if (used.has(p)) fail(`「${p}」同时在「${used.get(p)}」和「${name}」两个分区里`); used.set(p, name); }
    if (!provinces.length && ++rest > 1) fail('只能有一个不选省份的分区（表示「其余省份」）');
    const nn = (v, label, d = 0) => { if (v === '' || v == null) return d; const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 1e6) fail(`「${name}」${label}不正确`); return round4(x); };
    const bands = (Array.isArray(z.bands) ? z.bands : []).map(b => ({ upTo: nn(b && b.upTo, '重量段'), fee: nn(b && b.fee, '重量段价格') })).filter(b => b.upTo > 0).sort((a, b) => a.upTo - b.upTo);
    if (bands.length > 50) fail(`「${name}」重量段最多 50 个`);
    if (bands.some((b, i) => i && b.upTo === bands[i - 1].upTo)) fail(`「${name}」有重复的重量段`);
    const r = { name, provinces, first: nn(z.first, '首重', 1), firstFee: nn(z.firstFee, '首重价'), addStep: nn(z.addStep, '续重步长', 1) || 1, addFee: nn(z.addFee, '续重价'), bands, extra: nn(z.extra, '附加费'), min: nn(z.min, '最低收费') };
    if (!bands.length && !(r.first > 0)) fail(`「${name}」首重必须大于 0`);
    if (!bands.length && !(r.firstFee > 0)) fail(`「${name}」请填写首重价格，或者填写重量段价格`);
    return r;
  });
}
function saveCarrier(ctx, id) {
  const b = ctx.body, name = str(b.name, 20) || fail('请填写快递公司名称');
  const nn = (v, label, d, max) => { if (v === '' || v == null) return d; const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > max) fail(label + '不正确'); return round4(x); };
  return tx(() => {
    if (list('carriers').some(c => c.name === name && c.id !== id)) fail('快递公司名称已存在');
    const old = id ? get('carriers', id) || fail('快递公司不存在', 404) : null;
    const c = { ...(old || { id: uid(), createdAt: today() }), name, code: str(b.code, 20), enabled: b.enabled !== false, remark: str(b.remark, 200),
      step: nn(b.step, '计费重量进位', 0.1, 10), volDiv: nn(b.volDiv, '抛比', 0, 100000), pack: nn(b.pack, '包材重量', 0, 100),
      insureRate: nn(b.insureRate, '保价费率', 0, 100), insureMin: nn(b.insureMin, '最低保价费', 0, 10000), tol: nn(b.tol, '对账容差', 0.5, 1000), zones: cleanZones(b.zones), eo: cleanEo(b.eo, old && old.eo) };
    put('carriers', c); audit(ctx, (old ? '修改' : '新增') + '快递公司', `${name}（${c.zones.length} 个分区）`);
    return c;
  });
}
function deleteCarrier(ctx, id) {
  return tx(() => {
    const c = get('carriers', id) || fail('快递公司不存在', 404);
    if (list('shipments').some(s => s.carrierId === id) || list('shipBills').some(x => x.carrierId === id)) fail('这家快递已有运单或账单，不能删除，可以停用');
    del('carriers', id); audit(ctx, '删除快递公司', c.name);
  });
}

/* ---------- 运单：一个包裹一条，记估算运费；对账后写入账单运费 ---------- */
const SHIP = { col: 'shipments', prefix: 'YD', title: '运单' };
const BILL = { col: 'shipBills', prefix: 'ZD', title: '快递账单' };
const normTrack = v => str(v, 60).replace(/\s+/g, '').toUpperCase().slice(0, 40);
const findShipment = (trackNo, except) => list('shipments').find(s => s.trackNo === trackNo && s.status !== '已作废' && s.id !== except);
const carrierName = id => (get('carriers', id) || {}).name || '已删除快递';
function shipSource(type, id) {
  if (!type) return null;
  if (type === 'out') {
    const o = get('stockDocs', id);
    if (!o || o.dir !== 'out') fail('出库单不存在');
    if (o.status === '已作废') fail('出库单已作废');
    return { type, id: o.id, no: o.no, party: o.party || '', address: o.address || '', items: o.items };
  }
  if (type === 'sales') {
    const o = get('sales', id) || fail('销售单不存在');
    if (o.status === '已作废') fail('销售单已作废');
    const c = get('customers', o.customerId) || {};
    return { type, id: o.id, no: o.no, party: c.name || '', address: c.address || '', items: o.items };
  }
  fail('来源单据类型不正确');
}
function pickProv(province, address) {
  const p = str(province, 10);
  if (p) return PROVINCES.includes(p) ? p : fail('省份不正确');
  return parseAddr(address).province || fail('识别不出收件省份，请在地址前写上省份，或者手动选择省份');
}
const optNum = (v, label, max = 1e6) => { if (v === '' || v == null) return null; const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > max) fail(label + '不正确'); return x; };
function shipQuote(ctx) {
  const b = ctx.body, src = shipSource(str(b.srcType, 10), str(b.srcId, 64));
  const items = src ? src.items : (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId).slice(0, 500).map(i => {
    const p = get('products', i.productId); if (!p) return null;
    try { return { productId: p.id, qty: unitQty(p, i).qty }; } catch (e) { return null; }
  }).filter(Boolean);
  const address = str(b.address, 200) || (src ? src.address : ''), pa = parseAddr(address);
  const province = PROVINCES.includes(b.province) ? b.province : pa.province;
  const est = itemsWeight(items), w = optNum(b.weight, '重量', 10000), declared = optNum(b.declared, '保价金额') || 0;
  const opt = w ? { weight: w, packed: true, vol: est.vol, declared } : { weight: est.weight, vol: est.vol, declared };
  const quotes = list('carriers').filter(c => c.enabled).map(c => quoteCarrier(c, province, opt)).sort((x, y) => !!x.error - !!y.error || (x.fee || 0) - (y.fee || 0));
  return { province, city: pa.city, detected: pa.province, address, weight: est.weight, vol: est.vol, missing: est.missing, items: items.length, quotes };
}
function createShipments(ctx, b, extra = {}) {
  const src = shipSource(str(b.srcType, 10), str(b.srcId, 64));
  const c = get('carriers', str(b.carrierId, 64)) || fail('请选择快递公司');
  if (!c.enabled) fail(`「${c.name}」已停用`);
  const address = str(b.address, 200) || (src ? src.address : ''), province = pickProv(b.province, address);
  const pk = (Array.isArray(b.packages) ? b.packages : []).filter(x => x && (str(x.trackNo, 60) || (x.weight !== '' && x.weight != null)));
  if (!pk.length) fail('请填写快递单号');
  if (pk.length > 50) fail('一次最多登记 50 个包裹');
  const est = src ? itemsWeight(src.items) : { weight: 0, vol: 0 };
  const declared = optNum(b.declared, '保价金额') || 0, date = isDate(b.date) ? b.date : today(), seen = new Set();
  return tx(() => {
    const out = pk.map((x, n) => {
      const trackNo = normTrack(x.trackNo) || fail(`第 ${n + 1} 个包裹没有填快递单号`);
      if (seen.has(trackNo)) fail(`快递单号 ${trackNo} 重复`);
      seen.add(trackNo);
      if (findShipment(trackNo)) fail(`快递单号 ${trackNo} 已经登记过`);
      const w = optNum(x.weight, `快递单号 ${trackNo} 的重量`, 10000);
      if (!w && (pk.length > 1 || !(est.weight > 0))) fail(`请填写快递单号 ${trackNo} 的包裹重量（kg）`);
      const first = n === 0, vol = pk.length === 1 ? est.vol : 0;
      const q = quoteCarrier(c, province, w ? { weight: w, packed: true, vol, declared: first ? declared : 0 } : { weight: est.weight, vol, declared });
      if (q.error) fail(`${c.name}：${q.error}`);
      const s = { id: uid(), no: nextNo(SHIP), date, carrierId: c.id, trackNo, srcType: src ? src.type : '', srcId: src ? src.id : '', srcNo: src ? src.no : '',
        party: str(b.party, 100) || (src ? src.party : ''), mobile: str(b.mobile, 30), address, province, weight: q.weight, weighed: !!w, vol, volWeight: q.volWeight, chargeWeight: q.chargeWeight,
        declared: first ? declared : 0, zone: q.zone, estFee: q.fee, status: '待对账', note: str(b.note, 200), creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(),
        ...(extra.eorder && first ? { eorder: extra.eorder } : {}) };
      put('shipments', s);
      return s;
    });
    if (src && src.type === 'out' && !src.address && address) { const o = get('stockDocs', src.id); o.address = address; put('stockDocs', o); }
    audit(ctx, '登记运单', `${c.name} ${out.map(s => s.trackNo).join('、')}${src ? ' ← ' + src.no : ''}`);
    return out;
  });
}
function editShipment(ctx, id) {
  const b = ctx.body;
  return tx(() => {
    const s = get('shipments', id) || fail('运单不存在', 404);
    if (s.status !== '待对账') fail(`运单状态为「${s.status}」，不能修改`);
    const c = get('carriers', str(b.carrierId, 64) || s.carrierId) || fail('快递公司不存在');
    const trackNo = 'trackNo' in b ? normTrack(b.trackNo) || fail('请填写快递单号') : s.trackNo;
    if (findShipment(trackNo, s.id)) fail(`快递单号 ${trackNo} 已经登记过`);
    const address = 'address' in b ? str(b.address, 200) : s.address;
    const province = 'province' in b || 'address' in b ? pickProv(b.province, address) : s.province;
    const w = 'weight' in b ? optNum(b.weight, '重量', 10000) : s.weight;
    if (!w) fail('请填写包裹重量（kg）');
    const declared = 'declared' in b ? optNum(b.declared, '保价金额') || 0 : s.declared || 0;
    const q = quoteCarrier(c, province, { weight: w, packed: true, vol: s.vol || 0, declared });
    if (q.error) fail(`${c.name}：${q.error}`);
    Object.assign(s, { carrierId: c.id, trackNo, address, province, weight: q.weight, weighed: s.weighed || w !== s.weight, volWeight: q.volWeight, chargeWeight: q.chargeWeight,
      declared, zone: q.zone, estFee: q.fee, date: isDate(b.date) ? b.date : s.date, note: 'note' in b ? str(b.note, 200) : s.note, mobile: 'mobile' in b ? str(b.mobile, 30) : s.mobile || '' });
    put('shipments', s); audit(ctx, '修改运单', `${s.trackNo} ¥${s.estFee}`);
    return s;
  });
}
function voidShipment(ctx, id) {
  return tx(() => {
    const s = get('shipments', id) || fail('运单不存在', 404);
    if (s.status !== '待对账') fail(`运单状态为「${s.status}」，不能作废`);
    s.status = '已作废'; s.voidBy = ctx.user.name; s.voidAt = new Date().toISOString();
    put('shipments', s); audit(ctx, '作废运单', s.trackNo);
    return s;
  });
}
// 出库单作废时，它名下还没对账的运单一起作废（已对账的是实际发生的运费，保留）
function voidShipmentsOf(type, id) {
  for (const s of list('shipments')) if (s.srcType === type && s.srcId === id && s.status === '待对账') { s.status = '已作废'; s.voidAt = new Date().toISOString(); put('shipments', s); }
}
const shipFinanceOn = () => enabledModules().includes('finance');
const shipExpense = (ctx, amount, ref, note) => put('finance', { id: uid(), date: today(), type: 'expense', category: '快递费', amount: round2(amount), method: '银行转账', ref, note, operator: ctx.user.name });
// 申诉处理完：按最终金额结算
function resolveShipment(ctx, id) {
  const fee = optNum(ctx.body.fee, '最终运费');
  if (fee == null) fail('请填写最终运费');
  return tx(() => {
    const s = get('shipments', id) || fail('运单不存在', 404);
    if (s.status !== '申诉中') fail('只有申诉中的运单需要处理');
    const bill = get('shipBills', s.billId);
    Object.assign(s, { status: '已对账', billFee: round2(fee), resolveNote: str(ctx.body.note, 200), resolvedBy: ctx.user.name, resolvedAt: new Date().toISOString() });
    put('shipments', s);
    if (bill && bill.toFinance && shipFinanceOn() && fee > 0) shipExpense(ctx, fee, bill.no, `申诉结算 ${s.trackNo}`);
    audit(ctx, '处理运费申诉', `${s.trackNo} 最终 ¥${s.billFee}`);
    return s;
  });
}

/* ---------- 快递账单：导入 → 按快递单号匹配 → 差异诊断 → 确认（认可 / 申诉） ---------- */
const BILL_CATS = { ok: '一致', diff: '金额差异', extra: '账单有、系统无', dup: '重复计费' };
function matchBill(bill, c) {
  const ships = list('shipments').filter(s => s.status !== '已作废'), byTrack = new Map(ships.map(s => [s.trackNo, s]));
  const seen = new Map(), tol = c.tol ?? 0.5;
  for (const r of bill.rows) {
    Object.assign(r, { cat: '', shipId: '', est: null, diff: null, reason: '' });
    if (seen.has(r.trackNo)) { r.cat = 'dup'; r.reason = `和表格第 ${seen.get(r.trackNo)} 行是同一个快递单号`; continue; }
    seen.set(r.trackNo, r.line);
    const s = byTrack.get(r.trackNo);
    if (!s) { r.cat = 'extra'; r.reason = '系统里没有登记这个快递单号（漏登记，或不是我们发的件）'; continue; }
    r.shipId = s.id; r.est = s.estFee; r.diff = round2(r.fee - s.estFee);
    if (s.billId && s.billId !== bill.id) { r.cat = 'dup'; r.reason = `已经在账单 ${s.billNo || ''} 里结算过`; continue; }
    const why = [], prov = PROVINCES.includes(r.province) ? r.province : s.province;
    if (s.carrierId !== c.id) why.push(`系统登记的快递是「${carrierName(s.carrierId)}」`);
    if (Math.abs(r.diff) <= tol + 1e-9 && !why.length) { r.cat = 'ok'; continue; }
    r.cat = 'diff';
    const wDiff = r.weight != null && Math.abs(r.weight - s.chargeWeight) > 0.0005, pDiff = prov !== s.province;
    if (pDiff) why.push(`省份不符：系统 ${s.province}，账单 ${prov}`);
    if (wDiff) why.push(`计费重量：系统 ${s.chargeWeight}kg，账单 ${r.weight}kg（${r.weight > s.chargeWeight ? '多' : '少'} ${round3(Math.abs(r.weight - s.chargeWeight))}kg）`);
    if (Math.abs(r.diff) > tol + 1e-9) {
      // 用账单上的重量和省份套我们的报价重算：算得一致说明价格没问题，差异出在重量 / 省份；不一致说明没按报价收费
      const q = quoteCarrier(c, prov, { charge: r.weight != null ? r.weight : s.chargeWeight, declared: s.declared || 0 });
      if (q.error) why.push('按账单重量重算失败：' + q.error);
      else if (Math.abs(q.fee - r.fee) <= tol + 1e-9) why.push(`按账单的重量和省份套报价是 ¥${q.fee}，和账单一致 → 价格没问题，差异来自${[wDiff && '称重', pDiff && '省份'].filter(Boolean).join('和') || '估算口径（体积重 / 包材 / 保价）'}`);
      else why.push(`按账单的重量和省份套报价应为 ¥${q.fee}，账单收 ¥${r.fee} → 没按约定报价收费，或者报价表需要更新`);
    }
    r.reason = why.join('；');
  }
  const inBill = new Set(bill.rows.map(r => r.shipId).filter(Boolean));
  bill.missing = bill.period ? ships.filter(s => s.carrierId === c.id && String(s.date).startsWith(bill.period) && !s.billId && !inBill.has(s.id)).map(s => s.id) : [];
  bill.counts = Object.fromEntries(Object.keys(BILL_CATS).map(k => [k, bill.rows.filter(r => r.cat === k).length]));
  bill.counts.missing = bill.missing.length;
  bill.total = round2(sum(bill.rows, r => r.fee));
  bill.estTotal = round2(sum(bill.rows.filter(r => r.est != null && r.cat !== 'dup'), r => r.est));
}
const cleanMap = m => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {}).slice(0, 10).map(([k, v]) => [str(k, 20), str(v, 40)]));
function importBill(ctx) {
  const b = ctx.body, raw = Array.isArray(b.rows) ? b.rows : fail('账单里没有数据');
  if (!raw.length) fail('账单里没有数据');
  if (raw.length > 20000) fail('一个账单最多 20000 行，请按月拆开导入');
  const c = get('carriers', str(b.carrierId, 64)) || fail('请选择快递公司');
  const period = /^\d{4}-\d{2}$/.test(b.period) ? b.period : '', errors = [];
  const rows = raw.map((r, i) => {
    r = r && typeof r === 'object' ? r : {};
    const line = Number.isInteger(r._row) ? r._row : i + 2, err = m => { errors.push(`第 ${line} 行：${m}`); return null; };
    const trackNo = normTrack(r.trackNo); if (!trackNo) return err('快递单号为空');
    const fee = Number(r.fee); if (r.fee === '' || r.fee == null || !Number.isFinite(fee) || fee < 0) return err(`金额「${str(r.fee, 20)}」不正确`);
    const weight = r.weight === '' || r.weight == null ? null : Number(r.weight);
    if (weight != null && !(Number.isFinite(weight) && weight >= 0 && weight < 1e5)) return err(`重量「${str(r.weight, 20)}」不正确`);
    return { line, trackNo, date: isDate(r.date) ? r.date : '', province: r.province ? normProv(r.province) || str(r.province, 20) : '', weight: weight == null ? null : round3(weight), fee: round2(fee) };
  });
  if (errors.length) fail('账单有错误，没有导入：\n' + errors.slice(0, 20).join('\n') + (errors.length > 20 ? `\n……共 ${errors.length} 处错误` : ''));
  return tx(() => {
    const bill = { id: uid(), no: nextNo(BILL), date: today(), carrierId: c.id, period, fileName: str(b.fileName, 100), map: cleanMap(b.map), rows, status: '草稿',
      creator: ctx.user.name, createdAt: new Date().toISOString() };
    matchBill(bill, c);
    put('shipBills', bill);
    audit(ctx, '导入快递账单', `${bill.no} ${c.name} ${period} ${rows.length} 行 ¥${bill.total}`);
    return bill;
  });
}
// 打开账单：草稿每次都重新匹配（期间可能补录了运单）
function getBill(ctx, id) {
  return tx(() => {
    const bill = get('shipBills', id) || fail('账单不存在', 404);
    if (bill.status === '草稿') { matchBill(bill, get('carriers', bill.carrierId) || { id: bill.carrierId, name: '已删除快递', zones: [] }); put('shipBills', bill); }
    return bill;
  });
}
// 确认账单：一致的自动认可；其余按前端传来的 acts（行序号 → ok / dispute）处理，没传的算申诉
function confirmBill(ctx, id) {
  const b = ctx.body || {}, acts = b.acts && typeof b.acts === 'object' ? b.acts : {}, notes = b.notes && typeof b.notes === 'object' ? b.notes : {};
  return tx(() => {
    const bill = get('shipBills', id) || fail('账单不存在', 404);
    if (bill.status !== '草稿') fail('账单已经确认过');
    const c = get('carriers', bill.carrierId) || fail('快递公司已删除，不能确认');
    matchBill(bill, c);
    let pay = 0, disputed = 0;
    bill.rows.forEach((r, i) => {
      r.act = r.cat === 'ok' || acts[i] === 'ok' ? 'ok' : 'dispute';
      r.note = r.act === 'dispute' ? str(notes[i], 200) : '';
      if (r.act === 'ok') pay += r.fee; else disputed++;
      const s = r.shipId && r.cat !== 'dup' && get('shipments', r.shipId);
      if (!s) return;
      Object.assign(s, { billId: bill.id, billNo: bill.no, billFee: r.fee, billWeight: r.weight, billProvince: r.province, diffReason: r.reason,
        status: r.act === 'ok' ? '已对账' : '申诉中', disputeNote: r.note });
      put('shipments', s);
    });
    Object.assign(bill, { status: '已确认', payable: round2(pay), disputed, toFinance: !!b.finance && shipFinanceOn(), confirmedBy: ctx.user.name, confirmedAt: new Date().toISOString() });
    if (bill.toFinance && pay > 0) shipExpense(ctx, pay, bill.no, `${c.name}${bill.period ? ' ' + bill.period : ''} 快递账单`);
    put('shipBills', bill);
    audit(ctx, '确认快递账单', `${bill.no} 应付 ¥${bill.payable}，申诉 ${disputed} 条`);
    return bill;
  });
}
// 撤销确认：运单退回待对账，删掉这张账单生成的财务支出
function undoBill(ctx, id) {
  return tx(() => {
    const bill = get('shipBills', id) || fail('账单不存在', 404);
    if (bill.status !== '已确认') fail('账单还没确认');
    for (const s of list('shipments').filter(s => s.billId === bill.id)) {
      ['billId', 'billNo', 'billFee', 'billWeight', 'billProvince', 'diffReason', 'disputeNote', 'resolveNote', 'resolvedBy', 'resolvedAt'].forEach(k => delete s[k]);
      s.status = '待对账'; put('shipments', s);
    }
    for (const f of list('finance').filter(f => f.ref === bill.no)) del('finance', f.id);
    bill.rows.forEach(r => { delete r.act; delete r.note; });
    ['payable', 'disputed', 'toFinance', 'confirmedBy', 'confirmedAt'].forEach(k => delete bill[k]);
    bill.status = '草稿'; put('shipBills', bill);
    audit(ctx, '撤销确认快递账单', bill.no);
    return bill;
  });
}
function deleteBill(ctx, id) {
  return tx(() => {
    const bill = get('shipBills', id) || fail('账单不存在', 404);
    if (bill.status !== '草稿') fail('已确认的账单不能删除，请先撤销确认');
    del('shipBills', id); audit(ctx, '删除快递账单', bill.no);
  });
}

/* ================= 快递鸟：电子面单（1007 下单 / 1147 取消）、物流轨迹（1002 即时查询）。需要服务器能连外网 ================= */
const KDN_URL = { eorder: 'https://api.kdniao.com/api/EOrderService', track: 'https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx',
  sandbox: 'http://sandboxapi.kdniao.com:8080/kdniaosandbox/gateway/exterfaceInvoke.json' };
const KDN_TEST_BASE = process.env.XERP_KDN_BASE || '';  // 自动化测试用：指向本机模拟的快递鸟服务
const KDN_STATE = { 0: '暂无轨迹', 1: '已揽收', 2: '在途中', 3: '已签收', 4: '问题件', 5: '转寄', 6: '清关' };
const kdnConf = () => getMeta('settings', {}).kdn || {};
const kdnSenderOk = k => { const s = k.sender || {}; return !!(s.name && (s.mobile || s.tel) && s.province && s.city && s.area && s.address); };
function cleanEo(b, old) {
  if (!b || typeof b !== 'object') return old;
  const pay = Number(b.payType);
  return { customerName: str(b.customerName, 60), customerPwd: str(b.customerPwd, 60) || (old && old.customerPwd) || '', monthCode: str(b.monthCode, 60), sendSite: str(b.sendSite, 60),
    payType: [1, 2, 3, 4].includes(pay) ? pay : 1, expType: str(b.expType, 10) || '1', templateSize: str(b.templateSize, 20) };
}
async function kdnCall(type, data) {
  const k = kdnConf();
  if (!k.ebid || !k.key) fail('请先在 系统设置 → 快递鸟 里填写商户 ID 和 AppKey');
  const json = JSON.stringify(data);
  // 签名：(请求内容 + AppKey) 取 MD5（32 位小写）→ Base64；表单提交时再做一次 URL 编码
  const sign = Buffer.from(crypto.createHash('md5').update(json + k.key, 'utf8').digest('hex')).toString('base64');
  const url = KDN_TEST_BASE ? `${KDN_TEST_BASE}/${type}` : k.sandbox ? KDN_URL.sandbox : type === 1002 ? KDN_URL.track : KDN_URL.eorder;
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({ RequestData: json, EBusinessID: k.ebid, RequestType: String(type), DataSign: sign, DataType: '2' }).toString(), signal: AbortSignal.timeout(15000) });
  } catch (e) { fail('连不上快递鸟（' + (e.cause && e.cause.code || e.message) + '），请检查服务器能否上外网'); }
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { fail(`快递鸟返回了无法识别的内容（HTTP ${r.status}）：${t.slice(0, 120)}`); }
  return j;
}
// 地址拆成快递鸟要的 省 / 市 / 区县 / 详细地址
const PROV_FULL = p => ['北京', '天津', '上海', '重庆'].includes(p) ? p + '市' : { 内蒙古: '内蒙古自治区', 西藏: '西藏自治区', 广西: '广西壮族自治区', 宁夏: '宁夏回族自治区', 新疆: '新疆维吾尔自治区', 香港: '香港特别行政区', 澳门: '澳门特别行政区' }[p] || p + '省';
function splitAddr(addr, prov) {
  let s = String(addr || '').replace(/[\s,，]+/g, '').replace(/^(中华人民共和国|中国)/, '');
  const p = prov || parseAddr(s).province;
  if (!p) fail('识别不出收件省份');
  if (s.startsWith(p)) s = s.slice(p.length).replace(/^(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)/, '');
  let city = '';
  if (['北京', '天津', '上海', '重庆'].includes(p)) city = PROV_FULL(p);
  else {
    const m = /^(.{2,}?(?:市|自治州|地区|盟))/.exec(s), c = cityAt(s, 0);
    if (m && !(c && c.length >= m[1].length)) { city = m[1]; s = s.slice(city.length); }
    else if (c) { city = /(自治州|盟|地区)$/.test(c) || c === '海南州' ? c : c + '市'; s = s.slice(c.length).replace(/^(市|地区)/, ''); }
  }
  const a = /^(.{1,}?(?:区|县|旗|市))/.exec(s), area = a ? a[1] : '';
  if (area) s = s.slice(area.length);
  if (!city || !area || !s) fail('收件地址要写到区县和详细地址，例如：浙江省杭州市西湖区文三路 100 号');
  return { ProvinceName: PROV_FULL(p), CityName: city, ExpAreaName: area, Address: s };
}
// 电子面单下单：先调快递鸟取号，成功后在本地登记运单并保存面单 HTML
async function eorderCreate(ctx) {
  const b = ctx.body, k = kdnConf();
  const src = shipSource(str(b.srcType, 10), str(b.srcId, 64));
  const c = get('carriers', str(b.carrierId, 64)) || fail('请选择快递公司');
  if (!c.enabled) fail(`「${c.name}」已停用`);
  if (!c.code) fail(`「${c.name}」没有填快递鸟编码（如 ZTO、SF、YTO），请在快递报价里补上`);
  if (!kdnSenderOk(k)) fail('请先在 系统设置 → 快递鸟 里填好寄件人姓名、电话和地址（写到区县）');
  const name = str(b.party, 50) || (src ? src.party : '') || fail('请填写收件人');
  const mobile = str(b.mobile, 30) || fail('电子面单需要收件人电话');
  const address = str(b.address, 200) || (src ? src.address : ''), province = pickProv(b.province, address);
  const recv = splitAddr(address, province);
  const est = src ? itemsWeight(src.items) : { weight: 0, vol: 0 };
  const w = optNum(b.weight, '包裹重量', 10000);
  if (!w && !(est.weight > 0)) fail('请填写包裹重量（kg）');
  const declared = optNum(b.declared, '保价金额') || 0;
  const q = quoteCarrier(c, province, w ? { weight: w, packed: true, vol: est.vol, declared } : { weight: est.weight, vol: est.vol, declared });
  if (q.error) fail(`${c.name}：${q.error}`);
  const goods = str(b.goods, 100) || (src ? [...new Set(src.items.map(i => (get('products', i.productId) || {}).name).filter(Boolean))].join('、').slice(0, 100) : '') || '商品';
  const s0 = k.sender, eo = c.eo || {}, orderCode = 'XE' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const req = { OrderCode: orderCode, ShipperCode: c.code, PayType: eo.payType || 1, ExpType: eo.expType || '1', Quantity: 1, Weight: q.weight, IsReturnPrintTemplate: '1',
    ...(eo.customerName ? { CustomerName: eo.customerName } : {}), ...(eo.customerPwd ? { CustomerPwd: eo.customerPwd } : {}), ...(eo.monthCode ? { MonthCode: eo.monthCode } : {}),
    ...(eo.sendSite ? { SendSite: eo.sendSite } : {}), ...(eo.templateSize ? { TemplateSize: eo.templateSize } : {}),
    Sender: { Company: s0.company || '', Name: s0.name, Mobile: s0.mobile || '', Tel: s0.tel || '', ProvinceName: s0.province, CityName: s0.city, ExpAreaName: s0.area, Address: s0.address, ...(s0.postCode ? { PostCode: s0.postCode } : {}) },
    Receiver: { Name: name, Mobile: mobile, ...recv }, Commodity: [{ GoodsName: goods }], Remark: str(b.remark, 60) };
  const r = await kdnCall(1007, req);
  const trackNo = r && r.Success && r.Order && normTrack(r.Order.LogisticCode);
  if (!trackNo) fail('快递鸟下单失败：' + ((r && (r.Reason || r.ResultCode)) || '没有返回快递单号'));
  // 取号成功后本地登记失败（例如单号重复）也要把面单留下，不然快递那边已占了号却打不出来
  const out = createShipments(ctx, { ...b, party: name, mobile, address, province, packages: [{ trackNo, weight: w || '' }] }, { eorder: { orderCode, at: new Date().toISOString() } });
  tx(() => { put('shipLabels', { id: out[0].id, html: String(r.PrintTemplate || ''), at: new Date().toISOString() }); audit(ctx, '电子面单下单', `${c.name} ${trackNo}`); });
  return { ...out[0], hasLabel: !!r.PrintTemplate };
}
async function eorderCancel(ctx, id) {
  const s = get('shipments', id) || fail('运单不存在', 404);
  if (!s.eorder) fail('这个运单不是电子面单下的单');
  if (s.status !== '待对账') fail(`运单状态为「${s.status}」，不能取消`);
  const c = get('carriers', s.carrierId) || fail('快递公司已删除'), eo = c.eo || {};
  const r = await kdnCall(1147, { ShipperCode: c.code, OrderCode: s.eorder.orderCode, ExpNo: s.trackNo, ...(eo.customerName ? { CustomerName: eo.customerName } : {}), ...(eo.customerPwd ? { CustomerPwd: eo.customerPwd } : {}) });
  if (!r || !r.Success) fail('快递鸟取消失败：' + ((r && (r.Reason || r.ResultCode)) || '未知原因'));
  return tx(() => {
    const x = get('shipments', id);
    Object.assign(x, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), eorder: { ...x.eorder, canceled: true } });
    put('shipments', x); audit(ctx, '取消电子面单', x.trackNo);
    return x;
  });
}
// 查一单的轨迹并保存到运单上：track = { state, stateText, traces: [{ time, station }], at }
async function trackOne(id) {
  const s = get('shipments', id) || fail('运单不存在', 404), c = get('carriers', s.carrierId) || {};
  if (!c.code) fail(`「${c.name || '该快递'}」没有填快递鸟编码，查不了轨迹`);
  const req = { ShipperCode: c.code, LogisticCode: s.trackNo, ...(s.eorder ? { OrderCode: s.eorder.orderCode } : {}),
    ...(/^SF|^ZTO$/.test(c.code) && s.mobile ? { CustomerName: String(s.mobile).replace(/\D/g, '').slice(-4) } : {}) };  // 顺丰、中通要收件人手机后四位
  const r = await kdnCall(1002, req);
  if (!r || !r.Success) fail('查询失败：' + ((r && r.Reason) || '快递鸟没有返回结果'));
  const traces = (Array.isArray(r.Traces) ? r.Traces : []).map(t => ({ time: str(t.AcceptTime, 30), station: str(t.AcceptStation, 300) })).slice(-100);
  const state = String(r.State ?? '0');
  return tx(() => {
    const x = get('shipments', id);
    x.track = { state, stateText: KDN_STATE[state] || '状态 ' + state, traces, reason: str(r.Reason, 200), at: new Date().toISOString() };
    put('shipments', x);
    return x;
  });
}
// 批量刷新：最近 30 天、还没签收的运单，每次最多 50 单（即时查询每天限 500 次）
let trackBusy = false;
async function trackAll() {
  if (trackBusy) fail('正在刷新，请稍后');
  trackBusy = true;
  const since = fmtDate(Date.now() - 30 * 864e5), res = { total: 0, done: 0, signed: 0, problem: 0, failed: 0 };
  try {
    const todo = list('shipments').filter(s => s.status !== '已作废' && s.date >= since && !(s.track && s.track.state === '3') && (get('carriers', s.carrierId) || {}).code)
      .sort((a, b) => ((a.track && a.track.at) || '').localeCompare((b.track && b.track.at) || '')).slice(0, 50);
    res.total = todo.length;
    for (const s of todo) {
      try { const x = await trackOne(s.id); res.done++; if (x.track.state === '3') res.signed++; if (x.track.state === '4') res.problem++; }
      catch (e) { res.failed++; if (/商户 ID|连不上/.test(e.message)) throw e; }
    }
    setMeta('trackLast', new Date().toISOString());
    return res;
  } finally { trackBusy = false; }
}
// 自动跟踪：开启后白天每 4 小时刷新一次
async function trackTick() {
  const k = kdnConf(), h = new Date().getHours();
  if (!k.autoTrack || !k.ebid || !k.key || !enabledModules().includes('shipping') || h < 8 || h > 21 || trackBusy) return;
  if (Date.now() - new Date(getMeta('trackLast', 0)).getTime() < 4 * 3600e3) return;
  try { const r = await trackAll(); log(`自动刷新物流轨迹：${r.done} 单，签收 ${r.signed}，问题件 ${r.problem}，失败 ${r.failed}`); }
  catch (e) { setMeta('trackLast', new Date().toISOString()); log('自动刷新物流轨迹失败：' + e.message); }
}
function saveKdn(ctx) {
  const b = ctx.body, s = getMeta('settings', {}), old = s.kdn || {}, sd = b.sender && typeof b.sender === 'object' ? b.sender : {};
  const sender = Object.fromEntries(['name', 'mobile', 'tel', 'company', 'province', 'city', 'area', 'address', 'postCode'].map(k => [k, str(sd[k], k === 'address' ? 200 : 50)]));
  s.kdn = { ebid: str(b.ebid, 40), key: str(b.key, 100) || old.key || '', sandbox: !!b.sandbox, autoTrack: !!b.autoTrack, sender };
  setMeta('settings', s); audit(ctx, '修改设置', '快递鸟接口' + (s.kdn.sandbox ? '（沙箱）' : ''));
}

/* ---------- 导入商品与期初库存 ---------- */
function importProducts(ctx) {
  const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : fail('没有可导入的数据');
  if (rows.length > 5000) fail('一次最多导入 5000 行');
  const update = ctx.body.update !== false, money = seesPrice(ctx.perms);
  return tx(() => {
    const bySku = new Map(list('products').map(p => [p.sku, p])), seen = new Set(), errors = [];
    const codeOwner = new Map(list('products').flatMap(p => codesOf(p).filter(c => c !== p.sku).map(c => [c, p.sku])));
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
      const cost = num('cost', '成本价'), price = num('price', '销售价'), stock = num('stock', '期初库存', true), safety = num('safety', '安全库存', true), weight = num('weight', '重量');
      if ([cost, price, stock, safety, weight].includes(null)) return;
      const fields = {};
      for (const k of ['name', 'spec', 'category', 'unit', 'remark']) if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') fields[k] = str(raw[k], k === 'remark' ? 500 : 200);
      const old = bySku.get(sku);
      if (raw.barcode !== undefined && raw.barcode !== null && String(raw.barcode).trim() !== '') fields.barcode = str(raw.barcode, 64);
      if (raw.units !== undefined && raw.units !== null && String(raw.units).trim() !== '') {
        try { fields.units = cleanUnits(parseUnitsText(raw.units), fields.unit || (old && old.unit) || '个'); } catch (e) { return err(e.message); }
      }
      // 条码（含辅助单位条码）不能和别的商品重复
      const mine = [fields.barcode ?? (old && old.barcode), ...(fields.units || (old && old.units) || []).map(u => u.barcode)].filter(Boolean);
      if (new Set(mine).size < mine.length) return err('条码重复：商品条码和各单位条码不能相同');
      const clash = mine.find(c => codeOwner.has(c) && codeOwner.get(c) !== sku);
      if (clash) return err(`条码 ${clash} 已被商品 ${codeOwner.get(clash)} 使用`);
      mine.forEach(c => codeOwner.set(c, sku));
      if (safety !== undefined) fields.safety = safety;
      if (weight !== undefined) fields.weight = round3(weight);
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
    salesReturns: any('sales', 'dashboard', 'reports', 'parties'), purchaseReturns: any('purchase', 'dashboard', 'reports', 'parties'),
    customers: any('sales', 'parties', 'dashboard', 'reports'), suppliers: any('purchase', 'parties'),
    finance: any('finance', 'sales', 'purchase', 'reports'), employees: P.has('hr'),
    warehouses: true, transferDocs: P.has('inv.view'), batches: any('inv.view', 'prod.view'), serials: P.has('inv.view'),
    carriers: any('ship.view', 'ship.edit', 'ship.rate'), shipments: any('ship.view', 'ship.edit'), shipBills: P.has('ship.view'), shipLabels: false
  };
  const byDate = (a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || ''));
  const data = {};
  COLS.forEach(c => { data[c] = want[c] ? list(c) : []; if (DATED.includes(c)) data[c].sort(byDate); });
  if (!seesPrice(P)) data.products = data.products.map(({ cost, price, ...p }) => p);
  data.shipBills = data.shipBills.map(({ rows, ...b }) => b);  // 账单明细可能上万行，打开账单时再单独取
  // 电子面单密码不下发，只告诉前端有没有设置
  data.carriers = data.carriers.map(c => c.eo ? { ...c, eo: { ...c.eo, customerPwd: '', pwdSet: !!c.eo.customerPwd } } : c);
  // 有审核权限的账号即使不能看他人单据，也能看到待审核的出入库单
  if (!P.has('inv.others')) for (const c of ['stockDocs', 'checkDocs', 'transferDocs']) data[c] = data[c].filter(o => o.creatorId === ctx.user.id || c === 'stockDocs' && o.status === '待审核' && P.has('inv.approve'));
  if (!P.has('inv.cost')) {
    data.stockDocs = data.stockDocs.map(o => ({ ...o, items: o.items.map(({ price, uprice, ...i }) => i) }));
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
// 推送地址带密钥，只给管理员看；快递鸟 AppKey 谁都不下发，只告诉前端设没设、能不能下电子面单
const publicSettings = ctx => {
  const { notify, kdn, ...s } = getMeta('settings', {}), k = kdn || {}, ready = !!(k.ebid && k.key);
  const pub = { ready, eorder: ready && kdnSenderOk(k), sandbox: !!k.sandbox, autoTrack: !!k.autoTrack };
  return ctx.user.role === 'admin' ? { ...s, notify, kdn: { ...pub, ebid: k.ebid || '', keySet: !!k.key, sender: k.sender || {} } } : { ...s, kdn: pub };
};
route('GET', '/api/data', ctx => ({
  version: VERSION, settings: { ...publicSettings(ctx), modules: enabledModules() },
  user: { ...publicUser(ctx.user), perms: [...ctx.perms] }, data: visibleData(ctx),
  meta: { modules: MODULES, perms: PERMS, docTypes: DOC_TYPES, defaultWh: DEFAULT_WH, provinces: PROVINCES, regions: REGIONS }
}));
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
  if (b.docApprove && typeof b.docApprove === 'object') {
    s.docApprove = { in: !!b.docApprove.in, out: !!b.docApprove.out };
    changes.push('出入库审核：入库单' + (s.docApprove.in ? '需审核' : '不审核') + '，出库单' + (s.docApprove.out ? '需审核' : '不审核'));
  }
  setMeta('settings', s); audit(ctx, '修改设置', changes.join('；'));
}, { admin: true });

route('PUT', '/api/settings/notify', ctx => {
  const b = ctx.body, s = getMeta('settings', {}), url = str(b.url, 500), time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : fail('推送时间格式应为 08:30');
  if (url) { try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch (e) { fail('推送地址必须以 http:// 或 https:// 开头'); } }
  if (b.enabled && !url) fail('请填写推送地址');
  s.notify = { enabled: !!b.enabled, url, time, skipEmpty: !!b.skipEmpty }; setMeta('settings', s);
  if (hhmm() >= time && getMeta('notifyLast', '') !== today()) setMeta('notifyLast', today());  // 今天的时间已过就从明天开始，不在保存时立刻发
  audit(ctx, '修改设置', '库存提醒推送' + (s.notify.enabled ? '：每天 ' + time : '：关闭'));
}, { admin: true });
route('POST', '/api/settings/notify/test', async ctx => {
  const url = str(ctx.body.url, 500) || (getMeta('settings', {}).notify || {}).url || fail('请填写推送地址');
  const m = notifyText();
  await sendNotify(url, '【测试】' + m.text);
  audit(ctx, '测试库存提醒推送');
  return { text: m.text };
}, { admin: true });
route('GET', '/api/settings/notify/preview', () => notifyText(), { admin: true });

// 打印模板：每种单据一份（标题、抬头、表头项目、明细列的显示 / 顺序 / 名称、签字栏、底部说明、字号），所有用户共用
const PRINT_KINDS = { in: '入库单', out: '出库单', transfer: '调拨单', sales: '销售单', purchase: '采购单', salesReturn: '销售退货单', purchaseReturn: '采购退货单' };
const PRINT_COLS = ['idx', 'sku', 'barcode', 'name', 'spec', 'unit', 'qty', 'price', 'amount', 'batch', 'note'];
const PRINT_META = ['no', 'type', 'date', 'party', 'wh', 'handler', 'contact', 'address', 'express'];
function cleanTpl(t) {
  if (!t || typeof t !== 'object') return null;
  const cols = (Array.isArray(t.cols) ? t.cols : []).filter((c, i, a) => c && PRINT_COLS.includes(c.k) && a.findIndex(x => x && x.k === c.k) === i)
    .map(c => ({ k: c.k, label: str(c.label, 10), on: !!c.on }));
  const meta = {};
  for (const k of PRINT_META) if (t.meta && k in t.meta) meta[k] = !!t.meta[k];
  const size = Math.round(Number(t.fontSize) || 12);
  return { title: str(t.title, 20), header: str(t.header, 300), footer: str(t.footer, 300), signs: str(t.signs, 100),
    fontSize: Math.min(16, Math.max(10, size)), upper: t.upper !== false, printer: t.printer !== false, cols, meta };
}
route('PUT', '/api/settings/print', ctx => {
  const kind = ctx.body.kind;
  if (!PRINT_KINDS[kind]) fail('单据类型不正确');
  const s = getMeta('settings', {}), all = { ...(s.printTpl || {}) }, t = cleanTpl(ctx.body.tpl);
  if (t) all[kind] = t; else delete all[kind];
  s.printTpl = all; setMeta('settings', s);
  audit(ctx, '修改打印模板', PRINT_KINDS[kind] + (t ? '' : ' 恢复默认'));
  return all;
}, { admin: true });

const ENTITY_PERM = { products: { POST: 'prod.edit', PUT: 'prod.edit', DELETE: 'prod.delete' }, customers: 'parties', suppliers: 'parties', employees: 'hr' };
for (const col of Object.keys(ENTITY)) {
  const perm = ctx => typeof ENTITY_PERM[col] === 'string' ? ENTITY_PERM[col] : ENTITY_PERM[col][ctx.method];
  route('POST', `/api/${col}`, ctx => saveEntity(ctx, col, null), { perm });
  route('PUT', `/api/${col}/:id`, ctx => saveEntity(ctx, col, ctx.params.id), { perm });
  route('DELETE', `/api/${col}/:id`, ctx => deleteEntity(ctx, col, ctx.params.id), { perm });
}
const orderPerm = { perm: ctx => (ORD[ctx.params.kind] || ORD.purchase).perm };
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
route('POST', '/api/stockdocs/:id/void', ctx => voidStockDoc(ctx, ctx.params.id), { perm: 'inv.view' });  // 具体权限在函数里按单据状态判断
route('POST', '/api/stockdocs/:id/approve', ctx => approveStockDoc(ctx, ctx.params.id, true), { perm: 'inv.approve' });
route('POST', '/api/stockdocs/:id/reject', ctx => approveStockDoc(ctx, ctx.params.id, false), { perm: 'inv.approve' });
route('POST', '/api/stockdocs/:id/print', ctx => markPrinted(ctx, ctx.params.id), { perm: 'inv.print' });
route('POST', '/api/transfers', ctx => saveTransfer(ctx), { perm: 'inv.transfer' });
route('POST', '/api/transfers/:id/void', ctx => voidTransfer(ctx, ctx.params.id), { perm: 'inv.void' });
route('POST', '/api/transfers/:id/print', ctx => tx(() => {
  const o = get('transferDocs', ctx.params.id) || fail('调拨单不存在', 404);
  ownDoc(ctx, o); o.printCount = (o.printCount || 0) + 1; put('transferDocs', o);
  audit(ctx, '打印调拨单', `${o.no} 第 ${o.printCount} 次`);
  return { printCount: o.printCount };
}), { perm: 'inv.print' });
route('POST', '/api/ship/quote', ctx => shipQuote(ctx), { perm: ctx => ctx.perms.has('ship.edit') ? 'ship.edit' : 'ship.view' });
route('POST', '/api/carriers', ctx => saveCarrier(ctx, null), { perm: 'ship.rate' });
route('PUT', '/api/carriers/:id', ctx => saveCarrier(ctx, ctx.params.id), { perm: 'ship.rate' });
route('DELETE', '/api/carriers/:id', ctx => deleteCarrier(ctx, ctx.params.id), { perm: 'ship.rate' });
route('POST', '/api/shipments', ctx => createShipments(ctx, ctx.body), { perm: 'ship.edit' });
route('PUT', '/api/shipments/:id', ctx => editShipment(ctx, ctx.params.id), { perm: 'ship.edit' });
route('POST', '/api/shipments/:id/void', ctx => voidShipment(ctx, ctx.params.id), { perm: 'ship.edit' });
route('POST', '/api/shipments/:id/resolve', ctx => resolveShipment(ctx, ctx.params.id), { perm: 'ship.bill' });
route('PUT', '/api/settings/kdn', ctx => saveKdn(ctx), { admin: true });
route('POST', '/api/settings/kdn/test', async () => {
  // 用一个不存在的单号查轨迹：签名或商户 ID 不对时快递鸟会直接报错，其余情况说明连通了
  const r = await kdnCall(1002, { ShipperCode: 'ZTO', LogisticCode: '0000000000' });
  if (r && r.Success === false && /签名|DataSign|EBusinessID|商户|用户|认证|授权|未开通/i.test(r.Reason || '')) fail('快递鸟拒绝了请求：' + r.Reason);
  return { ok: true, reason: (r && r.Reason) || '' };
}, { admin: true });
route('POST', '/api/ship/eorder', ctx => eorderCreate(ctx), { perm: 'ship.edit' });
route('POST', '/api/shipments/:id/cancel-eorder', ctx => eorderCancel(ctx, ctx.params.id), { perm: 'ship.edit' });
route('GET', '/api/shipments/:id/label', ctx => {
  const s = get('shipments', ctx.params.id) || fail('运单不存在', 404), l = get('shipLabels', s.id);
  if (!l || !l.html) fail('这个运单没有电子面单');
  return { html: l.html, trackNo: s.trackNo };
}, { perm: ctx => ctx.perms.has('ship.edit') ? 'ship.edit' : 'ship.view' });
route('POST', '/api/shipments/:id/track', ctx => trackOne(ctx.params.id), { perm: ctx => ctx.perms.has('ship.edit') ? 'ship.edit' : 'ship.view' });
route('POST', '/api/ship/track-all', () => trackAll(), { perm: ctx => ctx.perms.has('ship.edit') ? 'ship.edit' : 'ship.view' });
route('POST', '/api/shipbills', ctx => importBill(ctx), { perm: 'ship.bill' });
route('GET', '/api/shipbills/:id', ctx => getBill(ctx, ctx.params.id), { perm: 'ship.view' });
route('POST', '/api/shipbills/:id/confirm', ctx => confirmBill(ctx, ctx.params.id), { perm: 'ship.bill' });
route('POST', '/api/shipbills/:id/undo', ctx => undoBill(ctx, ctx.params.id), { perm: 'ship.bill' });
route('DELETE', '/api/shipbills/:id', ctx => deleteBill(ctx, ctx.params.id), { perm: 'ship.bill' });
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

/* ================= 消息推送：每天定时把库存预警发到企业微信 / 钉钉 / 飞书群机器人或任意 Webhook ================= */
function notifyText() {
  const s = getMeta('settings', {}), days = +s.expiryDays || 30, lines = [];
  const ps = list('products'), low = ps.filter(p => p.safety > 0 && p.stock < p.safety).sort((a, b) => a.stock - b.stock);
  const now = new Date(today()), left = b => Math.round((new Date(b.expDate) - now) / 864e5);
  const exp = list('batches').filter(b => b.qty > 0 && b.expDate && left(b) <= days).sort((a, b) => a.expDate.localeCompare(b.expDate));
  const pend = list('stockDocs').filter(o => o.status === '待审核');
  if (low.length) lines.push(`【库存不足】${low.length} 个商品`, ...low.slice(0, 15).map(p => `· ${p.name}：${p.stock}${p.unit || ''}（安全库存 ${p.safety}）`), ...(low.length > 15 ? [`· ……另有 ${low.length - 15} 个`] : []));
  if (exp.length) {
    const pn = id => (get('products', id) || {}).name || '已删除商品';
    lines.push(`【保质期】${exp.filter(b => left(b) < 0).length} 个批次已过期，${exp.filter(b => left(b) >= 0).length} 个批次 ${days} 天内到期`,
      ...exp.slice(0, 10).map(b => `· ${pn(b.productId)} 批次 ${b.no}：${left(b) < 0 ? '已过期' : left(b) + ' 天后到期'}（${b.expDate}，${b.qty}）`));
  }
  if (pend.length) lines.push(`【待审核】${pend.length} 张出入库单等待审核`);
  return { count: low.length + exp.length + pend.length, text: `${s.company || 'x.erp'} 库存提醒 ${today()}\n` + (lines.length ? lines.join('\n') : '今天没有需要处理的库存预警。') };
}
// 按地址判断机器人类型，拼对应的消息格式
async function sendNotify(url, text) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) fail('推送地址必须以 http:// 或 https:// 开头');
  const feishu = /feishu\.cn|larksuite\.com/.test(u.hostname);
  const body = /qyapi\.weixin\.qq\.com|dingtalk\.com/.test(u.hostname) ? { msgtype: 'text', text: { content: text } }
    : feishu ? { msg_type: 'text', content: { text } } : { title: 'x.erp 库存提醒', text, message: text };
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); }
  catch (e) { fail('推送失败：连不上推送地址（' + (e.cause && e.cause.code || e.message) + '）'); }
  const t = await r.text();
  if (!r.ok) fail(`推送失败：对方返回 HTTP ${r.status} ${t.slice(0, 200)}`);
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (j && ((j.errcode && j.errcode !== 0) || (feishu && j.code && j.code !== 0))) fail('推送失败：' + (j.errmsg || j.msg || t.slice(0, 200)));
}
let notifyBusy = false;
async function notifyTick() {
  const n = getMeta('settings', {}).notify;
  if (notifyBusy || !n || !n.enabled || !n.url || hhmm() < (n.time || '08:30') || getMeta('notifyLast', '') === today()) return;
  notifyBusy = true; setMeta('notifyLast', today());
  try {
    const m = notifyText();
    if (m.count || !n.skipEmpty) { await sendNotify(n.url, m.text); log('已推送库存提醒'); }
  } catch (e) { log('库存提醒推送失败：' + e.message); } finally { notifyBusy = false; }
}

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
    const out = await r.handler(ctx);
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
  setInterval(notifyTick, 60e3);
  setInterval(trackTick, 5 * 60e3);
});
const shutdown = () => { log('服务端停止'); try { db.close(); } catch (e) {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
