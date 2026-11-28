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
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const VERSION = '2.16.6';
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
if (arg('host')) config.host = arg('host');
config.cloud = Object.assign({
  device: crypto.randomBytes(16).toString('hex'), token: '', account: null,
  salt: '', key: '', keyCheck: '', auto: false, lastUpload: '',
  tunnelSecret: '', slug: '', remote: false,
}, config.cloud || {});
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

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
  CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS cost_layers (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, wh TEXT NOT NULL, date TEXT, qty REAL NOT NULL DEFAULT 0,
    unit REAL NOT NULL DEFAULT 0, ref TEXT, created_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_cost_layers_pw ON cost_layers (product_id, wh, date);
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
  layerAll: db.prepare("SELECT rowid, qty, unit FROM cost_layers WHERE product_id = ? AND wh = ? AND qty > 0.0000001 ORDER BY COALESCE(date, ''), rowid"),
  layerSum: db.prepare('SELECT COALESCE(SUM(qty), 0) AS q, COALESCE(SUM(qty * unit), 0) AS v FROM cost_layers WHERE product_id = ?'),
  layerIns: db.prepare('INSERT INTO cost_layers (id, product_id, wh, date, qty, unit, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  layerUpd: db.prepare('UPDATE cost_layers SET qty = ? WHERE rowid = ?'),
  layerDel: db.prepare('DELETE FROM cost_layers WHERE rowid = ?'),
  layerClear: db.prepare('DELETE FROM cost_layers WHERE product_id = ?'),
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
const round6 = n => Math.round(n * 1e6) / 1e6;
const itemsTotal = o => round2(sum(o.items, i => i.qty * i.price - (i.lineDiscount || 0)));
const orderTotal = o => round2(itemsTotal(o) - (o.discount || 0));  // 优惠（抹零、整单优惠）从合计里减掉
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (msg, status) => { throw new HttpError(msg, status); };
function audit(ctx, action, detail = '') { S.audit.run(new Date().toISOString(), ctx.user ? ctx.user.name : '-', action, String(detail).slice(0, 300), ctx.ip || ''); }

/* ================= 业务常量 ================= */
const COLS = ['products', 'customers', 'suppliers', 'employees', 'sales', 'purchases', 'salesReturns', 'purchaseReturns', 'stockLogs', 'stockDocs', 'checkDocs', 'finance', 'warehouses', 'transferDocs', 'batches', 'serials', 'carriers', 'shipments', 'shipBills', 'shipLabels', 'accounts', 'acctTransfers', 'expenses', 'advances', 'partyPayments', 'projects', 'deliveries', 'invoices', 'grainDocs', 'contracts', 'contractTpls', 'attendance', 'payrolls', 'fixedAssets', 'engJobs', 'fieldPlots', 'farmLogs'];
const DATED = ['sales', 'purchases', 'salesReturns', 'purchaseReturns', 'stockLogs', 'stockDocs', 'checkDocs', 'finance', 'transferDocs', 'shipments', 'shipBills', 'acctTransfers', 'expenses', 'advances', 'partyPayments', 'deliveries', 'invoices', 'grainDocs', 'contracts', 'attendance', 'payrolls', 'fixedAssets', 'engJobs', 'farmLogs'];
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
  products: { name: '商品', required: { name: '商品名称' },
    fields: { sku: ['s', '商品编码'], barcode: ['s', '条码'], name: ['s', '商品名称'], spec: ['s'], brand: ['s', '品牌'], category: ['s'], unit: ['s'], buyUnit: ['s', '默认采购单位'], saleUnit: ['s', '默认销售单位'], cost: ['n', '成本价'], price: ['n', '销售价'], stock: ['n', '期初库存'], safety: ['n', '安全库存'],
      batch: ['b'], serial: ['b'], dec: ['b'], shelfDays: ['n', '保质期天数'], weight: ['w', '重量'], size: ['z'], remark: ['s'],
      regNo: ['s', '注册证号 / 备案号'], regHolder: ['s', '注册人 / 备案人'], manufacturer: ['s', '生产厂家'], prodLicense: ['s', '生产许可证号'], regExp: ['s', '注册证有效期'], firstStatus: ['s', '首营状态'] } },
  customers: { name: '客户', required: { name: '客户名称' },
    fields: { name: ['s'], contact: ['s'], phone: ['s'], email: ['s'], level: ['s'], address: ['s'], remark: ['s'], ownerId: ['s', '负责业务员ID'], ownerName: ['s', '负责业务员'],
      openingBalance: ['n', '期初应收'], invoiceTitle: ['s', '开票抬头'], taxId: ['s', '纳税人识别号'], bankName: ['s', '开户银行'], bankAccount: ['s', '银行账号'], regAddress: ['s', '注册地址'], regPhone: ['s', '注册电话'],
      bizLicense: ['s', '营业执照号'], licenseNo: ['s', '经营许可证 / 备案号'], licenseExp: ['s', '许可证有效期'], firstStatus: ['s', '首营状态'] } },
  suppliers: { name: '供应商', required: { name: '供应商名称' },
    fields: { name: ['s'], contact: ['s'], phone: ['s'], email: ['s'], category: ['s'], address: ['s'], remark: ['s'],
      openingBalance: ['n', '期初应付'], bizLicense: ['s', '营业执照号'], licenseNo: ['s', '经营 / 生产许可证号'], licenseExp: ['s', '许可证有效期'], firstStatus: ['s', '首营状态'] } },
  employees: { name: '员工', required: { name: '姓名' },
    fields: { no: ['s'], name: ['s'], userId: ['s'], gender: ['s'], dept: ['s'], position: ['s'], phone: ['s'], idCard: ['s'], salary: ['n', '月薪'], dailyWage: ['n', '日薪'], tempRep: ['s', '临工代表'], joinDate: ['s'], status: ['s'] } },
  deliveries: { name: '门店配送 / 临时送货', required: { driver: '司机 / 送货人' },
    fields: { date: ['d', '日期'], mode: ['s'], status: ['s'], driver: ['s'], empId: ['s'], phone: ['s'], party: ['s'], customerId: ['s'], address: ['s'], srcType: ['s'], srcId: ['s'], srcNo: ['s'], amount: ['n', '运费'], paid: ['b'], note: ['s'] } }
};
const DOC_TYPES = { in: ['采购入库', '生产入库', '组装入库', '拆卸入库', '退货入库', '销售退货', '农产品收购', '其他入库'], out: ['领料出库', '组装出库', '销售出库', '拆卸出库', '报损出库', '采购退货', '其他出库'] };
const DOC = { in: { col: 'stockDocs', prefix: 'RK', title: '入库单' }, out: { col: 'stockDocs', prefix: 'CK', title: '出库单' } };
const TRANSFER = { col: 'transferDocs', prefix: 'DB', title: '调拨单' };
const DEFAULT_WH = 'w1';

/* ================= 模块 / 权限 ================= */
const MODULES = { inventory: '库存管理', products: '商品管理', bom: '生产 / BOM', dashboard: '工作台', sales: '销售管理', purchase: '采购管理', parties: '客户 / 供应商', finance: '财务管理', hr: '人事管理', reports: '统计报表', medical: '医疗器械（GSP）', shipping: '物流运费', agri: '农业 / 粮食收购' };
const DEMO = process.env.XERP_DEMO === '1';  // 在线演示，见 HTTP 服务部分的 DEMO_BLOCK
// 默认只开库存和商品；在线演示默认全开，方便别人看全部功能
const DEFAULT_MODULES = DEMO ? Object.keys(MODULES) : ['inventory', 'products'];
// [权限键, 名称, 所属模块]
const PERMS = [
  ['inv.view', '查看库存、出入库单与流水', 'inventory'], ['inv.in', '开入库单', 'inventory'], ['inv.out', '开出库单', 'inventory'],
  ['inv.check', '盘点录入（新建盘点单、录实盘数）', 'inventory'], ['inv.checkpost', '盘点审核（确认盘盈盘亏、调整库存）', 'inventory'], ['inv.void', '作废出入库单（冲回库存）', 'inventory'],
  ['inv.approve', '审核出入库单（开启审核后，审核通过才改库存）', 'inventory'],
['inv.print', '打印单据 / 盘点表', 'inventory'], ['tpl.edit', '修改打印模板', 'inventory'], ['inv.export', '导出数据', 'inventory'],
  ['inv.cost', '查看成本价（商品成本、库存金额、入库价与订单毛利）', 'inventory'],
  ['inv.price', '查看销售价与出库金额（不勾成本价也能按销售价开单）', 'inventory'],
  ['inv.backdate', '单据日期可选非当天（补录）', 'inventory'],
  ['inv.others', '查看 / 处理他人开的单据', 'inventory'], ['inv.transfer', '开调拨单（仓库之间移库）', 'inventory'],
  ['prod.view', '查看商品档案', 'products'], ['prod.edit', '新增 / 编辑商品', 'products'], ['prod.delete', '删除商品', 'products'],
  ['bom', '设置 BOM 物料清单、生产入库按 BOM 领料', 'bom'],
  ['dashboard', '工作台', 'dashboard'], ['sales', '销售管理（全部操作）', 'sales'], ['purchase', '采购管理（全部操作）', 'purchase'],
  ['parties', '客户 / 供应商管理', 'parties'], ['parties.all', '查看 / 管理全部客户（不勾则只看自己负责的客户）', 'parties'], ['finance', '财务管理', 'finance'],
  ['expense', '报销：提交、查看自己的报销单', 'finance'], ['exp.approve', '报销审批（查看全部报销单、批准 / 驳回）', 'finance'], ['exp.flow', '报销审批流程设置（指定各节点审核人与默认抄送人）', 'finance'], ['hr', '人事管理', 'hr'], ['reports', '统计报表', 'reports'], ['reports.all', '查看公司全量统计报表（不勾则只看本人业绩统计）', 'reports'],
  ['ship.view', '查看运单、快递账单与运费统计', 'shipping'], ['ship.edit', '登记运单（快递单号、称重）', 'shipping'],
  ['ship.rate', '维护快递公司与报价', 'shipping'], ['ship.bill', '导入快递账单、对账确认', 'shipping'],
  ['agri', '农业 / 粮食收购（登记车牌、扣水扣杂、农户结算）', 'agri']
];
const PERM_KEYS = PERMS.map(p => p[0]);
const PERM_MOD = Object.fromEntries(PERMS.map(p => [p[0], p[2]]));
const PERM_LABEL = Object.fromEntries(PERMS.map(p => [p[0], p[1]]));
const cleanPerms = a => [...new Set((Array.isArray(a) ? a : []).filter(k => PERM_KEYS.includes(k)))];

/* ---------- 角色 ---------- */
// 预置角色：首次启动写入，之后可在「角色管理」里修改、删除，也可新增自定义角色
const DEFAULT_ROLES = [
  ['r_wh_mgr', '仓库主管', '库存全部操作，含审核、作废、盘点审核、调拨、补录和查看金额', ['inv.view', 'inv.in', 'inv.out', 'inv.check', 'inv.checkpost', 'inv.void', 'inv.approve', 'inv.transfer', 'inv.print', 'inv.export', 'inv.cost', 'inv.price', 'inv.backdate', 'inv.others', 'prod.view', 'prod.edit', 'ship.view', 'ship.edit', 'ship.rate', 'ship.bill']],
  ['r_wh', '仓管员', '日常收发货：开入库单、出库单、调拨单并打印', ['inv.view', 'inv.in', 'inv.out', 'inv.transfer', 'inv.print', 'prod.view', 'ship.view', 'ship.edit']],
  ['r_in', '入库员', '只负责收货入库', ['inv.view', 'inv.in', 'inv.print', 'prod.view']],
  ['r_out', '出库员', '只负责发货 / 领料出库', ['inv.view', 'inv.out', 'inv.print', 'prod.view', 'ship.view', 'ship.edit']],
  ['r_check', '盘点员', '新建盘点单、录入实盘数（审核由主管完成）', ['inv.view', 'inv.check', 'inv.print', 'inv.others', 'prod.view']],
  ['r_prod', '商品专员', '维护商品档案（编码、规格、安全库存）', ['inv.view', 'prod.view', 'prod.edit']],
  ['r_acct', '成本会计', '查看全部单据与金额，导出对账', ['inv.view', 'inv.cost', 'inv.price', 'inv.export', 'inv.print', 'inv.others', 'prod.view', 'finance', 'reports', 'ship.view', 'ship.bill']],
  ['r_read', '只读查询', '只能查看和打印，不能改动库存', ['inv.view', 'inv.print', 'inv.export', 'inv.others', 'prod.view']],
  ['r_sales', '销售业务员', '只看自己负责的客户、开销售单与个人业绩报表', ['dashboard', 'sales', 'parties', 'prod.view', 'reports', 'expense']],
  ['r_staff', '业务员', '旧版「业务员」：全部业务功能（不含用户与数据管理）', PERM_KEYS]
];
db.exec('CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, descr TEXT, perms TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT)');
try { db.exec('ALTER TABLE users ADD COLUMN role_id TEXT'); } catch (e) {}
if (!db.prepare('SELECT COUNT(*) AS n FROM roles').get().n) {
  const ins = db.prepare('INSERT INTO roles (id, name, descr, perms, builtin, sort, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)');
  DEFAULT_ROLES.forEach(([id, name, descr, perms], i) => ins.run(id, name, descr, JSON.stringify(perms), i, new Date().toISOString()));
}
if (!getMeta('expPerms', false)) {  // v2.1.4 升级：有「财务管理」权限的角色补上报销提交 / 审批
  for (const r of db.prepare('SELECT id, perms FROM roles').all()) {
    let ps; try { ps = JSON.parse(r.perms); } catch (e) { continue; }
    if (Array.isArray(ps) && ps.includes('finance')) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...new Set([...ps, 'expense', 'exp.approve'])]), r.id);
  }
  setMeta('expPerms', true);
}
if (!getMeta('bomPerm', false)) {  // v2.1.6 升级：能编辑商品的角色补上 BOM 权限（模块默认不启用，启用后才生效）
  for (const r of db.prepare('SELECT id, perms FROM roles').all()) {
    let ps; try { ps = JSON.parse(r.perms); } catch (e) { continue; }
    if (Array.isArray(ps) && ps.includes('prod.edit') && !ps.includes('bom')) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...ps, 'bom']), r.id);
  }
  setMeta('bomPerm', true);
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
if (getMeta('permsVersion', 1) < 6) {
  for (const r of db.prepare('SELECT * FROM roles').all()) {
    if (r.id === 'r_sales') continue;
    const p = rolePerms(r), add = [];
    if (p.includes('parties') && !p.includes('parties.all')) add.push('parties.all');
    if (p.includes('reports') && !p.includes('reports.all')) add.push('reports.all');
    if ((p.includes('purchase') || p.includes('inv.in')) && !p.includes('agri')) add.push('agri');
    if (add.length) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...new Set([...p, ...add])]), r.id);
  }
  if (!db.prepare("SELECT 1 FROM roles WHERE id = 'r_sales'").get()) {
    db.prepare('INSERT OR IGNORE INTO roles (id, name, descr, perms, builtin, sort, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run('r_sales', '销售业务员', '只看自己负责的客户、开销售单与个人业绩报表', JSON.stringify(['dashboard', 'sales', 'parties', 'prod.view', 'reports', 'expense']), 8, new Date().toISOString());
  }
  setMeta('permsVersion', 6);
}
if (getMeta('permsVersion', 1) < 7) {
  for (const r of db.prepare('SELECT * FROM roles').all()) {
    const p = rolePerms(r);
    if (p.includes('inv.cost') && !p.includes('inv.price')) db.prepare('UPDATE roles SET perms = ? WHERE id = ?').run(JSON.stringify([...p, 'inv.price']), r.id);
  }
  setMeta('permsVersion', 7);
}
const rawPerms = u => { if (u.role === 'admin') return PERM_KEYS; const r = u.role_id && roleById.get(u.role_id); return r ? rolePerms(r) : []; };
function enabledModules() { const m = getMeta('settings', {}).modules; return Array.isArray(m) && m.length ? m : DEFAULT_MODULES; }
// 实际生效的权限 = 账号权限 ∩ 已启用模块
const seesCost = P => P.has('inv.cost');
const seesSalePrice = P => ['inv.price', 'inv.cost', 'sales', 'purchase', 'finance', 'reports', 'dashboard'].some(k => P.has(k));
const seesPrice = seesSalePrice;
function maskProduct(ctx, p) {
  if (!p || typeof p !== 'object') return p;
  let out = p;
  if (!seesCost(ctx.perms)) {
    const { cost, ...rest } = out;
    out = rest.bom ? { ...rest, bom: rest.bom.map(({ price, ...l }) => l) } : rest;
  }
  if (!seesSalePrice(ctx.perms)) {
    const { price, ...rest } = out;
    out = rest;
  }
  return out;
}
function maskOrder(ctx, kind, o) {
  if (!o || !Array.isArray(o.items)) return o;
  if ((kind === 'sales' || kind === 'salesReturn') && !seesCost(ctx.perms)) {
    return { ...o, items: o.items.map(({ cost, ...i }) => i) };
  }
  return o;
}
function maskStockDoc(ctx, o) {
  if (!o || !Array.isArray(o.items)) return o;
  const hideCost = !seesCost(ctx.perms), hideSale = !seesSalePrice(ctx.perms);
  if (!hideCost && !hideSale) return o;
  return {
    ...o,
    items: o.items.map(i => {
      const it = { ...i };
      if (hideCost) { delete it.price; delete it.uprice; }
      if (hideSale) { delete it.sale; delete it.usale; }
      return it;
    })
  };
}
function maskTransfer(ctx, o) {
  if (!o || !Array.isArray(o.items) || seesCost(ctx.perms)) return o;
  return { ...o, items: o.items.map(({ cost, ...i }) => i) };
}
function maskCheckDoc(ctx, o) {
  if (!o || !Array.isArray(o.lines) || seesCost(ctx.perms)) return o;
  return { ...o, lines: o.lines.map(({ cost, ...l }) => l) };
}
function maskEngJob(ctx, o) {
  if (!o || !Array.isArray(o.items) || seesCost(ctx.perms)) return o;
  return { ...o, items: o.items.map(({ cost, ...i }) => i) };
}
const maskCarrier = c => c && c.eo ? { ...c, eo: { ...c.eo, customerPwd: '', pwdSet: !!c.eo.customerPwd } } : c;
// 净化快递鸟返回的电子面单 HTML：剥离脚本、危险嵌入元素、内联事件属性与危险协议
function sanitizeLabelHtml(raw) {
  let s = String(raw || '');
  s = s.replace(/<\s*(script|iframe|object|embed|applet|base|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*(script|iframe|object|embed|applet|base|form)\b[^>]*\/?>/gi, '');
  s = s.replace(/<\s*meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src|action|formaction)\s*=\s*(["'])\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"']*\2/gi, '$1=""');
  s = s.replace(/(href|src|action|formaction)\s*=\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^\s>]*/gi, '$1=""');
  return s;
}
function sanitizePrintSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  if (out.printTpl && typeof out.printTpl === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(out.printTpl)) {
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(k) || !v || typeof v !== 'object') continue;
      const t = cleanTpl(v);
      if (t) cleaned[k] = t;
    }
    out.printTpl = cleaned;
  }
  if (out.printTplList && typeof out.printTplList === 'object') {
    const cleaned = {};
    for (const [k, arr] of Object.entries(out.printTplList)) {
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(k) || !Array.isArray(arr)) continue;
      cleaned[k] = arr.slice(0, 10).map(item => {
        if (!item || typeof item !== 'object') return null;
        const t = cleanTpl(item.tpl || item);
        return t ? { id: typeof item.id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(item.id) ? item.id : uid(), name: str(item.name, 20) || '模板', tpl: t } : null;
      }).filter(Boolean);
    }
    out.printTplList = cleaned;
  }
  if (out.printTplActive && typeof out.printTplActive === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(out.printTplActive)) {
      if (/^[a-zA-Z0-9_-]{1,32}$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9_.:-]{0,64}$/.test(v)) cleaned[k] = v;
    }
    out.printTplActive = cleaned;
  }
  return out;
}
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
function sanitizeDocRecord(col, rec) {
  const r = { ...rec };
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(r.id)) r.id = uid();
  if (typeof r.no === 'string') r.no = r.no.replace(/[<>"'&]/g, '').slice(0, 64);
  if (typeof r.date === 'string' && r.date && !isDate(r.date)) r.date = '';
  if (col === 'shipLabels' && typeof r.html === 'string') r.html = sanitizeLabelHtml(r.html);
  return r;
}
function writeAll(data) {
  db.exec('DELETE FROM docs');
  for (const col of COLS) {
    const arr = Array.isArray(data[col]) ? data[col] : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const r = arr[i];
      if (!r || typeof r !== 'object') continue;
      put(col, sanitizeDocRecord(col, r));
    }
  }
  ensureWh();
  ensureAccounts();
  ensureOrderFulfillment();
  // 商品图片：备份里有就恢复，没有（演示数据、清空、旧版备份）就清掉
  db.exec('DELETE FROM images');
  const ins = db.prepare('INSERT OR REPLACE INTO images (id, mime, data, updated_at) VALUES (?, ?, ?, ?)');
  for (const i of Array.isArray(data.images) ? data.images : []) {
    if (!i || typeof i.id !== 'string' || !IMG_TYPES.includes(i.mime) || typeof i.data !== 'string') continue;
    const buf = Buffer.from(i.data, 'base64');
    if (buf.length && buf.length <= IMG_MAX && imgMime(buf) === i.mime) ins.run(i.id, i.mime, buf, new Date().toISOString());
  }
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
/* ---------- 资金账户：{ id, name, kind(方式), no, opening(期初余额), remark, off }；余额 = 期初 + 收入 - 支出 + 转入 - 转出 ---------- */
const ACCT_NAME = { 银行转账: '银行账户' };
function ensureAccounts() {
  const accts = list('accounts');
  const add = kind => { const a = { id: 'a' + uid(), name: ACCT_NAME[kind] || kind, kind, no: '', opening: 0, remark: '', createdAt: today() }; put('accounts', a); accts.push(a); return a; };
  if (!accts.length) ['银行转账', '现金', '微信', '支付宝'].forEach(add);
  for (const f of list('finance')) {
    if (f.account && accts.some(a => a.id === f.account)) continue;
    const kind = METHODS.includes(f.method) ? f.method : '银行转账';
    f.account = (accts.find(a => a.kind === kind) || add(kind)).id; f.method = kind;
    put('finance', f);
  }
}
// 收付款选账户：指定了账户就用它（停用的不行，除非是修改时原来的账户）；没指定按方式找第一个同类账户
function pickAccount(b, keep) {
  const accts = list('accounts'), id = str(b.account, 64);
  let a = id ? accts.find(x => x.id === id) || fail('资金账户不存在') : null;
  if (a && a.off && a.id !== keep) fail(`账户「${a.name}」已停用`);
  if (!a) a = accts.find(x => !x.off && x.kind === b.method) || accts.find(x => !x.off) || fail('请先在财务管理里添加资金账户');
  return a;
}
const acctBalance = id => {
  const a = get('accounts', id); if (!a) return 0;
  return round2((a.opening || 0) + sum(list('finance').filter(f => f.account === id && !f.nonCash && f.category !== '固定资产折旧'), f => f.type === 'income' ? f.amount : -f.amount)
    + sum(list('acctTransfers').filter(t => t.to === id), t => t.amount) - sum(list('acctTransfers').filter(t => t.from === id), t => t.amount));
};
function saveAccount(ctx, id) {
  const b = ctx.body, name = str(b.name, 30) || fail('请填写账户名称');
  const kind = METHODS.includes(b.kind) ? b.kind : fail('账户类型不正确');
  const opening = round2(Number(b.opening) || 0);
  return tx(() => {
    const all = list('accounts');
    if (all.some(a => a.name === name && a.id !== id)) fail('账户名称已存在');
    let a;
    if (id) {
      a = get('accounts', id) || fail('账户不存在', 404);
      if (b.off && !a.off && !all.some(x => x.id !== id && !x.off)) fail('至少要留一个启用的账户');
      Object.assign(a, { name, kind, no: str(b.no, 40), opening, remark: str(b.remark, 200), off: !!b.off });
    } else a = { id: 'a' + uid(), name, kind, no: str(b.no, 40), opening, remark: str(b.remark, 200), off: false, createdAt: today() };
    put('accounts', a); audit(ctx, (id ? '修改' : '新增') + '资金账户', name);
    return a;
  });
}
function deleteAccount(ctx, id) {
  return tx(() => {
    const a = get('accounts', id) || fail('账户不存在', 404);
    if (list('finance').some(f => f.account === id) || list('acctTransfers').some(t => t.from === id || t.to === id)) fail('该账户已有收支或转账记录，不能删除，可以停用');
    if (!list('accounts').some(x => x.id !== id && !x.off)) fail('至少要留一个启用的账户');
    del('accounts', id); audit(ctx, '删除资金账户', a.name);
  });
}
// 账户互转（取现、存现、提现到银行卡）：不算收入支出，只影响两个账户的余额
function addTransfer(ctx) {
  const b = ctx.body, amount = round2(Number(b.amount));
  if (!(amount > 0)) fail('金额必须大于 0');
  if (!isDate(b.date)) fail('日期格式不正确');
  return tx(() => {
    const from = pickAccount({ account: b.from || '-' }), to = pickAccount({ account: b.to || '-' });
    if (from.id === to.id) fail('转出和转入账户不能相同');
    const t = { id: uid(), date: b.date, from: from.id, to: to.id, amount, note: str(b.note), operator: ctx.user.name };
    put('acctTransfers', t); audit(ctx, '账户转账', `${from.name} → ${to.name} ${amount}`);
    return t;
  });
}
function deleteTransfer(ctx, id) {
  return tx(() => {
    const t = get('acctTransfers', id) || fail('记录不存在', 404);
    del('acctTransfers', id); audit(ctx, '删除转账', `${t.amount}`);
  });
}
/* ---------- 商品图片：前端压缩后以 data URL 上传，校验文件头，商品上记一个版本号 p.img 供前端判断有没有图、刷新缓存 ---------- */
const IMG_MAX = 800 * 1024, IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
function imgMime(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}
function saveProductImage(ctx, id) {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(ctx.body.data || '')) || fail('图片格式不正确');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > IMG_MAX) fail('图片太大（最大 800 KB），请换一张或压缩后再传');
  const mime = imgMime(buf) || fail('只支持 JPG、PNG、WebP 图片');
  return tx(() => {
    const p = get('products', id) || fail('商品不存在', 404);
    db.prepare('INSERT OR REPLACE INTO images (id, mime, data, updated_at) VALUES (?, ?, ?, ?)').run(id, mime, buf, new Date().toISOString());
    p.img = Date.now().toString(36); put('products', p); audit(ctx, '上传商品图片', p.name);
    return { img: p.img };
  });
}
function deleteProductImage(ctx, id) {
  return tx(() => {
    const p = get('products', id) || fail('商品不存在', 404);
    db.prepare('DELETE FROM images WHERE id = ?').run(id);
    delete p.img; put('products', p); audit(ctx, '删除商品图片', p.name);
  });
}
const RAW = Symbol('raw');  // 路由返回 { [RAW]: { type, body } } 时直接输出二进制
function getProductImage(ctx, id) {
  if (!['inv.view', 'prod.view', 'sales', 'purchase', 'dashboard', 'reports'].some(k => ctx.perms.has(k))) fail('没有权限查看商品', 403);
  if (String(id).startsWith('bx_')) fail('这个商品没有图片', 404);
  const r = db.prepare('SELECT mime, data FROM images WHERE id = ?').get(id) || fail('这个商品没有图片', 404);
  return { [RAW]: { type: r.mime, body: Buffer.from(r.data) } };
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
function takeBatches(p, wh, qty, alloc, kind, prefer) {
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
  // 手动指定批次：先从这个批次扣，不够的再按先到期先出补
  if (prefer && prefer.id && left > 0) {
    const b = get('batches', prefer.id);
    if (b && b.productId === p.id && b.wh === wh && b.qty > 0) {
      const n = round4(Math.min(left, b.qty));
      b.qty = round4(b.qty - n); left = round4(left - n);
      b.qty > 0.0000001 ? put('batches', b) : del('batches', b.id);
      out.push({ id: b.id, no: b.no, prodDate: b.prodDate || '', expDate: b.expDate || '', qty: n });
    }
  }
  for (const b of fefoOrder(batchesOf(p.id, wh), kind)) {
    if (!left) break;
    const n = Math.min(left, b.qty);
    b.qty -= n; left -= n;
    b.qty ? put('batches', b) : del('batches', b.id);
    out.push({ id: b.id, no: b.no, prodDate: b.prodDate || '', expDate: b.expDate || '', qty: n });
  }
  if (left) out.push({ id: '', no: '（无批次）', expDate: '', qty: left });  // 批次账与库存不一致时不阻断出库
  const merged = [];
  for (const a of out) {
    const hit = a.id && merged.find(x => x.id === a.id);
    if (hit) hit.qty = round4(hit.qty + a.qty); else merged.push({ ...a });
  }
  return merged;
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
const fifoOn = () => (getMeta('settings', {}).costMethod || 'avg') === 'fifo';
/* ---------- 先进先出（FIFO）成本层：每个商品、每个仓库各自一队入库成本，出库从最早一层开始结转 ---------- */
function addCostLayer(p, wh, qty, unit, ref = '', date = '') {
  if (!(qty > 0)) return;
  S.layerIns.run(uid(), p.id, wh || DEFAULT_WH, date || today(), round4(qty), round4(unit), str(ref, 60), new Date().toISOString());
}
function takeCostLayers(p, wh, qty, matchUnit) {
  const rows = S.layerAll.all(p.id, wh || DEFAULT_WH).map(r => ({ ...r, left: r.qty }));
  let remain = qty, total = 0;
  const take = r => {
    if (remain <= 1e-9 || r.left <= 1e-9) return;
    const n = Math.min(remain, r.left);
    total += n * r.unit;
    remain = round4(remain - n);
    r.left = round4(r.left - n);
  };
  if (matchUnit != null && Number.isFinite(+matchUnit)) rows.filter(r => Math.abs(r.unit - +matchUnit) < 1e-6).forEach(take);
  rows.forEach(take);
  rows.forEach(r => {
    if (r.left === r.qty) return;
    if (r.left <= 1e-9) S.layerDel.run(r.rowid); else S.layerUpd.run(r.left, r.rowid);
  });
  if (remain > 1e-9) total += remain * (p.cost || 0);  // 旧数据没有成本层时按当前成本兜底
  return { total: round4(total) };
}
function refreshFifoCost(p, fallback) {
  const stock = p.stock || 0;
  if (stock <= 0) { p.cost = round4(fallback != null ? fallback : p.cost || 0); return; }
  const { q, v } = S.layerSum.get(p.id);
  const missing = Math.max(0, stock - q);
  p.cost = round4((v + missing * (fallback != null ? fallback : p.cost || 0)) / stock);
}
function rebuildCostLayers(p) {
  S.layerClear.run(p.id);
  const byWh = {};
  for (const [w, q] of Object.entries(p.wh || {})) if (q > 0) byWh[w] = (byWh[w] || 0) + q;
  const covered = sum(Object.values(byWh), x => x);
  if ((p.stock || 0) > covered) byWh[DEFAULT_WH] = (byWh[DEFAULT_WH] || 0) + (p.stock - covered);
  for (const [w, q] of Object.entries(byWh)) addCostLayer(p, w, q, p.cost || 0, 'FIFO 启用');
}
function rebuildAllCostLayers() { list('products').forEach(rebuildCostLayers); }
/**
 * 所有库存变动的唯一入口，按设置的成本口径核算：
 * - 移动加权平均（默认）：入库带单价 price 时重算加权成本；出库按当前成本计价；冲回入库传 reversePrice 按原价减掉
 * - 先进先出 FIFO：入库记一层成本，出库从最早一层开始结转；reversePrice 优先冲减相同单价的成本层
 * 流水上记录本次计价单价 cost 与变动后的单位成本 costAfter，收发存报表据此计算金额
 * 成本按商品整体核算（不分仓库）；数量同时记到仓库 wh 上；FIFO 成本层按仓库分别记录
 * 启用批次的商品：入库按 batch（{ no, prodDate, expDate }）或 alloc（批次列表，冲回 / 调拨用）入批次；出库按 alloc 冲回指定批次，否则先到期先出
 * 返回 { unit: 计价单价, alloc: 本次涉及的批次 }
 */
function moveStock(ctx, p, qty, kind, ref = '', note = '', { price, reversePrice, date, wh = DEFAULT_WH, batch, alloc, serials, undo, preferBatch, voided } = {}) {
  const before = p.stock || 0, cost0 = p.cost || 0, after = before + qty;
  if (!p.wh) p.wh = { [DEFAULT_WH]: before };
  if (qty < 0 && whQty(p, wh) + qty < 0) fail(`「${p.name}」在${whName(wh)}库存不足（需 ${-qty}，现有 ${whQty(p, wh)}）`);
  if (p.serial && qty) moveSerials(p, qty, wh, { serials, undo, ref, kind, date, party: note });
  const fifo = fifoOn();
  let unit = cost0;
  if (qty > 0) {
    const priced = price != null && Number.isFinite(+price);
    if (priced) unit = +price;
    if (fifo) addCostLayer(p, wh, qty, unit, ref, date);
    if (priced) p.cost = before <= 0 || after <= 0 ? round4(unit) : round4((before * cost0 + qty * unit) / after);
  } else if (qty < 0) {
    if (fifo) {
      const t = takeCostLayers(p, wh, -qty, reversePrice);
      unit = round4(t.total / -qty);
    } else if (reversePrice != null) {
      unit = +reversePrice;
      if (after > 0) p.cost = Math.max(0, round4((before * cost0 + qty * unit) / after));
    }
  }
  p.stock = after;
  p.wh[wh] = whQty(p, wh) + qty;
  if (fifo && qty) refreshFifoCost(p, unit);
  let used;
  if (p.batch && qty) {
    if (qty > 0) used = alloc ? alloc.map(a => addBatch(p, wh, a.qty, a, ref, date)) : [addBatch(p, wh, qty, batch, ref, date)];
    else used = takeBatches(p, wh, -qty, alloc, kind, preferBatch);
  }
  put('products', p);
  addLog(ctx, p.id, kind, qty, ref, note, date, { cost: round4(unit), costAfter: p.cost, wh, ...(used ? { batches: used.map(({ no, expDate, qty }) => ({ no, expDate, qty })) } : {}), ...(p.serial && serials ? { serials } : {}), ...(voided ? { voided: true } : {}) });
  return { unit, alloc: used };
}
function nextNo(C) {
  const k = C.prefix + today().replace(/-/g, ''), counters = getMeta('counters', {});
  let n = counters[k] || 0, no;
  do { n++; no = k + String(n).padStart(3, '0'); } while (S.noExists.get(C.col, no));
  counters[k] = n; setMeta('counters', counters);
  return no;
}
function autoSku() {
  const prefix = 'P' + today().replace(/-/g, '') + '-';
  const used = new Set(list('products').map(p => p.sku));
  let n = 1;
  while (used.has(prefix + String(n).padStart(3, '0'))) n++;
  return prefix + String(n).padStart(3, '0');
}
function clean(col, body) {
  const v = {};
  for (const [k, [t, label]] of Object.entries(ENTITY[col].fields)) {
    if (!(k in body)) continue;
    if (t === 'n') { const n = Number(body[k]); if (!Number.isFinite(n) || n < 0) fail((label || k) + '必须是非负数字'); v[k] = round2(n); }
    else if (t === 'b') v[k] = body[k] === true || body[k] === 1 || body[k] === '1';
    else if (t === 'd') { const s = str(body[k], 20); if (s && !isDate(s)) fail((label || k) + '格式不正确'); v[k] = s; }
    else if (t === 'w') { const n = Number(body[k] || 0); if (!Number.isFinite(n) || n < 0 || n > 100000) fail((label || k) + '必须是 0 ~ 100000 的数字（kg）'); v[k] = round3(n); }
    else if (t === 'z') { const s = str(body[k], 40), d = parseSize(s); if (s && !d) fail('包装尺寸格式应为 长×宽×高（厘米），例如 30×20×15'); v[k] = d ? d.join('×') : ''; }
    else v[k] = str(body[k], 500);
  }
  return v;
}
const allParties = ctx => ctx.user.role === 'admin' || ctx.perms.has('parties.all');
function canSeeCustomer(c, ctx) {
  if (!c || allParties(ctx)) return true;
  return c.ownerId === ctx.user.id || (!c.ownerId && c.creatorId === ctx.user.id) || (!c.ownerId && !c.creatorId && c.ownerName === ctx.user.name);
}
function isOwnOrder(o, ctx) {
  if (!o) return false;
  return o.creatorId === ctx.user.id || (!o.creatorId && (o.creator === ctx.user.name || o.handler === ctx.user.name));
}
function userDept(u) {
  if (!u) return '';
  const emps = list('employees');
  const e = emps.find(x => x.userId === u.id)
    || emps.find(x => x.username && x.username === u.username)
    || emps.find(x => x.status !== '离职' && x.name === u.name)
    || emps.find(x => x.name === u.name);
  return (e && e.dept) || '';
}
function resolvePersonUser(userId, nameOrUser) {
  const active = db.prepare('SELECT id, username, name FROM users WHERE disabled = 0').all();
  if (userId) {
    const u = active.find(x => x.id === userId || x.username === userId);
    if (u) return u;
  }
  const q = String(nameOrUser || '').trim();
  if (!q) return null;
  const emp = list('employees').find(e => e.userId && (e.name === q || e.username === q));
  if (emp) {
    const u = active.find(x => x.id === emp.userId);
    if (u) return u;
  }
  return active.find(x => x.username === q) || active.find(x => x.name === q) || null;
}
function saveEntity(ctx, col, id) {
  const E = ENTITY[col] || fail('接口不存在', 404), v = clean(col, ctx.body);
  if (col === 'products') {
    if (!seesCost(ctx.perms)) delete v.cost;
    if (!seesSalePrice(ctx.perms)) delete v.price;
  }
  return tx(() => {
    const rec = id ? (get(col, id) || fail(E.name + '不存在', 404)) : null;
    if (col === 'customers') {
      if (rec && !canSeeCustomer(rec, ctx)) fail('只能查看和修改自己负责的客户', 403);
      if (allParties(ctx)) {
        if ('ownerId' in v) {
          const u = v.ownerId ? S.userById.get(v.ownerId) : null;
          v.ownerName = u ? u.name : str(v.ownerName, 32);
        }
      } else {
        delete v.ownerId; delete v.ownerName;
      }
    }
    const r = { ...(rec || {}), ...v };
    if (col === 'employees') {
      if ('userId' in ctx.body) {
        const wantUid = str(ctx.body.userId, 64);
        if (wantUid) {
          const u = db.prepare('SELECT id, username, name FROM users WHERE id = ? AND disabled = 0').get(wantUid) || fail('所选登录账号不存在或已停用');
          if (list('employees').some(e => e.id !== id && e.userId === u.id)) fail('该登录账号已关联其他员工');
          r.userId = u.id; r.username = u.username; r.name = u.name;
        } else {
          delete r.userId; delete r.username;
        }
      } else if (r.userId) {
        const u = db.prepare('SELECT id, username, name FROM users WHERE id = ? AND disabled = 0').get(r.userId);
        if (u) { r.username = u.username; r.name = u.name; }
      }
    }
    if (col === 'customers' && !rec) {
      r.creatorId = ctx.user.id;
      r.creator = ctx.user.name;
      if (!allParties(ctx)) { r.ownerId = ctx.user.id; r.ownerName = ctx.user.name; }
      else if (r.ownerId && !r.ownerName) { const u = S.userById.get(r.ownerId); if (u) r.ownerName = u.name; }
    }
    for (const [k, l] of Object.entries(E.required)) if (!r[k]) fail('请填写' + l);
    if (r.licenseExp && !isDate(r.licenseExp)) fail('许可证有效期格式应为 YYYY-MM-DD');
    if (col === 'products') {
      if (!r.sku) {
        if (rec) fail('商品编码不能为空');
        r.sku = autoSku();
      }
      const others = list('products').filter(p => p.id !== id);
      if (others.some(p => p.sku === r.sku)) fail('商品编码已存在');
      if (rec && r.unit && r.unit !== rec.unit && productBaseUnitUsed(rec)) fail('基本单位已经使用过，不能修改；如需调整请新建商品');
      r.units = cleanUnits('units' in ctx.body ? ctx.body.units : (rec && rec.units) || [], r.unit || '个');
      const unitNames = new Set([r.unit || '个', ...r.units.map(u => u.name)]);
      for (const [k, label] of [['buyUnit', '默认采购单位'], ['saleUnit', '默认销售单位']]) {
        if (r[k] && !unitNames.has(r[k])) fail(`${label}「${r[k]}」不在该商品的单位设置里`);
      }
      const mine = [r.barcode, ...r.units.map(u => u.barcode)].filter(Boolean), used = new Set(others.flatMap(codesOf));
      if (new Set(mine).size < mine.length) fail('条码重复：商品条码和各单位条码不能相同');
      if (mine.some(c => used.has(c))) fail('条码已被其他商品使用');
      r.stock = rec ? rec.stock : Math.round(r.stock || 0);
      r.wh = rec ? rec.wh : undefined;
      r.safety = Math.round(r.safety || 0);
      r.shelfDays = Math.round(r.shelfDays || 0);
      if (r.regExp && !isDate(r.regExp)) fail('注册证有效期格式应为 YYYY-MM-DD');
      if (rec && rec.stock !== 0) r.cost = rec.cost;  // 有库存时成本由成本口径自动计算
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
    if (col === 'employees' && r.idCard && !/^\d{15}$|^\d{17}[\dX]$/i.test(String(r.idCard).trim())) fail('身份证号格式不正确，应为 15 位或 18 位');
    if (col === 'employees' && r.idCard) r.idCard = String(r.idCard).trim().toUpperCase();
    if (!rec) { r.id = uid(); r.createdAt = today(); }
    if (col === 'employees' && ctx.body.account && ctx.body.account.create) {
      if (ctx.user.role !== 'admin') fail('只有管理员可以在人事管理中联动创建登录账号', 403);
      if (DEMO) fail('在线演示环境不能创建登录账号', 403);
      if (r.userId) fail('该员工已经关联了系统登录账号');
      const ac = ctx.body.account;
      let roleId = str(ac.roleId, 64);
      if (roleId === '__new__' || (ac.newRole && typeof ac.newRole === 'object' && !roleId)) {
        const nr = ac.newRole || {};
        const rName = str(nr.name, 20) || fail('请填写新角色名称');
        if (rName === '管理员') fail('「管理员」是系统保留名称');
        if (db.prepare('SELECT id FROM roles WHERE name = ?').get(rName)) fail('角色名称已存在');
        const perms = cleanPerms(nr.perms);
        if (!perms.length) fail('请至少为新角色勾选一项权限');
        roleId = 'r' + uid();
        db.prepare('INSERT INTO roles (id, name, descr, perms, sort, created_at) VALUES (?, ?, ?, ?, 50, ?)')
          .run(roleId, rName, str(nr.descr, 100), JSON.stringify(perms), new Date().toISOString());
      }
      const userId = createUser({ username: ac.username, name: r.name, roleId, password: ac.password });
      r.userId = userId;
      r.username = str(ac.username, 32);
      audit(ctx, '员工联动开号', `${r.name}（${r.username}）`);
    }
    const init = !rec && col === 'products' ? r.stock : 0;
    if (!rec && col === 'products') { r.stock = 0; r.wh = { [DEFAULT_WH]: 0 }; }
    put(col, r);
    if (init > 0) moveStock(ctx, r, init, '期初库存', '', '新建商品', { price: r.cost || 0, wh: pickWh(ctx.body.wh), batch: { no: '期初' } });
    audit(ctx, (rec ? '修改' : '新增') + E.name, r.name);
    return col === 'products' ? maskProduct(ctx, r) : r;
  });
}
function deleteEntity(ctx, col, id) {
  const E = ENTITY[col] || fail('接口不存在', 404);
  return tx(() => {
    const rec = get(col, id) || fail(E.name + '不存在', 404);
    if (col === 'customers' && !canSeeCustomer(rec, ctx)) fail('只能删除自己负责的客户', 403);
    const refs = [];
    if (col === 'products') {
      const add = (label, arr) => arr.forEach(o => refs.push(`${label} ${o.no || o.id}`));
      add('销售单', list('sales').filter(o => (o.items || []).some(i => i.productId === id)));
      add('采购单', list('purchases').filter(o => (o.items || []).some(i => i.productId === id)));
      add('销售退货单', list('salesReturns').filter(o => (o.items || []).some(i => i.productId === id)));
      add('采购退货单', list('purchaseReturns').filter(o => (o.items || []).some(i => i.productId === id)));
      add('出入库单', list('stockDocs').filter(o => (o.items || []).some(i => i.productId === id)));
      add('盘点单', list('checkDocs').filter(o => (o.lines || []).some(l => l.productId === id)));
      add('调拨单', list('transferDocs').filter(o => (o.items || []).some(i => i.productId === id)));
      add('粮食收购单', list('grainDocs').filter(o => o.productId === id));
    } else if (col === 'customers') {
      list('sales').filter(o => o.customerId === id).forEach(o => refs.push(`销售单 ${o.no || o.id}`));
      list('salesReturns').filter(o => o.customerId === id).forEach(o => refs.push(`销售退货单 ${o.no || o.id}`));
    } else if (col === 'suppliers') {
      list('purchases').filter(o => o.supplierId === id).forEach(o => refs.push(`采购单 ${o.no || o.id}`));
      list('purchaseReturns').filter(o => o.supplierId === id).forEach(o => refs.push(`采购退货单 ${o.no || o.id}`));
    }
    if (refs.length) {
      const preview = refs.slice(0, 5).join('、') + (refs.length > 5 ? ` 等共 ${refs.length} 张单据` : '');
      fail(`该${E.name}已被单据引用，无法删除：${preview}`);
    }
    let delUserName = '';
    if (col === 'employees' && ctx.query && ctx.query.get('delUser') === '1' && rec.userId) {
      if (ctx.user.role !== 'admin') fail('只有管理员可以同步删除关联登录账号', 403);
      if (rec.userId === ctx.user.id) fail('不能删除当前正在登录的账号');
      const u = S.userById.get(rec.userId);
      if (u) {
        if (u.role === 'admin' && S.adminCount.get().n <= 1) fail('系统至少需要保留一个管理员，无法同步删除关联账号');
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
        delUserName = u.username;
      }
    }
    del(col, id);
    if (col === 'products') setBatchMode(rec, false);
    audit(ctx, '删除' + E.name, rec.name + (delUserName ? `（同步删除账号 ${delUserName}）` : ''));
  });
}
/* ---------- 订单分批执行：发货 / 入库统一生成关联出入库单，订单只记录已执行数量 ---------- */
function linkedOrderDocs(o, kind, pending = false, excludeDocId = null) {
  const dir = kind === 'sales' ? 'out' : 'in';
  return list('stockDocs').filter(d => d.id !== excludeDocId && d.srcOrderId === o.id && d.dir === dir && (d.status === '正常' || pending && d.status === '待审核'));
}
function orderFulfilledByProduct(o, kind, pending = false, excludeDocId = null) {
  const out = {};
  for (const d of linkedOrderDocs(o, kind, pending, excludeDocId)) for (const i of d.items || []) {
    if (!(i.productId in out)) out[i.productId] = { qty: 0, value: 0, serials: [], batches: [] };
    out[i.productId].qty += +i.qty || 0;
    const unitCost = Number.isFinite(+i.cost) ? +i.cost : (+i.price || 0);
    out[i.productId].value += (+i.qty || 0) * unitCost;
    if (i.serials) out[i.productId].serials.push(...i.serials);
    if (i.batches) out[i.productId].batches.push(...i.batches);
  }
  return out;
}
function orderRemainingByProduct(o, kind, pending = true) {
  if (!o) return {};
  if (kind === 'sales' && ['已发货', '已完成'].includes(o.status) || kind === 'purchase' && o.status === '已入库') return {};
  const had = {};
  o.items.forEach(i => { had[i.productId] = round4((had[i.productId] || 0) + i.qty); });
  const done = orderFulfilledByProduct(o, kind, pending), out = {};
  for (const [pid, qty] of Object.entries(had)) out[pid] = round4(Math.max(0, qty - ((done[pid] || {}).qty || 0)));
  return out;
}
function orderLineRemaining(o, kind) {
  const left = orderRemainingByProduct(o, kind, true);
  return o.items.map(i => { const q = round4(Math.min(i.qty, left[i.productId] || 0)); left[i.productId] = round4((left[i.productId] || 0) - q); return q; });
}
function orderTolerancePct(b) {
  const sPct = getMeta('settings', {}).overTolerancePct;
  if (sPct != null && Number.isFinite(Number(sPct))) return Math.max(0, Math.min(100, Number(sPct)));
  return 0;
}
function syncOrderFulfillment(o, kind) {
  const C = ORD[kind];
  if (!o || !C || o.status === '已作废') return;
  const done = orderFulfilledByProduct(o, kind, false);
  const withPend = orderFulfilledByProduct(o, kind, true);
  const doneLeft = {}, pendLeft = {};
  for (const [pid, d] of Object.entries(done)) doneLeft[pid] = d.qty || 0;
  for (const [pid, wp] of Object.entries(withPend)) pendLeft[pid] = round4(Math.max(0, (wp.qty || 0) - (done[pid]?.qty || 0)));
  const totalDone = Object.values(done).reduce((s, d) => s + (d.qty || 0), 0);
  let all = true, changed = false;
  o.items.forEach((i, idx) => {
    const pid = i.productId, d = done[pid] || {};
    const hasMore = o.items.slice(idx + 1).some(nx => nx.productId === pid);
    const leftD = doneLeft[pid] || 0;
    const take = hasMore ? round4(Math.min(i.qty, leftD)) : round4(leftD);
    doneLeft[pid] = round4(Math.max(0, leftD - take));
    const remLine = round4(Math.max(0, i.qty - take));
    const leftP = pendLeft[pid] || 0;
    const ptake = hasMore ? round4(Math.min(remLine, leftP)) : round4(leftP);
    pendLeft[pid] = round4(Math.max(0, leftP - ptake));
    if (i.fulfilledQty !== take) { i.fulfilledQty = take; changed = true; }
    if (ptake > 0.0001) { if (i.pendingQty !== ptake) { i.pendingQty = ptake; changed = true; } }
    else if ('pendingQty' in i) { delete i.pendingQty; changed = true; }
    if (take > 0 && d.qty > 0) { const c = round4(d.value / d.qty); if (i.cost !== c) { i.cost = c; changed = true; } }
    if (take > 0 && d.serials && d.serials.length) { const sn = [...new Set(d.serials)]; if (JSON.stringify(i.serials || []) !== JSON.stringify(sn)) { i.serials = sn; changed = true; } }
    if (take > 0 && d.batches && d.batches.length) { if (JSON.stringify(i.batches || []) !== JSON.stringify(d.batches)) { i.batches = d.batches; changed = true; } }
    if (take + 0.0001 < i.qty) all = false;
  });
  if (o.earlyClosed) {
    if (totalDone > 0.0001) all = true;
    else { delete o.earlyClosed; delete o.earlyClosedAt; delete o.earlyClosedBy; delete o.earlyCloseNote; changed = true; }
  }
  if (kind === 'sales') {
    if (all && o.status === '待发货') { o.status = '已发货'; changed = true; }
    else if (!all && o.status === '已发货') { o.status = '待发货'; changed = true; }
  } else {
    if (all && o.status === '已审核') { o.status = '已入库'; changed = true; }
    else if (!all && o.status === '已入库') { o.status = '已审核'; changed = true; }
  }
  if (changed) put(C.col, o);
}
function syncSourceOrder(ctx, doc) {
  if (!doc || !doc.srcOrderId) return;
  const kind = doc.srcOrderKind || (doc.dir === 'out' ? 'sales' : 'purchase');
  if (kind !== 'sales' && kind !== 'purchase') return;
  const C = ORD[kind], o = C && get(C.col, doc.srcOrderId);
  if (o) syncOrderFulfillment(o, kind);
}
function ensureOrderFulfillment() {
  const seen = new Set();
  for (const d of list('stockDocs')) {
    if (!d.srcOrderId) continue;
    const kind = d.srcOrderKind || (d.dir === 'out' ? 'sales' : 'purchase');
    if (kind !== 'sales' && kind !== 'purchase') continue;
    const key = kind + '|' + d.srcOrderId;
    if (seen.has(key)) continue;
    seen.add(key);
    const C = ORD[kind], o = C && get(C.col, d.srcOrderId);
    if (o) syncOrderFulfillment(o, kind);
  }
}
function validateSourceItems(o, kind, items, allowOver = false, excludeDocId = null) {
  const ordered = {};
  (o.items || []).forEach(i => { ordered[i.productId] = round4((ordered[i.productId] || 0) + (+i.qty || 0)); });
  const used = orderFulfilledByProduct(o, kind, true, excludeDocId);
  const pct = orderTolerancePct({ allowOver });
  const need = {};
  items.forEach(i => { need[i.productId] = round4((need[i.productId] || 0) + (+i.qty || 0)); });
  for (const [pid, q] of Object.entries(need)) {
    const p = get('products', pid), ord = ordered[pid] || 0, did = (used[pid] && used[pid].qty) || 0;
    const maxTotal = pct > 0 ? round4(ord * (1 + pct / 100)) : ord;
    if (did + q > maxTotal + 0.0001) {
      if (pct > 0) fail(`「${p ? p.name : pid}」累计数量 ${round4(did + q)} 超过订单容差上限 ${maxTotal}（允许超${kind === 'sales' ? '发' : '收'} ${pct}%），请先修改订单`);
      fail(`「${p ? p.name : pid}」本次数量 ${round4(q)} 超过订单未执行数量 ${round4(Math.max(0, ord - did))}`);
    }
  }
}
function orderLineEffectiveBasePrice(o, line) {
  if (!line) return 0;
  const qty = +line.qty || 0;
  if (!(qty > 0)) return +line.price || 0;
  const lineGross = qty * (+line.price || 0) - (+line.lineDiscount || 0);
  const grossTotal = itemsTotal(o);
  const disc = +o.discount || 0;
  const ratio = disc > 0 && grossTotal > 0 ? Math.max(0, (grossTotal - disc) / grossTotal) : 1;
  return round6(Math.max(0, lineGross * ratio) / qty);
}
function createOrderFulfillment(ctx, kind, o, b) {
  const dir = kind === 'sales' ? 'out' : 'in';
  if (kind === 'sales' && o.status !== '待发货') fail(`销售单当前状态为「${o.status}」，不能发货`);
  if (kind === 'purchase' && o.status !== '已审核') fail(`采购单当前状态为「${o.status}」，不能入库`);
  const remLine = orderLineRemaining(o, kind);
  const raw = Array.isArray(b.items) && b.items.length ? b.items : o.items.map((i, k) => {
    if (remLine[k] <= 0) return null;
    const p = get('products', i.productId); if (!p) return null;
    const unit = i.unit || p.unit, rate = unit === p.unit ? 1 : ((p.units || []).find(u => u.name === unit) || {}).rate || 1;
    let qty = remLine[k] / rate, useUnit = unit;
    if (!p.dec && !Number.isInteger(qty)) { qty = remLine[k]; useUnit = p.unit; }
    return { line:k, productId:i.productId, unit:useUnit, qty, serials:(b.serials || {})[k] || [], batchNo:((b.batches || {})[i.productId] || {}).no || '', prodDate:((b.batches || {})[i.productId] || {}).prodDate || '', expDate:((b.batches || {})[i.productId] || {}).expDate || '' };
  }).filter(Boolean);
  if (!raw.length) fail('没有可执行的商品数量');
  const items = raw.map(x => {
    const p = get('products', x.productId) || fail('商品不存在或已删除');
    const line = Number.isInteger(x.line) ? o.items[x.line] : null;
    const unit = str(x.unit, 10) || line && line.unit || p.unit;
    const l = unitQty(p, { qty:x.qty, unit });
    const hasAdj = line && (line.lineDiscount || o.discount);
    const baseOrderPrice = hasAdj ? orderLineEffectiveBasePrice(o, line) : (line ? (+line.price || 0) : kind === 'sales' ? (p.price || 0) : (p.cost || 0));
    const unitPrice = round6((!hasAdj && line && unit === line.unit && line.uprice != null ? +line.uprice : baseOrderPrice * (l.rate || 1)));
    return { productId:p.id, unit, qty:l.uqty || l.qty, ...(l.rate ? { rate:l.rate, uqty:l.uqty } : {}),
      ...(kind === 'sales' ? { sale:unitPrice } : { price:unitPrice }), note:'',
      ...(x.batchNo ? { batchNo:str(x.batchNo, 40), prodDate:isDate(x.prodDate) ? x.prodDate : '', expDate:isDate(x.expDate) ? x.expDate : '' } : {}),
      ...(Array.isArray(x.serials) && x.serials.length ? { serials:x.serials } : {}) };
  });
  validateSourceItems(o, kind, items.map(i => ({ productId:i.productId, qty:i.qty * (i.rate || 1) })), !!b.allowOver);
  const party = (get(kind === 'sales' ? 'customers' : 'suppliers', o[kind === 'sales' ? 'customerId' : 'supplierId']) || {}).name || '';
  return saveStockDoc({ ...ctx, body: { dir, type:kind === 'sales' ? '销售出库' : '采购入库', date:b.date || today(), wh:b.wh, party,
    handler:o.handler, remark:'来源订单 ' + o.no, items, srcOrderId:o.id, srcOrderKind:kind, allowOver: !!b.allowOver } }, true);
}
function saveOrder(ctx, kind, id, noTx = false) {
  const C = ORD[kind] || fail('接口不存在', 404), b = ctx.body;
  const run = () => {
    const party = str(b.partyId, 64);
    const partyRec = get(C.party, party) || fail('请选择有效的' + C.partyLabel);
    if ((kind === 'sales' || kind === 'salesReturn') && !canSeeCustomer(partyRec, ctx)) fail('只能为自己负责的客户开单', 403);
    if (!isDate(b.date)) fail('日期格式不正确');
    const src = C.src && b.srcId ? returnSrc(C, str(b.srcId, 64), party) : null;
    const items = (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId).map(i => {
      const p = get('products', i.productId) || fail('商品不存在或已删除');
      const l = unitQty(p, i), price = Number(i.price);
      if (!Number.isFinite(price) || price < 0) fail('单价不正确');
      const baseUnitPrice = basePrice(round4(price), l);
      const lineDiscount = round2(Number(i.lineDiscount) || 0);
      if (lineDiscount > round2(l.qty * baseUnitPrice) + 0.001) fail(`「${p.name}」小计不能小于 0`);
      // 退货的 cost：销售退货按原单发货成本入库，采购退货按原采购净单价（含行优惠与整单优惠分摊）冲减库存价值；没关联原单按当前成本
      const sl = src && src.items.find(x => x.productId === p.id);
      const cost = !C.src ? p.cost : C.src === 'sales' ? (sl && sl.cost != null ? sl.cost : p.cost) : sl ? orderLineEffectiveBasePrice(src, sl) : null;
      return { productId: p.id, ...l, price: baseUnitPrice, ...(l.rate ? { uprice: round4(price) } : {}), ...(lineDiscount ? { lineDiscount } : {}), cost };
    });
    if (!items.length) fail('请至少添加一个商品');
    if (src) {
      const left = returnable(src, id);
      for (const [pid, q] of Object.entries(qtyByProduct(items))) {
        const p = get('products', pid);
        if (!(pid in left)) fail(`「${p.name}」不在原单 ${src.no} 里`);
        if (q > left[pid] + 1e-9) fail(`「${p.name}」最多还能退 ${left[pid]}（原单 ${src.no}）`);
      }
    }
    const discount = C.src ? 0 : round2(Number(b.discount) || 0);
    if (discount < 0 || discount > itemsTotal({ items }) + 0.001) fail('优惠金额要在 0 到明细合计之间');
    const data = { [C.partyKey]: party, date: b.date, remark: str(b.remark, 500), handler: str(b.handler, 32) || ctx.user.name, items, ...(kind === 'sales' ? { address: str(b.address, 200) } : {}), ...(C.src ? { srcId: src ? src.id : '', srcNo: src ? src.no : '' } : { discount }) };
    if (id) {
      const o = get(C.col, id) || fail('单据不存在', 404);
      if ((kind === 'sales' || kind === 'salesReturn') && !allParties(ctx) && !isOwnOrder(o, ctx) && !canSeeCustomer(get('customers', o.customerId), ctx)) fail('只能修改自己负责的单据', 403);
      const linkedDocs = kind === 'sales' || kind === 'purchase' ? list('stockDocs').filter(d => d.srcOrderId === id && ['正常', '待审核'].includes(d.status)) : [];
      if (linkedDocs.length) {
        const q0 = qtyByProduct(o.items), q1 = qtyByProduct(items);
        const samePQ = Object.keys(q0).length === Object.keys(q1).length && Object.entries(q0).every(([pid, q]) => Math.abs(q1[pid] - q) < 1e-9);
        if (!samePQ) fail('这张订单已经生成出入库单，不能直接改商品或数量；请先作废对应的出入库单');
        if (kind === 'purchase' && items.some((it, k) => Math.abs(it.price - o.items[k].price) > 1e-9 || Math.abs((it.lineDiscount || 0) - (o.items[k].lineDiscount || 0)) > 1e-9)) fail('这张采购单已经入库，不能直接改单价或行调整；请先作废入库单');
      }
      // 采购单审核后、入库前也能改，改完回到待审核重新审核
      const reApprove = kind === 'purchase' && o.status === '已审核';
      // 已发货的销售单（完成前）、已入库的采购单也能改：明细变了就把原来的出入库冲回，按新明细重新出入库
      const posted = kind === 'sales' && o.status === '已发货' || kind === 'purchase' && o.status === '已入库';
      if (o.status !== C.statuses[0] && !reApprove && !posted) fail(`单据状态为「${o.status}」，不能编辑${kind === 'sales' && o.status === '已完成' ? '，已完成的订单请用销售退货单' : ''}`);
      if (reApprove) { data.status = '待审核'; data.approver = ''; }
      if (!C.src && !posted) items.forEach(it => { const old = o.items.find(x => x.productId === it.productId); if (old && old.cost != null) it.cost = old.cost; });
      if ((o.offset || 0) > 0 && o.srcId !== data.srcId) fail('已冲抵过原单的退货单不能改关联原单');
      if ((o[C.paidKey] || 0) > orderTotal({ items, discount }) + 0.001) fail(`已${C.payWord} ${o[C.paidKey]} 元，修改后的合计不能少于这个数`);
      let note = '';
      if (posted) note = redoPosted(ctx, kind, o, items);
      Object.assign(o, data);
      put(C.col, o); if (linkedDocs.length) syncOrderFulfillment(o, kind); audit(ctx, '修改' + C.title, o.no + note);
      return maskOrder(ctx, kind, o);
    }
    const o = { id: uid(), no: nextNo(C), ...data, status: C.statuses[0], [C.paidKey]: 0, createdAt: today(), creator: ctx.user.name, creatorId: ctx.user.id };
    put(C.col, o); audit(ctx, '新建' + C.title, `${o.no} ${orderTotal(o)}`);
    return maskOrder(ctx, kind, o);
  };
  return noTx ? run() : tx(run);
}
// 改已发货 / 已入库的订单。数量没变（销售单只改单价、优惠，采购单连单价也没变）就不动库存，沿用原来的成本、批次、序列号；
// 否则先冲回原来的出入库（按原成本 / 原进价，批次原路退回），再按新明细出入库，都在同一个事务里，失败整体回滚
function redoPosted(ctx, kind, o, items) {
  const same = items.length === o.items.length && items.every((it, k) => { const x = o.items[k];
    return x.productId === it.productId && x.qty === it.qty && (kind === 'sales' || Math.abs(x.price - it.price) < 1e-9); });
  if (same) {
    items.forEach((it, k) => { const x = o.items[k]; for (const f of ['cost', 'batches', 'serials']) if (x[f] != null) it[f] = x[f]; });
    return '';
  }
  const R = ORD[kind + 'Return'];
  if (list(R.col).some(r => r.srcId === o.id && r.status !== '已作废')) fail(`这张单已经开过${R.title}，不能再改商品、数量${kind === 'purchase' ? '或单价' : ''}，请先作废退货单`);
  const sn = [...o.items, ...items].map(i => get('products', i.productId)).find(p => p && p.serial);
  if (sn) fail(`「${sn.name}」登记了序列号，${kind === 'sales' ? '发货' : '入库'}后不能改商品、数量${kind === 'purchase' ? '或单价' : ''}，请用退货单`);
  const wh = o.wh || DEFAULT_WH, word = kind === 'sales' ? '销售出库' : '采购入库';
  if (kind === 'sales') {
    o.items.forEach(i => { const p = get('products', i.productId); if (!p) return;
      moveStock(ctx, p, i.qty, '改单冲回', o.no, '', { price: i.cost != null ? i.cost : p.cost || 0, wh, alloc: p.batch && i.batches ? i.batches : undefined }); });
    const lack = lackOf(items, wh);
    if (lack.length) fail(lackText(lack, wh));
    items.forEach(i => { const m = moveStock(ctx, get('products', i.productId), -i.qty, word, o.no, '', { wh }); i.cost = m.unit; if (m.alloc) i.batches = m.alloc; });
  } else {
    const lack = lackOf(o.items, wh);
    if (lack.length) fail('这批货已经出库了一部分，无法冲回后重新入库：' + lack.map(x => x.p ? `${x.p.name}（原入库 ${x.q}，${whName(wh)}现有 ${whQty(x.p, wh)}）` : '商品已删除').join('、'));
    const old = {};
    o.items.forEach(i => { const p = get('products', i.productId); if (!p) return;
      if (i.batches && i.batches[0]) old[p.id] = i.batches[0];
      moveStock(ctx, p, -i.qty, '改单冲回', o.no, '', { reversePrice: i.price, wh, alloc: p.batch && i.batches ? i.batches : undefined }); });
    items.forEach(i => { const p = get('products', i.productId), b = old[p.id] || {};
      const m = moveStock(ctx, p, i.qty, word, o.no, '', { price: i.price, wh, batch: { no: b.no || o.no, prodDate: b.prodDate, expDate: b.expDate } });
      if (m.alloc) i.batches = m.alloc; });
  }
  return `（已${kind === 'sales' ? '发货' : '入库'}，库存已按新明细重算）`;
}
// 退货关联的原单：同一往来单位，已发货 / 已入库
function returnSrc(C, srcId, party) {
  const S0 = ORD[C.src], src = get(S0.col, srcId) || fail('原单不存在');
  if (src[S0.partyKey] !== party) fail(`原单 ${src.no} 不是这个${C.partyLabel}的`);
  if (!C.srcOk.includes(src.status)) fail(`原单 ${src.no} 状态为「${src.status}」，${C.src === 'sales' ? '发货' : '入库'}后才能退货`);
  return src;
}
// 原单每个商品还能退多少（基本单位）= 原单实际已执行数量（旧数据无关联出入库单时回退原单数量）- 其他没作废的退货单已退的
function returnable(src, exceptId) {
  const kind = src.supplierId ? 'purchase' : 'sales';
  const col = src.supplierId ? 'purchaseReturns' : 'salesReturns';
  const okDocs = linkedOrderDocs(src, kind, false);
  const left = {};
  if (okDocs.length) {
    const done = orderFulfilledByProduct(src, kind, false);
    for (const [pid, d] of Object.entries(done)) left[pid] = round4(d.qty || 0);
    for (const i of src.items || []) if (!(i.productId in left)) left[i.productId] = 0;
  } else {
    Object.assign(left, qtyByProduct(src.items));
  }
  list(col).filter(r => r.srcId === src.id && r.id !== exceptId && r.status !== '已作废').forEach(r => r.items.forEach(i => {
    if (i.productId in left) left[i.productId] = round4(left[i.productId] - i.qty);
  }));
  for (const k in left) left[k] = Math.max(0, round4(left[k]));
  return left;
}
// 订单明细第 k 行的序列号：启用序列号的商品必须登记，数量要和这一行一致
function lineSerials(b, p, i, k) {
  if (!p.serial) return undefined;
  return cleanSerials(p, ((b.serials && typeof b.serials === 'object') ? b.serials : {})[k], i.qty);
}
function orderAction(ctx, kind, id, action) {
  const C = ORD[kind] || fail('接口不存在', 404), b = ctx.body || {};
  return tx(() => {
    const o = get(C.col, id) || fail('单据不存在', 404);
    if ((kind === 'sales' || kind === 'salesReturn') && !allParties(ctx) && !isOwnOrder(o, ctx) && !canSeeCustomer(get('customers', o.customerId), ctx)) fail('只能操作自己负责的单据', 403);
    const need = st => { if (o.status !== st) fail(`单据当前状态为「${o.status}」，无法执行此操作`); };
    if (action === 'ship' && kind === 'sales') {
      need('待发货');
      const doc = createOrderFulfillment(ctx, 'sales', o, b);
      Object.assign(o, get(C.col, id));
      o.shipDate = doc.date; o.wh = doc.wh;
    } else if (action === 'complete' && kind === 'sales') { need('已发货'); o.status = '已完成'; }
    else if (action === 'approve' && kind === 'purchase') { need('待审核'); o.status = '已审核'; o.approver = ctx.user.name; }
    else if (action === 'unapprove' && kind === 'purchase') { need('已审核'); o.status = '待审核'; o.approver = ''; }
    else if (action === 'inbound' && kind === 'purchase') {
      need('已审核');
      const doc = createOrderFulfillment(ctx, 'purchase', o, b);
      Object.assign(o, get(C.col, id));
      o.inDate = doc.date; o.wh = doc.wh;
    } else if (action === 'finish-fulfill' && (kind === 'sales' || kind === 'purchase')) {
      need(kind === 'sales' ? '待发货' : '已审核');
      const okDocs = linkedOrderDocs(o, kind, false);
      const allDocs = linkedOrderDocs(o, kind, true);
      if (!okDocs.length) fail(`还没有已生效的${kind === 'sales' ? '出库单' : '入库单'}，直接作废订单即可`);
      if (allDocs.some(d => d.status === '待审核')) fail('还有待审核的出入库单，请先在库存管理审核或作废后再完结');
      if (b.syncQty === true) {
        const oldItemsTotal = itemsTotal(o);
        const doneMap = orderFulfilledByProduct(o, kind, false);
        const doneLeft = {};
        for (const [pid, d] of Object.entries(doneMap)) doneLeft[pid] = d.qty || 0;
        const items = o.items.map((i, idx) => {
          const p = get('products', i.productId);
          const hasMore = o.items.slice(idx + 1).some(nx => nx.productId === i.productId);
          const got = doneLeft[i.productId] || 0;
          const take = hasMore ? round4(Math.min(i.qty, got)) : round4(got);
          doneLeft[i.productId] = round4(Math.max(0, got - take));
          if (take <= 0) return null;
          if (p && !p.dec && Math.abs(take - Math.round(take)) > 1e-6) fail(`「${p.name}」实${kind === 'sales' ? '发' : '收'}数量 ${take} 带小数，请先开启允许小数或取消同步金额`);
          const rate = i.rate || 1, uqty = round4(take / rate);
          const origQty = i.origQty != null ? i.origQty : i.qty;
          const next = { ...i, origQty, qty: take, ...(i.rate ? { uqty } : {}), fulfilledQty: take };
          if (i.lineDiscount) {
            const scaled = origQty > 0 ? round2(i.lineDiscount * take / origQty) : 0;
            const maxDisc = round2(take * (i.price || 0));
            const ld = Math.min(scaled, maxDisc);
            if (ld) next.lineDiscount = ld; else delete next.lineDiscount;
          }
          return next;
        }).filter(Boolean);
        if (!items.length) fail('实际已执行数量为 0，不能完结');
        const newItemsTotal = itemsTotal({ items });
        let newDiscount = o.discount || 0;
        if (newDiscount > 0) {
          newDiscount = oldItemsTotal > 0 ? Math.min(newItemsTotal, round2(newDiscount * newItemsTotal / oldItemsTotal)) : Math.min(newItemsTotal, newDiscount);
        }
        if ((o[C.paidKey] || 0) > orderTotal({ items, discount: newDiscount }) + 0.001) {
          fail(`已${C.payWord} ${o[C.paidKey]} 元，按实${kind === 'sales' ? '发' : '收'}数量调整后的订单合计不能少于这个数`);
        }
        o.items = items;
        if (o.discount) o.discount = newDiscount;
      }
      o.earlyClosed = true;
      o.earlyClosedAt = new Date().toISOString();
      o.earlyClosedBy = ctx.user.name;
      o.earlyCloseNote = str(b.note, 200);
      o.status = kind === 'sales' ? '已发货' : '已入库';
    } else if (action === 'post' && C.src) {
      need(C.statuses[0]);
      if (o.srcId) {
        const src = returnSrc(C, o.srcId, o[C.partyKey]);
        const left = returnable(src, o.id);
        for (const [pid, q] of Object.entries(qtyByProduct(o.items))) {
          const p = get('products', pid);
          if (!(pid in left)) fail(`「${p ? p.name : pid}」不在原单 ${src.no} 里`);
          if (q > left[pid] + 1e-9) fail(`「${p ? p.name : pid}」最多还能退 ${left[pid]}（原单 ${src.no}）`);
        }
      }
      const wh = pickWh(b.wh), bi = b.batches && typeof b.batches === 'object' ? b.batches : {}, pname = (get(C.party, o[C.partyKey]) || {}).name || '';
      const approveNote = str(b.note, 200) || fail('请填写审核备注');
      if (kind === 'purchaseReturn') { const lack = lackOf(o.items, wh); if (lack.length) fail(lackText(lack, wh)); }
      o.items.forEach((i, k) => {
        const p = get('products', i.productId) || fail('商品不存在或已删除');
        const sn = lineSerials(b, p, i, k);
        const m = kind === 'salesReturn'
          ? moveStock(ctx, p, i.qty, '销售退货', o.no, pname, { price: i.cost != null ? i.cost : p.cost || 0, wh, batch: { no: o.no, ...(bi[p.id] || {}) }, serials: sn })
          : moveStock(ctx, p, -i.qty, '采购退货', o.no, pname, { reversePrice: i.cost != null ? i.cost : undefined, wh, serials: sn });
        i.cost = round4(m.unit);
        if (m.alloc) i.batches = m.alloc;
        if (sn) i.serials = sn;
      });
      o.status = C.statuses[1]; o.postDate = today(); o.wh = wh;
      o.approveNote = approveNote;
      o.approver = ctx.user.name; o.approvedAt = new Date().toISOString();
      const dir = kind === 'salesReturn' ? 'in' : 'out';
      const retDoc = {
        id: uid(), no: nextNo(DOC[dir]), dir, type: kind === 'salesReturn' ? '销售退货' : '采购退货',
        wh, date: today(), time: hhmm(), party: pname, handler: o.handler || ctx.user.name,
        remark: (approveNote ? approveNote + ' · ' : '') + '来源退货单 ' + o.no,
        srcOrderId: o.id, srcOrderNo: o.no, srcOrderKind: kind,
        items: o.items.map(i => ({
          productId: i.productId,
          unit: i.unit || (get('products', i.productId) || {}).unit || '',
          qty: i.qty,
          ...(i.rate ? { rate: i.rate, uqty: i.uqty } : {}),
          price: i.cost != null ? round4(i.cost) : 0,
          ...(i.rate ? { uprice: round4((i.cost || 0) * i.rate) } : {}),
          ...(kind === 'purchaseReturn' ? { sale: round4(i.price || 0), ...(i.rate ? { usale: round4((i.price || 0) * i.rate) } : {}) } : {}),
          ...(i.batches ? { batches: i.batches } : {}),
          ...(i.serials ? { serials: i.serials } : {}),
          note: '退货单 ' + o.no
        })),
        status: '正常', creator: ctx.user.name, creatorId: ctx.user.id,
        approver: ctx.user.name, approvedAt: o.approvedAt, createdAt: new Date().toISOString(), printCount: 0
      };
      put('stockDocs', retDoc);
      o.stockDocId = retDoc.id; o.stockDocNo = retDoc.no;
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
      if ((kind === 'sales' || kind === 'purchase') && list('stockDocs').some(d => d.srcOrderId === id && ['正常', '待审核'].includes(d.status))) fail('这张订单已经生成出入库单，请先作废对应单据');
      if (o[C.paidKey] > 0) fail(`单据已有${C.payWord}记录，不能作废`);
      o.status = '已作废';
    } else if (action === 'pay') {
      if (o.status === '已作废') fail(`已作废单据不能${C.payWord}`);
      const unpaid = round2(orderTotal(o) - (o[C.paidKey] || 0)), amount = round2(Number(b.amount));
      if (!(amount > 0) || amount > unpaid + 0.001) fail(`${C.payWord}金额需在 0 ~ ${unpaid} 之间`);
      o[C.paidKey] = round2((o[C.paidKey] || 0) + amount);
      const acct = pickAccount(b);
      put('finance', { id: uid(), date: isDate(b.date) ? b.date : today(), type: C.fin[0], category: C.fin[1],
        amount, account: acct.id, method: acct.kind, ref: o.no, note: str(b.note), operator: ctx.user.name });
    } else fail('不支持的操作', 404);
    put(C.col, o);
    audit(ctx, { ship: '发货', complete: '完成订单', approve: '审核采购', unapprove: '反审核采购', inbound: '采购入库', 'finish-fulfill': kind === 'sales' ? '提前完成发货' : '提前完成收货', post: kind === 'salesReturn' ? '销售退货审核入库' : '采购退货审核出库', offset: '退货冲抵', cancel: '作废单据', pay: C.payWord }[action], o.no + (action === 'pay' || action === 'offset' ? ' ' + b.amount : '') + (action === 'post' && b.note ? ' · ' + str(b.note, 200) : ''));
    return maskOrder(ctx, kind, o);
  });
}
// 改 / 删订单上的一笔收付款（退货单上的退款）：同步单据的已收 / 已付，不能超过单据合计
function editPay(ctx, kind, id, fid, remove) {
  const C = ORD[kind] || fail('接口不存在', 404), b = ctx.body || {};
  return tx(() => {
    const o = get(C.col, id) || fail('单据不存在', 404);
    if ((kind === 'sales' || kind === 'salesReturn') && !allParties(ctx) && !isOwnOrder(o, ctx) && !canSeeCustomer(get('customers', o.customerId), ctx)) fail('只能操作自己负责的单据', 403);
    const f = get('finance', fid);
    if (!f || f.ref !== o.no || f.category !== C.fin[1]) fail(`${C.payWord}记录不存在`, 404);
    const rest = round2((o[C.paidKey] || 0) - f.amount);
    if (remove) {
      o[C.paidKey] = Math.max(0, rest); del('finance', f.id); put(C.col, o);
      audit(ctx, '删除' + C.payWord + '记录', `${o.no} ${f.amount}`);
      return maskOrder(ctx, kind, o);
    }
    const amount = round2(Number(b.amount)), max = round2(orderTotal(o) - rest);
    if (!(amount > 0) || amount > max + 0.001) fail(`${C.payWord}金额需在 0 ~ ${max} 之间`);
    if (b.date != null && !isDate(b.date)) fail('日期格式不正确');
    const acct = pickAccount(b, f.account);
    Object.assign(f, { amount, date: b.date || f.date, account: acct.id, method: acct.kind, note: str(b.note) });
    put('finance', f);
    o[C.paidKey] = round2(rest + amount); put(C.col, o);
    audit(ctx, '修改' + C.payWord + '记录', `${o.no} ${amount}`);
    return maskOrder(ctx, kind, o);
  });
}
function partyPaymentCreate(ctx) {
  const b = ctx.body, type = b.partyType === 'supplier' ? 'supplier' : 'customer';
  const col = type === 'supplier' ? 'suppliers' : 'customers';
  const party = get(col, str(b.partyId, 64)) || fail((type === 'supplier' ? '供应商' : '客户') + '不存在', 404);
  const amount = round2(Number(b.amount));
  if (!(amount > 0)) fail('金额必须大于 0');
  const date = isDate(b.date) ? b.date : today();
  if (date > today()) fail('日期不能晚于今天');
  const kind = type === 'supplier' ? 'purchase' : 'sales', C = ORD[kind];
  let order = null;
  if (b.orderId) {
    order = get(C.col, str(b.orderId, 64)) || fail('关联订单不存在', 404);
    if (order[C.partyKey] !== party.id) fail(`这笔款不是这个${C.partyLabel}的`);
    if (order.status === '已作废') fail('已作废订单不能登记收付款');
    const due = round2(orderTotal(order) - (order[C.paidKey] || 0));
    if (amount > due + 0.001) fail(`订单最多还能${C.payWord} ${due} 元`);
  }
  const acct = pickAccount(b);
  return tx(() => {
    const f = { id: uid(), date, type: type === 'supplier' ? 'expense' : 'income',
      category: order ? C.fin[1] : (type === 'supplier' ? '供应商预付款' : '客户预收款'),
      amount, account: acct.id, method: acct.kind, ref: order ? order.no : '', note: str(b.note, 200),
      partyType: type, partyId: party.id, partyName: party.name, operator: ctx.user.name };
    put('finance', f);
    const pp = { id: uid(), partyType: type, partyId: party.id, partyName: party.name, amount, date,
      account: acct.id, method: acct.kind, note: f.note, financeId: f.id,
      ...(order ? { appliedOrderId: order.id, appliedOrderNo: order.no } : {}), creator: ctx.user.name, createdAt: new Date().toISOString() };
    if (order) { order[C.paidKey] = round2((order[C.paidKey] || 0) + amount); put(C.col, order); }
    put('partyPayments', pp);
    audit(ctx, type === 'supplier' ? '供应商付款' : '客户收款', `${party.name} ${amount}${order ? ' ← ' + order.no : '（未核销）'}`);
    return pp;
  });
}
function partyPaymentBatch(ctx) {
  const b = ctx.body, type = b.partyType === 'supplier' ? 'supplier' : 'customer';
  const col = type === 'supplier' ? 'suppliers' : 'customers';
  const party = get(col, str(b.partyId, 64)) || fail((type === 'supplier' ? '供应商' : '客户') + '不存在', 404);
  const amount = round2(Number(b.amount));
  if (!(amount > 0)) fail('金额必须大于 0');
  const date = isDate(b.date) ? b.date : today();
  if (date > today()) fail('日期不能晚于今天');
  const ids = Array.isArray(b.orderIds) ? [...new Set(b.orderIds.map(x => String(x || '')).filter(Boolean))] : [];
  if (ids.length < 2) fail('合并收款至少要选两张订单');
  const kind = type === 'supplier' ? 'purchase' : 'sales', C = ORD[kind];
  const acct = pickAccount(b);
  return tx(() => {
    const orders = ids.map(id => get(C.col, id) || fail('订单不存在', 404));
    for (const o of orders) {
      if (o[C.partyKey] !== party.id) fail(`订单 ${o.no} 不是这个${C.partyLabel}的`);
      if (o.status === '已作废') fail(`订单 ${o.no} 已作废，不能登记收付款`);
    }
    orders.sort((x, y) => (x.date + (x.createdAt || '')).localeCompare(y.date + (y.createdAt || '')));
    const dues = orders.map(o => round2(orderTotal(o) - (o[C.paidKey] || 0)));
    const totalDue = round2(dues.reduce((s, x) => s + x, 0));
    if (amount > totalDue + 0.001) fail(`这些单最多还能${C.payWord} ${totalDue} 元`);
    let left = amount;
    const allocs = [];
    orders.forEach((o, i) => {
      if (left <= 0.001 || dues[i] <= 0.001) return;
      const take = round2(Math.min(left, dues[i]));
      o[C.paidKey] = round2((o[C.paidKey] || 0) + take);
      put(C.col, o);
      allocs.push({ orderId: o.id, no: o.no, amount: take });
      left = round2(left - take);
    });
    const ref = allocs.map(a => a.no).slice(0, 3).join('、') + (allocs.length > 3 ? `等 ${allocs.length} 张` : '');
    const f = {
      id: uid(), date, type: type === 'supplier' ? 'expense' : 'income', category: C.fin[1],
      amount, account: acct.id, method: acct.kind, ref, note: str(b.note, 200),
      partyType: type, partyId: party.id, partyName: party.name, operator: ctx.user.name,
    };
    put('finance', f);
    const pp = {
      id: uid(), partyType: type, partyId: party.id, partyName: party.name, amount, date,
      account: acct.id, method: acct.kind, note: f.note, financeId: f.id, appliedOrders: allocs,
      creator: ctx.user.name, createdAt: new Date().toISOString(),
    };
    if (allocs.length === 1) { pp.appliedOrderId = allocs[0].orderId; pp.appliedOrderNo = allocs[0].no; }
    put('partyPayments', pp);
    audit(ctx, type === 'supplier' ? '供应商合并付款' : '客户合并收款', `${party.name} ${amount}（${allocs.length} 张单）`);
    return pp;
  });
}
function ppAllocs(pp) {
  if (Array.isArray(pp.appliedOrders) && pp.appliedOrders.length) return pp.appliedOrders;
  if (pp.appliedOrderId) return [{ orderId: pp.appliedOrderId, no: pp.appliedOrderNo || '', amount: +pp.amount || 0, date: pp.date }];
  return [];
}
function ppApplied(pp) { return round2(ppAllocs(pp).reduce((s, a) => s + (+a.amount || 0), 0)); }
function ppRemaining(pp) { return round2(Math.max(0, (+pp.amount || 0) - ppApplied(pp))); }
function partyPaymentApply(ctx, id) {
  const b = ctx.body || {}, pp = get('partyPayments', id) || fail('往来款记录不存在', 404);
  const rem = ppRemaining(pp);
  if (rem <= 0.001) fail('这笔往来款已全部核销');
  const kind = pp.partyType === 'supplier' ? 'purchase' : 'sales', C = ORD[kind];
  return tx(() => {
    const order = get(C.col, str(b.orderId, 64)) || fail('关联订单不存在', 404);
    if (order[C.partyKey] !== pp.partyId) fail(`订单不是这个${C.partyLabel}的`);
    if (order.status === '已作废') fail('已作废订单不能核销');
    const due = round2(orderTotal(order) - (order[C.paidKey] || 0));
    if (due <= 0.001) fail('该订单已结清，无需核销');
    const maxTake = round2(Math.min(rem, due));
    const take = b.amount != null && b.amount !== '' ? round2(Number(b.amount)) : maxTake;
    if (!(take > 0)) fail('核销金额必须大于 0');
    if (take > rem + 0.001) fail(`这笔往来款最多只剩 ${rem} 元可核销`);
    if (take > due + 0.001) fail(`订单最多只能核销 ${due} 元`);
    const allocs = ppAllocs(pp).map(a => ({ ...a }));
    allocs.push({ orderId: order.id, no: order.no, amount: take, date: today() });
    pp.appliedOrders = allocs;
    const left = round2(Math.max(0, (+pp.amount || 0) - allocs.reduce((s, a) => s + (+a.amount || 0), 0)));
    if (allocs.length === 1 && left <= 0.001) {
      pp.appliedOrderId = order.id; pp.appliedOrderNo = order.no;
    } else {
      delete pp.appliedOrderId; delete pp.appliedOrderNo;
    }
    const f = get('finance', pp.financeId) || fail('对应的资金流水不存在');
    const uniqNos = [...new Set(allocs.map(a => a.no).filter(Boolean))];
    f.ref = uniqNos.slice(0, 3).join('、') + (uniqNos.length > 3 ? `等 ${uniqNos.length} 张` : '');
    if (left <= 0.001) f.category = C.fin[1];
    put('finance', f);
    order[C.paidKey] = round2((order[C.paidKey] || 0) + take); put(C.col, order);
    put('partyPayments', pp);
    audit(ctx, '核销往来款', `${pp.partyName} ${take} → ${order.no}${left > 0.001 ? `（剩 ${left}）` : ''}`);
    return { ...pp, appliedOrderNo: order.no, appliedAmount: take, remaining: left };
  });
}
function partyPaymentDelete(ctx, id) {
  return tx(() => {
    const pp = get('partyPayments', id) || fail('往来款记录不存在', 404);
    const kind = pp.partyType === 'supplier' ? 'purchase' : 'sales', C = ORD[kind];
    if ((pp.appliedOrders || []).length) {
      for (const a of pp.appliedOrders) {
        const order = get(C.col, a.orderId);
        if (order) { order[C.paidKey] = round2(Math.max(0, (order[C.paidKey] || 0) - a.amount)); put(C.col, order); }
      }
    } else if (pp.appliedOrderId) {
      const order = get(C.col, pp.appliedOrderId);
      if (order) { order[C.paidKey] = round2(Math.max(0, (order[C.paidKey] || 0) - pp.amount)); put(C.col, order); }
    }
    del('finance', pp.financeId); del('partyPayments', id);
    audit(ctx, '删除往来款', `${pp.partyName} ${pp.amount}`);
  });
}
function saveProject(ctx, id) {
  const b = ctx.body, name = str(b.name, 60);
  if (!name) fail('请填写项目名称');
  const status = ['进行中', '暂停', '已结束'].includes(b.status) ? b.status : '进行中';
  const startDate = b.startDate && !isDate(b.startDate) ? fail('开工日期格式不正确') : (b.startDate || '');
  const endDate = b.endDate && !isDate(b.endDate) ? fail('结束日期格式不正确') : (b.endDate || '');
  if (startDate && endDate && endDate < startDate) fail('结束日期不能早于开工日期');
  return tx(() => {
    if (list('projects').some(p => p.name === name && p.id !== id)) fail('项目名称已存在');
    const old = id ? get('projects', id) || fail('项目不存在', 404) : null;
    const p = { ...(old || { id: uid(), createdAt: new Date().toISOString() }), name, status, startDate, endDate,
      manager: str(b.manager, 32), remark: str(b.remark, 500), creator: old ? old.creator : ctx.user.name };
    if (old && old.name !== name) {
      for (const col of ['stockDocs', 'sales', 'purchases', 'salesReturns', 'purchaseReturns']) {
        for (const r of list(col)) if (r.project === old.name) { r.project = name; put(col, r); }
      }
    }
    put('projects', p);
    audit(ctx, old ? '修改项目' : '新建项目', name);
    return p;
  });
}
function deleteProject(ctx, id) {
  return tx(() => {
    const p = get('projects', id) || fail('项目不存在', 404);
    const used = ['stockDocs', 'sales', 'purchases', 'salesReturns', 'purchaseReturns'].some(col => list(col).some(o => o.project === p.name));
    if (used) fail('这个项目已被单据引用，不能删除');
    del('projects', id);
    audit(ctx, '删除项目', p.name);
  });
}
const PRICE_COL = { customers: { perm: 'sales', name: '客户' }, suppliers: { perm: 'purchase', name: '供应商' } };
function cleanPrices(raw) {
  const out = {};
  for (const [pid, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (v === '' || v == null) continue;
    const p = get('products', pid) || fail('商品不存在或已删除');
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) fail(`「${p.name}」的专属价不正确`);
    out[pid] = round4(n);
  }
  if (Object.keys(out).length > 5000) fail('专属价最多 5000 个商品');
  return out;
}
function savePrices(ctx, col, id) {
  const P = PRICE_COL[col] || fail('接口不存在', 404);
  return tx(() => {
    const r = get(col, id) || fail(P.name + '不存在', 404);
    if (col === 'customers' && !canSeeCustomer(r, ctx)) fail('只能修改自己负责客户的专属价', 403);
    r.prices = cleanPrices(ctx.body.prices);
    put(col, r); audit(ctx, '设置专属价', `${P.name} ${r.name}：${Object.keys(r.prices).length} 个商品`);
    return r;
  });
}
// 表格导入：每行 往来单位名称 + 商品（编码 / 条码 / 名称）+ 单价；同一单位同一商品以最后一行为准；单价留空 = 删掉这条专属价
function importPrices(ctx, col) {
  const P = PRICE_COL[col] || fail('接口不存在', 404), rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : [];
  if (!rows.length) fail('没有可导入的数据');
  if (rows.length > 20000) fail('一次最多导入 20000 行');
  return tx(() => {
    const parties = list(col), prods = list('products'), errors = [], touched = new Map();
    const byName = new Map(parties.map(x => [x.name, x])), byCode = new Map();
    prods.forEach(p => { for (const c of codesOf(p)) if (!byCode.has(c)) byCode.set(c, p); });
    const byPName = new Map(prods.map(p => [p.name, p]));
    let n = 0;
    rows.forEach((row, k) => {
      const line = k + 2, name = str(row && row.party, 100), code = str(row && row.product, 100), raw = row && row.price;
      if (!name && !code) return;
      const party = touched.get(name) || byName.get(name);
      if (!party) return errors.push(`第 ${line} 行：找不到${P.name}「${name}」`);
      if (col === 'customers' && !canSeeCustomer(party, ctx)) return errors.push(`第 ${line} 行：无权修改客户「${name}」的专属价`);
      const p = byCode.get(code) || byPName.get(code);
      if (!p) return errors.push(`第 ${line} 行：找不到商品「${code}」`);
      party.prices = party.prices || {};
      if (raw === '' || raw == null) delete party.prices[p.id];
      else { const v = Number(raw); if (!Number.isFinite(v) || v < 0) return errors.push(`第 ${line} 行：单价「${raw}」不正确`); party.prices[p.id] = round4(v); }
      touched.set(name, party); n++;
    });
    if (errors.length) fail(errors.slice(0, 10).join('；') + (errors.length > 10 ? `……共 ${errors.length} 处错误` : '') + '。没有导入任何数据，请改好后重新导入');
    touched.forEach(r => put(col, r));
    audit(ctx, '导入专属价', `${P.name} ${touched.size} 个，${n} 行`);
    return { parties: touched.size, rows: n };
  });
}
function deleteOrder(ctx, kind, id) {
  const C = ORD[kind] || fail('接口不存在', 404);
  return tx(() => {
    const o = get(C.col, id) || fail('单据不存在', 404);
    if ((kind === 'sales' || kind === 'salesReturn') && !allParties(ctx) && !isOwnOrder(o, ctx) && !canSeeCustomer(get('customers', o.customerId), ctx)) fail('只能删除自己负责的单据', 403);
    if (o.status !== '已作废') fail('只能删除已作废的单据');
    del(C.col, id); audit(ctx, '删除' + C.title, o.no);
  });
}
function adjustStock(ctx, id) {
  const { mode, note } = ctx.body, qty = Number(ctx.body.qty);
  const T = { in: '手工入库', out: '手工出库', check: '盘点调整' }[mode] || fail('不支持的操作');
  const p0 = get('products', id);
  if (!Number.isInteger(qty) && !(p0 && p0.dec)) fail('数量必须为整数（按重量 / 长度卖的商品请在商品档案里打开「允许小数数量」）');
  if (p0 && p0.dec && Math.abs(qty - round2(qty)) > 1e-9) fail('数量最多两位小数');
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
  if (o.dir === 'in' && o.bom) bomConsume(ctx, o);
  o.items.forEach(i => {
    const m = moveStock(ctx, get('products', i.productId), o.dir === 'in' ? i.qty : -i.qty, o.type, o.no, i.note || o.party, { price: o.dir === 'in' ? i.price : undefined, date: o.date, wh: o.wh, batch: i.batch, serials: i.serials, preferBatch: i.preferBatch });
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
    const name = str(u && u.name, 10), rate = round4(Number(u && u.rate)), barcode = str(u && u.barcode, 64);
    const hasPrice = u && u.price !== '' && u.price != null, price = Number(u && u.price);
    if (!name) fail('辅助单位名称不能为空');
    if (seen.has(name)) fail(`单位「${name}」重复（不能和基本单位相同）`);
    if (!Number.isFinite(rate) || rate < 0.0001 || rate > 100000 || Math.abs(rate - 1) < 1e-6) fail(`「1 ${name} = ? ${base}」的换算数需在 0.0001 ~ 100000 之间且不能为 1`);
    if (hasPrice && (!Number.isFinite(price) || price < 0)) fail(`「${name}」的销售价不正确`);
    seen.add(name);
    return { name, rate, ...(barcode ? { barcode } : {}), ...(hasPrice ? { price: round2(price) } : {}) };
  });
}
function productBaseUnitUsed(p) {
  if (!p) return false;
  return p.stock !== 0 || (p.units || []).length || list('stockLogs').some(l => l.productId === p.id)
    || ['sales', 'purchases', 'salesReturns', 'purchaseReturns'].some(col => list(col).some(o => (o.items || []).some(i => i.productId === p.id)));
}
const codesOf = p => [p.sku, p.barcode, ...(p.units || []).map(u => u.barcode)].filter(Boolean);
// 「箱=12/条码；盒=0.5」→ [{ name, rate, barcode }]，和商品档案里的写法一致
function parseUnitsText(t) {
  return String(t || '').split(/[;；,，\n]+/).map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^1?\s*([^=＝\s\/／\d@＠][^=＝\s\/／@＠]*)\s*[=＝]\s*([\d.]+)\s*[^\d\/／@＠]*?(?:[\/／]\s*([^@＠]+?))?(?:[@＠]\s*([\d.]+))?$/.exec(x);
    if (!m) fail('辅助单位格式不对：「' + x + '」，应写成 箱=12 或 包=0.5');
    return { name: m[1], rate: +m[2], barcode: (m[3] || '').trim(), ...(m[4] != null ? { price: +m[4] } : {}) };
  });
}
// 明细数量按所选单位录入，换算成基本单位：返回 { qty: 基本单位数量, unit, rate, uqty: 录入数量 }
function unitQty(p, i) {
  let n = Number(i.qty), name = str(i.unit, 10);
  if (!Number.isFinite(n) || n <= 0) fail(`「${p.name}」数量必须大于 0`);
  if (p.serial && !Number.isInteger(n)) fail(`「${p.name}」启用了序列号，数量必须为整数`);
  if (p.dec) {
    const r = round2(n);
    if (Math.abs(n - r) > 1e-9) fail(`「${p.name}」数量最多两位小数`);
    n = r;
  } else if (!Number.isInteger(n)) fail(`「${p.name}」数量必须为正整数（按重量 / 长度卖的商品请在商品档案里打开「允许小数数量」）`);
  if (!name || name === p.unit) return { qty: n };
  const u = (p.units || []).find(x => x.name === name) || fail(`「${p.name}」没有单位「${name}」，请先在商品档案里设置`);
  const baseQty = round4(n * u.rate);
  if (p.serial && Math.abs(baseQty - Math.round(baseQty)) > 1e-6) fail(`「${p.name}」启用了序列号，换算后的基本单位数量必须为整数`);
  return { qty: baseQty, unit: u.name, rate: u.rate, uqty: n };
}
// 录入的是所选单位的单价，按基本单位保存且不取整，保证 数量 × 单价 等于录入金额
const basePrice = (price, l) => (l.rate ? price / l.rate : price);
/* ---------- BOM（物料清单）：每个商品可挂一份；用量按成品 1 个基本单位计；
   物料可以是商品档案里的商品（成本取商品当前成本），也可以是档案外的物料（手填单价）；
   「生产入库」勾选按 BOM 领料时：按用量扣原料库存，成品入库成本 = 原料实际出库成本 + 档案外物料单价，逐项累加 ---------- */
const BOM_BUILTIN = ['sku', 'name', 'spec', 'unit', 'qty', 'price', 'amount', 'note'];
function bomCols() {
  const c = getMeta('settings', {}).bomCols || {};
  return { show: Array.isArray(c.show) ? c.show : BOM_BUILTIN, custom: Array.isArray(c.custom) ? c.custom : [] };
}
function cleanBomLines(p, raw) {
  if (!Array.isArray(raw)) fail('BOM 格式不正确');
  if (raw.length > 300) fail('一个商品的 BOM 最多 300 行');
  const custom = bomCols().custom, seen = new Set();
  return raw.filter(l => l && (l.productId || str(l.name, 100))).map((l, n) => {
    const at = `第 ${n + 1} 行`, qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6) fail(`${at}用量需大于 0`);
    const x = {};
    for (const k of custom) { const v = str(l.x && l.x[k], 100); if (v) x[k] = v; }
    const base = { qty: round4(qty), note: str(l.note, 100), ...(Object.keys(x).length ? { x } : {}) };
    if (l.productId) {
      const m = get('products', str(l.productId, 64)) || fail(`${at}的物料不在商品档案里（可能已删除）`);
      if (m.id === p.id) fail(`${at}：BOM 里不能包含商品自己`);
      if (seen.has(m.id)) fail(`${at}：「${m.name}」重复了，同一物料请合并成一行`);
      seen.add(m.id);
      return { productId: m.id, ...base };
    }
    const price = l.price === '' || l.price == null ? 0 : Number(l.price);
    if (!Number.isFinite(price) || price < 0) fail(`${at}单价不正确`);
    const sku = str(l.sku, 40);
    return { ...(sku ? { sku } : {}), name: str(l.name, 100), spec: str(l.spec, 60), unit: str(l.unit, 10), price: round4(price), ...base };
  });
}
// BOM 成本：每个基本单位成品需要的物料成本合计
const bomCost = lines => round4(sum(lines || [], l => l.qty * (l.productId ? ((get('products', l.productId) || {}).cost || 0) : l.price || 0)));
function saveBom(ctx, id) {
  return tx(() => {
    const p = get('products', id) || fail('商品不存在', 404);
    const lines = cleanBomLines(p, ctx.body.lines);
    if (lines.length) p.bom = lines; else delete p.bom;
    // 按 BOM 成本更新成本价：只在没有库存时可以（有库存时成本按移动加权平均，生产入库会按 BOM 自动算）
    if (ctx.body.applyCost) {
      if (!seesCost(ctx.perms)) fail('没有查看成本价的权限', 403);
      if (p.stock) fail(`「${p.name}」还有库存 ${p.stock}，成本价由入库自动计算；请用「生产入库」按 BOM 领料入库，入库成本会按 BOM 自动累加`);
      p.cost = bomCost(lines);
    }
    put('products', p); audit(ctx, '修改 BOM', `${p.name} ${lines.length} 项`);
    return maskProduct(ctx, p);
  });
}
// 批量导入：{ boms: [{ productId, lines }] }，列出的商品整份替换；任何一行出错整批不导入
function importBoms(ctx) {
  const boms = Array.isArray(ctx.body.boms) ? ctx.body.boms : fail('没有可导入的数据');
  if (!boms.length) fail('没有可导入的数据');
  return tx(() => {
    let n = 0;
    for (const b of boms) {
      const p = get('products', str(b && b.productId, 64)) || fail('成品不在商品档案里');
      try { const lines = cleanBomLines(p, b.lines); if (lines.length) p.bom = lines; else delete p.bom; n += lines.length; }
      catch (e) { fail(`「${p.name}」${e.message}`); }
      put('products', p);
    }
    audit(ctx, '导入 BOM', `${boms.length} 个商品 ${n} 行`);
    return { products: boms.length, rows: n };
  });
}
function saveBomCols(ctx) {
  const b = ctx.body, show = (Array.isArray(b.show) ? b.show : BOM_BUILTIN).filter(k => BOM_BUILTIN.includes(k));
  for (const k of ['name', 'qty']) if (!show.includes(k)) show.push(k);
  const custom = [...new Set((Array.isArray(b.custom) ? b.custom : []).map(c => str(c, 12)).filter(Boolean))];
  if (custom.length > 8) fail('自定义列最多 8 个');
  const clash = custom.find(c => ['物料编码', '编码', '物料名称', '名称', '规格', '单位', '用量', '单价', '金额', '备注'].includes(c));
  if (clash) fail(`「${clash}」和内置列重名，换个名字`);
  const s = getMeta('settings', {}); s.bomCols = { show: BOM_BUILTIN.filter(k => show.includes(k)), custom }; setMeta('settings', s);
  audit(ctx, '修改 BOM 表头', custom.join('、'));
  return s.bomCols;
}
// 生产入库按 BOM 领料：在成品入库前调用，扣原料、算出成品单价写回明细；领料记录存在 i.mats，作废时原路退回
function bomConsume(ctx, o) {
  const wh = o.wh || DEFAULT_WH;
  const plan = o.items.map(i => { const p = get('products', i.productId) || fail('单据里有商品已被删除'); return { i, p, lines: p.bom || [] }; });
  const noBom = plan.filter(x => !x.lines.length).map(x => x.p.name);
  if (noBom.length) fail(`「${noBom.join('、')}」没有设置 BOM，不能按 BOM 领料（可以先在商品管理里设置 BOM，或取消「按 BOM 领料」）`);
  // 先汇总检查库存，一次说清缺哪些
  const need = {};
  for (const { i, p, lines } of plan) for (const l of lines) if (l.productId) {
    const q = round4(l.qty * i.qty);
    if (Math.abs(q - Math.round(q)) > 1e-6) fail(`「${p.name}」生产 ${i.qty} 需要「${(get('products', l.productId) || {}).name}」${q}，库存按整数计，请调整 BOM 用量或生产数量`);
    need[l.productId] = (need[l.productId] || 0) + Math.round(q);
  }
  const lack = Object.entries(need).map(([pid, q]) => ({ m: get('products', pid), q })).filter(x => !x.m || whQty(x.m, wh) < x.q);
  if (lack.length) fail('原料不足，不能生产入库：' + lack.map(x => x.m ? `${x.m.name}（需 ${x.q}，${whName(wh)}现有 ${whQty(x.m, wh)}）` : '有物料已被删除').join('、'));
  const serial = Object.keys(need).map(pid => get('products', pid)).find(m => m.serial);
  if (serial) fail(`原料「${serial.name}」启用了序列号，不能自动领料，请先用出库单登记序列号领料`);
  for (const { i, p, lines } of plan) {
    let total = 0; i.mats = [];
    for (const l of lines) {
      if (!l.productId) { total += l.qty * i.qty * (l.price || 0); continue; }
      const m = get('products', l.productId), q = Math.round(l.qty * i.qty);
      const r = moveStock(ctx, m, -q, '生产领料', o.no, p.name, { date: o.date, wh });
      total += q * r.unit;
      i.mats.push({ productId: m.id, qty: q, cost: round4(r.unit), ...(r.alloc ? { batches: r.alloc.map(({ no, expDate, qty }) => ({ no, expDate, qty })) } : {}) });
    }
    i.price = round4(total / i.qty);
    if (i.rate) i.uprice = round4(i.price * i.rate);
  }
}
function bomReturn(ctx, o, reason) {
  const wh = o.wh || DEFAULT_WH;
  o.items.forEach(i => (i.mats || []).forEach(x => {
    const m = get('products', x.productId); if (!m) return;
    moveStock(ctx, m, x.qty, '作废冲回', o.no, reason || '生产入库作废，原料退回', { price: x.cost, wh, alloc: m.batch && x.batches ? x.batches : undefined, undo: o.no, voided: true });
  }));
}
/* ---------- BOM 自动组装 / 拆卸：一次操作生成成对的两张出入库单，物料和成品同时变动 ----------
   组装：按 BOM 领料出库（组装出库），成品按物料实际成本入库（组装入库）
   拆卸：成品按当前成本出库（拆卸出库），成本按各物料 BOM 金额比例分摊回物料入库（拆卸入库） */
function bomTransform(ctx, mode) {
  return tx(() => {
    const b = ctx.body || {};
    const p = get('products', str(b.productId, 40)) || fail('商品不存在或已删除', 404);
    const qty = Number(b.qty);
    if (!Number.isInteger(qty) || qty <= 0) fail('数量必须是正整数');
    if (p.serial) fail(`「${p.name}」启用了序列号，暂不支持自动组装 / 拆卸，请用出入库单逐号登记`);
    const date = isDate(b.date) ? b.date : today();
    if (date > today()) fail('单据日期不能晚于今天');
    if (date !== today() && !ctx.perms.has('inv.backdate')) fail('没有补录权限，只能开当天的单据', 403);
    if (!ctx.perms.has('inv.out') || !ctx.perms.has('inv.in')) fail('组装 / 拆卸需要同时具备入库和出库权限', 403);
    if (needApprove('out') || needApprove('in')) fail('已开启出入库审核，不能直接执行自动组装 / 拆卸，请通过出入库单提交审核');
    const wh = pickWh(b.wh), remark = str(b.remark, 500);
    const lines = p.bom || [];
    if (!lines.length) fail(`「${p.name}」还没有设置 BOM，请先在商品档案里设置`);
    const plan = lines.filter(l => l.productId).map(l => {
      const m = get('products', l.productId) || fail('BOM 里的物料已被删除，请先修改 BOM');
      const need = round4(l.qty * qty);
      if (Math.abs(need - Math.round(need)) > 1e-6) fail(`「${p.name}」${qty} ${p.unit}需要「${m.name}」${need}，库存按整数计，请调整 BOM 用量或数量`);
      return { m, need: Math.round(need) };
    });
    if (!plan.length) fail('BOM 里没有商品档案内的物料，不能自动组装 / 拆卸');
    const base = { wh, date, time: hhmm(), party: '', handler: '', remark, status: '正常', creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), printCount: 0 };
    const group = uid();
    const external = round4(sum(lines.filter(l => !l.productId), l => (+l.qty || 0) * qty * (+l.price || 0)));
    let out, into;
    if (mode === 'assemble') {
      const lack = plan.filter(x => whQty(x.m, wh) < x.need);
      if (lack.length) fail('物料不足，不能组装：' + lack.map(x => `${x.m.name}（需 ${x.need}，${whName(wh)}现有 ${whQty(x.m, wh)}）`).join('、'));
      const noOut = nextNo(DOC.out), noIn = nextNo(DOC.in);
      out = { id: uid(), no: noOut, dir: 'out', type: '组装出库', ...base,
        items: plan.map(x => ({ productId: x.m.id, qty: x.need, note: `${p.name} 组装领料` })),
        bomGroup: group, bomMode: mode, bomProduct: p.id };
      postStockDoc(ctx, out);
      const total = round4(sum(out.items, i => i.price * i.qty) + external);
      into = { id: uid(), no: noIn, dir: 'in', type: '组装入库', ...base,
        items: [{ productId: p.id, qty, price: round4(total / qty), note: external ? '含 BOM 档案外物料成本' : '' }],
        bomGroup: group, bomMode: mode, bomProduct: p.id };
      postStockDoc(ctx, into);
      put('stockDocs', out); put('stockDocs', into);
      audit(ctx, 'BOM 组装', `${p.name} × ${qty}，${noOut} / ${noIn}`);
    } else {
      const have = whQty(p, wh);
      if (have < qty) fail(`成品不足，不能拆卸：${p.name}（需 ${qty}，${whName(wh)}现有 ${have}）`);
      const noOut = nextNo(DOC.out), noIn = nextNo(DOC.in);
      out = { id: uid(), no: noOut, dir: 'out', type: '拆卸出库', ...base,
        items: [{ productId: p.id, qty, note: `${p.name} 拆卸` }],
        bomGroup: group, bomMode: mode, bomProduct: p.id };
      postStockDoc(ctx, out);
      const total = round4(out.items[0].price * qty);
      const weights = plan.map(x => x.need * ((x.m.cost || 0)));
      const wsum = sum(weights, x => x), qsum = sum(plan, x => x.need);
      into = { id: uid(), no: noIn, dir: 'in', type: '拆卸入库', ...base,
        items: plan.map((x, i) => {
          const amount = wsum > 0 ? total * weights[i] / wsum : (qsum > 0 ? total * x.need / qsum : 0);
          return { productId: x.m.id, qty: x.need, price: round4(amount / x.need), note: `${p.name} 拆卸入库` };
        }),
        bomGroup: group, bomMode: mode, bomProduct: p.id };
      postStockDoc(ctx, into);
      put('stockDocs', out); put('stockDocs', into);
      audit(ctx, 'BOM 拆卸', `${p.name} × ${qty}，${noOut} / ${noIn}`);
    }
    const showCost = ctx.perms.has('inv.cost');
    const view = d => ({ id: d.id, no: d.no, type: d.type, items: showCost ? d.items : d.items.map(i => ({ productId: i.productId, qty: i.qty })) });
    return { mode, product: p.name, productId: p.id, qty, wh, date,
      ...(showCost ? { unitCost: mode === 'assemble' ? into.items[0].price : out.items[0].price } : {}),
      out: view(out), in: view(into) };
  });
}
function prepareStockDoc(ctx, dir, b, excludeDocId = null) {
  const D = DOC[dir];
  if (!DOC_TYPES[dir].includes(b.type)) fail('请选择' + D.title.slice(0, 2) + '类型');
  const date = isDate(b.date) ? b.date : today();
  if (date > today()) fail('单据日期不能晚于今天');
  if (date !== today() && !ctx.perms.has('inv.backdate')) fail('没有补录权限，只能开当天的单据', 403);
  const srcKind = b.srcOrderId ? (b.srcOrderKind === 'purchase' || (!b.srcOrderKind && dir === 'in') ? 'purchase' : 'sales') : '';
  const srcOrder = srcKind ? get(srcKind === 'sales' ? 'sales' : 'purchases', str(b.srcOrderId, 64)) : null;
  if (b.srcOrderId && !srcOrder) fail('来源订单不存在');
  const canInPrice = seesCost(ctx.perms) || (srcKind === 'purchase' && !!srcOrder);
  const canOutSale = seesSalePrice(ctx.perms) || (srcKind === 'sales' && !!srcOrder);
  const wh = pickWh(b.wh);
  const items = (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId).map(i => {
    const p = get('products', i.productId) || fail('商品不存在或已删除');
    const l = unitQty(p, i);
    // 出库按设置的成本口径计价；入库可填单价（所选单位的单价；看不到成本价的账号按当前成本，来源采购订单按订单净单价）
    const poLine = srcKind === 'purchase' && srcOrder ? (srcOrder.items || []).find(x => x.productId === p.id) : null;
    const poUnitPrice = poLine ? round6(orderLineEffectiveBasePrice(srcOrder, poLine) * (l.rate || 1)) : null;
    const price = dir === 'in' && canInPrice
      ? (i.price !== undefined && i.price !== '' ? Number(i.price) : (poUnitPrice != null ? poUnitPrice : (p.cost || 0) * (l.rate || 1)))
      : (p.cost || 0) * (l.rate || 1);
    if (!Number.isFinite(price) || price < 0) fail(`「${p.name}」单价不正确`);
    const it = { productId: p.id, ...l, price: dir === 'in' ? basePrice(round6(price), l) : 0, ...(dir === 'in' && l.rate ? { uprice: round6(price) } : {}), note: str(i.note, 100) };
    // 出库单价（销售价）：有查看销售价权限或关联销售订单发货时允许记录；库存成本照旧按设置的成本口径
    if (dir === 'out' && canOutSale && i.sale !== undefined && i.sale !== '' && i.sale !== null) {
      const sp = Number(i.sale);
      if (!Number.isFinite(sp) || sp < 0) fail(`「${p.name}」出库单价不正确`);
      it.sale = basePrice(round6(sp), l); if (l.rate) it.usale = round6(sp);
    }
    if (p.serial) it.serials = cleanSerials(p, i.serials, l.qty);
    if (dir === 'in' && p.batch) {
      it.batch = { no: str(i.batchNo, 40), prodDate: isDate(i.prodDate) ? i.prodDate : '', expDate: isDate(i.expDate) ? i.expDate : '' };
      if (it.batch.expDate && it.batch.prodDate && it.batch.expDate < it.batch.prodDate) fail(`「${p.name}」有效期早于生产日期`);
    }
    const preferId = i.preferBatch && typeof i.preferBatch === 'object' ? i.preferBatch.id : i.preferBatch;
    if (dir === 'out' && p.batch && preferId) {
      const bt = get('batches', str(preferId, 64)) || fail(`「${p.name}」所选批次不存在，请重新选择`);
      if (bt.productId !== p.id || bt.wh !== wh) fail(`「${p.name}」所选批次不在当前仓库`);
      it.preferBatch = { id: bt.id, no: bt.no, expDate: bt.expDate || '' };
    }
    return it;
  });
  if (!items.length) fail('请至少添加一个商品');
  let party = str(b.party, 100);
  if (srcOrder) {
    if (srcKind === 'sales' && (dir !== 'out' || b.type !== '销售出库' || srcOrder.status !== '待发货')) fail('只有待发货的销售订单可以生成销售出库单');
    if (srcKind === 'purchase' && (dir !== 'in' || b.type !== '采购入库' || srcOrder.status !== '已审核')) fail('只有已审核的采购订单可以生成采购入库单');
    validateSourceItems(srcOrder, srcKind, items.map(i => ({ productId: i.productId, qty: i.qty })), !!b.allowOver, excludeDocId);
    if (!party) party = (get(srcKind === 'sales' ? 'customers' : 'suppliers', srcOrder[srcKind === 'sales' ? 'customerId' : 'supplierId']) || {}).name || '';
  }
  if (dir === 'out') { const lack = lackOf(items, wh); if (lack.length) fail(lackText(lack, wh)); }
  const sn = items.flatMap(i => i.serials || []);
  if (new Set(sn).size < sn.length) fail('同一张单据里序列号有重复');
  items.forEach(i => { if (i.serials) checkSerials(get('products', i.productId), i.serials, dir === 'in' ? 1 : -1, wh); });
  const useBom = dir === 'in' && b.type === '生产入库' && !!b.bom;
  if (useBom && !ctx.perms.has('bom')) fail('没有权限：' + PERM_LABEL.bom + (enabledModules().includes('bom') ? '' : '（「生产 / BOM」模块未启用）'), 403);
  if (useBom && items.some(i => i.serials)) fail('按 BOM 领料的生产入库暂不支持序列号成品，请取消「按 BOM 领料」');
  return { wh, date, items, srcKind, srcOrder, party, useBom };
}
function saveStockDoc(ctx, noTx = false) {
  const b = ctx.body, dir = b.dir === 'out' ? 'out' : 'in', D = DOC[dir];
  const run = () => {
    const { wh, date, items, srcKind, srcOrder, party, useBom } = prepareStockDoc(ctx, dir, b, null);
    const pending = needApprove(dir);
    const o = { id: uid(), no: nextNo(D), dir, type: b.type, ...(useBom ? { bom: true } : {}), wh, date, time: hhmm(), party, handler: str(b.handler, 32), remark: str(b.remark, 500),
      ...(srcOrder ? { srcOrderId: srcOrder.id, srcOrderNo: srcOrder.no, srcOrderKind: srcKind } : {}),
      ...(str(b.project, 60) ? { project: str(b.project, 60) } : {}),
      ...(dir === 'out' && str(b.address, 200) ? { address: str(b.address, 200) } : {}), items, status: pending ? '待审核' : '正常', creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), printCount: 0 };
    if (!pending) postStockDoc(ctx, o);
    put('stockDocs', o);
    if (srcOrder) syncSourceOrder(ctx, o);
    audit(ctx, (pending ? '提交' : '新建') + D.title, `${o.no} ${o.type} ${items.length} 项`);
    return noTx ? o : maskStockDoc(ctx, o);
  };
  return noTx ? run() : tx(run);
}
function updateStockDoc(ctx, id) {
  return tx(() => {
    const o = get('stockDocs', id) || fail('单据不存在', 404);
    ownDoc(ctx, o);
    const dir = o.dir === 'out' ? 'out' : 'in';
    const needPerm = dir === 'out' ? 'inv.out' : 'inv.in';
    if (!ctx.perms.has(needPerm)) fail('没有权限：' + PERM_LABEL[needPerm], 403);
    if (o.status !== '待审核' && o.status !== '已驳回') fail('只有待审核或已驳回的单据可以直接修改；已生效单据请先作废');
    const b = ctx.body || {};
    const { wh, date, items, srcKind, srcOrder, party, useBom } = prepareStockDoc(ctx, dir, b, o.id);
    const prevSrc = o.srcOrderId ? { id: o.srcOrderId, kind: o.srcOrderKind } : null;
    o.type = b.type;
    if (useBom) o.bom = true; else delete o.bom;
    o.wh = wh; o.date = date; o.party = party; o.handler = str(b.handler, 32); o.remark = str(b.remark, 500);
    if (str(b.project, 60)) o.project = str(b.project, 60); else delete o.project;
    if (dir === 'out' && str(b.address, 200)) o.address = str(b.address, 200); else delete o.address;
    if (srcOrder) { o.srcOrderId = srcOrder.id; o.srcOrderNo = srcOrder.no; o.srcOrderKind = srcKind; }
    else { delete o.srcOrderId; delete o.srcOrderNo; delete o.srcOrderKind; }
    o.items = items;
    o.status = '待审核';
    o.editor = ctx.user.name; o.editedAt = new Date().toISOString();
    delete o.rejectReason; delete o.approver; delete o.approvedAt;
    put('stockDocs', o);
    if (prevSrc && (!srcOrder || prevSrc.id !== srcOrder.id)) syncSourceOrder(ctx, { dir, srcOrderId: prevSrc.id, srcOrderKind: prevSrc.kind });
    if (srcOrder) syncSourceOrder(ctx, o);
    audit(ctx, '修改待审' + DOC[dir].title, `${o.no} ${o.type} ${items.length} 项`);
    return maskStockDoc(ctx, o);
  });
}
function deleteStockDoc(ctx, id) {
  return tx(() => {
    const o = get('stockDocs', id) || fail('单据不存在', 404);
    if (o.status === '正常') fail('已生效的出入库单不能直接删除，请先作废');
    if (o.status === '已作废') {
      if (!ctx.perms.has('inv.void') && ctx.user.role !== 'admin') fail('没有权限：' + PERM_LABEL['inv.void'], 403);
      del('stockDocs', id);
      list('stockLogs').filter(l => l.ref === o.no).forEach(l => del('stockLogs', l.id));
      syncSourceOrder(ctx, o);
      audit(ctx, '删除作废单据', o.no);
      return { ok: true };
    }
    ownDoc(ctx, o);
    if (!ctx.perms.has('inv.void') && o.creatorId !== ctx.user.id) fail('没有权限：' + PERM_LABEL['inv.void'], 403);
    del('stockDocs', id);
    syncSourceOrder(ctx, o);
    audit(ctx, '删除未审核' + DOC[o.dir].title, o.no);
    return { ok: true };
  });
}
function importStockDocs(ctx) {
  const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : fail('没有可导入的单据数据');
  if (rows.length > 5000) fail('一次最多导入 5000 行');
  const groups = new Map(), products = list('products'), warehouses = list('warehouses'), customers = list('customers'), suppliers = list('suppliers');
  const dirOf = v => {
    const x = String(v || '').trim().toLowerCase();
    if (['in', '入库', '入库单'].includes(x)) return 'in';
    if (['out', '出库', '出库单'].includes(x)) return 'out';
    if (['sales', '销售', '销售单'].includes(x)) return 'sales';
    if (['purchase', '采购', '采购单'].includes(x)) return 'purchase';
    return fail(`方向「${v || ''}」不正确，请填入库、出库、销售或采购`);
  };
  rows.forEach((raw, i) => {
    const line = Number.isInteger(raw._row) ? raw._row : i + 2;
    const key = str(raw.doc, 40) || `第${line}行`;
    const dir = dirOf(raw.dir), date = String(raw.date || '').trim().replace(/\//g, '-') || today();
    if (!isDate(date)) fail(`第 ${line} 行：日期格式应为 YYYY-MM-DD`);
    if (date > today()) fail(`第 ${line} 行：单据日期不能晚于今天`);
    const rawType = String(raw.type || '').trim();
    const type = dir === 'in' || dir === 'out' ? (DOC_TYPES[dir].includes(rawType) ? rawType : (dir === 'in' ? '其他入库' : '其他出库')) : (dir === 'sales' ? '销售单' : '采购单');
    const whText = String(raw.wh || '').trim();
    const wh = whText ? (warehouses.find(w => w.name === whText || w.id === whText) || fail(`第 ${line} 行：仓库「${whText}」不存在`)).id : DEFAULT_WH;
    const code = String(raw.sku || raw.barcode || raw.name || '').trim();
    const p = products.find(x => x.sku === code) || products.find(x => x.barcode === code) || products.find(x => x.name === code);
    if (!p) fail(`第 ${line} 行：商品「${code || '空'}」不存在`);
    if (p.serial) fail(`第 ${line} 行：「${p.name}」启用了序列号，暂不支持批量导入`);
    if (p.batch) fail(`第 ${line} 行：「${p.name}」启用了批次，暂不支持批量导入`);
    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty <= 0) fail(`第 ${line} 行：数量必须是正整数`);
    let price = raw.price === '' || raw.price == null ? undefined : Number(raw.price);
    if (price !== undefined && (!Number.isFinite(price) || price < 0)) fail(`第 ${line} 行：单价不正确`);
    if ((dir === 'sales' || dir === 'purchase') && price === undefined) price = dir === 'sales' ? (p.price || 0) : (p.cost || 0);
    const item = { productId: p.id, unit: String(raw.unit || p.unit).trim() || p.unit, qty, ...(dir === 'out' ? { sale: price } : { price }) };
    const partyText = str(raw.party, 100);
    const party = dir === 'sales' ? customers.find(x => x.name === partyText || x.id === partyText) : dir === 'purchase' ? suppliers.find(x => x.name === partyText || x.id === partyText) : null;
    if ((dir === 'sales' || dir === 'purchase') && !party) fail(`第 ${line} 行：${dir === 'sales' ? '客户' : '供应商'}「${partyText || '空'}」不存在`);
    const g = groups.get(key) || { key, dir, type, date, wh, party: partyText, partyId: party ? party.id : '', address: str(raw.address, 200), handler: str(raw.handler, 32), project: str(raw.project, 60), remark: str(raw.remark, 500), items: [] };
    for (const [k, v] of Object.entries({ dir, type, date, wh, partyId: party ? party.id : '' })) if (g[k] !== v) fail(`第 ${line} 行：同一单据编号「${key}」的${k === 'dir' ? '方向' : k === 'type' ? '业务类型' : k === 'date' ? '日期' : k === 'wh' ? '仓库' : '往来单位'}不一致`);
    g.items.push(item); groups.set(key, g);
  });
  return tx(() => {
    const created = [];
    for (const g of groups.values()) {
      if (g.dir === 'in' && !ctx.perms.has('inv.in')) fail('没有权限批量导入入库单');
      if (g.dir === 'out' && !ctx.perms.has('inv.out')) fail('没有权限批量导入出库单');
      if (g.dir === 'sales' && !ctx.perms.has('sales')) fail('没有权限批量导入销售单');
      if (g.dir === 'purchase' && !ctx.perms.has('purchase')) fail('没有权限批量导入采购单');
      if (g.dir === 'sales' || g.dir === 'purchase') {
        created.push(saveOrder({ ...ctx, body: { partyId: g.partyId, date: g.date, address: g.address, handler: g.handler, remark: g.remark, items: g.items } }, g.dir, null, true));
      } else {
        created.push(saveStockDoc({ ...ctx, body: { dir: g.dir, type: g.type, date: g.date, wh: g.wh, party: g.party, handler: g.handler, project: g.project, remark: g.remark, items: g.items } }, true));
      }
    }
    audit(ctx, '批量导入单据', `${created.length} 张，${rows.length} 行`);
    return { docs: created.length, rows, numbers: created.map(o => o.no) };
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
    syncSourceOrder(ctx, o);
    audit(ctx, (pass ? '审核' : '驳回') + DOC[o.dir].title, o.no + (pass ? '' : ' ' + o.rejectReason));
    return maskStockDoc(ctx, o);
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
      syncSourceOrder(ctx, o);
      voidShipmentsOf('out', o.id);
      audit(ctx, '作废' + DOC[o.dir].title, o.no + (o.voidReason ? ' ' + o.voidReason : ''));
      return maskStockDoc(ctx, o);
    }
    if (!ctx.perms.has('inv.void')) fail('没有权限：' + PERM_LABEL['inv.void'], 403);
    if (o.srcOrderKind === 'grain') fail('粮食收购生成的入库单请在「粮食收购」页面作废');
    if (o.srcOrderKind === 'eng') fail('工程单生成的出库单请在「工程结算」页面作废');
    const isRetDoc = o.srcOrderKind === 'salesReturn' || o.srcOrderKind === 'purchaseReturn';
    const retOrd = isRetDoc && o.srcOrderId ? get(ORD[o.srcOrderKind].col, o.srcOrderId) : null;
    if (retOrd && (retOrd.refunded || 0) > 0) fail('关联退货单已有退款或冲抵记录，不能作废此出入库单');
    const need = qtyByProduct(o.items), wh = o.wh || DEFAULT_WH;
    if (o.dir === 'in') {  // 入库单作废要把货扣回来
      const lack = Object.entries(need).map(([pid, q]) => ({ p: get('products', pid), q })).filter(x => x.p && whQty(x.p, wh) < x.q);
      if (lack.length) fail('库存已被领用，无法作废：' + lack.map(x => `${x.p.name}（需扣回 ${x.q}，${whName(wh)}现有 ${whQty(x.p, wh)}）`).join('、'));
    }
    const reason = str(ctx.body.reason, 200);
    const undoRef = retOrd ? retOrd.no : o.no;
    // 保留现有流水并标记 voided，避免作废单据计入统计
    list('stockLogs').filter(l => (l.ref === o.no || (retOrd && l.ref === retOrd.no)) && !l.voided)
      .forEach(l => put('stockLogs', { ...l, voided: true }));
    // 入库单作废：按原入库单价冲减；出库单作废：按原出库成本退回；批次原路冲回
    o.items.forEach(i => {
      const p = get('products', i.productId); if (!p) return;
      const alloc = p.batch && i.batches ? i.batches : undefined;
      moveStock(ctx, p, o.dir === 'in' ? -i.qty : i.qty, '作废冲回', o.no, reason, o.dir === 'in' ? { reversePrice: i.price, wh, alloc, undo: undoRef, voided: true } : { price: i.price, wh, alloc, undo: undoRef, voided: true });
    });
    if (o.dir === 'in' && o.bom) bomReturn(ctx, o, reason);  // 生产入库：领用的原料退回
    if (retOrd && retOrd.status !== '已作废') {
      retOrd.status = ORD[o.srcOrderKind].statuses[0];
      delete retOrd.stockDocId; delete retOrd.stockDocNo; delete retOrd.postDate; delete retOrd.approver; delete retOrd.approvedAt; delete retOrd.approveNote;
      put(ORD[o.srcOrderKind].col, retOrd);
    }
    Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: reason });
    put('stockDocs', o);
    syncSourceOrder(ctx, o);
    voidShipmentsOf('out', o.id);
    audit(ctx, '作废' + DOC[o.dir].title, o.no + (reason ? ' ' + reason : ''));
    return maskStockDoc(ctx, o);
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
  const wh = o.wh || DEFAULT_WH;
  const byId = new Map(o.lines.map(l => [l.productId, l]));
  for (const x of Array.isArray(lines) ? lines : []) {
    if (!x || !x.productId) continue;
    const p = get('products', x.productId);
    let l = byId.get(x.productId);
    if (!l && x.add && p) {
      l = { productId: p.id, book: whQty(p, wh), counted: null };
      o.lines.push(l);
      byId.set(p.id, l);
    }
    if (!l) continue;
    if (x.counted === null || x.counted === '' || x.counted === undefined) { l.counted = null; continue; }
    const n = Number(x.counted);
    if (p && p.dec) {
      const r = round2(n);
      if (!Number.isFinite(n) || n < 0 || Math.abs(n - r) > 1e-9) fail('实盘数量必须是非负数字（最多两位小数）');
      l.counted = r;
    } else {
      if (!Number.isInteger(n) || n < 0) fail('实盘数量必须是非负整数');
      l.counted = n;
    }
  }
}
function createCheck(ctx) {
  const b = ctx.body, cat = str(b.category, 50), empty = !!b.empty;
  let ps = empty ? [] : list('products');
  if (!empty) {
    if (cat) ps = ps.filter(p => p.category === cat);
    if (Array.isArray(b.productIds) && b.productIds.length) { const s = new Set(b.productIds); ps = ps.filter(p => s.has(p.id)); }
    if (!ps.length) fail('没有符合条件的商品');
    ps.sort((x, y) => String(x.sku).localeCompare(String(y.sku)));
  }
  const wh = pickWh(b.wh);
  const scope = empty ? (str(b.scope, 60) || '扫码自由盘点') : (cat ? '分类：' + cat : b.productIds && b.productIds.length ? `指定 ${ps.length} 个商品` : '全部商品');
  return tx(() => {
    const o = { id: uid(), no: nextNo(CHECK), wh, date: today(), time: hhmm(), scope,
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
  return maskCheckDoc(ctx, o);
});
const postCheck = (ctx, id) => editCheck(ctx, id, o => {
  if (ctx.body.lines !== undefined) {
    if (!ctx.perms.has('inv.check')) fail('没有实盘录入权限，审核时不能修改实盘数量', 403);
    applyCounts(o, ctx.body.lines);
  }
  const counted = o.lines.filter(l => l.counted != null);
  if (!counted.length) fail('还没有录入任何实盘数量');
  let gain = 0, loss = 0;
  const wh = o.wh || DEFAULT_WH;
  for (const l of counted) {
    const p = get('products', l.productId); if (!p) continue;
    const book = whQty(p, wh);
    l.bookAtPost = book; l.diff = round2(l.counted - book); l.cost = p.cost || 0;
    if (l.diff > 0) gain = round2(gain + l.diff); else loss = round2(loss - l.diff);
    if (l.diff) moveStock(ctx, p, l.diff, l.diff > 0 ? '盘盈' : '盘亏', o.no, '', { wh, batch: { no: '盘盈' + o.no } });
  }
  Object.assign(o, { status: '已完成', poster: ctx.user.name, postedAt: new Date().toISOString(), postDate: today() });
  put('checkDocs', o);
  audit(ctx, '审核盘点单', `${o.no} 盘盈 ${gain} 盘亏 ${loss}`);
  return maskCheckDoc(ctx, o);
});
const voidCheck = (ctx, id) => editCheck(ctx, id, o => {
  Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString() });
  put('checkDocs', o); audit(ctx, '作废盘点单', o.no);
  return maskCheckDoc(ctx, o);
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
    return maskTransfer(ctx, o);
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
    list('stockLogs').filter(l => l.ref === o.no && !l.voided).forEach(l => put('stockLogs', { ...l, voided: true }));
    o.items.forEach(i => {
      const p = get('products', i.productId); if (!p) return;
      const alloc = p.batch && i.batches ? i.batches : undefined;
      const back = moveStock(ctx, p, -i.qty, '作废冲回', o.no, reason, { wh: o.to, alloc, undo: o.no, voided: true });
      moveStock(ctx, get('products', i.productId), i.qty, '作废冲回', o.no, reason, { wh: o.from, price: back.unit, alloc: back.alloc, undo: o.no, voided: true });
    });
    Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: reason });
    put('transferDocs', o); audit(ctx, '作废调拨单', o.no + (reason ? ' ' + reason : ''));
    return maskTransfer(ctx, o);
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
    return maskCarrier(c);
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
    const c = o.party ? (list('customers').find(x => x.name === o.party) || {}) : {};
    return { type, id: o.id, no: o.no, party: o.party || '', customerId: c.id || '', address: o.address || c.address || '', mobile: c.phone || '', items: o.items };
  }
  if (type === 'sales') {
    const o = get('sales', id) || fail('销售单不存在');
    if (o.status === '已作废') fail('销售单已作废');
    const c = get('customers', o.customerId) || {};
    return { type, id: o.id, no: o.no, party: c.name || '', customerId: o.customerId || '', address: o.address || c.address || '', mobile: c.phone || '', items: o.items };
  }
  fail('来源单据类型不正确');
}
const cleanSubTracks = (raw, master) => {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,，;；]+/);
  return [...new Set(arr.map(normTrack).filter(t => t && t !== master))].slice(0, 50);
};
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
      const customerId = str(b.customerId, 64) || (src && src.customerId) || '';
      const custRec = customerId ? get('customers', customerId) : null;
      const subTracks = cleanSubTracks(x.subTracks != null ? x.subTracks : (first ? b.subTracks : []), trackNo);
      const s = { id: uid(), no: nextNo(SHIP), date, carrierId: c.id, trackNo, ...(subTracks.length ? { subTracks } : {}), srcType: src ? src.type : '', srcId: src ? src.id : '', srcNo: src ? src.no : '',
        customerId: custRec ? custRec.id : '', party: str(b.party, 100) || (custRec ? custRec.name : '') || (src ? src.party : ''), mobile: str(b.mobile, 30) || (custRec ? custRec.phone || '' : ''), address, province, weight: q.weight, weighed: !!w, vol, volWeight: q.volWeight, chargeWeight: q.chargeWeight,
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
    const customerId = 'customerId' in b ? str(b.customerId, 64) : (s.customerId || '');
    const custRec = customerId ? get('customers', customerId) : null;
    const subTracks = 'subTracks' in b ? cleanSubTracks(b.subTracks, trackNo) : (s.subTracks || []);
    Object.assign(s, { carrierId: c.id, trackNo, subTracks, customerId: custRec ? custRec.id : '', party: 'party' in b ? str(b.party, 100) : s.party, address, province, weight: q.weight, weighed: s.weighed || w !== s.weight, volWeight: q.volWeight, chargeWeight: q.chargeWeight,
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
const shipExpense = (ctx, amount, ref, note) => { const a = pickAccount({ method: '银行转账' }); put('finance', { id: uid(), date: today(), type: 'expense', category: '快递费', amount: round2(amount), account: a.id, method: a.kind, ref, note, operator: ctx.user.name }); };
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
  tx(() => { put('shipLabels', { id: out[0].id, html: sanitizeLabelHtml(r.PrintTemplate || ''), at: new Date().toISOString() }); audit(ctx, '电子面单下单', `${c.name} ${trackNo}`); });
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
  const update = ctx.body.update !== false, canC = seesCost(ctx.perms), canP = seesSalePrice(ctx.perms);
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
      for (const k of ['name', 'spec', 'brand', 'category', 'unit', 'buyUnit', 'saleUnit', 'remark']) if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') fields[k] = str(raw[k], k === 'remark' ? 500 : 200);
      const old = bySku.get(sku);
      if (old && fields.unit && fields.unit !== old.unit && productBaseUnitUsed(old)) return err('基本单位已经使用过，不能修改');
      if (raw.barcode !== undefined && raw.barcode !== null && String(raw.barcode).trim() !== '') fields.barcode = str(raw.barcode, 64);
      if (raw.units !== undefined && raw.units !== null && String(raw.units).trim() !== '') {
        try { fields.units = cleanUnits(parseUnitsText(raw.units), fields.unit || (old && old.unit) || '个'); } catch (e) { return err(e.message); }
      }
      const unitNames = new Set([fields.unit || (old && old.unit) || '个', ...((fields.units || (old && old.units) || []).map(u => u.name))]);
      for (const [k, label] of [['buyUnit', '默认采购单位'], ['saleUnit', '默认销售单位']]) {
        const name = fields[k] || (old && old[k]);
        if (name && !unitNames.has(name)) return err(`${label}「${name}」不在该商品的单位设置里`);
      }
      // 条码（含辅助单位条码）不能和别的商品重复
      const mine = [fields.barcode ?? (old && old.barcode), ...(fields.units || (old && old.units) || []).map(u => u.barcode)].filter(Boolean);
      if (new Set(mine).size < mine.length) return err('条码重复：商品条码和各单位条码不能相同');
      const clash = mine.find(c => codeOwner.has(c) && codeOwner.get(c) !== sku);
      if (clash) return err(`条码 ${clash} 已被商品 ${codeOwner.get(clash)} 使用`);
      mine.forEach(c => codeOwner.set(c, sku));
      if (safety !== undefined) fields.safety = safety;
      if (weight !== undefined) fields.weight = round3(weight);
      if (canP && price !== undefined) fields.price = round2(price);
      const p = bySku.get(sku);
      if (p) {
        if (!update) { skipped++; return; }
        Object.assign(p, fields);
        if (canC && cost !== undefined && p.stock === 0) p.cost = cost;  // 有库存时成本由成本口径决定，不覆盖
        put('products', p); updated++;
        return;
      }
      if (!name) return err('新商品必须填写商品名称');
      const np = { id: uid(), sku, name, spec: '', brand: '', category: '', unit: '个', price: 0, safety: 0, remark: '', ...fields, cost: canC && cost !== undefined ? cost : 0, stock: 0, createdAt: today() };
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
    products: any('inv.view', 'prod.view', 'sales', 'purchase', 'agri', 'dashboard', 'reports'),
    stockLogs: any('inv.view', 'dashboard'), stockDocs: P.has('inv.view'), checkDocs: P.has('inv.view'),
    sales: any('sales', 'dashboard', 'reports', 'parties'), purchases: any('purchase', 'dashboard', 'reports', 'parties'),
    salesReturns: any('sales', 'dashboard', 'reports', 'parties'), purchaseReturns: any('purchase', 'dashboard', 'reports', 'parties'),
    customers: any('sales', 'parties', 'dashboard', 'reports'), suppliers: any('purchase', 'parties'),
    finance: any('finance', 'sales', 'purchase', 'reports', 'agri'), partyPayments: any('finance', 'parties', 'sales', 'purchase'), projects: P.has('inv.view') || any('sales', 'purchase'), employees: P.has('hr'),
    warehouses: true, transferDocs: P.has('inv.view'), batches: any('inv.view', 'prod.view'), serials: P.has('inv.view'),
    carriers: any('ship.view', 'ship.edit', 'ship.rate'), shipments: any('ship.view', 'ship.edit'), shipBills: P.has('ship.view'), shipLabels: false,
    accounts: any('finance', 'sales', 'purchase', 'ship.bill', 'expense', 'agri'), acctTransfers: P.has('finance'), expenses: enabledModules().includes('finance'),
    advances: enabledModules().includes('finance'),
    deliveries: any('ship.view', 'ship.edit', 'sales'),
    invoices: P.has('finance'),
    grainDocs: any('agri', 'finance', 'reports'),
    contracts: any('sales', 'purchase', 'agri', 'finance'),
    contractTpls: any('sales', 'purchase', 'agri', 'finance'),
    attendance: any('hr', 'finance'),
    payrolls: any('hr', 'finance'),
    fixedAssets: P.has('finance'),
    engJobs: any('sales', 'inv.out', 'finance'),
    fieldPlots: P.has('agri'),
    farmLogs: P.has('agri')
  };
  const byDate = (a, b) => ((b.date || '') + (b.time || '')).localeCompare((a.date || '') + (a.time || ''));
  const data = {};
  COLS.forEach(c => { data[c] = want[c] ? list(c) : []; if (DATED.includes(c)) data[c].sort(byDate); });
  if (data.employees.length) {
    const uById = new Map(db.prepare('SELECT id, username, name FROM users WHERE disabled = 0').all().map(u => [u.id, u]));
    data.employees = data.employees.map(e => {
      const u = e.userId ? uById.get(e.userId) : null;
      return u ? { ...e, name: u.name, username: u.username } : e;
    });
  }
  if (!seesCost(P)) {
    data.products = data.products.map(({ cost, ...p }) => p.bom ? { ...p, bom: p.bom.map(({ price, ...l }) => l) } : p);
    data.sales = data.sales.map(o => ({ ...o, items: (o.items || []).map(({ cost, ...i }) => i) }));
    data.salesReturns = data.salesReturns.map(o => ({ ...o, items: (o.items || []).map(({ cost, ...i }) => i) }));
    data.stockDocs = data.stockDocs.map(o => ({ ...o, items: o.items.map(({ price, uprice, ...i }) => i) }));
    data.transferDocs = data.transferDocs.map(o => ({ ...o, items: o.items.map(({ cost, ...i }) => i) }));
    data.stockLogs = data.stockLogs.map(({ cost, costAfter, ...l }) => l);
    data.checkDocs = data.checkDocs.map(o => ({ ...o, lines: o.lines.map(({ cost, ...l }) => l) }));
    data.engJobs = data.engJobs.map(o => ({ ...o, items: (o.items || []).map(({ cost, ...i }) => i) }));
  }
  if (!seesSalePrice(P)) {
    data.products = data.products.map(({ price, ...p }) => p);
    for (const c of ['customers', 'suppliers']) data[c] = data[c].map(({ prices, openingBalance, ...r }) => r);
    data.stockDocs = data.stockDocs.map(d => ({ ...d, items: d.items.map(({ sale, usale, ...i }) => i) }));
  }
  if (!P.has('bom')) data.products = data.products.map(({ bom, ...p }) => p);
  if (!expAll(P)) data.expenses = data.expenses.filter(o => expCanView(o, ctx));
  if (!expAll(P)) data.advances = data.advances.filter(a => advIsOwner(a, ctx));
  data.shipBills = data.shipBills.map(({ rows, ...b }) => b);  // 账单明细可能上万行，打开账单时再单独取
  // 电子面单密码不下发，只告诉前端有没有设置
  data.carriers = data.carriers.map(c => c.eo ? { ...c, eo: { ...c.eo, customerPwd: '', pwdSet: !!c.eo.customerPwd } } : c);
  // 有审核权限的账号即使不能看他人单据，也能看到待审核的出入库单；退货单自动生成的出入库单对仓储人员可见
  if (!P.has('inv.others')) for (const c of ['stockDocs', 'checkDocs', 'transferDocs']) data[c] = data[c].filter(o => o.creatorId === ctx.user.id || (c === 'stockDocs' && ((o.status === '待审核' && P.has('inv.approve')) || ['salesReturn', 'purchaseReturn'].includes(o.srcOrderKind))));
  // 客户归属与业务员客户隔离（#128）
  if (!allParties(ctx)) {
    const visCustIds = new Set(data.customers.filter(c => canSeeCustomer(c, ctx)).map(c => c.id));
    data.customers = data.customers.filter(c => visCustIds.has(c.id));
    data.sales = data.sales.filter(o => visCustIds.has(o.customerId) || isOwnOrder(o, ctx));
    data.salesReturns = data.salesReturns.filter(o => visCustIds.has(o.customerId) || isOwnOrder(o, ctx));
  }
  if (data.contracts.length) {
    data.contracts = data.contracts.filter(o => canSeeContract(o, ctx));
  }
  // 统计报表个人数据隔离（#130：无 reports.all 时只看个人相关，不暴露公司经营支出、采购成本或他人收款）
  if (ctx.user.role !== 'admin' && !P.has('reports.all')) {
    const visCustIds = new Set(data.customers.filter(c => canSeeCustomer(c, ctx)).map(c => c.id));
    if (allParties(ctx) && !P.has('sales')) data.customers = data.customers.filter(c => visCustIds.has(c.id));
    if (!P.has('sales')) {
      data.sales = data.sales.filter(o => isOwnOrder(o, ctx));
      data.salesReturns = data.salesReturns.filter(o => isOwnOrder(o, ctx));
    }
    if (!P.has('purchase')) {
      data.purchases = data.purchases.filter(o => isOwnOrder(o, ctx));
      data.purchaseReturns = data.purchaseReturns.filter(o => isOwnOrder(o, ctx));
    }
    if (!P.has('agri')) {
      data.grainDocs = data.grainDocs.filter(o => o.creatorId === ctx.user.id);
    }
    if (!P.has('finance')) {
      const visOrderNos = new Set([...data.sales, ...data.salesReturns, ...data.purchases, ...data.purchaseReturns, ...data.grainDocs].map(o => o.no));
      data.partyPayments = data.partyPayments.filter(pp => pp.operator === ctx.user.name || pp.creatorId === ctx.user.id || (pp.partyType === 'customer' && visCustIds.has(pp.partyId)));
      const visPpNos = new Set(data.partyPayments.map(pp => pp.no));
      data.finance = data.finance.filter(f => (f.ref && (visOrderNos.has(f.ref) || visPpNos.has(f.ref))) || (['销售收款', '销售退款', '销售收款(核销)'].includes(f.category) && f.operator === ctx.user.name));
    }
  }
  return data;
}

const AUTO_CATS = [...Object.values(ORD).map(C => C.fin[1]), '农产品收购'];  // 单据自动生成的科目，手工不能记
function cleanFinance(b, keep) {
  const type = b.type === 'income' ? 'income' : b.type === 'expense' ? 'expense' : fail('收支类型不正确');
  const category = str(b.category, 20) || fail('请填写科目');
  if (AUTO_CATS.includes(category)) fail(`「${category}」由单据自动生成，请到对应单据里登记`);
  const amount = round2(Number(b.amount));
  if (!(amount > 0)) fail('金额必须大于 0');
  if (!isDate(b.date)) fail('日期格式不正确');
  const a = pickAccount(b, keep);
  return { date: b.date, type, category, amount, account: a.id, method: a.kind, note: str(b.note) };
}
function addFinance(ctx) {
  return tx(() => {
    const r = { id: uid(), ...cleanFinance(ctx.body), ref: '', operator: ctx.user.name }; put('finance', r); audit(ctx, '记账', `${r.type === 'income' ? '收入' : '支出'} ${r.category} ${r.amount}`);
    return r;
  });
}
function editFinance(ctx, id) {
  return tx(() => {
    const f = get('finance', id) || fail('记录不存在', 404);
    if (f.ref) fail('单据生成的收付款不能在这里修改，请到对应单据里处理');
    Object.assign(f, cleanFinance(ctx.body, f.account), { editor: ctx.user.name });
    put('finance', f); audit(ctx, '修改记账', `${f.type === 'income' ? '收入' : '支出'} ${f.category} ${f.amount}`);
    return f;
  });
}
function deleteFinance(ctx, id) {
  return tx(() => {
    const f = get('finance', id) || fail('记录不存在', 404);
    if (f.ref) fail('由单据生成的收付款记录不能直接删除');
    del('finance', id); audit(ctx, '删除流水', `${f.category} ${f.amount}`);
  });
}

/* ---------- 发票管理（销项 / 进项发票，#131） ---------- */
const INV = { col: 'invoices', prefix: 'FP', title: '发票' };
const INV_STATUSES = ['待开具', '已开具', '待收票', '已收票', '已作废'];
function saveInvoice(ctx, id) {
  return tx(() => {
    const b = ctx.body || {};
    const existing = id ? (get('invoices', id) || fail('发票记录不存在', 404)) : null;
    const dir = b.dir === 'in' ? 'in' : b.dir === 'out' ? 'out' : (existing ? existing.dir : fail('请选择发票类型（销项/进项）'));
    const date = isDate(b.date) ? b.date : (existing ? existing.date : today());
    const amount = round2(Number(b.amount));
    if (!Number.isFinite(amount) || !(amount > 0)) fail('含税金额必须大于 0');
    const taxRate = round2(Number(b.taxRate ?? (existing ? existing.taxRate : 0)));
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) fail('税率需在 0 ~ 100 之间');
    const netAmount = round2(amount / (1 + taxRate / 100));
    const taxAmount = round2(amount - netAmount);
    const partyId = str(b.partyId, 64);
    const pt = partyId ? (get(dir === 'out' ? 'customers' : 'suppliers', partyId) || get('customers', partyId) || get('suppliers', partyId)) : null;
    const partyName = str(b.partyName, 100) || (pt ? pt.name : '') || fail('请填写开票 / 收票单位名称');
    const taxId = str(b.taxId || (pt && pt.taxId) || '', 40);
    let orderKind = str(b.orderKind, 30), orderId = str(b.orderId, 64), orderNo = '';
    if (orderId && orderKind) {
      const col = orderKind === 'grain' ? 'grainDocs' : (ORD[orderKind] && ORD[orderKind].col);
      if (!col) fail('关联单据类型不正确');
      const ord = get(col, orderId) || fail('关联订单不存在', 404);
      orderNo = ord.no;
    } else { orderKind = ''; orderId = ''; }
    const defaultStatus = dir === 'out' ? '已开具' : '待收票';
    const status = b.status ? (INV_STATUSES.includes(b.status) ? b.status : fail('发票状态不正确')) : (existing ? existing.status : defaultStatus);
    const invType = str(b.invType, 30) || (existing && existing.invType) || '增值税普通发票';
    const rec = {
      id: existing ? existing.id : uid(),
      no: existing ? existing.no : nextNo(INV),
      dir, invType,
      invNo: str(b.invNo, 60),
      invCode: str(b.invCode, 40),
      date,
      partyType: dir === 'out' ? 'customer' : 'supplier',
      partyId: pt ? pt.id : '',
      partyName,
      taxId,
      orderKind, orderId, orderNo,
      title: str(b.title, 120),
      taxRate, amount, netAmount, taxAmount, status,
      note: str(b.note, 300),
      creator: existing ? existing.creator : ctx.user.name,
      creatorId: existing ? existing.creatorId : ctx.user.id,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      ...(existing ? { editor: ctx.user.name, editedAt: new Date().toISOString() } : {})
    };
    put('invoices', rec);
    audit(ctx, (existing ? '修改' : '登记') + (dir === 'out' ? '销项发票' : '进项发票'), `${rec.no} ${rec.partyName} ¥${rec.amount.toFixed(2)}`);
    return rec;
  });
}
function deleteInvoice(ctx, id) {
  return tx(() => {
    const r = get('invoices', id) || fail('发票记录不存在', 404);
    if (r.status === '已开具' || r.status === '已收票') fail('已生效发票请先改为「已作废」后再删除');
    del('invoices', id);
    audit(ctx, '删除发票', r.no);
    return { ok: true };
  });
}

/* ---------- 农业 / 粮食购销过磅（#135 + #141/#147/#148/#155） ---------- */
const GRAIN = { col: 'grainDocs', prefix: 'SL', title: '收粮单' };
const GRAIN_OUT = { col: 'grainDocs', prefix: 'GL', title: '售粮单' };
function createGrainDoc(ctx) {
  return tx(() => {
    const b = ctx.body || {};
    const dir = b.dir === 'out' ? 'out' : 'in';
    const date = isDate(b.date) ? b.date : today();
    if (date > today()) fail((dir === 'out' ? '出库' : '收购') + '日期不能晚于今天');
    const partyType = b.partyType === 'supplier' || b.partyType === 'customer' ? b.partyType : '';
    const partyId = str(b.partyId, 64);
    const partyRec = partyId ? (get(partyType === 'supplier' ? 'suppliers' : partyType === 'customer' ? 'customers' : (dir === 'out' ? 'customers' : 'suppliers'), partyId) || null) : null;
    const farmerName = str(b.farmerName, 60) || (partyRec ? partyRec.name : '') || fail(dir === 'out' ? '请填写客户 / 购粮单位' : '请填写农户 / 供应商姓名');
    const farmerPhone = str(b.farmerPhone, 30) || (partyRec ? partyRec.phone || '' : '');
    const farmerIdCard = str(b.farmerIdCard, 30);
    const category = ['自产', '外购', '烘干', '代售'].includes(b.category) ? b.category : '';
    const plateNo = str(b.plateNo, 20);
    const driverName = str(b.driverName, 40);
    const driverPhone = str(b.driverPhone, 30);
    const p = get('products', str(b.productId, 64)) || fail('请选择粮食品种');
    if (p.serial) fail(`「${p.name}」启用了序列号管理，不能用于粮食过磅`);
    const wh = pickWh(b.wh);
    const grossWeight = round3(Number(b.grossWeight || 0));
    const tareWeight = round3(Number(b.tareWeight || 0));
    let rawNet = 0;
    if (grossWeight > 0) {
      if (!Number.isFinite(tareWeight) || tareWeight < 0 || tareWeight >= grossWeight) fail('皮重不能为负且必须小于毛重');
      rawNet = round3(grossWeight - tareWeight);
    } else {
      rawNet = round3(Number(b.rawWeight || b.qty || 0));
    }
    if (!Number.isFinite(rawNet) || !(rawNet > 0)) fail('毛重减皮重（或毛净重）必须大于 0');
    const moisture = round2(Number(b.moisture || 0));
    const stdMoisture = round2(Number(b.stdMoisture ?? 14));
    const impurity = round2(Number(b.impurity || 0));
    if (!Number.isFinite(moisture) || moisture < 0 || moisture >= 100) fail('实测水份需在 0 ~ 99.99% 之间');
    if (!Number.isFinite(stdMoisture) || stdMoisture < 0 || stdMoisture >= 100) fail('标准水份需在 0 ~ 99.99% 之间');
    if (!Number.isFinite(impurity) || impurity < 0 || impurity >= 100) fail('杂质比例需在 0 ~ 99.99% 之间');
    const extraDeduct = round3(Number(b.extraDeduct || 0));
    if (!Number.isFinite(extraDeduct) || extraDeduct < 0) fail('其他扣重不能为负');
    const calcMode = ['deduct', 'dry', 'price'].includes(b.calcMode) ? b.calcMode : 'deduct';
    const deviation = dir === 'out' && Number.isFinite(Number(b.deviation)) ? round3(Number(b.deviation)) : 0;
    const moisturePricePerPt = round4(Math.max(0, Number(b.moisturePricePerPt || 0)));
    const impurityPricePerPt = round4(Math.max(0, Number(b.impurityPricePerPt || 0)));
    const moistureDiff = Math.max(0, round2(moisture - stdMoisture));
    let deductWeight = 0, netWeight = 0;
    if (calcMode === 'dry') {
      // #155 干粮折算公式：干粮重 = 潮粮重 × (1 - 实际水分) ÷ (1 - 标准水分)
      const dryW = round3(rawNet * (1 - moisture / 100) / (1 - stdMoisture / 100));
      const impW = round3(dryW * impurity / 100);
      netWeight = round3(dryW - impW - extraDeduct + deviation);
      deductWeight = round3(Math.max(0, rawNet - netWeight));
    } else if (calcMode === 'price') {
      // #141 按点扣价：重量仅扣手工其他扣重（加出库偏差），水分/杂质折算进单价
      deductWeight = b.deductWeight != null && b.deductWeight !== '' ? round3(Number(b.deductWeight)) : extraDeduct;
      netWeight = round3(rawNet - deductWeight + deviation);
    } else {
      const pctDeduct = round3(rawNet * (moistureDiff + impurity) / 100);
      deductWeight = b.deductWeight != null && b.deductWeight !== '' ? round3(Number(b.deductWeight)) : round3(pctDeduct + extraDeduct);
      if (!Number.isFinite(deductWeight) || deductWeight < 0 || deductWeight >= rawNet) fail('总扣重不能为负或大于等于毛净重');
      netWeight = round3(rawNet - deductWeight + deviation);
    }
    if (!(netWeight > 0)) fail('结算净重必须大于 0');
    const baseUnitPrice = round4(Number(b.unitPrice));
    if (!Number.isFinite(baseUnitPrice) || baseUnitPrice < 0) fail('请填写单价');
    const unitPrice = calcMode === 'price'
      ? round4(Math.max(0, baseUnitPrice - moistureDiff * moisturePricePerPt - impurity * impurityPricePerPt))
      : baseUnitPrice;
    const freightFee = round2(Math.max(0, Number(b.freightFee || 0)));
    const freightPayer = ['self', 'customer'].includes(b.freightPayer) ? b.freightPayer : '';
    const grossAmount = round2(netWeight * unitPrice);
    const totalAmount = freightPayer === 'self' && freightFee > 0 ? round2(Math.max(0, grossAmount - freightFee)) : grossAmount;

    // #147 出库混合销售按自称过磅比例分摊粮站结算重量/金额
    let splits = [];
    if (dir === 'out' && Array.isArray(b.splits) && b.splits.length) {
      const rawSplits = b.splits.map(x => ({
        customerId: str(x.customerId, 64),
        customerName: str(x.customerName, 60) || ((x.customerId && get('customers', str(x.customerId, 64)) || {}).name || ''),
        selfWeight: round3(Number(x.selfWeight || 0)),
        freightFee: round2(Math.max(0, Number(x.freightFee || 0))),
        freightPayer: ['self', 'customer'].includes(x.freightPayer) ? x.freightPayer : ''
      })).filter(x => x.customerName && x.selfWeight > 0);
      const sumSelf = rawSplits.reduce((n, x) => n + x.selfWeight, 0);
      if (sumSelf > 0) {
        const stationWeight = round3(Number(b.stationWeight || 0)) || netWeight;
        const stationAmount = round2(Number(b.stationAmount || 0)) || grossAmount;
        let remW = stationWeight, remA = stationAmount;
        splits = rawSplits.map((x, idx) => {
          const isLast = idx === rawSplits.length - 1;
          const ratio = round4(x.selfWeight / sumSelf);
          const allocWeight = isLast ? round3(Math.max(0, remW)) : round3(stationWeight * x.selfWeight / sumSelf);
          const allocAmount = isLast ? round2(Math.max(0, remA)) : round2(stationAmount * x.selfWeight / sumSelf);
          remW = round3(remW - allocWeight);
          remA = round2(remA - allocAmount);
          const settleAmount = x.freightPayer === 'self' && x.freightFee > 0 ? round2(Math.max(0, allocAmount - x.freightFee)) : allocAmount;
          return { ...x, ratio, allocWeight, allocAmount, settleAmount };
        });
      }
    }
    // #141 过磅照片（最多 4 张，单张 ≤ 800KB）
    const photos = (Array.isArray(b.photos) ? b.photos : []).filter(x => typeof x === 'string' && x.length <= 800000 && /^data:image\/(jpeg|png|webp);base64,/i.test(x)).slice(0, 4);

    const payNow = round2(Number(b.payNow || 0));
    if (!Number.isFinite(payNow) || payNow < 0 || payNow > totalAmount + 0.001) fail('实付/实收结算金额必须在 0 ~ 结算总额之间');
    if (dir === 'out' && whQty(p, wh) < netWeight - 1e-6) fail(`库存不足（需出库 ${netWeight}，${whName(wh)}现有 ${whQty(p, wh)}）`);

    const id = uid(), no = nextNo(dir === 'out' ? GRAIN_OUT : GRAIN);
    const stockType = dir === 'out' ? '销售出库' : '农产品收购';
    const moved = moveStock(ctx, p, dir === 'out' ? -netWeight : netWeight, stockType, no, farmerName + (plateNo ? ' · ' + plateNo : ''), { price: unitPrice, wh, date });
    const unitCost = dir === 'out' ? round4(moved.unit) : unitPrice;
    const stockDoc = {
      id: uid(), no: nextNo(DOC[dir]), dir, type: stockType, wh, date, time: hhmm(),
      party: farmerName + (plateNo ? ` (${plateNo})` : ''), handler: str(b.handler, 32) || ctx.user.name,
      remark: `${dir === 'out' ? '售粮单' : '收购单'} ${no}${category ? ' · ' + category : ''} · 净重 ${netWeight}${p.unit || ''}`,
      srcOrderId: id, srcOrderNo: no, srcOrderKind: 'grain',
      items: [{ productId: p.id, unit: p.unit || '', qty: netWeight, price: unitCost, ...(dir === 'out' ? { sale: unitPrice } : {}), note: `水分${moisture}% 杂质${impurity}%` }],
      status: '正常', creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), printCount: 0
    };
    put('stockDocs', stockDoc);

    let paid = 0;
    if (payNow > 0) {
      const acct = pickAccount(b);
      paid = payNow;
      put('finance', {
        id: uid(), date, type: dir === 'out' ? 'income' : 'expense', category: dir === 'out' ? '粮食销售' : '农产品收购',
        amount: payNow, account: acct.id, method: acct.kind, ref: no,
        note: `${dir === 'out' ? '售粮收款' : '收粮结算'} · ${farmerName}` + (plateNo ? ` · ${plateNo}` : ''), operator: ctx.user.name
      });
    }

    const doc = {
      id, no, dir, category, date, time: hhmm(),
      partyType: partyRec ? (partyType || (dir === 'out' ? 'customer' : 'supplier')) : '',
      partyId: partyRec ? partyRec.id : '',
      farmerName, farmerPhone, farmerIdCard, plateNo, driverName, driverPhone,
      productId: p.id, productName: p.name, unit: p.unit || '', wh,
      grossWeight, tareWeight, rawNet, calcMode, deviation,
      moisture, stdMoisture, impurity, extraDeduct, deductWeight, netWeight,
      baseUnitPrice, moisturePricePerPt, impurityPricePerPt, unitPrice, unitCost,
      grossAmount, freightFee, freightPayer, totalAmount, paid,
      ...(splits.length ? { splits } : {}),
      ...(photos.length ? { photos } : {}),
      stockDocId: stockDoc.id, stockDocNo: stockDoc.no,
      handler: str(b.handler, 32) || ctx.user.name,
      note: str(b.note, 300),
      status: '正常', creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString()
    };
    put('grainDocs', doc);
    audit(ctx, dir === 'out' ? '粮食销售出库' : '粮食收购', `${no} ${farmerName} ${p.name} 净重${netWeight} ¥${totalAmount.toFixed(2)}`);
    return doc;
  });
}
function payGrainDoc(ctx, id) {
  return tx(() => {
    const o = get('grainDocs', id) || fail('粮食单据不存在', 404);
    if (o.status === '已作废') fail('已作废单据不能结算');
    const b = ctx.body || {};
    const unpaid = round2(o.totalAmount - (o.paid || 0));
    const amount = round2(Number(b.amount));
    if (!(amount > 0) || amount > unpaid + 0.001) fail(`结算金额需在 0 ~ ${unpaid} 之间`);
    const acct = pickAccount(b);
    o.paid = round2((o.paid || 0) + amount);
    const isOut = o.dir === 'out';
    const f = {
      id: uid(), date: isDate(b.date) ? b.date : today(), type: isOut ? 'income' : 'expense', category: isOut ? '粮食销售' : '农产品收购',
      amount, account: acct.id, method: acct.kind, ref: o.no,
      note: str(b.note, 200) || `${isOut ? '售粮收款' : '收粮结算'} · ${o.farmerName}`, operator: ctx.user.name
    };
    put('finance', f);
    put('grainDocs', o);
    audit(ctx, isOut ? '售粮结算收款' : '收粮结算付款', `${o.no} ¥${amount.toFixed(2)}`);
    return o;
  });
}
function delGrainPay(ctx, id, fid) {
  return tx(() => {
    const o = get('grainDocs', id) || fail('粮食单据不存在', 404);
    const f = get('finance', fid) || fail('结算记录不存在', 404);
    const expectCat = o.dir === 'out' ? '粮食销售' : '农产品收购';
    if (f.ref !== o.no || f.category !== expectCat) fail('记录不属于这张粮食单据', 400);
    o.paid = round2(Math.max(0, (o.paid || 0) - f.amount));
    del('finance', fid);
    put('grainDocs', o);
    audit(ctx, '删除粮食结算记录', `${o.no} ¥${f.amount.toFixed(2)}`);
    return o;
  });
}
function voidGrainDoc(ctx, id) {
  return tx(() => {
    const o = get('grainDocs', id) || fail('粮食单据不存在', 404);
    if (o.status === '已作废') fail('单据已作废');
    if ((o.paid || 0) > 0) fail('已有结算记录，请先删除结算记录后再作废');
    const p = get('products', o.productId);
    const reason = str((ctx.body || {}).reason, 200);
    const isOut = o.dir === 'out';
    if (p) {
      if (!isOut && whQty(p, o.wh || DEFAULT_WH) < o.netWeight) fail(`库存不足（需扣回 ${o.netWeight}，${whName(o.wh)}现有 ${whQty(p, o.wh || DEFAULT_WH)}），无法作废`);
      list('stockLogs').filter(l => (l.ref === o.no || (o.stockDocNo && l.ref === o.stockDocNo)) && !l.voided)
        .forEach(l => put('stockLogs', { ...l, voided: true }));
      moveStock(ctx, p, isOut ? o.netWeight : -o.netWeight, '作废冲回', o.no, reason || o.farmerName, isOut ? { price: o.unitCost != null ? o.unitCost : (p.cost || 0), wh: o.wh || DEFAULT_WH, voided: true } : { reversePrice: o.unitPrice, wh: o.wh || DEFAULT_WH, voided: true });
    }
    const sd = o.stockDocId ? get('stockDocs', o.stockDocId) : null;
    if (sd && sd.status !== '已作废') {
      Object.assign(sd, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: reason || ('关联粮食单 ' + o.no + ' 作废') });
      put('stockDocs', sd);
    }
    Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: reason });
    put('grainDocs', o);
    audit(ctx, isOut ? '作废售粮单' : '作废收粮单', o.no + (reason ? ' ' + reason : ''));
    return o;
  });
}
/* ---------- 报销：员工提交 → 审批（批准 / 驳回）→ 财务付款（按类别记支出流水，从资金账户扣）；付款可撤销 ---------- */
const EXP = { col: 'expenses', prefix: 'BX', title: '报销单' };
const ADV = { col: 'advances', prefix: 'JY', title: '备用金' };
const EXP_CATS = ['差旅', '交通费', '餐费', '住宿费', '办公费', '招待费', '通讯费', '其他支出'];
const EXP_IMG_MAX = 9;
const expAll = P => P.has('finance') || P.has('exp.approve');  // 能看全部报销单
const expPerm = ctx => ['expense', 'exp.approve', 'finance'].find(k => ctx.perms.has(k)) || 'expense';
const expIsApprover = (o, username) => !!(o && o.approval && Array.isArray(o.approval.steps) && o.approval.steps.some(s => (s.approvers || []).includes(username)));
const expCanView = (o, ctx) => !!(o && (expAll(ctx.perms) || o.creatorId === ctx.user.id || (Array.isArray(o.cc) && o.cc.includes(ctx.user.username)) || expIsApprover(o, ctx.user.username)));
function expStepPerm(ctx) {
  if (!enabledModules().includes('finance')) return 'exp.approve';
  if (ctx.perms.has('exp.approve')) return 'exp.approve';
  const o = get('expenses', ctx.params.id), step = o ? currentApprovalStep(o) : null;
  if (step && (step.approvers || []).includes(ctx.user.username)) return null;
  return 'exp.approve';
}
function expViewPerm(ctx) {
  if (!enabledModules().includes('finance')) return 'expense';
  if (ctx.perms.has('expense') || ctx.perms.has('exp.approve') || ctx.perms.has('finance')) return null;
  const o = get('expenses', ctx.params.id);
  if (expCanView(o, ctx)) return null;
  return 'expense';
}
function expGet(ctx, id) {
  const o = get('expenses', id) || fail('报销单不存在', 404);
  if (!expCanView(o, ctx)) fail('只能查看自己提交或与自己相关的报销单', 403);
  return o;
}
function cleanExpense(b) {
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => l && (str(l.category, 20) || Number(l.amount))).map((l, n) => {
    const category = str(l.category, 20) || fail(`第 ${n + 1} 行请填写报销类别`);
    if (AUTO_CATS.includes(category)) fail(`「${category}」是单据自动生成的科目，换一个类别`);
    const amount = round2(Number(l.amount));
    if (!(amount > 0) || amount > 1e8) fail(`第 ${n + 1} 行金额需大于 0`);
    return { category, amount, note: str(l.note, 100) };
  });
  if (!lines.length) fail('请至少填写一行报销明细');
  if (lines.length > 30) fail('报销明细最多 30 行');
  const date = isDate(b.date) ? b.date : today();
  if (date > today()) fail('报销日期不能晚于今天');
  const amount = round2(sum(lines, l => l.amount));
  const applicant = str(b.applicant, 32) || fail('请填写报销人');
  const expUser = resolvePersonUser('', applicant);
  const dept = str(b.dept, 32) || (expUser ? userDept(expUser) : ((list('employees').find(e => e.name === applicant) || {}).dept || ''));
  const advanceId = str(b.advanceId, 64);
  let advanceOffset = 0;
  if (advanceId) {
    const a = get('advances', advanceId) || fail('备用金单不存在', 404);
    if (!['已发放', '部分核销'].includes(a.status)) fail('这张备用金还没有发放或已经核销完');
    const samePerson = a.applicant === applicant || (expUser && ((a.applicantUserId && a.applicantUserId === expUser.id) || (a.applicantUsername && a.applicantUsername === expUser.username)));
    if (a.applicant && !samePerson) fail('备用金领用人和报销人不一致');
    advanceOffset = round2(Number(b.advanceOffset || 0));
    if (!(advanceOffset > 0)) fail('请填写冲抵备用金的金额');
    if (advanceOffset > amount + 0.001) fail('冲抵金额不能超过报销金额');
    if (advanceOffset > advRemaining(a) + 0.001) fail(`这张备用金只剩 ${advRemaining(a).toFixed(2)} 可冲抵`);
  }
  const flow = getMeta('settings', {}).expenseFlow || {};
  const defCc = Array.isArray(flow.cc) ? flow.cc : [];
  const allowCustomCc = flow.allowCustomCc !== false;
  const userCc = (Array.isArray(b.cc) ? b.cc : String(b.cc || '').split(/[,，\s]+/)).map(x => String(x).trim()).filter(Boolean);
  const cc = [...new Set(allowCustomCc ? [...defCc, ...userCc] : defCc)].slice(0, 20);
  return { date, applicant, dept, reason: str(b.reason, 300) || fail('请填写报销事由'),
    lines, amount, advanceId: advanceId || '', advanceOffset, cc };
}
function buildExpenseApproval(v, user) {
  const flow = getMeta('settings', {}).expenseFlow || {};
  const namesOf = x => (Array.isArray(x) ? x : String(x || '').split(/[,，\s]+/)).map(s => String(s).trim()).filter(Boolean);
  const modes = flow.modes || {};
  const step = (name, who, modeKey) => {
    const names = [...new Set(namesOf(who))].filter(n => n !== user.username);
    return names.length ? { name, approvers: names, mode: modes[modeKey] === 'any' ? 'any' : 'all', status: '待审批', acted: [] } : null;
  };
  const steps = [];
  const head = step('部门负责人', flow.deptHeads && flow.deptHeads[v.dept], 'dept');
  if (head) steps.push(head);
  const fin = step('财务', flow.finance, 'finance');
  if (fin) steps.push(fin);
  const threshold = Number(flow.gmThreshold) || 0;
  if (!threshold || v.amount >= threshold) {
    const gm = step('总经理', flow.gm, 'gm');
    if (gm) steps.push(gm);
  }
  if (!steps.length) return { steps: [{ name: '审批', approvers: [], mode: 'any', status: '待审批', acted: [] }], current: 0, fallback: true };
  return { steps, current: 0 };
}
function createExpense(ctx) {
  return tx(() => {
    const v = cleanExpense(ctx.body);
    const o = { id: uid(), no: nextNo(EXP), ...v, status: '待审批', imgs: [], payImgs: [], approval: buildExpenseApproval(v, ctx.user),
      creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), time: hhmm() };
    put('expenses', o); audit(ctx, '提交报销', `${o.no} ${o.applicant} ${o.amount}`);
    return o;
  });
}
function saveExpense(ctx, id) {
  return tx(() => {
    const o = expGet(ctx, id);
    if (!['待审批', '已驳回', '已撤回'].includes(o.status)) fail(`报销单已${o.status.replace('已', '')}，不能再修改${o.status === '已批准' ? '（可以请审批人驳回后再改）' : ''}`);
    if (o.creatorId !== ctx.user.id && !ctx.perms.has('finance')) fail('只能修改自己提交的报销单', 403);
    const v = cleanExpense(ctx.body);
    Object.assign(o, v, { status: '待审批', approval: buildExpenseApproval(v, ctx.user), payImgs: [], editor: ctx.user.name, editedAt: new Date().toISOString() });
    delete o.approver; delete o.approvedAt; delete o.rejectReason; delete o.withdrawnAt; delete o.withdrawnBy;
    put('expenses', o); audit(ctx, '修改报销', `${o.no} ${o.amount}`);
    return o;
  });
}
function approveExpense(ctx, id, pass) {
  return tx(() => {
    const o = get('expenses', id) || fail('报销单不存在', 404);
    if (o.status !== '待审批') fail(`报销单当前状态为「${o.status}」，不能审批`);
    const ap = o.approval;
    if (!ap || !Array.isArray(ap.steps) || !ap.steps.length) {
      if (pass) Object.assign(o, { status: '已批准', approver: ctx.user.name, approvedAt: new Date().toISOString() });
      else Object.assign(o, { status: '已驳回', approver: ctx.user.name, approvedAt: new Date().toISOString(), rejectReason: str(ctx.body.reason, 200) || fail('请填写驳回原因') });
      put('expenses', o); audit(ctx, pass ? '批准报销' : '驳回报销', o.no + (pass ? '' : ' ' + o.rejectReason));
      return o;
    }
    const step = ap.steps[ap.current] || fail('审批流程已结束');
    const me = ctx.user.username;
    const allowed = ctx.user.role === 'admin' || (step.approvers || []).includes(me) || (!(step.approvers || []).length && ctx.perms.has('exp.approve'));
    if (!allowed) fail('当前审批节点不是你，不能处理', 403);
    step.acted = Array.isArray(step.acted) ? step.acted : [];
    if (step.acted.some(x => x.by === me)) fail('这一步你已经处理过了');
    const comment = str(ctx.body.comment || ctx.body.reason, 300);
    step.acted.push({ by: me, name: ctx.user.name, at: new Date().toISOString(), pass: !!pass, comment });
    if (!pass) {
      Object.assign(o, { status: '已驳回', approver: ctx.user.name, approvedAt: new Date().toISOString(),
        rejectReason: comment || fail('请填写驳回原因') });
      step.status = '已驳回';
    } else {
      const passed = step.acted.filter(x => x.pass).length;
      const need = (step.approvers || []).length || 1;
      const done = step.mode === 'any' ? passed >= 1 : passed >= need;
      if (!done) step.status = '审批中';
      else {
        step.status = '已通过'; ap.current++;
        if (ap.current >= ap.steps.length) {
          o.status = '已批准';
          o.approver = ap.steps.map(s => (s.acted || []).filter(x => x.pass).map(x => x.name).join('、')).filter(Boolean).join(' → ');
          o.approvedAt = new Date().toISOString();
        }
      }
    }
    put('expenses', o); audit(ctx, pass ? '批准报销' : '驳回报销', o.no + (pass ? '' : ' ' + o.rejectReason));
    return o;
  });
}
/* ---------- 审批增强：加签 / 转交 / 催办 / 抄送 / 撤回（仿钉钉会签） ---------- */
function currentApprovalStep(o) {
  const ap = o.approval;
  return ap && Array.isArray(ap.steps) && ap.steps.length ? ap.steps[ap.current] || null : null;
}
function canApproveStep(ctx, step) {
  const me = ctx.user.username;
  return ctx.user.role === 'admin' || (step.approvers || []).includes(me) || (!(step.approvers || []).length && ctx.perms.has('exp.approve'));
}
function addExpenseSigner(ctx, id) {
  return tx(() => {
    const o = get('expenses', id) || fail('报销单不存在', 404);
    if (o.status !== '待审批') fail(`报销单当前状态为「${o.status}」，不能加签`);
    const ap = o.approval, step = currentApprovalStep(o) || fail('审批流程已结束');
    if (!canApproveStep(ctx, step)) fail('只有当前审批人可以加签', 403);
    const who = str(ctx.body.who, 32) || fail('请选择加签人');
    const u = S.userByName.get(who) || fail('没有这个账号');
    if (who === ctx.user.username) fail('不能加签给自己');
    if ((step.approvers || []).includes(who)) fail('这个人已经在当前节点里了');
    const pos = ctx.body.position === 'before' ? 'before' : 'after';
    const ns = { name: '加签 · ' + u.name, approvers: [who], mode: 'all', status: '待审批', acted: [], added: true };
    if (pos === 'before') ap.steps.splice(ap.current, 0, ns);
    else ap.steps.splice(ap.current + 1, 0, ns);
    (ap.log = ap.log || []).push({ type: 'addsigner', by: ctx.user.name, to: u.name, position: pos, at: new Date().toISOString() });
    put('expenses', o);
    audit(ctx, '审批加签', `${o.no} → ${u.name}（${pos === 'before' ? '前加签' : '后加签'}）`);
    return o;
  });
}
function transferExpense(ctx, id) {
  return tx(() => {
    const o = get('expenses', id) || fail('报销单不存在', 404);
    if (o.status !== '待审批') fail(`报销单当前状态为「${o.status}」，不能转交`);
    const ap = o.approval, step = currentApprovalStep(o) || fail('审批流程已结束');
    if (!canApproveStep(ctx, step)) fail('只有当前审批人可以转交', 403);
    const me = ctx.user.username;
    if (!(step.approvers || []).includes(me)) fail('当前节点里没有你，不能转交（管理员代审请直接同意/驳回）');
    if ((step.acted || []).some(x => x.by === me)) fail('这一步你已经处理过了，不能再转交');
    const to = str(ctx.body.to, 32) || fail('请选择转交人');
    const u = S.userByName.get(to) || fail('没有这个账号');
    if (to === me) fail('不能转交给自己');
    if ((step.approvers || []).includes(to)) fail('这个人已经在当前审批节点里了，不能重复转交');
    if ((step.acted || []).some(x => x.by === to)) fail('这个人已经审批过当前节点，不能再转交给他');
    step.approvers = [...new Set((step.approvers || []).filter(x => x !== me).concat(to))];
    (ap.log = ap.log || []).push({ type: 'transfer', by: ctx.user.name, to: u.name, at: new Date().toISOString() });
    put('expenses', o);
    audit(ctx, '审批转交', `${o.no} → ${u.name}`);
    return o;
  });
}
function urgeExpense(ctx, id) {
  return tx(() => {
    const o = get('expenses', id) || fail('报销单不存在', 404);
    if (o.status !== '待审批') fail('只有审批中的单据可以催办');
    if (o.creatorId !== ctx.user.id && ctx.user.role !== 'admin') fail('只有提交人可以催办', 403);
    const ap = o.approval || {};
    const last = (ap.urges || []).filter(x => x.by === ctx.user.username).pop();
    if (last && Date.now() - new Date(last.at).getTime() < 10 * 60e3) fail('10 分钟内已经催过了，请稍后再试');
    (ap.urges = ap.urges || []).push({ by: ctx.user.username, name: ctx.user.name, at: new Date().toISOString() });
    o.approval = ap;
    put('expenses', o);
    audit(ctx, '催办审批', o.no);
    return o;
  });
}
function withdrawExpense(ctx, id) {
  return tx(() => {
    const o = get('expenses', id) || fail('报销单不存在', 404);
    if (o.creatorId !== ctx.user.id && ctx.user.role !== 'admin') fail('只有提交人可以撤回', 403);
    if (o.status !== '待审批') fail(`报销单当前状态为「${o.status}」，不能撤回`);
    Object.assign(o, { status: '已撤回', withdrawnAt: new Date().toISOString(), withdrawnBy: ctx.user.name });
    put('expenses', o);
    audit(ctx, '撤回报销', o.no);
    return o;
  });
}
const advRemaining = a => round2((a.amount || 0) - (a.used || 0) - (a.returned || 0));
function advIsOwner(a, ctx) {
  if (!a || !ctx || !ctx.user) return false;
  if (a.creatorId === ctx.user.id) return true;
  if (a.applicantUserId && a.applicantUserId === ctx.user.id) return true;
  if (a.applicantUsername && a.applicantUsername === ctx.user.username) return true;
  if (!a.applicantUserId && a.applicant) {
    if (a.applicant === ctx.user.name || a.applicant === ctx.user.username) return true;
    const emp = list('employees').find(e => e.userId === ctx.user.id);
    if (emp && emp.name === a.applicant) return true;
  }
  return false;
}
function advGet(ctx, id) {
  const a = get('advances', id) || fail('备用金单不存在', 404);
  if (!expAll(ctx.perms) && !advIsOwner(a, ctx)) fail('只能查看自己的备用金', 403);
  return a;
}
function cleanAdvance(b) {
  const date = isDate(b.date) ? b.date : today();
  if (date > today()) fail('领用日期不能晚于今天');
  const amount = round2(Number(b.amount));
  if (!(amount > 0)) fail('备用金金额需大于 0');
  const rawUid = str(b.applicantUserId, 64);
  let applicant = str(b.applicant, 32);
  const u = resolvePersonUser(rawUid, applicant);
  if (rawUid && u) applicant = u.name;
  else if (!applicant && u) applicant = u.name;
  if (!applicant) fail('请填写领用人');
  const dept = str(b.dept, 32) || (u ? userDept(u) : ((list('employees').find(e => e.name === applicant) || {}).dept || ''));
  return { date, applicant, applicantUserId: u ? u.id : '', applicantUsername: u ? u.username : '', dept,
    amount, purpose: str(b.purpose, 300) || fail('请填写用途'), note: str(b.note, 300) };
}
function createAdvance(ctx) {
  return tx(() => {
    const v = cleanAdvance(ctx.body);
    const a = { id: uid(), no: nextNo(ADV), ...v, status: '待审批', used: 0, returned: 0, expenseIds: [],
      creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), time: hhmm() };
    put('advances', a); audit(ctx, '申请备用金', `${a.no} ${a.applicant} ${a.amount}`);
    return a;
  });
}
function saveAdvance(ctx, id) {
  return tx(() => {
    const a = advGet(ctx, id);
    if (!['待审批', '已驳回'].includes(a.status)) fail(`备用金当前状态为「${a.status}」，不能修改`);
    if (a.creatorId !== ctx.user.id && !ctx.perms.has('finance')) fail('只能修改自己提交的备用金', 403);
    Object.assign(a, cleanAdvance(ctx.body), { status: '待审批' });
    delete a.approver; delete a.approvedAt; delete a.rejectReason;
    put('advances', a); audit(ctx, '修改备用金', `${a.no} ${a.amount}`);
    return a;
  });
}
function approveAdvance(ctx, id, pass) {
  return tx(() => {
    const a = get('advances', id) || fail('备用金单不存在', 404);
    if (a.status !== '待审批') fail(`备用金当前状态为「${a.status}」，不能审批`);
    if (pass) Object.assign(a, { status: '已批准', approver: ctx.user.name, approvedAt: new Date().toISOString() });
    else Object.assign(a, { status: '已驳回', approver: ctx.user.name, approvedAt: new Date().toISOString(), rejectReason: str(ctx.body.reason, 200) || fail('请填写驳回原因') });
    put('advances', a); audit(ctx, pass ? '批准备用金' : '驳回备用金', a.no);
    return a;
  });
}
function payAdvance(ctx, id) {
  return tx(() => {
    const a = get('advances', id) || fail('备用金单不存在', 404), b = ctx.body;
    if (a.status !== '已批准') fail(`备用金当前状态为「${a.status}」，不能发放`);
    const date = isDate(b.date) ? b.date : today();
    if (date > today()) fail('发放日期不能晚于今天');
    const acc = pickAccount(b);
    Object.assign(a, { status: '已发放', payer: ctx.user.name, paidAt: new Date().toISOString(), payDate: date, account: acc.id });
    put('advances', a); audit(ctx, '发放备用金', `${a.no} ${a.amount} ${acc.name}`);
    return a;
  });
}
function returnAdvance(ctx, id) {
  return tx(() => {
    const a = get('advances', id) || fail('备用金单不存在', 404);
    if (!['已发放', '部分核销'].includes(a.status)) fail(`备用金当前状态为「${a.status}」，不能退回`);
    const amount = round2(Number(ctx.body.amount));
    if (!(amount > 0)) fail('退回金额需大于 0');
    if (amount > advRemaining(a) + 0.001) fail('退回金额不能超过未核销余额');
    a.returned = round2((a.returned || 0) + amount);
    a.status = advRemaining(a) <= 0.001 ? '已核销' : '部分核销';
    a.returnedAt = new Date().toISOString();
    put('advances', a); audit(ctx, '退回备用金', `${a.no} ${amount}`);
    return a;
  });
}
function voidAdvance(ctx, id) {
  return tx(() => {
    const a = advGet(ctx, id);
    if (a.creatorId !== ctx.user.id && !ctx.perms.has('finance') && !ctx.perms.has('exp.approve')) fail('只能作废自己提交的备用金', 403);
    if (a.status === '已作废') fail('备用金单已作废');
    if (['已发放', '部分核销', '已核销'].includes(a.status)) fail('已发放的备用金不能作废');
    a.status = '已作废'; a.voidBy = ctx.user.name; a.voidAt = new Date().toISOString();
    put('advances', a); audit(ctx, '作废备用金', a.no);
    return a;
  });
}
// 付款：同一类别合并成一笔支出流水（科目 = 报销类别），关联单号 = 报销单号；有审批权限的可以从「待审批」直接批准并付款
function payExpense(ctx, id) {
  return tx(() => {
    const o = get('expenses', id) || fail('报销单不存在', 404), b = ctx.body;
    if (o.status === '待审批' && ctx.perms.has('exp.approve') && (!o.approval || !o.approval.steps || !o.approval.steps.length || o.approval.fallback)) Object.assign(o, { approver: ctx.user.name, approvedAt: new Date().toISOString() });
    else if (o.status !== '已批准') fail(o.status === '待审批' ? '报销单还没审批，审批通过后才能付款' : `报销单当前状态为「${o.status}」，不能付款`);
    const date = isDate(b.date) ? b.date : today();
    if (date > today()) fail('付款日期不能晚于今天');
    const a = pickAccount(b), cats = {};
    o.lines.forEach(l => { cats[l.category] = round2((cats[l.category] || 0) + l.amount); });
    for (const [category, amount] of Object.entries(cats))
      put('finance', { id: uid(), date, type: 'expense', category, amount, account: a.id, method: a.kind, note: str(`报销 ${o.applicant}：${o.reason}`, 200), ref: o.no, exp: o.id, operator: ctx.user.name });
    if (o.advanceId && o.advanceOffset > 0) {
      const adv = get('advances', o.advanceId) || fail('备用金单不存在，不能冲抵');
      if (!['已发放', '部分核销'].includes(adv.status)) fail('备用金已核销或状态不正确，不能冲抵');
      if (o.advanceOffset > advRemaining(adv) + 0.001) fail('备用金余额不足，不能冲抵');
      adv.used = round2((adv.used || 0) + o.advanceOffset);
      adv.expenseIds = [...new Set([...(adv.expenseIds || []), o.id])];
      adv.status = advRemaining(adv) <= 0.001 ? '已核销' : '部分核销';
      put('advances', adv);
      o.advanceApplied = true;
    }
    Object.assign(o, { status: '已付款', payer: ctx.user.name, paidAt: new Date().toISOString(), payDate: date, account: a.id });
    put('expenses', o); audit(ctx, '报销付款', `${o.no} ${o.amount} ${a.name}`);
    return o;
  });
}
function unpayExpense(ctx, id) {
  return tx(() => {
    const o = get('expenses', id) || fail('报销单不存在', 404);
    if (o.status !== '已付款') fail('报销单还没付款');
    list('finance').filter(f => f.exp === o.id).forEach(f => del('finance', f.id));
    if (o.advanceId && o.advanceApplied) {
      const adv = get('advances', o.advanceId);
      if (adv) {
        adv.used = round2(Math.max(0, (adv.used || 0) - (o.advanceOffset || 0)));
        adv.expenseIds = (adv.expenseIds || []).filter(x => x !== o.id);
        adv.status = advRemaining(adv) <= 0.001 ? '已核销' : (adv.used > 0 || adv.returned > 0 ? '部分核销' : '已发放');
        put('advances', adv);
      }
    }
    Object.assign(o, { status: '已批准' }); delete o.payer; delete o.paidAt; delete o.payDate; delete o.account;
    delete o.advanceApplied;
    put('expenses', o); audit(ctx, '撤销报销付款', `${o.no} ${o.amount}`);
    return o;
  });
}
function voidExpense(ctx, id) {
  return tx(() => {
    const o = expGet(ctx, id);
    if (o.status === '已作废') fail('报销单已作废');
    if (o.status === '已付款') fail('已付款的报销单要先「撤销付款」才能作废');
    const mine = o.creatorId === ctx.user.id && ['待审批', '已驳回'].includes(o.status);
    if (!mine && !expAll(ctx.perms)) fail('已批准的报销单只有审批人或财务能作废', 403);
    Object.assign(o, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString(), voidReason: str(ctx.body.reason, 200) });
    put('expenses', o); audit(ctx, '作废报销', o.no);
    return o;
  });
}
// 附件（发票、小票照片）：存在 images 表，id = bx_报销单id_序号，随备份一起走
function addExpenseImage(ctx, id) {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(ctx.body.data || '')) || fail('图片格式不正确');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > IMG_MAX) fail('图片太大（最大 800 KB），请换一张或压缩后再传');
  const mime = imgMime(buf) || fail('只支持 JPG、PNG、WebP 图片');
  return tx(() => {
    const o = expGet(ctx, id);
    if (o.creatorId !== ctx.user.id && !expAll(ctx.perms)) fail('只能修改自己提交的报销单附件', 403);
    if (o.status === '已作废' || o.status === '已付款') fail(`报销单已${o.status.replace('已', '')}，不能再加附件`);
    const imgs = o.imgs || [];
    if (imgs.length >= EXP_IMG_MAX) fail(`每张报销单最多 ${EXP_IMG_MAX} 张附件`);
    const k = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    db.prepare('INSERT OR REPLACE INTO images (id, mime, data, updated_at) VALUES (?, ?, ?, ?)').run(`bx_${o.id}_${k}`, mime, buf, new Date().toISOString());
    o.imgs = [...imgs, k]; put('expenses', o);
    return { imgs: o.imgs };
  });
}
function delExpenseImage(ctx, id, k) {
  return tx(() => {
    const o = expGet(ctx, id);
    if (o.creatorId !== ctx.user.id && !expAll(ctx.perms)) fail('只能修改自己提交的报销单附件', 403);
    if (o.status === '已作废' || o.status === '已付款') fail(`报销单已${o.status.replace('已', '')}，不能再删附件`);
    if (!(o.imgs || []).includes(k)) fail('附件不存在', 404);
    db.prepare('DELETE FROM images WHERE id = ?').run(`bx_${o.id}_${k}`);
    o.imgs = o.imgs.filter(x => x !== k); put('expenses', o);
    return { imgs: o.imgs };
  });
}
function getExpenseImage(ctx, id, k) {
  const o = expGet(ctx, id);
  if (!(o.imgs || []).includes(k)) fail('附件不存在', 404);
  const r = db.prepare('SELECT mime, data FROM images WHERE id = ?').get(`bx_${o.id}_${k}`) || fail('附件不存在', 404);
  return { [RAW]: { type: r.mime, body: Buffer.from(r.data) } };
}
// 付款回单：付款后由财务上传，和发票 / 小票附件分开，打印时单独带出
function addExpensePayImage(ctx, id) {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(ctx.body.data || '')) || fail('图片格式不正确');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > IMG_MAX) fail('图片太大（最大 800 KB），请换一张或压缩后再传');
  const mime = imgMime(buf) || fail('只支持 JPG、PNG、WebP 图片');
  return tx(() => {
    const o = expGet(ctx, id);
    if (o.status !== '已付款') fail('付款后才能上传付款回单');
    const imgs = o.payImgs || [];
    if (imgs.length >= EXP_IMG_MAX) fail(`每张报销单最多 ${EXP_IMG_MAX} 张付款回单`);
    const k = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    db.prepare('INSERT OR REPLACE INTO images (id, mime, data, updated_at) VALUES (?, ?, ?, ?)').run(`py_${o.id}_${k}`, mime, buf, new Date().toISOString());
    o.payImgs = [...imgs, k]; put('expenses', o);
    return { payImgs: o.payImgs };
  });
}
function delExpensePayImage(ctx, id, k) {
  return tx(() => {
    const o = expGet(ctx, id);
    if (!(o.payImgs || []).includes(k)) fail('付款回单不存在', 404);
    db.prepare('DELETE FROM images WHERE id = ?').run(`py_${o.id}_${k}`);
    o.payImgs = o.payImgs.filter(x => x !== k); put('expenses', o);
    return { payImgs: o.payImgs };
  });
}
function getExpensePayImage(ctx, id, k) {
  const o = expGet(ctx, id);
  if (!(o.payImgs || []).includes(k)) fail('付款回单不存在', 404);
  const r = db.prepare('SELECT mime, data FROM images WHERE id = ?').get(`py_${o.id}_${k}`) || fail('付款回单不存在', 404);
  return { [RAW]: { type: r.mime, body: Buffer.from(r.data) } };
}
function backup() {
  const data = {};
  COLS.forEach(c => { data[c] = list(c); });
  data.images = db.prepare('SELECT id, mime, data FROM images').all().map(r => ({ id: r.id, mime: r.mime, data: Buffer.from(r.data).toString('base64') }));
  const roles = db.prepare('SELECT id, name, perms, created_at FROM roles').all();
  return { app: 'XERP', version: VERSION, exportedAt: new Date().toISOString(), settings: getMeta('settings', {}), counters: getMeta('counters', {}), roles, data };
}
function restore(ctx) {
  const b = ctx.body || {};
  const src = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : b;  // 同时兼容单机版备份
  if (!Array.isArray(src.products) || !Array.isArray(src.sales)) fail('备份文件格式不正确');
  tx(() => {
    writeAll(src);
    if (b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings)) {
      const cur = getMeta('settings', {}), inc = sanitizePrintSettings(b.settings), next = { ...cur };
      if (typeof inc.company === 'string' && inc.company.trim()) next.company = str(inc.company, 100);
      if (Array.isArray(inc.modules)) next.modules = inc.modules.filter(m => typeof m === 'string' && /^[a-z0-9_.-]{1,32}$/i.test(m));
      if (inc.docApprove && typeof inc.docApprove === 'object') next.docApprove = { in: !!inc.docApprove.in, out: !!inc.docApprove.out };
      const tol = inc.overTolerance != null ? inc.overTolerance : inc.overTol;
      if (Number.isFinite(+tol) && +tol >= 0 && +tol <= 100) next.overTolerance = round2(+tol);
      if (inc.printTpl && typeof inc.printTpl === 'object') next.printTpl = inc.printTpl;
      if (inc.printTplList && typeof inc.printTplList === 'object') next.printTplList = inc.printTplList;
      if (inc.printTplActive && typeof inc.printTplActive === 'object') next.printTplActive = inc.printTplActive;
      if (Array.isArray(inc.categories)) next.categories = inc.categories.map(x => str(x, 40)).filter(Boolean).slice(0, 200);
      if (Array.isArray(inc.departments)) next.departments = inc.departments.map(x => str(x, 40)).filter(Boolean).slice(0, 200);
      if (Array.isArray(inc.expCats)) next.expCats = inc.expCats.map(x => str(x, 40)).filter(Boolean).slice(0, 100);
      const eflow = inc.expenseFlow || inc.expFlow;
      if (eflow && typeof eflow === 'object') next.expenseFlow = eflow;
      if (Array.isArray(inc.bomCols)) next.bomCols = inc.bomCols;
      if (typeof inc.tiandituKey === 'string') next.tiandituKey = str(inc.tiandituKey, 128);
      setMeta('settings', next);
    }
    if (Array.isArray(b.roles)) {
      const insRole = db.prepare('INSERT OR REPLACE INTO roles (id, name, perms, created_at) VALUES (?, ?, ?, ?)');
      for (const r of b.roles) {
        if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(r.id)) continue;
        const name = str(r.name, 40); if (!name) continue;
        const perms = typeof r.perms === 'string' ? r.perms : JSON.stringify(Array.isArray(r.perms) ? r.perms : []);
        insRole.run(r.id, name, perms, str(r.created_at, 40) || new Date().toISOString());
      }
    }
    setMeta('counters', b.counters && typeof b.counters === 'object' && !Array.isArray(b.counters) ? b.counters : {});
    audit(ctx, '导入备份', `商品 ${src.products.length}，销售单 ${src.sales.length}`);
  });
}
function autoBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, 'erp-' + today().replace(/-/g, '') + '.db');
    if (!fs.existsSync(f)) { db.prepare('VACUUM INTO ?').run(f); log('自动备份完成：' + f); }
    fs.readdirSync(BACKUP_DIR).filter(n => /^erp-\d{8}\.db$/.test(n)).sort().slice(0, -30).forEach(n => fs.unlinkSync(path.join(BACKUP_DIR, n)));
  } catch (e) { log('自动备份失败：' + e.message); }
}

/* ================= 云备份（付费云服务；数据在本机加密后上传） ================= */
const CLOUD_API = (process.env.XERP_CLOUD_URL || 'https://www.zhaoyoucai.xyz/xerp-cloud/api').replace(/\/+$/, '');
const TUNNEL_DOMAIN = process.env.XERP_TUNNEL_DOMAIN || 'xerp.zhaoyoucai.xyz';
const TUNNEL_WS_URL = (process.env.XERP_TUNNEL_URL || 'wss://tunnel.zhaoyoucai.xyz/tunnel').replace(/\/+$/, '');
const CLOUD_MAGIC = Buffer.from('XERPCLOUD1');
const CLOUD_TABLES = ['docs', 'meta', 'users', 'roles', 'images', 'cost_layers', 'audit'];
const cloudState = () => ({
  activated: !!(config.cloud.token && config.cloud.account),
  account: config.cloud.account || null,
  local: { hasKey: !!config.cloud.key, salt: !!config.cloud.salt, auto: !!config.cloud.auto, lastUpload: config.cloud.lastUpload || '', device: config.cloud.device },
  remote: cloudTunnelState(),
});
async function cloudReq(pathname, { method = 'GET', body, token, raw } = {}) {
  let r;
  try {
    r = await fetch(CLOUD_API + pathname, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body !== undefined ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}),
      },
      body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(120e3),
    });
  } catch (e) {
    throw new HttpError('连不上云备份服务，请检查这台设备能不能上网', 502);
  }
  if (!r.ok) {
    let d = {};
    try { d = await r.json(); } catch (e) {}
    throw new HttpError(d.error || `云备份服务返回 ${r.status}`, r.status === 401 ? 401 : 400);
  }
  return r;
}
function cloudKey(pass) {
  if (config.cloud.key) return Buffer.from(config.cloud.key, 'base64');
  if (!pass) fail('请输入云备份密码');
  if (!config.cloud.salt) { config.cloud.salt = crypto.randomBytes(16).toString('hex'); saveConfig(); }
  return crypto.scryptSync(String(pass), Buffer.from(config.cloud.salt, 'hex'), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function cloudEncrypt(buf, pass) {
  if (!config.cloud.salt) { config.cloud.salt = crypto.randomBytes(16).toString('hex'); saveConfig(); }
  const key = cloudKey(pass), iv = crypto.randomBytes(12);
  const salt = Buffer.from(config.cloud.salt, 'hex');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([CLOUD_MAGIC, Buffer.from([1]), salt, iv, c.getAuthTag(), body]);
}
function cloudDecrypt(buf, pass) {
  if (buf.length < 65 || !buf.subarray(0, 10).equals(CLOUD_MAGIC) || buf[10] !== 1) fail('备份文件格式不正确');
  const salt = buf.subarray(11, 27), iv = buf.subarray(27, 39), tag = buf.subarray(39, 55), body = buf.subarray(55);
  const key = config.cloud.key ? Buffer.from(config.cloud.key, 'base64')
    : crypto.scryptSync(String(pass || fail('请输入这台设备当初设置的云备份密码')), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  } catch (e) {
    fail('备份密码不正确，无法解密');
  }
}
function cloudSnapshot() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const f = path.join(BACKUP_DIR, `cloud-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  db.prepare('VACUUM INTO ?').run(f);
  return f;
}
async function cloudBackupNow(pass) {
  if (!config.cloud.token || !config.cloud.account) fail('还没有开通云备份，请先输入授权码');
  const snap = cloudSnapshot();
  try {
    const plain = fs.readFileSync(snap);
    const enc = cloudEncrypt(plain, pass);
    const name = `xerp-${today()}-${new Date().toTimeString().slice(0, 5).replace(':', '')}.db.enc`;
    const r = await cloudReq('/backup/' + name, { method: 'PUT', token: config.cloud.token, body: enc, raw: true });
    const d = await r.json();
    config.cloud.account = d.account;
    config.cloud.lastUpload = new Date().toISOString();
    saveConfig();
    log(`云备份上传完成：${name}（${(enc.length / 1024 / 1024).toFixed(2)} MB）`);
    return { ok: true, name, size: enc.length, account: d.account, backups: d.backups };
  } finally {
    try { fs.unlinkSync(snap); } catch (e) {}
  }
}
async function cloudDownload(id, pass) {
  if (!config.cloud.token) fail('还没有开通云备份，请先输入授权码');
  const r = await cloudReq('/backup/' + encodeURIComponent(id), { token: config.cloud.token });
  const enc = Buffer.from(await r.arrayBuffer());
  return { plain: cloudDecrypt(enc, pass), size: enc.length };
}
async function cloudRestore(id, pass, ctx) {
  const { plain } = await cloudDownload(id, pass);
  const tmp = path.join(BACKUP_DIR, `restore-${Date.now()}.db`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(tmp, plain);
  let src;
  try {
    src = new DatabaseSync(tmp);
    const ok = src.prepare('PRAGMA integrity_check').get();
    if (!ok || ok.integrity_check !== 'ok') fail('云备份文件已损坏，无法恢复');
    const has = t => src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has('docs') || !has('users')) fail('这个备份不是 x.erp 数据库，无法恢复');
    const pre = path.join(BACKUP_DIR, `pre-restore-${Date.now()}.db`);
    db.prepare('VACUUM INTO ?').run(pre);
    db.prepare('ATTACH DATABASE ? AS cloudrestore').run(tmp);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const t of CLOUD_TABLES) {
        if (!has(t)) continue;
        const mainCols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
        const srcCols = src.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
        const cols = mainCols.filter(c => srcCols.includes(c));
        if (!cols.length) continue;
        db.exec(`DELETE FROM main.${t}`);
        db.exec(`INSERT INTO main.${t} (${cols.join(',')}) SELECT ${cols.join(',')} FROM cloudrestore.${t}`);
      }
      // 清洗云备份恢复进来的打印模板与电子面单 HTML，防恶意模板/脚本绕过写入校验
      const restoredSettings = getMeta('settings', null);
      if (restoredSettings && typeof restoredSettings === 'object') setMeta('settings', sanitizePrintSettings(restoredSettings));
      for (const l of list('shipLabels')) {
        if (l && typeof l.html === 'string') put('shipLabels', { ...l, html: sanitizeLabelHtml(l.html) });
      }
      db.exec('DELETE FROM sessions');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (x) {}
      throw e;
    } finally {
      try { db.exec('DETACH DATABASE cloudrestore'); } catch (e) {}
    }
    const n = t => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (e) { return 0; } };
    log(`云备份恢复完成：商品 ${n('docs')} 条文档，账号 ${n('users')} 个，恢复前本地备份 ${pre}`);
    return { ok: true, preBackup: pre, docs: n('docs'), users: n('users') };
  } finally {
    try { if (src) src.close(); } catch (e) {}
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}
let cloudBusy = false;
async function cloudAutoTick() {
  if (cloudBusy || !config.cloud.auto || !config.cloud.token || !config.cloud.key) return;
  try {
    if (config.cloud.lastUpload && fmtDate(config.cloud.lastUpload) === today()) return;
    if (new Date().getHours() < 3) return;
    cloudBusy = true;
    await cloudBackupNow(null);
  } catch (e) {
    log('云备份自动上传失败：' + e.message);
  } finally { cloudBusy = false; }
}

/* ================= 远程访问：NAS 主动连云，云端子域名反代 ================= */
let tunnelWs = null, tunnelRetry = null, tunnelPing = null, tunnelOnline = false, tunnelDelay = 5000;
function cloudTunnelState() {
  return {
    enabled: !!config.cloud.remote,
    online: tunnelOnline,
    url: config.cloud.slug ? `https://${config.cloud.slug}.${TUNNEL_DOMAIN}` : '',
    slug: config.cloud.slug || '',
    domain: TUNNEL_DOMAIN,
    slugUpdated: config.cloud.slugUpdated || 0,
    nextSlugAt: config.cloud.nextSlugAt || 0,
  };
}
function tunnelForward(msg, ws) {
  const body = Buffer.from(String(msg.body || ''), 'base64');
  const headers = { ...(msg.headers || {}) };
  headers.host = '127.0.0.1:' + config.port;
  delete headers['accept-encoding'];
  const r = http.request({ host: '127.0.0.1', port: config.port, path: msg.path || '/', method: msg.method || 'GET', headers }, resp => {
    const chunks = [];
    let size = 0;
    resp.on('data', c => { size += c.length; if (size <= 25 * 1024 * 1024) chunks.push(c); });
    resp.on('end', () => {
      if (size > 25 * 1024 * 1024) return;
      const raw = Buffer.concat(chunks);
      const useGz = raw.length >= 1024;
      const payload = useGz ? zlib.gzipSync(raw, { level: 6 }) : raw;
      try { ws.send(JSON.stringify({ type: 'res', id: msg.id, status: resp.statusCode, headers: resp.headers, gz: useGz || undefined, body: payload.toString('base64') })); } catch (e) {}
    });
  });
  r.on('error', () => {
    try { ws.send(JSON.stringify({ type: 'res', id: msg.id, status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('本机 x.erp 服务没有响应').toString('base64') })); } catch (e) {}
  });
  r.setTimeout(30000, () => r.destroy());
  r.end(body);
}
function cloudTunnelStop() {
  clearTimeout(tunnelRetry); tunnelRetry = null;
  clearInterval(tunnelPing); tunnelPing = null;
  tunnelOnline = false;
  try { if (tunnelWs) tunnelWs.close(); } catch (e) {}
  tunnelWs = null;
}
function cloudTunnelStart() {
  if (!config.cloud.remote || !config.cloud.token || !config.cloud.tunnelSecret) return;
  if (tunnelWs) return;
  if (typeof WebSocket !== 'function') { log('当前 Node 不支持 WebSocket，无法启动远程访问'); return; }
  const url = TUNNEL_WS_URL + '?device=' + encodeURIComponent(config.cloud.device) + '&secret=' + encodeURIComponent(config.cloud.tunnelSecret);
  let ws;
  try { ws = new WebSocket(url); }
  catch (e) { log('远程访问连接失败：' + e.message); return; }
  tunnelWs = ws;
  ws.onopen = () => {
    tunnelOnline = true; tunnelDelay = 5000;
    log('远程访问隧道已连接' + (config.cloud.slug ? '：https://' + config.cloud.slug + '.' + TUNNEL_DOMAIN : ''));
    clearInterval(tunnelPing);
    tunnelPing = setInterval(() => { try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {} }, 30000);
  };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
    if (msg.type === 'req') tunnelForward(msg, ws);
  };
  ws.onerror = () => {};
  ws.onclose = ev => {
    log(`远程访问隧道断开（code ${ev.code}${ev.reason ? '，' + ev.reason : ''}），稍后重连`);
    tunnelOnline = false;
    clearInterval(tunnelPing); tunnelPing = null;
    if (tunnelWs === ws) tunnelWs = null;
    if (config.cloud.remote) {
      clearTimeout(tunnelRetry);
      tunnelRetry = setTimeout(cloudTunnelStart, tunnelDelay);
      tunnelDelay = Math.min(60000, tunnelDelay * 2);
    }
  };
}

/* ================= 初始化 ================= */
if (!getMeta('initialized', false)) {
  if (process.env.XERP_NO_DEMO === '1') {
    tx(() => { writeAll({}); setMeta('settings', { company: process.env.XERP_COMPANY || '我的公司' }); setMeta('counters', {}); setMeta('initialized', true); });
    log('首次启动：已创建空账套');
  } else {
    tx(() => { writeAll(seed()); setMeta('settings', { company: '示例科技有限公司' }); setMeta('counters', {}); setMeta('initialized', true); });
    log('首次启动：已写入演示数据');
  }
}
tx(ensureWh);  // v1.0.3 升级：补默认仓库与分仓库存
tx(ensureAccounts);  // v2.0.11 升级：补资金账户，旧流水按收付方式归到对应账户
tx(ensureOrderFulfillment);  // v2.14.8 升级：同步分批关联出入库单的订单已执行 / 待审数量
// --admin-password-file：安装向导写入的一次性管理员密码，读取后删除；空库时用于创建 admin，保留旧数据重装时重置 admin 密码
let filePwd = '';
try { if (arg('admin-password-file')) filePwd = fs.readFileSync(arg('admin-password-file'), 'utf8').trim(); } catch (e) {}
if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  let pwd = filePwd;
  if (pwd.length < 6) pwd = String(process.env.XERP_ADMIN_PASSWORD || '').trim();  // Docker：环境变量仅在首次空库建号时生效
  if (pwd.length < 6) pwd = 'admin123';
  createUser({ username: 'admin', name: '管理员', roleId: 'admin', password: pwd });
  log(pwd === 'admin123' ? '已创建默认管理员账号 admin / admin123' : '已创建管理员账号 admin（密码为安装时设置的密码）');
} else if (filePwd.length >= 6) {
  const adm = db.prepare("SELECT id FROM users WHERE username = 'admin' AND disabled = 0").get();
  if (adm) {
    const { salt, hash } = hashPwd(filePwd);
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, adm.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(adm.id);
    log('已按安装向导重置管理员 admin 密码');
  }
}
try { if (arg('admin-password-file')) fs.unlinkSync(arg('admin-password-file')); } catch (e) {}
if (argv.includes('--init')) { log('账套初始化完成'); process.exit(0); }

/* ================= 路由 ================= */
const routes = [];
// opts.perm：所需权限键，或根据请求返回权限键的函数
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, auth: opts.auth !== false, admin: !!opts.admin, perm: opts.perm });

route('GET', '/api/ping', () => {
  const adm = S.userByName.get('admin');
  const defaultPwd = !!(adm && checkPwd(adm, 'admin123')) && !list('products').length && !list('sales').length && !list('purchases').length && !list('stockDocs').length;
  return { ok: true, app: 'XERP', version: VERSION, company: getMeta('settings', {}).company || '', defaultPwd };
}, { auth: false });
route('POST', '/api/login', ctx => login(ctx, ctx.body), { auth: false });
route('POST', '/api/logout', ctx => { db.prepare('DELETE FROM sessions WHERE token = ?').run(ctx.user.token); });
// 推送地址带密钥，只给管理员看；快递鸟 AppKey 谁都不下发，只告诉前端设没设、能不能下电子面单
const publicSettings = ctx => {
  const { notify, kdn, expenseFlow, ...s } = getMeta('settings', {}), k = kdn || {}, ready = !!(k.ebid && k.key);
  const pub = { ready, eorder: ready && kdnSenderOk(k), sandbox: !!k.sandbox, autoTrack: !!k.autoTrack };
  const safeNotify = notify ? { ...notify, mail: notify.mail ? { ...notify.mail, pass: '', hasPass: !!notify.mail.pass } : undefined } : notify;
  return ctx.user.role === 'admin' ? { ...s, backupPath: BACKUP_DIR, notify: safeNotify, expenseFlow: expenseFlow || {}, kdn: { ...pub, ebid: k.ebid || '', keySet: !!k.key, sender: k.sender || {} } } : { ...s, expenseFlow: expenseFlow || {}, kdn: pub };
};
const FEATURE_PUBKEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA5LC5WoojcHAYW6IgpJSE9hoR3FeyO9wXvg0SPJkZrGY=\n-----END PUBLIC KEY-----';
const REDEEM_URL = process.env.XERP_REDEEM_URL ?? 'https://www.zhaoyoucai.xyz/xerp/api/redeem';
function ensureInstallId() {
  let id = getMeta('installId', '');
  if (!/^[0-9a-f]{32}$/.test(id)) { id = crypto.randomBytes(16).toString('hex'); setMeta('installId', id); }
  return id;
}
function verifyFeatureCert(feat, cert) {
  if (!cert || typeof cert.payload !== 'string' || typeof cert.sig !== 'string') return false;
  try {
    if (!crypto.verify(null, Buffer.from(cert.payload, 'utf8'), FEATURE_PUBKEY, Buffer.from(cert.sig, 'base64'))) return false;
    const p = JSON.parse(cert.payload);
    return !!(p && p.installId === ensureInstallId() && p.feature === feat);
  } catch (e) { return false; }
}
const ENCRYPTED_TPL_VAULT = [{"id":"v01","s":"ac1fde5caea6b36ca087ec530f2e5886","i":"08eae0b6236830d33f873a89","t":"d52d468c360e3c2002b949bdecddb44e","d":"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"}];
function decryptVaultPreset(code) {
  for (const e of ENCRYPTED_TPL_VAULT) {
    if (!e || !e.s || !e.i || !e.t || !e.d) continue;
    try {
      const key = crypto.scryptSync(code, Buffer.from(e.s, 'hex'), 32);
      const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.i, 'hex'));
      dec.setAuthTag(Buffer.from(e.t, 'hex'));
      const plain = Buffer.concat([dec.update(Buffer.from(e.d, 'base64')), dec.final()]);
      const preset = JSON.parse(zlib.inflateSync(plain).toString('utf8'));
      if (preset && preset.tpl) return { vaultId: e.id, preset };
    } catch (_) {}
  }
  return null;
}
function hasPrivateVaultPreprint() {
  const v = getMeta('privateVault', {}) || {};
  const id = ensureInstallId();
  return Object.values(v).some(x => x && x.installId === id);
}
const hasFeature = feat => verifyFeatureCert(feat, (getMeta('features', {}) || {})[feat]) || (feat === 'preprint' && hasPrivateVaultPreprint());
const unlockedFeatures = () => {
  const all = getMeta('features', {}) || {};
  const list = Object.keys(all).filter(k => verifyFeatureCert(k, all[k]));
  if (hasPrivateVaultPreprint() && !list.includes('preprint')) list.push('preprint');
  return list;
};

route('GET', '/api/data', ctx => ({
  version: VERSION, settings: { ...publicSettings(ctx), modules: enabledModules(), feedbackUnread: fbUnread(), platform: PLAT, features: unlockedFeatures(), ...(ctx.user.role === 'admin' ? { deviceCode: ensureInstallId().slice(0, 12).toUpperCase() } : {}) },
  user: { ...publicUser(ctx.user), dept: userDept(ctx.user), perms: [...ctx.perms] }, data: visibleData(ctx),
  meta: { modules: MODULES, perms: PERMS, docTypes: DOC_TYPES, expCats: EXP_CATS, defaultWh: DEFAULT_WH, provinces: PROVINCES, regions: REGIONS }
}));
route('POST', '/api/settings/redeem', async ctx => {
  if (DEMO) fail('演示环境不支持激活功能', 403);
  const code = str(ctx.body && ctx.body.code, 40).toUpperCase();
  if (/^PT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    const hit = decryptVaultPreset(code);
    if (!hit) fail('专属模板码无效，请核对后重试');
    const { vaultId, preset } = hit;
    const cleaned = cleanTpl(preset.tpl);
    if (!cleaned) fail('专属模板解析失败');
    const kinds = (Array.isArray(preset.kinds) ? preset.kinds : ['sales']).filter(k => PRINT_KINDS[k]);
    const s = getMeta('settings', {});
    const lists = { ...(s.printTplList || {}) }, actives = { ...(s.printTplActive || {}) }, all = { ...(s.printTpl || {}) };
    const tplName = str(preset.name, 30) || '专属套打模板';
    const tplId = 'pv_' + vaultId;
    for (const k of kinds) {
      const arr = Array.isArray(lists[k]) ? lists[k].filter(x => x && x.id !== tplId) : [];
      if (arr.length >= 10) arr.pop();
      arr.unshift({ id: tplId, name: tplName, tpl: cleaned });
      lists[k] = arr;
      if (!actives[k] || actives[k] === tplId) { actives[k] = tplId; all[k] = cleaned; }
    }
    s.printTplList = lists; s.printTplActive = actives; s.printTpl = all;
    setMeta('settings', s);
    const pv = { ...(getMeta('privateVault', {}) || {}), [vaultId]: { installId: ensureInstallId(), at: new Date().toISOString() } };
    setMeta('privateVault', pv);
    audit(ctx, '激活专属模板', tplName);
    return { ok: true, feature: 'preprint', presetName: tplName, kinds, features: unlockedFeatures() };
  }
  if (!/^XP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) fail('激活码格式不正确（应为 XP-XXXX-XXXX-XXXX 或 PT-XXXX-XXXX-XXXX）');
  if (!REDEEM_URL) fail('未配置激活服务地址');
  let r, j;
  try {
    r = await fetch(REDEEM_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, installId: ensureInstallId() }), signal: AbortSignal.timeout(10000) });
    j = await r.json().catch(() => ({}));
  } catch (e) { fail('无法连接激活服务器，请确认当前网络可访问外网'); }
  if (!r.ok || !j.ok) fail(j.error || '激活失败（状态码 ' + r.status + '）', r.status >= 400 && r.status < 500 ? r.status : 400);
  const cert = { payload: j.payload, sig: j.sig };
  if (!verifyFeatureCert(j.feature, cert)) fail('激活凭证校验失败');
  const all = { ...(getMeta('features', {}) || {}), [j.feature]: cert };
  setMeta('features', all);
  audit(ctx, '功能激活', `${j.feature}（${code}）`);
  return { ok: true, feature: j.feature, features: unlockedFeatures() };
}, { admin: true });
route('PUT', '/api/settings/expiry', ctx => {
  const n = Math.round(Number(ctx.body.days));
  if (!(n >= 1 && n <= 365)) fail('临期提醒天数需在 1 ~ 365 之间');
  setMeta('settings', { ...getMeta('settings', {}), expiryDays: n }); audit(ctx, '修改设置', '临期提醒 ' + n + ' 天');
}, { perm: 'inv.checkpost' });
route('PUT', '/api/settings', ctx => {
  const s = getMeta('settings', {}), b = ctx.body, changes = [];
  if ('company' in b) { s.company = str(b.company, 100) || fail('公司名称不能为空'); changes.push('公司名称：' + s.company); }
  if ('tiandituKey' in b) { s.tiandituKey = str(b.tiandituKey, 120); changes.push('天地图Key已更新'); }
  if (Array.isArray(b.modules)) {
    s.modules = b.modules.filter(m => m in MODULES);
    if (!s.modules.length) fail('至少启用一个模块');
    changes.push('启用模块：' + s.modules.map(m => MODULES[m]).join('、'));
  }
  if (b.docApprove && typeof b.docApprove === 'object') {
    s.docApprove = { in: !!b.docApprove.in, out: !!b.docApprove.out };
    changes.push('出入库审核：入库单' + (s.docApprove.in ? '需审核' : '不审核') + '，出库单' + (s.docApprove.out ? '需审核' : '不审核'));
  }
  if ('birthdayDays' in b) {
    const n = Math.round(Number(b.birthdayDays));
    if (!(n >= 1 && n <= 365)) fail('生日提醒天数需在 1 ~ 365 之间');
    s.birthdayDays = n; changes.push('生日提醒：提前 ' + n + ' 天');
  }
  if ('overTolerancePct' in b) {
    const n = b.overTolerancePct === '' || b.overTolerancePct == null ? 0 : Math.round(Number(b.overTolerancePct) * 10) / 10;
    if (!Number.isFinite(n) || n < 0 || n > 100) fail('超发/超收容差比例需在 0 ~ 100 之间');
    s.overTolerancePct = n; changes.push('出入库超量容差：' + n + '%');
  }
  if ('stats' in b) { s.stats = !!b.stats; changes.push('匿名使用统计：' + (s.stats ? '开启' : '关闭')); }
  let rebuild = false;
  if ('costMethod' in b) {
    const m = b.costMethod === 'fifo' ? 'fifo' : 'avg', old = s.costMethod || 'avg';
    if (m !== old) {
      s.costMethod = m; rebuild = m === 'fifo';
      changes.push('成本核算：' + (m === 'fifo' ? '先进先出 FIFO' : '移动加权平均'));
    }
  }
  if (rebuild) tx(() => { setMeta('settings', s); rebuildAllCostLayers(); });
  else setMeta('settings', s);
  audit(ctx, '修改设置', changes.join('；'));
}, { admin: true });

route('GET', '/api/update/check', async () => {
  try {
    const m = await fetchUpdates(), key = updateKey();
    const p = key && m.packages[key] ? m.packages[key] : null;
    return {
      ok: true, current: VERSION, platform: PLAT, latest: m.latest, publishedAt: m.publishedAt || '',
      hasUpdate: cmpVer(m.latest, VERSION) > 0,
      notes: Array.isArray(m.notes) ? m.notes : (m.notes ? [String(m.notes)] : []),
      package: p ? { version: p.version || m.latest, url: p.url || '', sha256: p.sha256 || '', size: +p.size || 0, file: p.file || '', kind: p.kind || '', image: p.image || '' } : null,
      canDownload: !!(p && p.url && (p.kind || '') !== 'docker')
    };
  } catch (e) {
    return { ok: false, current: VERSION, platform: PLAT, error: '检查更新失败：' + e.message };
  }
}, { admin: true });

route('POST', '/api/update/download', async ctx => {
  const m = await fetchUpdates(), key = updateKey(), p = key && m.packages[key];
  if (!p || !p.url) fail('当前平台没有可下载的安装包');
  if ((p.kind || '') === 'docker') fail('Docker 版请拉取新镜像，不能下载安装包');
  const u = new URL(p.url), local = updateAllowLocal();
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) fail('安装包地址必须是 HTTPS');
  if (!UPDATE_HOSTS.has(u.hostname) && !(local && ['127.0.0.1', 'localhost'].includes(u.hostname))) fail('安装包地址不在允许的域名内');
  const fileName = path.basename(p.file || decodeURIComponent(u.pathname)).replace(/[^\w.\-]/g, '_');
  if (!/\.(fpk|exe|apk|tar\.gz|zip)$/i.test(fileName)) fail('安装包文件名不正确');
  const dir = path.join(DATA_DIR, 'updates'), dest = path.join(dir, fileName);
  fs.mkdirSync(dir, { recursive: true });
  const sha = String(p.sha256 || '').toLowerCase();
  if (fs.existsSync(dest)) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (h === sha) return { ok: true, version: m.latest, platform: PLAT, path: dest, file: fileName, size: fs.statSync(dest).size, sha256: h, kind: p.kind || '' };
  }
  const res = await fetch(u, { signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'x.erp/' + VERSION } });
  if (!res.ok) fail('下载安装包失败：HTTP ' + res.status);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 300 * 1024 * 1024) fail('安装包超过 300MB，已拒绝下载');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 300 * 1024 * 1024) fail('安装包超过 300MB，已拒绝下载');
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  if (!sha) fail('更新清单缺少 SHA-256，已拒绝下载');
  if (h !== sha) fail('安装包 SHA-256 校验失败，请重试');
  if (+p.size && +p.size !== buf.length) fail('安装包大小与更新清单不一致，请重试');
  fs.writeFileSync(dest + '.part', buf);
  fs.renameSync(dest + '.part', dest);
  audit(ctx, '下载更新包', `${m.latest} ${fileName}`);
  return { ok: true, version: m.latest, platform: PLAT, path: dest, file: fileName, size: buf.length, sha256: h, kind: p.kind || '' };
}, { admin: true });

route('PUT', '/api/settings/notify', ctx => {
  const b = ctx.body || {}, s = getMeta('settings', {});
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : fail('推送时间格式应为 08:30');
  const wb = b.webhook || {}, url = str(wb.url, 500) || str(b.url, 500) || '';
  if (url) { try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch (e) { fail('推送地址必须以 http:// 或 https:// 开头'); } }
  const oldMail = (s.notify || {}).mail || {};
  const mb = b.mail || {};
  const mail = {
    enabled: !!mb.enabled,
    host: str(mb.host, 120) || '',
    port: Math.max(1, Math.min(65535, +mb.port || 465)),
    secure: mb.secure !== false,
    user: str(mb.user, 160) || '',
    pass: str(mb.pass, 300) || oldMail.pass || '',
    from: str(mb.from, 160) || '',
    to: str(mb.to, 300) || '',
  };
  if (mail.enabled && (!mail.host || !mail.to)) fail('开启邮件通知需要填写 SMTP 服务器和收件人');
  const events = {};
  for (const k of Object.keys(NOTIFY_EVENTS)) events[k] = b.events ? !!b.events[k] : k === 'lowStock';
  if (!Object.values(events).some(Boolean)) fail('至少要选一个提醒内容');
  const webhook = { enabled: (b.events ? wb.enabled !== false : true) && !!url, url };
  if (b.enabled && !webhook.enabled && !mail.enabled) fail('请至少开启一个通知通道');
  s.notify = {
    enabled: !!b.enabled, time, skipEmpty: b.skipEmpty !== false,
    overdueDays: Math.max(1, Math.min(365, +b.overdueDays || 30)),
    events, url, webhook, mail,
  };
  setMeta('settings', s);
  if (hhmm() >= time && getMeta('notifyLast', '') !== today()) setMeta('notifyLast', today());  // 今天的时间已过就从明天开始，不在保存时立刻发
  audit(ctx, '修改设置', '消息通知' + (s.notify.enabled ? '：每天 ' + time : '：关闭'));
  return { ok: true };
}, { admin: true });
route('PUT', '/api/settings/expense-flow', ctx => {
  const b = ctx.body || {}, s = getMeta('settings', {});
  const names = x => [...new Set((Array.isArray(x) ? x : String(x || '').split(/[,，\s]+/)).map(v => String(v).trim()).filter(Boolean))].slice(0, 20);
  const heads = {};
  if (b.deptHeads && typeof b.deptHeads === 'object') {
    for (const [dept, who] of Object.entries(b.deptHeads)) {
      const d = str(dept, 32), n = names(who);
      if (d && n.length) heads[d] = n;
    }
  }
  const modes = {};
  for (const k of ['dept', 'finance', 'gm']) modes[k] = (b.modes && b.modes[k]) === 'any' ? 'any' : 'all';
  const flow = { deptHeads: heads, finance: names(b.finance), gm: names(b.gm), gmThreshold: Math.max(0, round2(Number(b.gmThreshold) || 0)), modes, cc: names(b.cc), allowCustomCc: b.allowCustomCc !== false };
  s.expenseFlow = flow; setMeta('settings', s);
  audit(ctx, '修改报销审批流程', `财务 ${flow.finance.length} 人，总经理 ${flow.gm.length} 人，默认抄送 ${flow.cc.length} 人`);
  return { ok: true, expenseFlow: flow };
}, { perm: 'exp.flow' });
route('POST', '/api/settings/notify/test', async ctx => {
  const b = ctx.body || {}, conf = notifyConf();
  const hookUrl = str((b.webhook && b.webhook.url) || b.url, 500);
  if (hookUrl) conf.webhook = { enabled: true, url: hookUrl };
  if (b.mail) conf.mail = { ...conf.mail, ...b.mail, pass: str(b.mail.pass, 300) || conf.mail.pass };
  const m = notifyText(conf);
  const results = await deliverNotify(conf, '【测试】' + m.text);
  if (!results.length) fail('请先开启一个通知通道（群机器人或邮件）');
  if (!results.some(x => x.ok)) fail(results.map(x => (x.channel === 'mail' ? '邮件' : '群机器人') + '：' + x.error).join('；'));
  audit(ctx, '测试消息通知');
  return { results, text: m.text };
}, { admin: true });
route('GET', '/api/settings/notify/preview', () => notifyText(), { admin: true });

// 打印模板：每种单据一份（标题、抬头、表头项目、明细列的显示 / 顺序 / 名称、签字栏、底部说明、字号），所有用户共用
const PRINT_KINDS = { in: '入库单', out: '出库单', transfer: '调拨单', sales: '销售单', purchase: '采购单', salesReturn: '销售退货单', purchaseReturn: '采购退货单', expense: '费用报销单' };
const PRINT_COLS = ['idx', 'sku', 'barcode', 'name', 'brand', 'spec', 'unit', 'qty', 'price', 'amount', 'category', 'batch', 'regNo', 'regHolder', 'manufacturer', 'expiry', 'note'];
const PRINT_META = ['no', 'type', 'date', 'party', 'wh', 'handler', 'contact', 'address', 'express', 'project', 'applicant', 'dept'];
const isCustomPrintCol = k => typeof k === 'string' && /^custom_[a-zA-Z0-9_-]{1,20}$/.test(k);
function cleanTpl(t) {
  if (!t || typeof t !== 'object') return null;
  let customCnt = 0;
  const cols = (Array.isArray(t.cols) ? t.cols : []).filter((c, i, a) => {
    if (!c || a.findIndex(x => x && x.k === c.k) !== i) return false;
    if (PRINT_COLS.includes(c.k)) return true;
    if (isCustomPrintCol(c.k)) return ++customCnt <= 10;
    return false;
  }).slice(0, 30)
    .map(c => ({
      k: c.k, label: str(c.label, 10), on: !!c.on,
      w: Number.isFinite(+c.w) && +c.w >= 5 && +c.w <= 200 ? Math.round(+c.w) : 0,
      al: ['left', 'center', 'right'].includes(c.al) ? c.al : '',
      ...(isCustomPrintCol(c.k) && str(c.def, 40) ? { def: str(c.def, 40) } : {})
    }));
  const meta = {};
  for (const k of PRINT_META) if (t.meta && k in t.meta) meta[k] = !!t.meta[k];
  const size = Math.round(Number(t.fontSize) || 12);
  const paper = ['', 'a4', 'a4l', 'full', 'half', 'a5'].includes(t.paper) ? t.paper : '';
  const paperW = Number.isFinite(+t.paperW) && +t.paperW >= 120 && +t.paperW <= 300 ? Math.round(+t.paperW) : 0;
  const font = ['song', 'hei', 'kai'].includes(t.font) ? t.font : 'song';
  const logo = typeof t.logo === 'string' && t.logo.length <= 180000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(t.logo) ? t.logo : '';
  const logoPos = ['inline', 'left', 'right', 'top'].includes(t.logoPos) ? t.logoPos : 'inline';
  const preprint = !!t.preprint;
  const hideTable = preprint && !!t.hideTable;
  const hideTableTotal = preprint && !!t.hideTableTotal;
  const offsetX = Number.isFinite(+t.offsetX) ? Math.max(-30, Math.min(80, Math.round(+t.offsetX * 10) / 10)) : 0;
  const offsetY = Number.isFinite(+t.offsetY) ? Math.max(-30, Math.min(120, Math.round(+t.offsetY * 10) / 10)) : 0;
  const rowH = Number.isFinite(+t.rowH) && +t.rowH >= 4 && +t.rowH <= 40 ? Math.round(+t.rowH * 10) / 10 : 0;
  const tableW = Number.isFinite(+t.tableW) && +t.tableW >= 40 && +t.tableW <= 300 ? Math.round(+t.tableW * 10) / 10 : 0;
  const preprintBg = typeof t.preprintBg === 'string' && t.preprintBg.length <= 260000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(t.preprintBg) ? t.preprintBg : '';
  const pos = {};
  if (t.pos && typeof t.pos === 'object' && !Array.isArray(t.pos)) {
    for (const [k, v] of Object.entries(t.pos).slice(0, 40)) {
      if (!/^[a-zA-Z0-9_.:-]{1,32}$/.test(k) || !Array.isArray(v) || v.length < 2) continue;
      const x = Number.isFinite(+v[0]) ? Math.max(-200, Math.min(200, Math.round(+v[0] * 10) / 10)) : 0;
      const y = Number.isFinite(+v[1]) ? Math.max(-200, Math.min(200, Math.round(+v[1] * 10) / 10)) : 0;
      if (x || y) pos[k] = [x, y];
    }
  }
  const boxes = [];
  if (preprint && Array.isArray(t.boxes)) {
    const seenBox = new Set();
    for (const b of t.boxes.slice(0, 30)) {
      if (!b || typeof b !== 'object') continue;
      const bid = typeof b.id === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(b.id) ? b.id : ('b' + (boxes.length + 1));
      if (seenBox.has(bid)) continue;
      seenBox.add(bid);
      const bind = typeof b.bind === 'string' && /^(?:__custom__|(?:order|party|summary|company)\.[a-zA-Z0-9_]{1,24})$/.test(b.bind) ? b.bind : 'order.no';
      boxes.push({
        id: bid,
        name: str(b.name, 20),
        bind,
        customTpl: bind === '__custom__' ? str(b.customTpl, 120) : '',
        x: Number.isFinite(+b.x) ? Math.max(-30, Math.min(300, Math.round(+b.x * 10) / 10)) : 0,
        y: Number.isFinite(+b.y) ? Math.max(-30, Math.min(320, Math.round(+b.y * 10) / 10)) : 0,
        fontSize: Number.isFinite(+b.fontSize) ? Math.min(28, Math.max(8, Math.round(+b.fontSize))) : 12,
        bold: !!b.bold,
        align: ['left', 'center', 'right'].includes(b.align) ? b.align : 'left'
      });
    }
  }
  return { title: str(t.title, 20), header: str(t.header, 300), footer: str(t.footer, 300), signs: str(t.signs, 100),
    fontSize: Math.min(24, Math.max(10, size)), paper, paperW, font, logo, logoPos, preprint, hideTable, hideTableTotal, offsetX, offsetY, rowH, tableW, preprintBg, pos, boxes, upper: t.upper !== false, printer: t.printer !== false, cols, meta };
}
// 商品分类 / 员工部门：列表存在设置里（没被用到的也能保留）；改名 / 删除同时改掉用到它的记录
function namedList(ctx, { key, col, field, label, unit, empty }) {
  const b = ctx.body, s = getMeta('settings', {});
  const clean = x => str(x, 40);
  let names = [...new Set((Array.isArray(b.list) ? b.list : []).map(clean).filter(Boolean))];
  if (names.length > 200) fail(label + '最多 200 个');
  let changed = 0, note = '';
  tx(() => {
    if (b.rename) {
      const from = clean(b.rename.from), to = clean(b.rename.to);
      if (!from || !to) fail('请填写' + label + '名称');
      if (from !== to) {
        for (const r of list(col)) {
          const val = String(r[field] || '');
          if (val === from || (key === 'categories' && val.startsWith(from + '/'))) {
            put(col, { ...r, [field]: to + val.slice(from.length) }); changed++;
          }
        }
        names = [...new Set(names.map(n => n === from ? to : n))];
        if (key === 'categories') names = [...new Set(names.map(n => n.startsWith(from + '/') ? to + n.slice(from.length) : n))];
        if (!names.includes(to)) names.push(to);
        note = `改名「${from}」→「${to}」，${changed} ${unit}`;
      }
    }
    if (b.remove) {
      const name = clean(b.remove);
      if (key === 'categories' && names.some(n => n.startsWith(name + '/'))) fail('请先删除或改名' + label + '下的子分类');
      for (const r of list(col)) if (r[field] === name) { put(col, { ...r, [field]: '' }); changed++; }
      names = names.filter(n => n !== name);
      note = `删除「${name}」，${changed} ${unit}改为${empty}`;
    }
    s[key] = names; setMeta('settings', s);
  });
  audit(ctx, '修改' + label, note || label + '：' + names.join('、'));
  return { [key]: names, changed };
}
route('PUT', '/api/categories', ctx => namedList(ctx, { key: 'categories', col: 'products', field: 'category', label: '商品分类', unit: '个商品', empty: '未分类' }), { perm: 'prod.edit' });
route('PUT', '/api/departments', ctx => namedList(ctx, { key: 'departments', col: 'employees', field: 'dept', label: '部门', unit: '名员工', empty: '未分配部门' }), { perm: 'hr' });
route('POST', '/api/customers/:id/followups', ctx => tx(() => {
  const c = get('customers', ctx.params.id) || fail('客户不存在', 404);
  if (!canSeeCustomer(c, ctx)) fail('只能操作自己负责的客户', 403);
  const text = str(ctx.body.text, 500);
  if (!text) fail('请填写跟进内容');
  const f = { id: uid(), time: new Date().toISOString(), by: ctx.user.name, text };
  c.followups = [...(Array.isArray(c.followups) ? c.followups : []), f].slice(-500);
  put('customers', c);
  audit(ctx, '客户跟进', `${c.name}：${text}`);
  return f;
}), { perm: 'parties' });
route('DELETE', '/api/customers/:id/followups/:fid', ctx => tx(() => {
  const c = get('customers', ctx.params.id) || fail('客户不存在', 404);
  if (!canSeeCustomer(c, ctx)) fail('只能操作自己负责的客户', 403);
  const before = Array.isArray(c.followups) ? c.followups : [];
  const next = before.filter(f => f.id !== ctx.params.fid);
  if (next.length === before.length) fail('跟进记录不存在', 404);
  c.followups = next;
  put('customers', c);
  audit(ctx, '删除客户跟进', c.name);
  return { ok: true };
}), { perm: 'parties' });
route('POST', '/api/projects', ctx => saveProject(ctx, null), { perm: ctx => ctx.perms.has('inv.in') ? 'inv.in' : 'inv.out' });
route('PUT', '/api/projects/:id', ctx => saveProject(ctx, ctx.params.id), { perm: ctx => ctx.perms.has('inv.in') ? 'inv.in' : 'inv.out' });
route('DELETE', '/api/projects/:id', ctx => deleteProject(ctx, ctx.params.id), { perm: ctx => ctx.perms.has('inv.in') ? 'inv.in' : 'inv.out' });

route('PUT', '/api/settings/print', ctx => {
  const kind = ctx.body.kind;
  if (!PRINT_KINDS[kind]) fail('单据类型不正确');
  const s = getMeta('settings', {}), all = { ...(s.printTpl || {}) };
  const lists = { ...(s.printTplList || {}) }, actives = { ...(s.printTplActive || {}) };
  const list = Array.isArray(lists[kind]) ? [...lists[kind]] : [];
  const id = str(ctx.body.id, 40), name = str(ctx.body.name, 30);
  const save = () => {
    lists[kind] = list; s.printTplList = lists; s.printTplActive = actives; s.printTpl = all;
    setMeta('settings', s);
    return { ...all, list, active: actives[kind] || '', defaultTpl: all[kind] || null };
  };
  if (ctx.body.del) {
    const i = list.findIndex(x => x.id === ctx.body.del);
    if (i >= 0) list.splice(i, 1);
    if (actives[kind] === ctx.body.del) { delete actives[kind]; delete all[kind]; }
    audit(ctx, '删除打印模板', PRINT_KINDS[kind]);
    return save();
  }
  const t = cleanTpl(ctx.body.tpl);
  if (t && t.preprint && !hasFeature('preprint')) fail('套打模板功能尚未激活，请先在「系统设置 → 常规设置 → 功能激活」中输入激活码', 403);
  if (ctx.body.create) {
    if (!name) fail('请填写模板名称');
    if (list.length >= 10) fail('每种单据最多 10 套模板');
    const nid = 'tp' + uid();
    list.push({ id: nid, name, tpl: t || null });
    actives[kind] = nid;
    if (t) all[kind] = t; else delete all[kind];
  } else if (id) {
    const e = list.find(x => x.id === id) || fail('模板不存在', 404);
    if (name) e.name = name;
    e.tpl = t;
    actives[kind] = id;
    if (t) all[kind] = t; else delete all[kind];
  } else {
    if (t) all[kind] = t; else delete all[kind];
    delete actives[kind];
  }
  audit(ctx, '修改打印模板', PRINT_KINDS[kind] + (name ? '：' + name : ''));
  return save();
}, { perm: 'tpl.edit' });

const ENTITY_PERM = { products: { POST: 'prod.edit', PUT: 'prod.edit', DELETE: 'prod.delete' }, customers: 'parties', suppliers: 'parties', employees: 'hr', deliveries: ctx => ctx.perms.has('ship.edit') ? 'ship.edit' : 'sales' };
for (const col of Object.keys(ENTITY)) {
  const perm = ctx => typeof ENTITY_PERM[col] === 'function' ? ENTITY_PERM[col](ctx) : typeof ENTITY_PERM[col] === 'string' ? ENTITY_PERM[col] : ENTITY_PERM[col][ctx.method];
  route('POST', `/api/${col}`, ctx => saveEntity(ctx, col, null), { perm });
  route('PUT', `/api/${col}/:id`, ctx => saveEntity(ctx, col, ctx.params.id), { perm });
  route('DELETE', `/api/${col}/:id`, ctx => { const r = deleteEntity(ctx, col, ctx.params.id); if (col === 'products') db.prepare('DELETE FROM images WHERE id = ?').run(ctx.params.id); return r; }, { perm });
}
function importParties(ctx) {
  const type = ctx.body.type === 'suppliers' ? 'suppliers' : 'customers';
  const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : fail('没有可导入的数据');
  if (!rows.length) fail('没有可导入的数据');
  if (rows.length > 5000) fail('一次最多导入 5000 行');
  const update = ctx.body.update === true;
  let created = 0, updated = 0, skipped = 0;
  const errors = [];
  return tx(() => {
    const existing = list(type);
    rows.forEach((raw, idx) => {
      const body = {};
      for (const [k, [t]] of Object.entries(ENTITY[type].fields)) {
        if (!(k in raw)) continue;
        let v = raw[k];
        if (t === 'n') { const n = Number(v); if (!Number.isFinite(n) || n < 0) v = 0; else v = round2(n); }
        else v = str(v, 500);
        if (v === '' || v == null) continue;
        body[k] = v;
      }
      const name = str(body.name, 200);
      if (!name) { skipped++; errors.push(`第 ${idx + 2} 行缺少名称`); return; }
      if (body.licenseExp && !isDate(body.licenseExp)) { skipped++; errors.push(`第 ${idx + 2} 行许可证有效期格式应为 YYYY-MM-DD`); return; }
      const hit = existing.find(x => x.name === name || (body.phone && x.phone === body.phone));
      if (hit) {
        if (update) {
          if (type === 'customers') {
            if (!canSeeCustomer(hit, ctx)) { skipped++; return; }
            if (!allParties(ctx)) { delete body.ownerId; delete body.ownerName; }
            else if (body.ownerId) { const u = S.userById.get(body.ownerId); if (u) body.ownerName = u.name; }
          }
          Object.assign(hit, body); put(type, hit); updated++;
        } else skipped++;
        return;
      }
      const own = type === 'customers' ? {
        creatorId: ctx.user.id, creator: ctx.user.name,
        ownerId: allParties(ctx) ? (body.ownerId || '') : ctx.user.id,
        ownerName: allParties(ctx) ? ((body.ownerId && S.userById.get(body.ownerId) ? S.userById.get(body.ownerId).name : '') || body.ownerName || '') : ctx.user.name
      } : {};
      const rec = { id: uid(), ...body, ...own, createdAt: today() };
      put(type, rec); existing.push(rec); created++;
    });
    audit(ctx, '批量导入' + (type === 'customers' ? '客户' : '供应商'), `新增 ${created}，更新 ${updated}，跳过 ${skipped}`);
    return { created, updated, skipped, errors: errors.slice(0, 20) };
  });
}
route('POST', '/api/import/parties', ctx => importParties(ctx), { perm: 'parties' });
const orderPerm = { perm: ctx => (ORD[ctx.params.kind] || ORD.purchase).perm };
route('POST', '/api/orders/:kind', ctx => saveOrder(ctx, ctx.params.kind, null), orderPerm);
route('PUT', '/api/orders/:kind/:id', ctx => saveOrder(ctx, ctx.params.kind, ctx.params.id), orderPerm);
route('DELETE', '/api/orders/:kind/:id', ctx => deleteOrder(ctx, ctx.params.kind, ctx.params.id), orderPerm);
route('POST', '/api/orders/:kind/:id/:action', ctx => orderAction(ctx, ctx.params.kind, ctx.params.id, ctx.params.action), orderPerm);
route('PUT', '/api/orders/:kind/:id/pays/:fid', ctx => editPay(ctx, ctx.params.kind, ctx.params.id, ctx.params.fid, false), orderPerm);
route('DELETE', '/api/orders/:kind/:id/pays/:fid', ctx => editPay(ctx, ctx.params.kind, ctx.params.id, ctx.params.fid, true), orderPerm);
route('POST', '/api/party-payments', ctx => partyPaymentCreate(ctx), { perm: 'finance' });
  route('POST', '/api/party-payments/batch', ctx => partyPaymentBatch(ctx), { perm: 'finance' });
route('POST', '/api/party-payments/:id/apply', ctx => partyPaymentApply(ctx, ctx.params.id), { perm: 'finance' });
route('DELETE', '/api/party-payments/:id', ctx => partyPaymentDelete(ctx, ctx.params.id), { perm: 'finance' });
const pricePerm = { perm: ctx => (PRICE_COL[ctx.params.col] || PRICE_COL.suppliers).perm };
route('PUT', '/api/prices/:col/:id', ctx => savePrices(ctx, ctx.params.col, ctx.params.id), pricePerm);
route('POST', '/api/prices/:col/import', ctx => importPrices(ctx, ctx.params.col), pricePerm);
route('POST', '/api/stock/:id', ctx => adjustStock(ctx, ctx.params.id), { perm: ctx => ({ in: 'inv.in', out: 'inv.out' })[ctx.body.mode] || 'inv.checkpost' });
route('POST', '/api/checkdocs', ctx => createCheck(ctx), { perm: 'inv.check' });
route('PUT', '/api/checkdocs/:id', ctx => saveCheck(ctx, ctx.params.id), { perm: 'inv.check' });
route('POST', '/api/checkdocs/:id/post', ctx => postCheck(ctx, ctx.params.id), { perm: 'inv.checkpost' });
route('POST', '/api/checkdocs/:id/void', ctx => voidCheck(ctx, ctx.params.id), { perm: 'inv.check' });
route('POST', '/api/products/import', ctx => importProducts(ctx), { perm: 'prod.edit' });
route('PUT', '/api/products/:id/cost', ctx => tx(() => {
  const p = get('products', ctx.params.id) || fail('商品不存在', 404);
  const cost = round4(Number(ctx.body.cost));
  if (!Number.isFinite(cost) || cost < 0) fail('成本价必须是非负数字');
  const reason = str(ctx.body.reason, 200);
  if (!reason) fail('请填写成本修正原因');
  const old = p.cost || 0;
  p.cost = cost; p.costAdjustedAt = new Date().toISOString(); p.costAdjustedBy = ctx.user.name;
  if (fifoOn()) rebuildCostLayers(p);
  put('products', p);
  audit(ctx, '修正商品成本', `${p.name}：${old} → ${cost}；${reason}`);
  return p;
}), { admin: true });
route('GET', '/api/products/:id/image', ctx => getProductImage(ctx, ctx.params.id));
route('PUT', '/api/products/:id/image', ctx => saveProductImage(ctx, ctx.params.id), { perm: 'prod.edit' });
route('DELETE', '/api/products/:id/image', ctx => deleteProductImage(ctx, ctx.params.id), { perm: 'prod.edit' });
route('PUT', '/api/products/:id/bom', ctx => saveBom(ctx, ctx.params.id), { perm: 'bom' });
route('POST', '/api/bom/import', ctx => importBoms(ctx), { perm: 'bom' });
route('PUT', '/api/bom/cols', ctx => saveBomCols(ctx), { perm: 'bom' });
route('POST', '/api/stockdocs', ctx => saveStockDoc(ctx), { perm: ctx => ctx.body.dir === 'out' ? 'inv.out' : 'inv.in' });
route('PUT', '/api/stockdocs/:id', ctx => updateStockDoc(ctx, ctx.params.id), { perm: 'inv.view' });  // 具体入出库权限和单据状态在函数里判断
route('DELETE', '/api/stockdocs/:id', ctx => deleteStockDoc(ctx, ctx.params.id), { perm: 'inv.view' });  // 具体作废/本人删除权限在函数里判断
route('POST', '/api/bom/assemble', ctx => bomTransform(ctx, 'assemble'), { perm: 'bom' });
route('POST', '/api/bom/disassemble', ctx => bomTransform(ctx, 'disassemble'), { perm: 'bom' });
route('POST', '/api/stockdocs/import', ctx => importStockDocs(ctx));
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
  return { html: sanitizeLabelHtml(l.html), trackNo: s.trackNo };
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
route('POST', '/api/accounts', ctx => saveAccount(ctx, null), { perm: 'finance' });
route('PUT', '/api/accounts/:id', ctx => saveAccount(ctx, ctx.params.id), { perm: 'finance' });
route('DELETE', '/api/accounts/:id', ctx => deleteAccount(ctx, ctx.params.id), { perm: 'finance' });
route('GET', '/api/accounts/balances', () => Object.fromEntries(list('accounts').map(a => [a.id, acctBalance(a.id)])), { perm: 'finance' });
route('POST', '/api/acct-transfers', ctx => addTransfer(ctx), { perm: 'finance' });
route('DELETE', '/api/acct-transfers/:id', ctx => deleteTransfer(ctx, ctx.params.id), { perm: 'finance' });
route('PUT', '/api/finance/:id', ctx => editFinance(ctx, ctx.params.id), { perm: 'finance' });
route('DELETE', '/api/finance/:id', ctx => deleteFinance(ctx, ctx.params.id), { perm: 'finance' });
route('POST', '/api/invoices', ctx => saveInvoice(ctx, null), { perm: 'finance' });
route('PUT', '/api/invoices/:id', ctx => saveInvoice(ctx, ctx.params.id), { perm: 'finance' });
route('DELETE', '/api/invoices/:id', ctx => deleteInvoice(ctx, ctx.params.id), { perm: 'finance' });
route('POST', '/api/graindocs', ctx => createGrainDoc(ctx), { perm: 'agri' });
route('POST', '/api/graindocs/:id/pay', ctx => payGrainDoc(ctx, ctx.params.id), { perm: 'agri' });
route('DELETE', '/api/graindocs/:id/pays/:fid', ctx => delGrainPay(ctx, ctx.params.id, ctx.params.fid), { perm: 'agri' });
route('POST', '/api/graindocs/:id/void', ctx => voidGrainDoc(ctx, ctx.params.id), { perm: 'agri' });

/* ---------- #8 合同管理（模板 + 合同台账，支持关联销售/采购/粮食单） ---------- */
const contractPerm = ctx => ['sales', 'purchase', 'agri', 'finance'].find(k => ctx.perms.has(k)) || 'sales';
const CONTRACT = { col: 'contracts', prefix: 'HT', title: '合同' };
route('POST', '/api/contract-tpls', ctx => tx(() => {
  const b = ctx.body || {}, name = str(b.name, 60) || fail('请填写合同模板名称');
  const rec = { id: uid(), name, kind: str(b.kind, 30) || '通用合同', body: String(b.body || '').slice(0, 20000), createdAt: new Date().toISOString() };
  put('contractTpls', rec); audit(ctx, '新建合同模板', name); return rec;
}), { perm: contractPerm });
route('PUT', '/api/contract-tpls/:id', ctx => tx(() => {
  const o = get('contractTpls', ctx.params.id) || fail('模板不存在', 404), b = ctx.body || {};
  Object.assign(o, { name: str(b.name, 60) || o.name, kind: str(b.kind, 30) || o.kind, body: b.body != null ? String(b.body).slice(0, 20000) : o.body });
  put('contractTpls', o); audit(ctx, '修改合同模板', o.name); return o;
}), { perm: contractPerm });
route('DELETE', '/api/contract-tpls/:id', ctx => tx(() => {
  const o = get('contractTpls', ctx.params.id) || fail('模板不存在', 404);
  del('contractTpls', o.id); audit(ctx, '删除合同模板', o.name); return { ok: true };
}), { perm: contractPerm });
function canSeeContractKind(kind, ctx) {
  if (ctx.user.role === 'admin' || ctx.perms.has('finance')) return true;
  if (kind === '销售合同') return ctx.perms.has('sales');
  if (kind === '采购合同') return ctx.perms.has('purchase');
  if (kind === '粮食购销合同') return ctx.perms.has('agri');
  return ['sales', 'purchase', 'agri', 'finance'].some(k => ctx.perms.has(k));
}
function canSeeContract(o, ctx) {
  if (!o) return false;
  if (!canSeeContractKind(o.kind, ctx)) return false;
  if (!allParties(ctx)) {
    if (o.partyType === 'customer' && o.partyId) {
      const c = get('customers', o.partyId);
      if (c && !canSeeCustomer(c, ctx) && o.creatorId !== ctx.user.id) return false;
    } else if (o.kind === '销售合同' && o.creatorId && o.creatorId !== ctx.user.id) {
      return false;
    }
  }
  return true;
}
function saveContract(ctx, id) {
  return tx(() => {
    const b = ctx.body || {}, old = id ? (get('contracts', id) || fail('合同不存在', 404)) : null;
    if (old && !canSeeContract(old, ctx)) fail('无权修改该合同', 403);
    const title = str(b.title, 100) || fail('请填写合同标题');
    const kind = ['销售合同', '采购合同', '粮食购销合同', '通用合同'].includes(b.kind) ? b.kind : '通用合同';
    if (!canSeeContractKind(kind, ctx)) fail(`没有权限创建或修改「${kind}」`, 403);
    const partyType = ['customer', 'supplier'].includes(b.partyType) ? b.partyType : '';
    const partyId = str(b.partyId, 64);
    const partyRec = partyId ? get(partyType === 'supplier' ? 'suppliers' : 'customers', partyId) : null;
    if (partyRec && partyType === 'customer' && !canSeeCustomer(partyRec, ctx)) fail('只能为自己负责的客户签订合同', 403);
    const partyName = str(b.partyName, 100) || (partyRec ? partyRec.name : '') || fail('请填写对方单位 / 姓名');
    const orderKind = ['sales', 'purchase', 'grain'].includes(b.orderKind) ? b.orderKind : '';
    const orderId = str(b.orderId, 64);
    const orderRec = orderKind && orderId ? get(orderKind === 'grain' ? 'grainDocs' : ORD[orderKind].col, orderId) : null;
    const amount = round2(Math.max(0, Number(b.amount || 0)));
    const base = old || { id: uid(), no: nextNo(CONTRACT), createdAt: new Date().toISOString(), creator: ctx.user.name, creatorId: ctx.user.id };
    const rawContent = String(b.content || '').slice(0, 20000);
    const content = rawContent.replace(/\{\{合同编号\}\}/g, base.no).replace(/(合同编号[：:]\s*)自动生成/g, '$1' + base.no);
    const rec = {
      ...base,
      title, kind, partyType, partyId: partyRec ? partyRec.id : '', partyName,
      orderKind: orderRec ? orderKind : '', orderId: orderRec ? orderRec.id : '', orderNo: orderRec ? orderRec.no : '',
      amount, date: isDate(b.date) ? b.date : (old ? old.date : today()),
      startDate: isDate(b.startDate) ? b.startDate : '', endDate: isDate(b.endDate) ? b.endDate : '',
      status: ['草稿', '执行中', '已完成', '已终止'].includes(b.status) ? b.status : (old ? old.status : '执行中'),
      tplId: str(b.tplId, 64), content, note: str(b.note, 300)
    };
    put('contracts', rec); audit(ctx, old ? '修改合同' : '新建合同', `${rec.no} ${rec.title}`); return rec;
  });
}
route('POST', '/api/contracts', ctx => saveContract(ctx, null), { perm: contractPerm });
route('PUT', '/api/contracts/:id', ctx => saveContract(ctx, ctx.params.id), { perm: contractPerm });
route('DELETE', '/api/contracts/:id', ctx => tx(() => {
  const o = get('contracts', ctx.params.id) || fail('合同不存在', 404);
  if (!canSeeContract(o, ctx)) fail('无权删除该合同', 403);
  del('contracts', o.id); audit(ctx, '删除合同', o.no); return { ok: true };
}), { perm: contractPerm });

/* ---------- #9 人事考勤打卡 / 奖惩 & 按月自动生成工资表（支持临工代表代领） ---------- */
function saveAttendance(ctx, id) {
  return tx(() => {
    const b = ctx.body || {}, old = id ? (get('attendance', id) || fail('考勤记录不存在', 404)) : null;
    const emp = get('employees', str(b.empId, 64)) || fail('请选择员工');
    const date = isDate(b.date) ? b.date : today();
    const days = round2(Math.max(0, Math.min(31, Number(b.days ?? 1))));
    const overtime = round2(Math.max(0, Number(b.overtime || 0)));
    const bonus = round2(Math.max(0, Number(b.bonus || 0)));
    const fine = round2(Math.max(0, Number(b.fine || 0)));
    const rec = {
      ...(old || { id: uid(), createdAt: new Date().toISOString(), creator: ctx.user.name }),
      empId: emp.id, empName: emp.name, dept: emp.dept || '', date, days, overtime, bonus, fine, note: str(b.note, 200)
    };
    put('attendance', rec); audit(ctx, old ? '修改考勤' : '考勤打卡', `${emp.name} ${date} ${days}天`); return rec;
  });
}
route('POST', '/api/attendance', ctx => saveAttendance(ctx, null), { perm: 'hr' });
route('PUT', '/api/attendance/:id', ctx => saveAttendance(ctx, ctx.params.id), { perm: 'hr' });
route('DELETE', '/api/attendance/:id', ctx => tx(() => {
  const o = get('attendance', ctx.params.id) || fail('考勤记录不存在', 404);
  del('attendance', o.id); audit(ctx, '删除考勤', `${o.empName} ${o.date}`); return { ok: true };
}), { perm: 'hr' });
route('POST', '/api/payrolls/generate', ctx => tx(() => {
  const month = str((ctx.body || {}).month, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) fail('月份格式应为 YYYY-MM');
  const existing = list('payrolls').find(p => p.month === month);
  if (existing && existing.paid) fail(`${month} 工资表已发放，不能重新生成`);
  const atts = list('attendance').filter(a => String(a.date || '').startsWith(month));
  const attEmpIds = new Set(atts.map(a => a.empId));
  // 在职/临工全员参与；本月已有考勤/奖罚记录的离职员工/临工也必须纳入结算，避免漏发已发生工资
  const emps = list('employees').filter(e => e.status !== '离职' || attEmpIds.has(e.id));
  if (!emps.length) fail('没有在职、临工或本月有考勤记录的员工可生成工资表');
  const items = emps.map(e => {
    const mine = atts.filter(a => a.empId === e.id);
    const days = round2(mine.reduce((n, a) => n + (+a.days || 0), 0));
    const overtime = round2(mine.reduce((n, a) => n + (+a.overtime || 0), 0));
    const bonus = round2(mine.reduce((n, a) => n + (+a.bonus || 0), 0));
    const fine = round2(mine.reduce((n, a) => n + (+a.fine || 0), 0));
    const isTemp = e.status === '临工' || (e.status === '离职' && (+e.dailyWage > 0 || !!e.tempRep));
    const basePay = isTemp
      ? round2((+e.dailyWage > 0 ? +e.dailyWage : (+e.salary || 0) / 26) * days)
      : (e.status === '离职' ? round2((+e.salary || 0) / 26 * days) : round2(+e.salary || 0));
    const netPay = round2(Math.max(0, basePay + overtime + bonus - fine));
    return { empId: e.id, empName: e.name, dept: e.dept || '', status: e.status || '在职', tempRep: isTemp ? (e.tempRep || '') : '', days, basePay, overtime, bonus, fine, netPay };
  });
  const totalPay = round2(items.reduce((n, i) => n + i.netPay, 0));
  const rec = {
    ...(existing || { id: uid(), no: 'GZ' + month.replace('-', ''), createdAt: new Date().toISOString() }),
    month, date: today(), items, totalPay, paid: false, status: '待发放', creator: ctx.user.name
  };
  put('payrolls', rec); audit(ctx, '生成月工资表', `${month} 共 ${items.length} 人 ¥${totalPay.toFixed(2)}`); return rec;
}), { perm: 'hr' });
route('POST', '/api/payrolls/:id/pay', ctx => tx(() => {
  const p = get('payrolls', ctx.params.id) || fail('工资表不存在', 404);
  if (p.paid) fail('该月工资已发放');
  const acct = pickAccount(ctx.body || {});
  p.paid = true; p.status = '已发放'; p.payDate = today(); p.account = acct.id;
  put('payrolls', p);
  if (p.totalPay > 0) {
    put('finance', { id: uid(), date: today(), type: 'expense', category: '工资', amount: p.totalPay, account: acct.id, method: acct.kind, ref: p.no, note: `${p.month} 工资发放（${p.items.length} 人）`, operator: ctx.user.name });
  }
  audit(ctx, '发放月工资', `${p.month} ¥${p.totalPay.toFixed(2)}`); return p;
}), { perm: ctx => ctx.perms.has('finance') ? 'finance' : 'hr' });
route('DELETE', '/api/payrolls/:id', ctx => tx(() => {
  const p = get('payrolls', ctx.params.id) || fail('工资表不存在', 404);
  if (p.paid) fail('已发放的工资表不能删除');
  del('payrolls', p.id); audit(ctx, '删除工资表', p.month); return { ok: true };
}), { perm: 'hr' });

/* ---------- #10 固定资产台账 & 按月计提折旧联动财务 ---------- */
const ASSET = { col: 'fixedAssets', prefix: 'ZC', title: '固定资产' };
function saveFixedAsset(ctx, id) {
  return tx(() => {
    const b = ctx.body || {}, old = id ? (get('fixedAssets', id) || fail('固定资产不存在', 404)) : null;
    const name = str(b.name, 80) || fail('请填写资产名称');
    const origValue = round2(Number(b.origValue));
    if (!Number.isFinite(origValue) || origValue <= 0) fail('资产原值必须大于 0');
    const salvageRate = round2(Math.max(0, Math.min(50, Number(b.salvageRate ?? 5))));
    const lifeMonths = Math.max(1, Math.min(600, Math.round(Number(b.lifeMonths || 36))));
    const accumDep = round2(Math.max(0, Math.min(origValue, Number(b.accumDep ?? (old ? old.accumDep : 0)))));
    const netValue = round2(Math.max(0, origValue - accumDep));
    const rec = {
      ...(old || { id: uid(), no: nextNo(ASSET), createdAt: new Date().toISOString(), lastDepMonth: '' }),
      name, category: str(b.category, 40) || '机械设备',
      date: isDate(b.buyDate || b.date) ? (b.buyDate || b.date) : today(),
      buyDate: isDate(b.buyDate || b.date) ? (b.buyDate || b.date) : today(),
      origValue, salvageRate, lifeMonths, accumDep, netValue,
      dept: str(b.dept, 40), keeper: str(b.keeper, 40),
      status: ['使用中', '闲置', '已报废'].includes(b.status) ? b.status : '使用中',
      note: str(b.note, 300)
    };
    put('fixedAssets', rec); audit(ctx, old ? '修改固定资产' : '新增固定资产', `${rec.no} ${rec.name}`); return rec;
  });
}
route('POST', '/api/fixed-assets', ctx => saveFixedAsset(ctx, null), { perm: 'finance' });
route('PUT', '/api/fixed-assets/:id', ctx => saveFixedAsset(ctx, ctx.params.id), { perm: 'finance' });
route('DELETE', '/api/fixed-assets/:id', ctx => tx(() => {
  const o = get('fixedAssets', ctx.params.id) || fail('固定资产不存在', 404);
  del('fixedAssets', o.id); audit(ctx, '删除固定资产', `${o.no} ${o.name}`); return { ok: true };
}), { perm: 'finance' });
route('POST', '/api/fixed-assets/depreciate', ctx => tx(() => {
  const b = ctx.body || {}, month = str(b.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) fail('折旧月份格式应为 YYYY-MM');
  const assets = list('fixedAssets').filter(a => {
    if (a.status !== '使用中') return false;
    const doneMonths = Array.isArray(a.depMonths) ? a.depMonths : (a.lastDepMonth ? [a.lastDepMonth] : []);
    if (doneMonths.includes(month)) return false;
    if (a.buyDate && String(a.buyDate).slice(0, 7) > month) return false;
    return true;
  });
  let totalDep = 0, count = 0;
  for (const a of assets) {
    const salvage = round2(a.origValue * (a.salvageRate || 0) / 100);
    const maxDep = round2(Math.max(0, a.origValue - salvage));
    const left = round2(Math.max(0, maxDep - (a.accumDep || 0)));
    if (left <= 0.001) continue;
    const step = Math.min(left, round2(maxDep / (a.lifeMonths || 36)));
    if (step <= 0) continue;
    a.accumDep = round2((a.accumDep || 0) + step);
    a.netValue = round2(Math.max(0, a.origValue - a.accumDep));
    const doneMonths = Array.isArray(a.depMonths) ? a.depMonths : (a.lastDepMonth ? [a.lastDepMonth] : []);
    a.depMonths = [...new Set([...doneMonths, month])].sort();
    a.lastDepMonth = a.depMonths[a.depMonths.length - 1];
    put('fixedAssets', a);
    totalDep = round2(totalDep + step);
    count++;
  }
  if (!count) fail(`${month} 没有需要计提折旧的在用资产（可能该月已计提、早于购置月份或已提足）`);
  // 折旧属非现金费用：记入费用统计但不扣减任何资金账户余额
  put('finance', { id: uid(), date: today(), type: 'expense', category: '固定资产折旧', amount: totalDep, account: '', method: '折旧摊销', nonCash: true, ref: 'ZJ-' + month, note: `${month} 固定资产月度折旧（${count} 项，非现金费用）`, operator: ctx.user.name });
  audit(ctx, '固定资产计提折旧', `${month} ${count}项 ¥${totalDep.toFixed(2)}`);
  return { month, count, totalDep };
}), { perm: 'finance' });

/* ---------- #21 工程结算（人工费 + 商品材料清单扣库存 + 杂项费用） ---------- */
const engPerm = ctx => ['sales', 'inv.out', 'finance'].find(k => ctx.perms.has(k)) || 'sales';
const ENG = { col: 'engJobs', prefix: 'GC', title: '工程单' };
route('POST', '/api/engjobs', ctx => tx(() => {
  const b = ctx.body || {}, name = str(b.name, 100) || fail('请填写工程名称');
  const date = isDate(b.date) ? b.date : today(), wh = pickWh(b.wh);
  const cust = b.customerId ? get('customers', str(b.customerId, 64)) : null;
  const partyName = str(b.partyName, 100) || (cust ? cust.name : '');
  const rawItems = (Array.isArray(b.items) ? b.items : []).filter(i => i && i.productId && Number(i.qty) > 0);
  if (rawItems.length) {
    if (!ctx.perms.has('inv.out')) fail('工程单包含材料出库，需要具备「出库」权限', 403);
    if (needApprove('out')) fail('已开启出库审核，工程单暂不能直接扣减库存，请先在库存管理提交出库单审核');
  }
  const items = rawItems.map(i => {
    const p = get('products', i.productId) || fail('商品不存在');
    const uq = unitQty(p, i), rawPrice = round4(Math.max(0, Number(i.price ?? (uq.rate ? (p.price || 0) * uq.rate : p.price) ?? 0)));
    const baseUnitPrice = basePrice(rawPrice, uq);
    return { productId: p.id, productName: p.name, unit: uq.unit || p.unit, qty: uq.qty, ...(uq.rate ? { rate: uq.rate, uqty: uq.uqty, uprice: rawPrice } : {}), price: baseUnitPrice, amount: round2(uq.qty * baseUnitPrice) };
  });
  const labors = (Array.isArray(b.labors) ? b.labors : []).filter(l => l && str(l.name, 60)).map(l => ({
    name: str(l.name, 60), days: round2(Math.max(0, Number(l.days || 1))), rate: round2(Math.max(0, Number(l.rate || 0))),
    amount: round2(Math.max(0, Number(l.amount != null && l.amount !== '' ? l.amount : (Number(l.days || 1) * Number(l.rate || 0))))), note: str(l.note, 100)
  }));
  const miscs = (Array.isArray(b.miscs) ? b.miscs : []).filter(m => m && str(m.name, 60)).map(m => ({
    name: str(m.name, 60), amount: round2(Math.max(0, Number(m.amount || 0))), note: str(m.note, 100)
  }));
  if (!items.length && !labors.length && !miscs.length) fail('请至少录入一项材料、人工费或杂项费用');
  const id = uid(), no = nextNo(ENG);
  let stockDocId = '', stockDocNo = '';
  if (items.length) {
    const lack = lackOf(items, wh);
    if (lack.length) fail(lackText(lack, wh));
    items.forEach(i => {
      const p = get('products', i.productId);
      const m = moveStock(ctx, p, -i.qty, '销售出库', no, name, { wh, date });
      i.cost = round4(m.unit);
    });
    const sd = {
      id: uid(), no: nextNo(DOC.out), dir: 'out', type: '销售出库', wh, date, time: hhmm(),
      party: partyName || name, handler: ctx.user.name, remark: `工程用料 ${no} · ${name}`,
      srcOrderId: id, srcOrderNo: no, srcOrderKind: 'eng',
      items: items.map(i => ({ productId: i.productId, unit: i.unit, qty: i.qty, price: i.cost || 0, sale: i.price, note: '工程 ' + no })),
      status: '正常', creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString(), printCount: 0
    };
    put('stockDocs', sd); stockDocId = sd.id; stockDocNo = sd.no;
  }
  const matTotal = round2(items.reduce((n, i) => n + i.amount, 0));
  const laborTotal = round2(labors.reduce((n, i) => n + i.amount, 0));
  const miscTotal = round2(miscs.reduce((n, i) => n + i.amount, 0));
  const totalAmount = round2(matTotal + laborTotal + miscTotal);
  const rec = {
    id, no, name, date, wh, customerId: cust ? cust.id : '', partyName,
    items, labors, miscs, matTotal, laborTotal, miscTotal, totalAmount, paid: 0,
    stockDocId, stockDocNo, status: '施工中', note: str(b.note, 300),
    creator: ctx.user.name, creatorId: ctx.user.id, createdAt: new Date().toISOString()
  };
  put('engJobs', rec); audit(ctx, '新建工程单', `${no} ${name} ¥${totalAmount.toFixed(2)}`); return maskEngJob(ctx, rec);
}), { perm: engPerm });
route('PUT', '/api/engjobs/:id', ctx => tx(() => {
  const o = get('engJobs', ctx.params.id) || fail('工程单不存在', 404), b = ctx.body || {};
  if (o.status === '已作废') fail('已作废工程单不能修改');
  if (['施工中', '已完工'].includes(b.status)) o.status = b.status;
  if ('note' in b) o.note = str(b.note, 300);
  if (Array.isArray(b.labors)) {
    o.labors = b.labors.filter(l => l && str(l.name, 60)).map(l => ({ name: str(l.name, 60), days: round2(Math.max(0, Number(l.days || 1))), rate: round2(Math.max(0, Number(l.rate || 0))), amount: round2(Math.max(0, Number(l.amount ?? (Number(l.days || 1) * Number(l.rate || 0))))), note: str(l.note, 100) }));
    o.laborTotal = round2(o.labors.reduce((n, i) => n + i.amount, 0));
  }
  if (Array.isArray(b.miscs)) {
    o.miscs = b.miscs.filter(m => m && str(m.name, 60)).map(m => ({ name: str(m.name, 60), amount: round2(Math.max(0, Number(m.amount || 0))), note: str(m.note, 100) }));
    o.miscTotal = round2(o.miscs.reduce((n, i) => n + i.amount, 0));
  }
  const nextTotal = round2((o.matTotal || 0) + (o.laborTotal || 0) + (o.miscTotal || 0));
  if (nextTotal + 0.001 < (o.paid || 0)) fail(`工程单已收款 ¥${(o.paid || 0).toFixed(2)}，修改后的工程总额不能低于已收金额`);
  o.totalAmount = nextTotal;
  put('engJobs', o); audit(ctx, '更新工程单', `${o.no} ${o.status}`); return maskEngJob(ctx, o);
}), { perm: engPerm });
route('POST', '/api/engjobs/:id/pay', ctx => tx(() => {
  const o = get('engJobs', ctx.params.id) || fail('工程单不存在', 404), b = ctx.body || {};
  if (o.status === '已作废') fail('已作废工程单不能收款');
  const unpaid = round2(o.totalAmount - (o.paid || 0)), amount = round2(Number(b.amount));
  if (!(amount > 0) || amount > unpaid + 0.001) fail(`收款金额需在 0 ~ ${unpaid} 之间`);
  const acct = pickAccount(b);
  o.paid = round2((o.paid || 0) + amount);
  put('finance', { id: uid(), date: isDate(b.date) ? b.date : today(), type: 'income', category: '工程收款', amount, account: acct.id, method: acct.kind, ref: o.no, note: str(b.note, 200) || `工程结算 · ${o.name}`, operator: ctx.user.name });
  put('engJobs', o); audit(ctx, '工程收款', `${o.no} ¥${amount.toFixed(2)}`); return maskEngJob(ctx, o);
}), { perm: engPerm });
route('POST', '/api/engjobs/:id/void', ctx => tx(() => {
  const o = get('engJobs', ctx.params.id) || fail('工程单不存在', 404);
  if (o.status === '已作废') fail('工程单已作废');
  if ((o.paid || 0) > 0) fail('已有收款记录，无法直接作废');
  const sd = o.stockDocId ? get('stockDocs', o.stockDocId) : null;
  if (!sd || sd.status !== '已作废') {
    list('stockLogs').filter(l => (l.ref === o.no || (o.stockDocNo && l.ref === o.stockDocNo)) && !l.voided)
      .forEach(l => put('stockLogs', { ...l, voided: true }));
    for (const i of o.items || []) {
      const p = get('products', i.productId);
      if (p) moveStock(ctx, p, i.qty, '作废冲回', o.no, o.name, { price: i.cost != null ? i.cost : p.cost || 0, wh: o.wh || DEFAULT_WH, voided: true });
    }
    if (sd) { Object.assign(sd, { status: '已作废', voidBy: ctx.user.name, voidAt: new Date().toISOString() }); put('stockDocs', sd); }
  }
  o.status = '已作废'; put('engJobs', o); audit(ctx, '作废工程单', o.no); return maskEngJob(ctx, o);
}), { perm: engPerm });

/* ---------- #11 田间管理（地块 KML/KMZ 导入 + 农事记录日历） ---------- */
function saveFieldPlot(ctx, id) {
  return tx(() => {
    const b = ctx.body || {}, old = id ? (get('fieldPlots', id) || fail('地块不存在', 404)) : null;
    const name = str(b.name, 80) || fail('请填写地块名称');
    const coords = (Array.isArray(b.coords) ? b.coords : (old ? old.coords : [])).filter(pt => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(+pt[0]) && Number.isFinite(+pt[1])).slice(0, 500).map(pt => [round4(+pt[0]), round4(+pt[1])]);
    const center = Array.isArray(b.center) && b.center.length >= 2 ? [round4(+b.center[0]), round4(+b.center[1])]
      : coords.length ? [round4(coords.reduce((s, p) => s + p[0], 0) / coords.length), round4(coords.reduce((s, p) => s + p[1], 0) / coords.length)] : [104.0668, 30.5728];
    const rec = {
      ...(old || { id: uid(), createdAt: new Date().toISOString() }),
      name, areaMu: round2(Math.max(0, Number(b.areaMu || 0))), crop: str(b.crop, 60),
      plantDate: isDate(b.plantDate) ? b.plantDate : '', owner: str(b.owner, 40),
      coords, center, note: str(b.note, 300)
    };
    put('fieldPlots', rec); audit(ctx, old ? '修改地块' : '新增地块', `${rec.name} ${rec.areaMu}亩`); return rec;
  });
}
route('POST', '/api/field-plots', ctx => saveFieldPlot(ctx, null), { perm: 'agri' });
route('PUT', '/api/field-plots/:id', ctx => saveFieldPlot(ctx, ctx.params.id), { perm: 'agri' });
route('DELETE', '/api/field-plots/:id', ctx => tx(() => {
  const o = get('fieldPlots', ctx.params.id) || fail('地块不存在', 404);
  del('fieldPlots', o.id); audit(ctx, '删除地块', o.name); return { ok: true };
}), { perm: 'agri' });
route('POST', '/api/farm-logs', ctx => tx(() => {
  const b = ctx.body || {}, plot = b.plotId ? get('fieldPlots', str(b.plotId, 64)) : null;
  const date = isDate(b.date) ? b.date : today();
  const task = str(b.task, 100) || fail('请填写农事安排 / 内容');
  const photos = (Array.isArray(b.photos) ? b.photos : []).filter(x => typeof x === 'string' && x.length <= 800000 && /^data:image\/(jpeg|png|webp);base64,/i.test(x)).slice(0, 4);
  const rec = {
    id: uid(), plotId: plot ? plot.id : '', plotName: plot ? plot.name : str(b.plotName, 80),
    date, crop: str(b.crop, 60) || (plot ? plot.crop || '' : ''), task, owner: str(b.owner, 40) || ctx.user.name,
    note: str(b.note, 400), ...(photos.length ? { photos } : {}), createdAt: new Date().toISOString()
  };
  put('farmLogs', rec); audit(ctx, '农事记录', `${rec.plotName || ''} ${rec.task}`); return rec;
}), { perm: 'agri' });
route('DELETE', '/api/farm-logs/:id', ctx => tx(() => {
  const o = get('farmLogs', ctx.params.id) || fail('农事记录不存在', 404);
  del('farmLogs', o.id); audit(ctx, '删除农事记录', o.task); return { ok: true };
}), { perm: 'agri' });
route('POST', '/api/expenses', ctx => createExpense(ctx), { perm: expPerm });
route('PUT', '/api/expenses/:id', ctx => saveExpense(ctx, ctx.params.id), { perm: expPerm });
route('POST', '/api/expenses/:id/approve', ctx => approveExpense(ctx, ctx.params.id, true), { perm: expStepPerm });
route('POST', '/api/expenses/:id/reject', ctx => approveExpense(ctx, ctx.params.id, false), { perm: expStepPerm });
  route('POST', '/api/expenses/:id/addsigner', ctx => addExpenseSigner(ctx, ctx.params.id), { perm: expStepPerm });
  route('POST', '/api/expenses/:id/transfer', ctx => transferExpense(ctx, ctx.params.id), { perm: expStepPerm });
  route('POST', '/api/expenses/:id/urge', ctx => urgeExpense(ctx, ctx.params.id), { perm: expPerm });
  route('POST', '/api/expenses/:id/withdraw', ctx => withdrawExpense(ctx, ctx.params.id), { perm: expPerm });
route('POST', '/api/expenses/:id/pay', ctx => payExpense(ctx, ctx.params.id), { perm: 'finance' });
route('POST', '/api/expenses/:id/unpay', ctx => unpayExpense(ctx, ctx.params.id), { perm: 'finance' });
route('POST', '/api/expenses/:id/void', ctx => voidExpense(ctx, ctx.params.id), { perm: expPerm });
route('POST', '/api/expenses/:id/images', ctx => addExpenseImage(ctx, ctx.params.id), { perm: expPerm });
route('DELETE', '/api/expenses/:id/images/:k', ctx => delExpenseImage(ctx, ctx.params.id, ctx.params.k), { perm: expPerm });
route('GET', '/api/expenses/:id/images/:k', ctx => getExpenseImage(ctx, ctx.params.id, ctx.params.k), { perm: expViewPerm });
route('POST', '/api/expenses/:id/payimages', ctx => addExpensePayImage(ctx, ctx.params.id), { perm: 'finance' });
route('DELETE', '/api/expenses/:id/payimages/:k', ctx => delExpensePayImage(ctx, ctx.params.id, ctx.params.k), { perm: 'finance' });
route('GET', '/api/expenses/:id/payimages/:k', ctx => getExpensePayImage(ctx, ctx.params.id, ctx.params.k), { perm: expViewPerm });
route('POST', '/api/advances', ctx => createAdvance(ctx), { perm: expPerm });
route('PUT', '/api/advances/:id', ctx => saveAdvance(ctx, ctx.params.id), { perm: expPerm });
route('POST', '/api/advances/:id/approve', ctx => approveAdvance(ctx, ctx.params.id, true), { perm: 'exp.approve' });
route('POST', '/api/advances/:id/reject', ctx => approveAdvance(ctx, ctx.params.id, false), { perm: 'exp.approve' });
route('POST', '/api/advances/:id/pay', ctx => payAdvance(ctx, ctx.params.id), { perm: 'finance' });
route('POST', '/api/advances/:id/return', ctx => returnAdvance(ctx, ctx.params.id), { perm: 'finance' });
route('POST', '/api/advances/:id/void', ctx => voidAdvance(ctx, ctx.params.id), { perm: expPerm });

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
route('GET', '/api/people', () => db.prepare('SELECT id, username, name FROM users WHERE disabled = 0 ORDER BY created_at').all().map(u => ({ ...u, dept: userDept(u) })));
route('POST', '/api/users', ctx => { const id = createUser(ctx.body); audit(ctx, '新增用户', ctx.body.username); return { id }; }, { admin: true });
route('PUT', '/api/users/:id', ctx => {
  const u = S.userById.get(ctx.params.id) || fail('用户不存在', 404), b = ctx.body;
  const r = pickRole(b.roleId);
  if (u.role === 'admin' && r.role !== 'admin' && S.adminCount.get().n <= 1) fail('系统至少需要保留一个管理员');
  if (u.id === ctx.user.id && r.role !== 'admin') fail('不能取消自己的管理员身份');
  const newName = str(b.name, 32) || u.name;
  tx(() => {
    db.prepare('UPDATE users SET name = ?, role = ?, role_id = ? WHERE id = ?').run(newName, r.role, r.roleId, u.id);
    if (b.password) {
      if (String(b.password).length < 6) fail('密码至少 6 位');
      const { salt, hash } = hashPwd(b.password);
      db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').run(salt, hash, u.id);
      if (u.id !== ctx.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    list('employees').filter(e => e.userId === u.id).forEach(e => {
      if (e.name !== newName || e.username !== u.username) {
        e.name = newName; e.username = u.username; put('employees', e);
      }
    });
  });
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
  tx(() => {
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    list('employees').filter(e => e.userId === u.id).forEach(e => { delete e.userId; delete e.username; put('employees', e); });
  });
  audit(ctx, '删除用户', u.username);
}, { admin: true });
route('GET', '/api/audit', ctx => db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(1000, +ctx.query.get('limit') || 200)), { admin: true });
route('GET', '/api/backup', ctx => { audit(ctx, '导出备份'); return backup(); }, { admin: true });
route('POST', '/api/restore', ctx => restore(ctx), { admin: true });
route('GET', '/api/cloud/status', async ctx => {
  if (!config.cloud.token) return cloudState();
  try {
    const r = await cloudReq('/status', { token: config.cloud.token });
    const d = await r.json();
    config.cloud.account = d.account;
    if (d.slug) config.cloud.slug = d.slug;
    if (d.remote) {
      config.cloud.slugUpdated = d.remote.slugUpdated || 0;
      config.cloud.nextSlugAt = d.remote.nextSlugAt || 0;
    }
    saveConfig();
    return { ...cloudState(), backups: d.backups || [] };
  } catch (e) {
    if (e.status === 401) { config.cloud.token = ''; config.cloud.account = null; config.cloud.auto = false; saveConfig(); return { ...cloudState(), error: '云备份授权已失效，请重新输入授权码' }; }
    throw e;
  }
}, { admin: true });
route('POST', '/api/cloud/activate', async ctx => {
  const code = str(ctx.body.code, 40);
  if (!code) fail('请输入授权码');
  const r = await cloudReq('/activate', { method: 'POST', body: { code, device: config.cloud.device, name: os.hostname(), transfer: ctx.body.transfer === true } });
  const d = await r.json();
  config.cloud.token = d.token;
  config.cloud.account = d.account;
  if (d.slug) config.cloud.slug = d.slug;
  if (d.tunnelSecret) config.cloud.tunnelSecret = d.tunnelSecret;
  config.cloud.remote = true;
  saveConfig();
  cloudTunnelStart();
  audit(ctx, '开通云备份', `${d.account.planName}，到期 ${fmtDate(new Date(d.account.expires * 1000))}`);
  return { ...cloudState(), backups: [], tunnelSecret: d.tunnelSecret || undefined };
}, { admin: true });
route('POST', '/api/cloud/passphrase', ctx => {
  const pass = String(ctx.body.pass || '');
  if (pass.length < 6) fail('备份密码至少 6 位');
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(pass, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const check = crypto.createHash('sha256').update(key).digest('hex');
  if (config.cloud.keyCheck && config.cloud.keyCheck !== check && config.cloud.account && config.cloud.account.backups > 0)
    fail('云端已有备份，修改密码会导致旧备份无法解密。请先删除旧备份，或继续使用原来的密码');
  config.cloud.salt = salt;
  config.cloud.keyCheck = check;
  if (ctx.body.remember === false) { delete config.cloud.key; config.cloud.auto = false; }
  else config.cloud.key = key.toString('base64');
  saveConfig();
  audit(ctx, '设置云备份密码', ctx.body.remember === false ? '不记住密码' : '已记住密码');
  return { ok: true, ...cloudState() };
}, { admin: true });
route('POST', '/api/cloud/backup', async ctx => {
  const d = await cloudBackupNow(ctx.body.pass);
  audit(ctx, '云备份上传', d.name);
  return { ...d, ...cloudState() };
}, { admin: true });
route('POST', '/api/cloud/download/:id', async ctx => {
  const d = await cloudDownload(ctx.params.id, ctx.body.pass);
  return { [RAW]: { type: 'application/octet-stream', body: d.plain } };
}, { admin: true });
route('POST', '/api/cloud/restore', async ctx => {
  const d = await cloudRestore(ctx.params.id || ctx.body.id, ctx.body.pass, ctx);
  audit(ctx, '从云备份恢复', `文档 ${d.docs} 条`);
  return d;
}, { admin: true });
route('DELETE', '/api/cloud/backups/:id', async ctx => {
  const r = await cloudReq('/backup/' + encodeURIComponent(ctx.params.id), { method: 'DELETE', token: config.cloud.token });
  const d = await r.json();
  config.cloud.account = d.account; saveConfig();
  audit(ctx, '删除云备份', ctx.params.id);
  return { ...cloudState(), backups: d.backups || [] };
}, { admin: true });
route('POST', '/api/cloud/auto', ctx => {
  const on = !!ctx.body.enabled;
  if (on && !config.cloud.key) fail('请先设置并记住备份密码，自动备份需要它');
  config.cloud.auto = on; saveConfig();
  audit(ctx, on ? '开启云备份自动上传' : '关闭云备份自动上传');
  return { ok: true, ...cloudState() };
}, { admin: true });
route('POST', '/api/cloud/remote', async ctx => {
  const on = !!ctx.body.enabled;
  if (on && !config.cloud.token) fail('还没有开通云服务，请先输入授权码');
  if (on && !config.cloud.tunnelSecret) {
    const r = await cloudReq('/tunnel/init', { method: 'POST', token: config.cloud.token, body: {} });
    const d = await r.json();
    if (d.tunnelSecret) { config.cloud.tunnelSecret = d.tunnelSecret; config.cloud.slug = d.slug; }
  }
  if (on && !config.cloud.tunnelSecret) fail('远程访问初始化失败，请稍后再试');
  config.cloud.remote = on; saveConfig();
  if (on) cloudTunnelStart(); else cloudTunnelStop();
  audit(ctx, on ? '开启远程访问' : '关闭远程访问');
  return { ok: true, ...cloudState() };
}, { admin: true });
route('GET', '/api/cloud/slug/check', async ctx => {
  if (!config.cloud.token) fail('还没有开通云服务，请先输入授权码');
  const slug = str(ctx.query.get('slug'), 32).toLowerCase();
  if (!slug) return { available: false, reason: '请输入自定义前缀' };
  const r = await cloudReq('/tunnel/slug/check?slug=' + encodeURIComponent(slug), { token: config.cloud.token });
  return await r.json();
}, { admin: true });
route('POST', '/api/cloud/slug', async ctx => {
  if (!config.cloud.token) fail('还没有开通云服务，请先输入授权码');
  const slug = str(ctx.body.slug, 32).toLowerCase();
  if (!slug) fail('请输入自定义地址前缀');
  const r = await cloudReq('/tunnel/slug', { method: 'POST', token: config.cloud.token, body: { slug } });
  const d = await r.json();
  config.cloud.slug = d.slug;
  config.cloud.slugUpdated = d.slugUpdated || 0;
  config.cloud.nextSlugAt = d.nextSlugAt || 0;
  saveConfig();
  audit(ctx, '修改远程访问地址', d.url);
  return { ok: true, ...cloudState(), url: d.url };
}, { admin: true });
route('POST', '/api/reset-demo', ctx => tx(() => { writeAll(seed()); setMeta('counters', {}); audit(ctx, '重置演示数据'); }), { admin: true });
// 清空前要再输一次当前账号的登录密码，防止误点或别人用你没锁的电脑清掉数据
route('POST', '/api/clear', ctx => {
  if (!checkPwd(ctx.user, ctx.body.password)) fail('密码不正确，数据没有清空');
  tx(() => { writeAll({}); setMeta('counters', {}); audit(ctx, '清空业务数据'); });
}, { admin: true });

/* ================= 消息通知：库存预警 / 应收逾期 / 生日提醒 / 待审批 / 经营日报，通道支持群机器人与邮件 ================= */
const NOTIFY_EVENTS = {
  lowStock: '库存预警',
  overdue: '应收逾期',
  birthday: '生日提醒',
  pendingApproval: '待审批',
  daily: '经营日报',
  license: '证照到期',
};
function notifyConf() {
  const n = getMeta('settings', {}).notify || {};
  const hasNew = !!n.webhook || !!n.mail || !!n.events;
  const webhook = { enabled: !!n.url, url: n.url || '', ...(n.webhook || {}) };
  const mail = { enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '', ...(n.mail || {}) };
  return {
    enabled: !!n.enabled,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(n.time) ? n.time : '08:30',
    skipEmpty: n.skipEmpty !== false,
    overdueDays: Math.max(1, Math.min(365, +n.overdueDays || 30)),
    events: { lowStock: true, overdue: false, birthday: false, pendingApproval: false, daily: false, ...(hasNew ? n.events || {} : {}) },
    webhook,
    mail,
  };
}
function idBirthdaySrv(id) {
  const s = String(id || '').trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s) && !/^\d{15}$/.test(s)) return '';
  const d = s.length === 18 ? s.slice(6, 14) : '19' + s.slice(6, 12);
  const y = +d.slice(0, 4), m = +d.slice(4, 6), day = +d.slice(6, 8);
  return y >= 1900 && m >= 1 && m <= 12 && day >= 1 && day <= 31 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
}
function notifyText(conf = notifyConf()) {
  const s = getMeta('settings', {}), ev = conf.events, lines = [], company = s.company || 'x.erp';
  let count = 0;

  if (ev.lowStock) {
    const days = +s.expiryDays || 30;
    const low = list('products').filter(p => p.safety > 0 && p.stock < p.safety).sort((a, b) => a.stock - b.stock);
    const now = new Date(today()), left = b => Math.round((new Date(b.expDate) - now) / 864e5);
    const exp = list('batches').filter(b => b.qty > 0 && b.expDate && left(b) <= days).sort((a, b) => a.expDate.localeCompare(b.expDate));
    const pend = list('stockDocs').filter(o => o.status === '待审核');
    const part = [];
    if (low.length) part.push(`【库存不足】${low.length} 个商品`, ...low.slice(0, 10).map(p => `· ${p.name}：${p.stock}${p.unit || ''}（安全库存 ${p.safety}）`), ...(low.length > 10 ? [`· ……另有 ${low.length - 10} 个`] : []));
    if (exp.length) {
      const pn = id => (get('products', id) || {}).name || '已删除商品';
      part.push(`【保质期】${exp.filter(b => left(b) < 0).length} 个批次已过期，${exp.filter(b => left(b) >= 0).length} 个批次 ${days} 天内到期`,
        ...exp.slice(0, 8).map(b => `· ${pn(b.productId)} 批次 ${b.no}：${left(b) < 0 ? '已过期' : left(b) + ' 天后到期'}（${b.expDate}，${b.qty}）`));
    }
    if (pend.length) part.push(`【待审核】${pend.length} 张出入库单等待审核`);
    if (part.length) { lines.push(...part); count += low.length + exp.length + pend.length; }
  }

  if (ev.overdue) {
    const od = conf.overdueDays, m = new Map();
    for (const o of list('sales')) {
      if (o.status === '已作废') continue;
      const due = round2(orderTotal(o) - (o.received || 0));
      if (due <= 0.001) continue;
      const age = Math.round((new Date(today()) - new Date(o.date)) / 864e5);
      if (age < od) continue;
      const k = o.customerId;
      const cur = m.get(k) || { name: (get('customers', k) || {}).name || '已删除客户', amt: 0, n: 0, oldest: 0 };
      cur.amt = round2(cur.amt + due); cur.n++; cur.oldest = Math.max(cur.oldest, age);
      m.set(k, cur);
    }
    const arr = [...m.values()].sort((a, b) => b.amt - a.amt);
    if (arr.length) {
      count += arr.length;
      lines.push(`【应收逾期】${arr.length} 个客户有超过 ${od} 天未结清的货款，合计 ¥${arr.reduce((x, v) => x + v.amt, 0).toFixed(2)}`,
        ...arr.slice(0, 8).map(v => `· ${v.name}：¥${v.amt.toFixed(2)}（${v.n} 张单，最长 ${v.oldest} 天）`),
        ...(arr.length > 8 ? [`· ……另有 ${arr.length - 8} 个`] : []));
    }
  }

  if (ev.birthday) {
    const bd = +s.birthdayDays || 7, out = [], base = new Date(today());
    for (const e of list('employees')) {
      if (e.status === '离职') continue;
      const b = idBirthdaySrv(e.idCard);
      if (!b) continue;
      let x = new Date(base.getFullYear(), +b.slice(5, 7) - 1, +b.slice(8, 10));
      if (x < base) x = new Date(base.getFullYear() + 1, +b.slice(5, 7) - 1, +b.slice(8, 10));
      const dd = Math.round((x - base) / 864e5);
      if (dd <= bd) out.push({ name: e.name, dept: e.dept || '', b, dd });
    }
    out.sort((a, b) => a.dd - b.dd);
    if (out.length) {
      count += out.length;
      lines.push(`【生日提醒】${out.length} 位员工 ${bd} 天内过生日`, ...out.map(x => `· ${x.name}${x.dept ? '（' + x.dept + '）' : ''} ${x.b.slice(5)} ${x.dd === 0 ? '就是今天' : x.dd + ' 天后'}`));
    }
  }

  if (ev.pendingApproval) {
    const ex = list('expenses').filter(o => o.status === '待审批');
    const ad = list('advances').filter(o => o.status === '待审批');
    if (ex.length || ad.length) {
      count += ex.length + ad.length;
      lines.push(`【待审批】报销 ${ex.length} 张${ex.length ? `（¥${ex.reduce((x, o) => x + (o.amount || 0), 0).toFixed(2)}）` : ''}，备用金 ${ad.length} 张`);
    }
  }

  if (ev.daily) {
    const tod = today();
    const sales = list('sales').filter(o => o.status !== '已作废' && o.date === tod);
    const amt = round2(sales.reduce((x, o) => x + orderTotal(o), 0));
    const cash = round2(list('finance').filter(f => f.date === tod && f.category === '销售收款').reduce((x, f) => x + f.amount, 0));
    const receiv = round2(list('sales').filter(o => o.status !== '已作废').reduce((x, o) => x + Math.max(0, orderTotal(o) - (o.received || 0)), 0));
    const lowN = list('products').filter(p => p.safety > 0 && p.stock < p.safety).length;
    const cost = round2(sum(sales, o => sum(o.items || [], i => (+i.qty || 0) * (+i.cost || 0))));
    const gp = round2(amt - cost), gpRate = amt > 0 ? (gp / amt * 100) : 0;
    const tops = new Map();
    for (const o of sales) for (const i of (o.items || [])) {
      if (!i || !i.productId) continue;
      const cur = tops.get(i.productId) || { name: (get('products', i.productId) || {}).name || '已删除商品', qty: 0, amt: 0 };
      cur.qty = round2(cur.qty + (+i.qty || 0));
      cur.amt = round2(cur.amt + (+i.qty || 0) * (+i.price || 0) - (+i.lineDiscount || 0));
      tops.set(i.productId, cur);
    }
    const top5 = [...tops.values()].sort((a, b) => b.amt - a.amt).slice(0, 5);
    count += 1;
    lines.push('【经营日报】', `· 今日销售 ${sales.length} 单，¥${amt.toFixed(2)}`, `· 今日毛利 ¥${gp.toFixed(2)}（${gpRate.toFixed(1)}%）`, `· 今日收款 ¥${cash.toFixed(2)}`, `· 待收款合计 ¥${receiv.toFixed(2)}`, `· 缺货商品 ${lowN} 个`);
    if (top5.length) lines.push('· 热销商品：' + top5.map((x, n) => `${n + 1}. ${x.name} ×${x.qty} ¥${x.amt.toFixed(2)}`).join('、'));
  }

  if (ev.license) {
    const within = 60, base = new Date(today());
    const rows = list('products').filter(p => p.regExp).map(p => ({ p, left: Math.round((new Date(p.regExp) - base) / 864e5) }))
      .filter(x => x.left <= within).sort((a, b) => a.left - b.left);
    const parts = [...list('suppliers').map(x => ({ name: x.name, kind: '供应商', no: x.licenseNo || '', exp: x.licenseExp })),
      ...list('customers').map(x => ({ name: x.name, kind: '客户', no: x.licenseNo || '', exp: x.licenseExp }))]
      .filter(x => x.exp).map(x => ({ ...x, left: Math.round((new Date(x.exp) - base) / 864e5) }))
      .filter(x => x.left <= within).sort((a, b) => a.left - b.left);
    if (rows.length || parts.length) {
      count += rows.length + parts.length;
      lines.push(`【证照到期】${rows.length + parts.length} 个证照即将到期或已过期`);
      lines.push(...rows.slice(0, 6).map(x => `· 商品 ${x.p.name}：${x.p.regNo || '无注册证号'}，${x.left < 0 ? '已过期 ' + (-x.left) + ' 天' : x.left + ' 天后到期'}（${x.p.regExp}）`));
      lines.push(...parts.slice(0, 6).map(x => `· ${x.kind} ${x.name}：${x.no || '无许可证号'}，${x.left < 0 ? '已过期 ' + (-x.left) + ' 天' : x.left + ' 天后到期'}（${x.exp}）`));
      if (rows.length + parts.length > 12) lines.push(`· ……另有 ${rows.length + parts.length - 12} 个`);
    }
  }

  return { count, text: `${company} 经营提醒 ${today()}\n` + (lines.length ? lines.join('\n') : '今天没有需要处理的事项。') };
}
// 按地址判断机器人类型，拼对应的消息格式
async function sendNotify(url, text) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) fail('推送地址必须以 http:// 或 https:// 开头');
  const feishu = /feishu\.cn|larksuite\.com/.test(u.hostname);
  const body = /qyapi\.weixin\.qq\.com|dingtalk\.com/.test(u.hostname) ? { msgtype: 'text', text: { content: text } }
    : feishu ? { msg_type: 'text', content: { text } } : { title: 'x.erp 经营提醒', text, message: text };
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); }
  catch (e) { fail('推送失败：连不上推送地址（' + (e.cause && e.cause.code || e.message) + '）'); }
  const t = await r.text();
  if (!r.ok) fail(`推送失败：对方返回 HTTP ${r.status} ${t.slice(0, 200)}`);
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (j && ((j.errcode && j.errcode !== 0) || (feishu && j.code && j.code !== 0))) fail('推送失败：' + (j.errmsg || j.msg || t.slice(0, 200)));
}
/* ---------- 邮件通道：内置最小 SMTP 客户端（默认 465 SSL），不依赖第三方库 ---------- */
function smtpTalk(host, port, secure) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = '', cur = [], done = [], waiters = [], dead = null, settled = false;
    const push = r => { const w = waiters.shift(); if (w) w.res(r); else done.push(r); };
    const die = e => { dead = dead || e; while (waiters.length) waiters.shift().rej(dead); };
    sock.setEncoding('utf8');
    sock.setTimeout(20000);
    sock.on('data', d => {
      buf += d;
      for (;;) {
        const i = buf.indexOf('\n'); if (i < 0) break;
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        cur.push(line);
        if (/^\d{3}(?: |$)/.test(line)) { const r = cur.join('\n'); cur = []; push(r); }
      }
    });
    sock.on('error', e => { die(e); if (!settled) { settled = true; reject(e); } });
    sock.on('timeout', () => { const e = new Error('连接邮件服务器超时'); die(e); if (!settled) { settled = true; reject(e); } });
    const api = {
      read: () => done.length ? Promise.resolve(done.shift()) : dead ? Promise.reject(dead) : new Promise((res, rej) => waiters.push({ res, rej })),
      cmd: line => { sock.write(line + '\r\n'); return api.read(); },
      write: data => sock.write(data),
      close: () => { try { sock.end(); } catch (e) {} },
    };
    sock.once(secure ? 'secureConnect' : 'connect', () => { settled = true; resolve(api); });
  });
}
async function sendMail(cfg, subject, text) {
  const host = String(cfg.host || '').trim();
  if (!host) fail('请填写 SMTP 服务器地址');
  const to = String(cfg.to || '').split(/[,;，；\s]+/).filter(Boolean);
  if (!to.length) fail('请填写收件人邮箱');
  const port = +cfg.port || 465, secure = cfg.secure !== false;
  let c;
  try { c = await smtpTalk(host, port, secure); } catch (e) { fail('连不上邮件服务器：' + e.message); }
  try {
    let r = await c.read();
    if (!/^220/.test(r)) fail('邮件服务器拒绝连接：' + r.slice(0, 100));
    r = await c.cmd('EHLO x.erp');
    if (!/^250/.test(r)) fail('EHLO 失败：' + r.slice(0, 100));
    if (cfg.user) {
      r = await c.cmd('AUTH LOGIN');
      if (!/^334/.test(r)) fail('邮件服务器不支持账号密码登录');
      r = await c.cmd(Buffer.from(String(cfg.user)).toString('base64'));
      if (!/^334/.test(r)) fail('邮箱账号不正确');
      r = await c.cmd(Buffer.from(String(cfg.pass || '')).toString('base64'));
      if (!/^235/.test(r)) fail('邮箱授权码不正确（QQ 邮箱要填授权码，不是登录密码）');
    }
    const from = String(cfg.from || cfg.user || '').trim();
    if (!from) fail('请填写发件人邮箱');
    r = await c.cmd(`MAIL FROM:<${from}>`);
    if (!/^250/.test(r)) fail('发件人被拒绝：' + r.slice(0, 100));
    for (const addr of to) {
      r = await c.cmd(`RCPT TO:<${addr}>`);
      if (!/^(250|251)/.test(r)) fail('收件人被拒绝（' + addr + '）：' + r.slice(0, 100));
    }
    r = await c.cmd('DATA');
    if (!/^354/.test(r)) fail('服务器不接受邮件正文');
    const head = [
      `From: =?UTF-8?B?${Buffer.from('x.erp').toString('base64')}?= <${from}>`,
      `To: ${to.join(', ')}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ].join('\r\n');
    const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    c.write(head + '\r\n\r\n' + body + '\r\n.\r\n');
    r = await c.read();
    if (!/^250/.test(r)) fail('邮件被服务器拒收：' + r.slice(0, 100));
    try { await c.cmd('QUIT'); } catch (e) {}
  } finally { try { c.close(); } catch (e) {} }
}
async function deliverNotify(conf, text) {
  const out = [], wh = conf.webhook || {}, ml = conf.mail || {};
  if (wh.enabled && wh.url) {
    try { await sendNotify(wh.url, text); out.push({ channel: 'webhook', ok: true }); }
    catch (e) { out.push({ channel: 'webhook', ok: false, error: e.message }); }
  }
  if (ml.enabled && ml.host && ml.to) {
    try { await sendMail(ml, 'x.erp 经营提醒', text); out.push({ channel: 'mail', ok: true }); }
    catch (e) { out.push({ channel: 'mail', ok: false, error: e.message }); }
  }
  return out;
}
let notifyBusy = false;
/* ---------- 问题反馈：用户留言发到作者官网，作者在官网后台回复，这里取回回复 ----------
 * 本机首次留言时随机生成 fbToken（只用来取回本机自己的留言和回复），留言在本地也存一份。
 * 留言带上版本号和系统类型；称呼、联系方式可不填，联系方式只有作者能看到。XERP_FEEDBACK_URL 可改地址，设为空字符串则关闭 */
const PLAT = process.env.XERP_PLAT || (process.env.TRIM_PKGVAR ? 'fnos' : process.platform);  // Docker 是 docker，飞牛包是 fnos
/* ---------- 在线更新：只检查版本、下载安装包；是否安装由用户自己在应用中心 / 安装程序里确认 ---------- */
const UPDATE_URLS = [process.env.XERP_UPDATE_URL, 'https://www.zhaoyoucai.xyz/xerp/updates.json', 'https://raw.githubusercontent.com/Zyc009234/x.erp/main/updates.json'].filter(Boolean);
const UPDATE_HOSTS = new Set(['www.zhaoyoucai.xyz', 'zhaoyoucai.xyz', 'github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'gitee.com']);
const UPDATE_CACHE_MS = 10 * 60e3;
let updateCache = { at: 0, data: null };
const cmpVer = (a, b) => {
  const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const updateKey = () => PLAT === 'fnos' ? 'fnos' : PLAT === 'win32' ? 'windows' : PLAT === 'docker' ? 'docker' : null;
const updateAllowLocal = () => process.env.XERP_UPDATE_ALLOW_LOCAL === '1';
async function fetchUpdates() {
  if (updateCache.data && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.data;
  let lastErr;
  for (const url of UPDATE_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'x.erp/' + VERSION } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!j || j.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(String(j.latest || '')) || !j.packages || typeof j.packages !== 'object') throw new Error('清单格式不正确');
      updateCache = { at: Date.now(), data: j };
      return j;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('没有可用的更新地址');
}
const FEEDBACK_URL = process.env.XERP_FEEDBACK_URL ?? 'https://www.zhaoyoucai.xyz/xerp/api/feedback';
function fbToken() {
  let t = getMeta('fbToken', '');
  if (!/^[0-9a-f]{32}$/.test(t)) { t = crypto.randomBytes(16).toString('hex'); setMeta('fbToken', t); }
  return t;
}
const fbList = () => getMeta('feedback', []);
const fbUnread = () => fbList().filter(f => f.replied && f.replied !== f.seen).length;
async function fbPost(path, body) {
  if (!FEEDBACK_URL) fail('留言功能已关闭');
  let r;
  try { r = await fetch(FEEDBACK_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); }
  catch (e) { fail('连不上作者的服务器，请确认这台设备能上网后再试', 502); }
  if (r.status === 429) fail('留言太频繁了，请过一会儿再试', 429);
  if (!r.ok) fail(`留言服务暂时不可用（${r.status}）`, 502);
  return r.json();
}
// 取回服务器上的回复、公开状态并入本地记录；作者删掉的留言本地也去掉
async function fbSync() {
  const remote = await fbPost('/mine', { token: fbToken() }), byFid = new Map(remote.map(x => [x.fid, x]));
  const list = fbList().filter(f => byFid.has(f.fid)).map(f => {
    const x = byFid.get(f.fid);
    const imgs = Array.isArray(x.images) && x.images.length ? x.images : (x.image ? [x.image] : []);
    return { ...f, reply: x.reply, replied: x.replied, public: x.public, ...(imgs.length ? { images: imgs, image: imgs[0] } : {}) };
  });
  setMeta('feedback', list); setMeta('fbSynced', Date.now());
  return list;
}
// 有近 60 天的留言时，每 6 小时取一次回复，侧栏「问题反馈」上显示未读回复数
async function fbTick() {
  const list = fbList(), recent = fmtDate(new Date(Date.now() - 60 * 864e5));
  if (!FEEDBACK_URL || !list.some(f => f.at >= recent) || Date.now() - getMeta('fbSynced', 0) < 6 * 3600e3) return;
  try { await fbSync(); } catch (e) {}
}
route('GET', '/api/feedback', async () => {
  let list = fbList(), error = '';
  if (list.length) try { list = await fbSync(); } catch (e) { error = e.message; }
  if (list.some(f => f.replied && f.replied !== f.seen)) { list = list.map(f => ({ ...f, seen: f.replied || f.seen })); setMeta('feedback', list); }  // 打开页面就算看过回复
  return { list: [...list].reverse(), error };
}, { admin: true });
route('POST', '/api/feedback', async ctx => {
  const b = ctx.body, text = String(b.text ?? '').trim().slice(0, 2000), nick = str(b.nick, 30), contact = str(b.contact, 100), allowPublic = !!b.allowPublic;
  const hasImagesArr = Array.isArray(b.images);
  const rawImgs = hasImagesArr ? b.images.filter(Boolean) : (b.image ? [b.image] : []);
  if (rawImgs.length > 4) fail('最多只能上传 4 张截图');
  const images = rawImgs.map(x => String(x || ''));
  let totalImgLen = 0;
  for (const img of images) {
    if (!/^data:image\/(jpeg|png|webp);base64,/i.test(img) || img.length > 1.2e6) fail('截图格式不正确或单张超过限制，请重新截图');
    totalImgLen += img.length;
  }
  if (totalImgLen > 4e6) fail('截图总大小超过限制，请减少数量或压缩后再试');
  const image = images[0] || '';
  if (!text) fail('请填写留言内容');
  const r = await fbPost('', { token: fbToken(), v: VERSION, plat: PLAT, nick, contact, text, allowPublic, ...(image ? { image } : {}), ...(hasImagesArr && images.length ? { images } : {}) });
  const d = new Date(), list = fbList();
  list.push({ fid: r.fid, at: today() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()), by: ctx.user.name, nick, contact, text, ...(image ? { image } : {}), ...(images.length ? { images } : {}), allowPublic, reply: '', replied: '', public: false, seen: '' });
  setMeta('feedback', list.slice(-200));
  audit(ctx, '问题反馈', text.slice(0, 60));
  return { fid: r.fid };
}, { admin: true });

/* ---------- 匿名使用统计：每天报一次 安装 ID（首次启动随机生成）、版本号、系统类型，不含任何业务数据和个人信息 ----------
 * 默认开启，系统设置里可关闭；连不上外网就静默跳过，不影响使用。环境变量 XERP_STATS_URL 可改地址，设为空字符串则完全不发 */
const STATS_URL = process.env.XERP_STATS_URL ?? 'http://101.201.141.121/xerp/api/ping';
async function statsTick() {
  if (!STATS_URL || getMeta('settings', {}).stats === false || getMeta('statsLast', '') === today()) return;
  let id = getMeta('installId', '');
  if (!/^[0-9a-f]{32}$/.test(id)) { id = crypto.randomBytes(16).toString('hex'); setMeta('installId', id); }
  try {
    const r = await fetch(STATS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, v: VERSION, plat: PLAT }), signal: AbortSignal.timeout(10000) });
    if (r.ok) setMeta('statsLast', today());
  } catch (e) {}
}
async function notifyTick() {
  const n = notifyConf();
  if (notifyBusy || !n.enabled || hhmm() < n.time || getMeta('notifyLast', '') === today()) return;
  if (!(n.webhook.enabled && n.webhook.url) && !(n.mail.enabled && n.mail.host && n.mail.to)) return;
  notifyBusy = true; setMeta('notifyLast', today());
  try {
    const m = notifyText(n);
    if (!m.count && n.skipEmpty) return;
    const r = await deliverNotify(n, m.text);
    const okN = r.filter(x => x.ok).length;
    if (okN) log('已推送经营提醒（' + okN + ' 个通道）');
    const bad = r.filter(x => !x.ok);
    if (bad.length) log('部分通知推送失败：' + bad.map(x => x.channel + ' ' + x.error).join('；'));
  } catch (e) { log('消息推送失败：' + e.message); } finally { notifyBusy = false; }
}

/* ================= HTTP 服务 ================= */
// 在线演示（XERP_DEMO=1）：公开给所有人试用。屏蔽改密码 / 账号 / 角色、推送、快递鸟、导入备份 / 清空、问题反馈、上传商品图片
// ——这些会把别人锁在门外、往外发请求或打扰作者。数据重置靠部署侧（每小时重启并清空数据目录）。
const DEMO_BLOCK = [/^POST \/api\/password$/, /^(POST|PUT|DELETE) \/api\/(users|roles)(\/|$)/, /^(PUT|POST) \/api\/settings\/(notify|kdn)(\/|$)/,
  /^POST \/api\/ship\/(eorder|track-all)$/, /^POST \/api\/shipments\/[^/]+\/(track|cancel-eorder)$/, /^POST \/api\/(restore|clear)$/, /^POST \/api\/feedback$/,
  /^(PUT|DELETE) \/api\/products\/[^/]+\/image$/, /^POST \/api\/expenses\/[^/]+\/images$/, /^\/api\/cloud\//];  // 商品图片：公开演示里不让传图，免得有人传不合适的图片给别的访客看
// 在线演示跑在本机 Caddy 后面：只有来自本机的连接才信任 X-Forwarded-For，否则所有访客都是 127.0.0.1，一人输错密码会锁住所有人
function clientIp(req) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fwd = DEMO && (peer === '127.0.0.1' || peer === '::1') && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || peer;
}
const demoBlocked = (method, p) => DEMO && DEMO_BLOCK.some(re => re.test(method + ' ' + p));
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
      return res.end(DEMO ? indexHtml().replace('</head>', '<script>window.XERP_DEMO = 1;</script></head>') : indexHtml());
    }
    const v = req.method === 'GET' && vendorFile(url.pathname);
    if (v) { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800' }); return res.end(v); }
    res.writeHead(404); return res.end();
  }
  const ctx = { ip: clientIp(req), method: req.method, query: url.searchParams, body: {}, user: null, params: {}, perms: new Set() };
  try {
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname)) || fail('接口不存在', 404);
    if (demoBlocked(req.method, url.pathname)) fail('在线演示版不能使用这个功能（改密码、账号、推送、导入备份、留言、上传图片等），下载安装后就能用', 403);
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
    if (out && out[RAW]) { res.writeHead(200, { 'Content-Type': out[RAW].type, 'Cache-Control': 'private, max-age=31536000' }); return res.end(out[RAW].body); }
    send(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) log('错误', req.method, url.pathname, e.stack || e.message);
    send(res, status, { error: status === 500 ? '服务器内部错误：' + e.message : e.message });
  }
});
// 默认 0.0.0.0（老版本写进 config.json 的也是它）改成监听 ::，IPv4 和 IPv6 都能连；系统关了 IPv6 时退回只听 IPv4
const DUAL = !config.host || config.host === '0.0.0.0';
let listenHost = DUAL ? '::' : config.host;
server.on('error', e => {
  if (DUAL && listenHost === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code)) {
    log('本机没有启用 IPv6，改为只监听 IPv4'); listenHost = '0.0.0.0'; return server.listen(config.port, listenHost);
  }
  log(e.code === 'EADDRINUSE' ? `启动失败：端口 ${config.port} 已被占用，请修改 ${CONFIG_FILE} 中的 port` : '启动失败：' + e.message);
  process.exit(1);
});
server.listen(config.port, listenHost, () => {
  const nics = Object.values(os.networkInterfaces()).flat().filter(i => i && !i.internal);
  const ips = nics.filter(i => i.family === 'IPv4' || i.family === 4).map(i => i.address);
  // IPv6 只列公网 / 唯一本地地址，fe80 链路本地地址浏览器里要带网卡号，列出来也用不了
  if (listenHost === '::') ips.push(...nics.filter(i => (i.family === 'IPv6' || i.family === 6) && !/^fe80/i.test(i.address)).slice(0, 2).map(i => '[' + i.address + ']'));
  log(`x.erp 服务端 v${VERSION} 已启动`);
  log('数据目录：' + DATA_DIR);
  log('访问地址：' + ['127.0.0.1', ...ips].map(ip => `http://${ip}:${config.port}`).join('  '));
  setTimeout(autoBackup, 10e3);
  setInterval(autoBackup, 3600e3);
  setTimeout(cloudAutoTick, 5 * 60e3);
  setInterval(cloudAutoTick, 3600e3);
  setTimeout(cloudTunnelStart, 4e3);
  setInterval(notifyTick, 60e3);
  setInterval(trackTick, 5 * 60e3);
  setTimeout(statsTick, Number(process.env.XERP_STATS_DELAY) || 60e3);
  setInterval(statsTick, 3600e3);
  setTimeout(fbTick, 90e3);
  setInterval(fbTick, 3600e3);
});
const shutdown = () => { log('服务端停止'); try { db.close(); } catch (e) {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
const portalParent = Number(process.env.XERP_PORTAL_PARENT || 0);
if (portalParent > 0) {
  const parentCheck = setInterval(() => {
    try { process.kill(portalParent, 0); }
    catch (e) { clearInterval(parentCheck); log('网关已退出，账套服务自动停止'); shutdown(); }
  }, 5000);
  parentCheck.unref();
}
