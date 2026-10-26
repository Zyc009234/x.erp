// x.erp 后端接口测试：在临时数据目录启动一个真实的服务端，通过 HTTP 调接口检查结果
// 运行：node --test tests/api.test.mjs（需要 Node 22+，不依赖任何第三方包）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-test-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin;

async function call(token, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };  // 单据本身也有 status 字段，HTTP 状态码另放
}
// 期望成功：失败时把服务端的错误信息带出来
async function ok(token, method, url, body) {
  const r = await call(token, method, url, body);
  assert.equal(r.http, 200, `${method} ${url} → ${r.http} ${r.error || ''}`);
  return r;
}
async function login(username, password) { return (await ok(null, 'POST', '/api/login', { username, password })).token; }
const data = async (token = admin) => (await ok(token, 'GET', '/api/data')).data;
const prod = async (id, token = admin) => (await data(token)).products.find(p => p.id === id);
const doc = async (id, token = admin) => (await data(token)).stockDocs.find(o => o.id === id);
const setApprove = (inOn, outOn) => ok(admin, 'PUT', '/api/settings', { docApprove: { in: inOn, out: outOn } });
async function newProduct(sku, extra = {}) { return ok(admin, 'POST', '/api/products', { sku, name: '测试商品' + sku, unit: '个', cost: 0, price: 10, ...extra }); }
const inDoc = (token, items, extra = {}) => call(token, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items, ...extra });
const outDoc = (token, items, extra = {}) => call(token, 'POST', '/api/stockdocs', { dir: 'out', type: '领料出库', items, ...extra });
async function newUser(username, roleId) {
  await ok(admin, 'POST', '/api/users', { username, name: username, roleId, password: 'test123456' });
  return login(username, 'test123456');
}

before(async () => {
  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/ping')).ok) break; } catch (e) {}
    if (i === 99) throw new Error('服务端没有启动：\n' + log);
    await new Promise(r => setTimeout(r, 100));
  }
  admin = await login('admin', 'admin123');
  await ok(admin, 'POST', '/api/clear');  // 清掉演示数据，从空库开始
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

test('登录：密码错误被拒绝，未登录不能访问数据', async () => {
  assert.equal((await call(null, 'POST', '/api/login', { username: 'admin', password: 'wrong' })).http, 401);
  assert.equal((await call(null, 'GET', '/api/data')).http, 401);
  const ping = await ok(null, 'GET', '/api/ping');
  assert.equal(ping.app, 'XERP');
});

test('入库单 / 出库单：改库存，成本按移动加权平均', async () => {
  const p = await newProduct('T001');
  const r1 = await inDoc(admin, [{ productId: p.id, qty: 10, price: 5 }]);
  assert.equal(r1.http, 200); assert.equal(r1.status, '正常');
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 10, price: 7 }] });
  let q = await prod(p.id);
  assert.equal(q.stock, 20); assert.equal(q.cost, 6);
  const o = await outDoc(admin, [{ productId: p.id, qty: 5 }]);
  assert.equal(o.http, 200);
  q = await prod(p.id);
  assert.equal(q.stock, 15); assert.equal(q.cost, 6);
  assert.equal((await doc(o.id)).items[0].price, 6, '出库按当前成本计价');
});

test('出库数量超过库存被拒绝，库存不变', async () => {
  const p = await newProduct('T002');
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 3, price: 1 }] });
  const r = await outDoc(admin, [{ productId: p.id, qty: 4 }]);
  assert.equal(r.http, 400); assert.match(r.error, /库存不足/);
  assert.equal((await prod(p.id)).stock, 3);
});

test('作废入库单把货扣回，作废出库单把货退回', async () => {
  const p = await newProduct('T003');
  const a = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 8, price: 2 }] });
  const b = await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '领料出库', items: [{ productId: p.id, qty: 3 }] });
  await ok(admin, 'POST', `/api/stockdocs/${b.id}/void`, { reason: '开错了' });
  assert.equal((await prod(p.id)).stock, 8);
  await ok(admin, 'POST', `/api/stockdocs/${a.id}/void`, { reason: '开错了' });
  assert.equal((await prod(p.id)).stock, 0);
  assert.equal((await call(admin, 'POST', `/api/stockdocs/${a.id}/void`, {})).http, 400, '不能重复作废');
});

test('多单位：按箱录入换算成基本单位', async () => {
  const p = await newProduct('T004', { units: [{ name: '箱', rate: 12 }] });
  const r = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, unit: '箱', qty: 2, price: 24 }] });
  const q = await prod(p.id);
  assert.equal(q.stock, 24); assert.equal(q.cost, 2);
  const it = (await doc(r.id)).items[0];
  assert.equal(it.uqty, 2); assert.equal(it.unit, '箱'); assert.equal(it.qty, 24);
});

test('盘点单：审核后按差异盘盈盘亏', async () => {
  const p = await newProduct('T005');
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 10, price: 1 }] });
  const c = await ok(admin, 'POST', '/api/checkdocs', { productIds: [p.id] });
  await ok(admin, 'POST', `/api/checkdocs/${c.id}/post`, { lines: [{ productId: p.id, counted: 7 }] });
  assert.equal((await prod(p.id)).stock, 7);
});

/* ---------- 出入库审核 ---------- */
test('审核关闭时单据直接生效（默认行为不变）', async () => {
  const d = await data();
  assert.ok(!d.stockDocs.some(o => o.status === '待审核'));
});

test('开启入库审核：新入库单待审核，不改库存；审核通过后才入库', async () => {
  await setApprove(true, false);
  const p = await newProduct('A001');
  const r = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 5, price: 4 }] });
  assert.equal(r.http, 200);
  let o = await doc(r.id);
  assert.equal(o.status, '待审核');
  assert.equal((await prod(p.id)).stock, 0, '待审核不改库存');
  assert.ok(!(await data()).stockLogs.some(l => l.ref === o.no), '待审核不写流水');
  await ok(admin, 'POST', `/api/stockdocs/${r.id}/approve`, {});
  o = await doc(r.id);
  assert.equal(o.status, '正常'); assert.equal(o.approver, '管理员');
  const q = await prod(p.id);
  assert.equal(q.stock, 5); assert.equal(q.cost, 4);
  assert.equal((await call(admin, 'POST', `/api/stockdocs/${r.id}/approve`, {})).http, 400, '不能重复审核');
  // 出库单没开审核，仍然直接生效
  const out = await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '领料出库', items: [{ productId: p.id, qty: 1 }] });
  assert.equal((await doc(out.id)).status, '正常');
  assert.equal((await prod(p.id)).stock, 4);
});

test('开启出库审核：审核时再查库存，不足则审核不通过', async () => {
  await setApprove(false, true);
  const p = await newProduct('A002');
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 10, price: 3 }] });
  const a = await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '领料出库', items: [{ productId: p.id, qty: 6 }] });
  const b = await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '领料出库', items: [{ productId: p.id, qty: 6 }] });
  assert.equal((await prod(p.id)).stock, 10, '两张待审核出库单都没扣库存');
  await ok(admin, 'POST', `/api/stockdocs/${a.id}/approve`, {});
  assert.equal((await prod(p.id)).stock, 4);
  assert.equal((await doc(a.id)).items[0].price, 3, '审核时回填出库成本');
  const r = await call(admin, 'POST', `/api/stockdocs/${b.id}/approve`, {});
  assert.equal(r.http, 400); assert.match(r.error, /库存不足/);
  assert.equal((await doc(b.id)).status, '待审核');
  assert.equal((await prod(p.id)).stock, 4);
});

test('驳回：必须填原因，库存不变，之后不能再审核', async () => {
  await setApprove(true, true);
  const p = await newProduct('A003');
  const r = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 5, price: 1 }] });
  assert.equal((await call(admin, 'POST', `/api/stockdocs/${r.id}/reject`, {})).http, 400);
  await ok(admin, 'POST', `/api/stockdocs/${r.id}/reject`, { reason: '数量不对' });
  const o = await doc(r.id);
  assert.equal(o.status, '已驳回'); assert.equal(o.rejectReason, '数量不对');
  assert.equal((await prod(p.id)).stock, 0);
  assert.equal((await call(admin, 'POST', `/api/stockdocs/${r.id}/approve`, {})).http, 400);
});

test('批次商品：审核通过时按开单填的批号入批次', async () => {
  await setApprove(true, true);
  const p = await newProduct('A004', { batch: true });
  const r = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 4, price: 1, batchNo: 'B-01', expDate: '2099-01-01' }] });
  assert.equal((await data()).batches.filter(b => b.productId === p.id).length, 0, '待审核不生成批次');
  await ok(admin, 'POST', `/api/stockdocs/${r.id}/approve`, {});
  const bs = (await data()).batches.filter(b => b.productId === p.id);
  assert.equal(bs.length, 1); assert.equal(bs[0].no, 'B-01'); assert.equal(bs[0].qty, 4);
  const o = await doc(r.id);
  assert.equal(o.items[0].batch, undefined); assert.equal(o.items[0].batches[0].no, 'B-01');
});

test('权限：仓管员能提交、能作废自己的待审核单，但不能审核；仓库主管能审核', async () => {
  await setApprove(true, true);
  const p = await newProduct('A005');
  const clerk = await newUser('clerk1', 'r_wh'), mgr = await newUser('mgr1', 'r_wh_mgr');
  const r = await inDoc(clerk, [{ productId: p.id, qty: 2 }]);
  assert.equal(r.http, 200);
  assert.equal((await call(clerk, 'POST', `/api/stockdocs/${r.id}/approve`, {})).http, 403);
  // 主管看得到并能审核
  assert.ok((await data(mgr)).stockDocs.some(o => o.id === r.id));
  await ok(mgr, 'POST', `/api/stockdocs/${r.id}/approve`, {});
  assert.equal((await prod(p.id)).stock, 2);
  // 已生效的单据仓管员不能作废（没有作废权限）
  assert.equal((await call(clerk, 'POST', `/api/stockdocs/${r.id}/void`, {})).http, 403);
  // 自己的待审核单可以作废，不动库存
  const r2 = await inDoc(clerk, [{ productId: p.id, qty: 9 }]);
  await ok(clerk, 'POST', `/api/stockdocs/${r2.id}/void`, {});
  assert.equal((await doc(r2.id)).status, '已作废');
  assert.equal((await prod(p.id)).stock, 2);
});

test('权限：有审核权限但不能看他人单据的账号，也能看到并审核待审核单', async () => {
  await setApprove(true, true);
  const role = await ok(admin, 'POST', '/api/roles', { name: '审核专员', perms: ['inv.view', 'inv.approve'] });
  const roleId = role.id || (await ok(admin, 'GET', '/api/roles')).list.find(x => x.name === '审核专员').id;
  const auditor = await newUser('auditor1', roleId), clerk = await newUser('clerk2', 'r_wh');
  const p = await newProduct('A006');
  const r = await inDoc(clerk, [{ productId: p.id, qty: 1 }]);
  assert.ok((await data(auditor)).stockDocs.some(o => o.id === r.id));
  await ok(auditor, 'POST', `/api/stockdocs/${r.id}/approve`, {});
  assert.ok(!(await data(auditor)).stockDocs.some(o => o.id === r.id), '审核完就不再显示他人单据');
});

test('开启审核后不能绕过单据直接手工入库 / 出库', async () => {
  await setApprove(true, true);
  const p = await newProduct('A007');
  const r = await call(admin, 'POST', '/api/stock/' + p.id, { mode: 'in', qty: 5 });
  assert.equal(r.http, 400); assert.match(r.error, /审核/);
  assert.equal((await prod(p.id)).stock, 0);
  await setApprove(false, false);
  await ok(admin, 'POST', '/api/stock/' + p.id, { mode: 'in', qty: 5 });
  assert.equal((await prod(p.id)).stock, 5);
});

test('预置角色：仓库主管带审核权限，审核设置写入系统设置', async () => {
  const roles = (await ok(admin, 'GET', '/api/roles')).list;
  assert.ok(JSON.stringify(roles.find(r => r.id === 'r_wh_mgr')).includes('inv.approve'));
  assert.ok(!JSON.stringify(roles.find(r => r.id === 'r_wh')).includes('inv.approve'));
  await setApprove(true, false);
  const s = (await ok(admin, 'GET', '/api/data')).settings;
  assert.deepEqual(s.docApprove, { in: true, out: false });
  const clerk = await login('clerk1', 'test123456');
  assert.equal((await call(clerk, 'PUT', '/api/settings', { docApprove: { in: false, out: false } })).http, 403, '只有管理员能改审核设置');
  await setApprove(false, false);
});

test('原专业版功能免费可用：新建仓库、调拨单、批次，不需要授权', async () => {
  assert.equal((await call(admin, 'POST', '/api/license/trial')).http, 404, '授权接口已移除');
  const w = await ok(admin, 'POST', '/api/warehouses', { name: '二号仓' });
  const wid = w.id || (await data()).warehouses.find(x => x.name === '二号仓').id;
  const p = await newProduct('F001', { batch: true });
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 6, price: 2, batchNo: 'F-01' }] });
  await ok(admin, 'POST', '/api/transfers', { from: 'w1', to: wid, items: [{ productId: p.id, qty: 4 }] });
  const q = await prod(p.id);
  assert.equal(q.stock, 6); assert.equal(q.wh[wid], 4); assert.equal(q.wh.w1, 2);
});

/* ---------- 序列号 ---------- */
const serials = async pid => (await data()).serials.filter(r => r.productId === pid);
test('序列号：入库逐件登记，数量要对得上，不能重复入库', async () => {
  const p = await newProduct('S001', { serial: true });
  let r = await inDoc(admin, [{ productId: p.id, qty: 2, price: 100, serials: ['SN-1'] }]);
  assert.equal(r.http, 400); assert.match(r.error, /需要登记 2 个序列号/);
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 3, price: 100, serials: ['SN-1', 'SN-2', 'SN-3'] }] });
  assert.equal((await prod(p.id)).stock, 3);
  assert.deepEqual((await serials(p.id)).map(x => x.status), ['在库', '在库', '在库']);
  r = await inDoc(admin, [{ productId: p.id, qty: 1, price: 100, serials: ['SN-2'] }]);
  assert.equal(r.http, 400); assert.match(r.error, /已在库/);
  // 不带序列号的入口一律拒绝
  r = await call(admin, 'POST', '/api/stock/' + p.id, { mode: 'in', qty: 1 });
  assert.equal(r.http, 400); assert.match(r.error, /序列号/);
});

test('序列号：出库只能出在库的号，作废出库单号回到在库', async () => {
  const p = (await data()).products.find(x => x.sku === 'S001');
  let r = await outDoc(admin, [{ productId: p.id, qty: 1, serials: ['SN-9'] }]);
  assert.equal(r.http, 400); assert.match(r.error, /不存在/);
  const o = await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '销售出库', party: '张三', items: [{ productId: p.id, qty: 1, serials: ['SN-2'] }] });
  let sn2 = (await serials(p.id)).find(x => x.sn === 'SN-2');
  assert.equal(sn2.status, '已出库'); assert.equal(sn2.hist.at(-1).party, '张三');
  r = await outDoc(admin, [{ productId: p.id, qty: 1, serials: ['SN-2'] }]);
  assert.equal(r.http, 400); assert.match(r.error, /已出库/);
  await ok(admin, 'POST', `/api/stockdocs/${o.id}/void`, { reason: '退回' });
  sn2 = (await serials(p.id)).find(x => x.sn === 'SN-2');
  assert.equal(sn2.status, '在库'); assert.equal(sn2.hist.length, 1);
  assert.equal((await prod(p.id)).stock, 3);
});

test('序列号：入库单里的号已出库时不能作废；调拨带着号走，作废调拨退回原仓', async () => {
  const p = await newProduct('S002', { serial: true });
  const a = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 2, price: 5, serials: ['X1', 'X2'] }] });
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '领料出库', items: [{ productId: p.id, qty: 1, serials: ['X1'] }] });
  const r = await call(admin, 'POST', `/api/stockdocs/${a.id}/void`, { reason: 'x' });
  assert.equal(r.http, 400);
  assert.equal((await prod(p.id)).stock, 1, '作废失败不改库存');
  const wid = (await data()).warehouses.find(x => x.name === '二号仓').id;
  const t = await ok(admin, 'POST', '/api/transfers', { from: 'w1', to: wid, items: [{ productId: p.id, qty: 1, serials: ['X2'] }] });
  let x2 = (await serials(p.id)).find(x => x.sn === 'X2');
  assert.equal(x2.wh, wid); assert.equal(x2.status, '在库');
  await ok(admin, 'POST', `/api/transfers/${t.id}/void`, { reason: '调错了' });
  x2 = (await serials(p.id)).find(x => x.sn === 'X2');
  assert.equal(x2.wh, 'w1'); assert.equal(x2.status, '在库');
});

test('序列号：有库存的商品不能直接开启', async () => {
  const p = await newProduct('S003');
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 1, price: 1 }] });
  const r = await call(admin, 'PUT', '/api/products/' + p.id, { serial: true });
  assert.equal(r.http, 400); assert.match(r.error, /清零/);
});

test('序列号：开启审核时，待审核的入库单审核通过才登记', async () => {
  await setApprove(true, true);
  const p = await newProduct('S004', { serial: true });
  const r = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', items: [{ productId: p.id, qty: 1, price: 1, serials: ['P1'] }] });
  assert.equal((await serials(p.id)).length, 0);
  await ok(admin, 'POST', `/api/stockdocs/${r.id}/approve`, {});
  assert.equal((await serials(p.id))[0].sn, 'P1');
  await setApprove(false, false);
});

/* ---------- Excel 导入：条码与辅助单位 ---------- */
test('导入：带条码和辅助单位，条码重复时整批不导入', async () => {
  const r = await ok(admin, 'POST', '/api/products/import', { rows: [{ sku: 'I001', name: '导入一', barcode: '690000000001', units: '箱=24/690000000024；盒=6', stock: 48, cost: 1 }] });
  assert.equal(r.created, 1);
  const p = (await data()).products.find(x => x.sku === 'I001');
  assert.equal(p.barcode, '690000000001'); assert.equal(p.stock, 48);
  assert.deepEqual(p.units, [{ name: '箱', rate: 24, barcode: '690000000024' }, { name: '盒', rate: 6 }]);
  const bad = await call(admin, 'POST', '/api/products/import', { rows: [{ sku: 'I002', name: '导入二', barcode: '690000000024' }, { sku: 'I003', name: '导入三' }] });
  assert.equal(bad.http, 400); assert.match(bad.error, /已被商品 I001 使用/);
  assert.ok(!(await data()).products.some(x => x.sku === 'I003'), '出错时一行都不导入');
  const bad2 = await call(admin, 'POST', '/api/products/import', { rows: [{ sku: 'I004', name: '导入四', units: '箱十二' }] });
  assert.equal(bad2.http, 400); assert.match(bad2.error, /辅助单位格式/);
});

/* ---------- 库存提醒推送 ---------- */
test('推送：测试消息按机器人格式发出，推送地址只有管理员能看到', async () => {
  const http = await import('node:http');
  const got = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { got.push({ url: req.url, body: JSON.parse(b) }); res.end('{"errcode":0}'); }); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${hook.address().port}/hook`;
  try {
    const low = await newProduct('N001', { safety: 10 });
    const prev = await ok(admin, 'GET', '/api/settings/notify/preview');
    assert.match(prev.text, /库存不足/); assert.match(prev.text, /测试商品N001/);
    await ok(admin, 'POST', '/api/settings/notify/test', { url });
    assert.equal(got.length, 1); assert.match(got[0].body.text, /【测试】/);
    await ok(admin, 'PUT', '/api/settings/notify', { enabled: true, url, time: '23:59', skipEmpty: true });
    assert.equal((await ok(admin, 'GET', '/api/data')).settings.notify.url, url);
    const clerk = await login('clerk1', 'test123456');
    assert.equal((await ok(clerk, 'GET', '/api/data')).settings.notify, undefined, '普通账号看不到推送地址');
    assert.equal((await call(admin, 'PUT', '/api/settings/notify', { enabled: true, url: 'ftp://x', time: '08:00' })).http, 400);
    assert.equal((await call(admin, 'POST', '/api/settings/notify/test', { url: 'http://127.0.0.1:1/none' })).http, 400);
    await ok(admin, 'PUT', '/api/settings/notify', { enabled: false, url: '', time: '08:30' });
    assert.ok(low.id);
  } finally { hook.close(); }
});

/* ---------- 物流运费 ---------- */
const ZONES = [
  { name: '江浙沪', provinces: ['上海', '江苏', '浙江'], bands: [{ upTo: 0.5, fee: 2.8 }, { upTo: 1, fee: 3.2 }, { upTo: 2, fee: 4 }, { upTo: 3, fee: 5 }], addStep: 1, addFee: 1 },
  { name: '其余', provinces: [], first: 1, firstFee: 8, addStep: 1, addFee: 5 }
];
let shipCarrier, shipProd;
async function shipSetup() {
  if (shipCarrier) return;
  await ok(admin, 'PUT', '/api/settings', { modules: ['inventory', 'products', 'shipping', 'finance'] });
  shipCarrier = await ok(admin, 'POST', '/api/carriers', { name: '测试快递', code: 'TST', step: 0.1, volDiv: 0, pack: 0.1, tol: 0.5, zones: ZONES });
  shipProd = await newProduct('WL001', { weight: 0.6 });
  await inDoc(admin, [{ productId: shipProd.id, qty: 100, price: 1 }]);
}
const shipOut = async (qty, extra = {}) => ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '销售出库', items: [{ productId: shipProd.id, qty }], party: '测试客户', ...extra });

test('物流：模块未启用时接口拒绝访问', async () => {
  const r = await call(admin, 'POST', '/api/ship/quote', { address: '浙江杭州' });
  assert.equal(r.http, 403); assert.match(r.error, /模块未启用/);
});

test('物流：地址识别省份（省份开头、只写城市、区县同名、路名同名）', async () => {
  await shipSetup();
  const prov = async address => (await ok(admin, 'POST', '/api/ship/quote', { address })).province;
  assert.equal(await prov('浙江省杭州市西湖区文三路 100 号'), '浙江');
  assert.equal(await prov('杭州市余杭区仓前街道'), '浙江');
  assert.equal(await prov('广西壮族自治区南宁市青秀区'), '广西');
  assert.equal(await prov('北京朝阳区建国路 1 号'), '北京');
  assert.equal(await prov('朝阳区建国路 1 号'), '', '只写区名识别不了，不能误判成辽宁朝阳');
  assert.equal(await prov('朝阳市双塔区'), '辽宁');
  assert.equal(await prov('海南藏族自治州共和县'), '青海');
  assert.equal(await prov('张三 13800000000 收货地址：广东省深圳市南山区'), '广东', '地址中间的「X省」也能识别');
  assert.equal(await prov('东莞长安镇'), '广东');
});

test('物流：按重量段 / 首重续重估算运费，称重覆盖估算，缺省份给出提示', async () => {
  await shipSetup();
  const items = [{ productId: shipProd.id, qty: 2 }];  // 1.2kg + 包材 0.1 = 1.3kg
  let q = await ok(admin, 'POST', '/api/ship/quote', { address: '上海浦东新区', items });
  assert.equal(q.weight, 1.2);
  let t = q.quotes.find(x => x.carrierId === shipCarrier.id);
  assert.equal(t.chargeWeight, 1.3); assert.equal(t.fee, 4, '江浙沪 1~2kg 段 4 元');
  q = await ok(admin, 'POST', '/api/ship/quote', { address: '广州天河区', items });
  t = q.quotes.find(x => x.carrierId === shipCarrier.id);
  assert.equal(t.fee, 13, '首重 1kg 8 元 + 续重 1kg 5 元');
  q = await ok(admin, 'POST', '/api/ship/quote', { address: '杭州', items, weight: 3.4 });
  t = q.quotes.find(x => x.carrierId === shipCarrier.id);
  assert.equal(t.chargeWeight, 3.4); assert.equal(t.fee, 6, '超出 3kg 段按续重：5 + 1');
  q = await ok(admin, 'POST', '/api/ship/quote', { address: '某某路 8 号', items });
  assert.match(q.quotes.find(x => x.carrierId === shipCarrier.id).error, /缺少收件省份/);
  const bad = await call(admin, 'POST', '/api/carriers', { name: '坏报价', zones: [{ name: 'A', provinces: ['浙江'], first: 1, firstFee: 5 }, { name: 'B', provinces: ['浙江省'], first: 1, firstFee: 6 }] });
  assert.equal(bad.http, 400); assert.match(bad.error, /同时在/);
});

test('物流：出库单登记运单，单号不能重复，作废出库单时未对账的运单一起作废', async () => {
  await shipSetup();
  const o = await shipOut(2, { address: '江苏省南京市鼓楼区' });
  const [s] = (await ok(admin, 'POST', '/api/shipments', { srcType: 'out', srcId: o.id, carrierId: shipCarrier.id, packages: [{ trackNo: 'tst 0001' }] })).list;
  assert.equal(s.trackNo, 'TST0001', '单号去空格转大写');
  assert.equal(s.province, '江苏'); assert.equal(s.estFee, 4); assert.equal(s.srcNo, o.no); assert.equal(s.status, '待对账');
  const dup = await call(admin, 'POST', '/api/shipments', { carrierId: shipCarrier.id, address: '浙江宁波', packages: [{ trackNo: 'TST0001', weight: 1 }] });
  assert.equal(dup.http, 400); assert.match(dup.error, /已经登记过/);
  const noW = await call(admin, 'POST', '/api/shipments', { carrierId: shipCarrier.id, address: '浙江宁波', packages: [{ trackNo: 'TST0002' }] });
  assert.equal(noW.http, 400); assert.match(noW.error, /包裹重量/, '没有来源单据时必须填重量');
  const ed = await ok(admin, 'PUT', '/api/shipments/' + s.id, { weight: 2.5 });
  assert.equal(ed.estFee, 5); assert.equal(ed.weighed, true);
  await ok(admin, 'POST', `/api/stockdocs/${o.id}/void`, { reason: '测试' });
  assert.equal((await data()).shipments.find(x => x.id === s.id).status, '已作废');
});

test('物流：账单对账（一致 / 称重差异 / 价格差异 / 系统无 / 重复 / 漏账），确认后生成快递费支出，可撤销', async () => {
  await shipSetup();
  const mk = async (trackNo, qty, address) => (await ok(admin, 'POST', '/api/shipments', { srcType: 'out', srcId: (await shipOut(qty, { address })).id, carrierId: shipCarrier.id, packages: [{ trackNo }], date: '2026-09-15' })).list[0];
  const a = await mk('B001', 2, '浙江杭州');   // 1.3kg ¥4
  const b = await mk('B002', 2, '浙江杭州');   // 账单称重 2.6kg → ¥5（报价对，重量多了）
  const c = await mk('B003', 2, '浙江杭州');   // 账单 1.3kg 收 ¥6（没按报价）
  const d = await mk('B004', 2, '浙江杭州');   // 账单里没有 → 漏账
  const rows = [
    { trackNo: 'B001', fee: 4, weight: 1.3, province: '浙江省', _row: 2 },
    { trackNo: 'B002', fee: 5, weight: 2.6, province: '浙江', _row: 3 },
    { trackNo: 'b003', fee: 6, weight: 1.3, province: '浙江', _row: 4 },
    { trackNo: 'X999', fee: 8, weight: 1, province: '广东', _row: 5 },
    { trackNo: 'B001', fee: 4, weight: 1.3, province: '浙江', _row: 6 }];
  const bad = await call(admin, 'POST', '/api/shipbills', { carrierId: shipCarrier.id, period: '2026-09', rows: [{ trackNo: '', fee: 1 }] });
  assert.equal(bad.http, 400); assert.match(bad.error, /快递单号为空/);
  const bill = await ok(admin, 'POST', '/api/shipbills', { carrierId: shipCarrier.id, period: '2026-09', fileName: '9月账单.xlsx', rows });
  const cat = t => bill.rows.filter(r => r.trackNo === t).map(r => r.cat);
  assert.deepEqual(cat('B001'), ['ok', 'dup']); assert.deepEqual(cat('B002'), ['diff']); assert.deepEqual(cat('B003'), ['diff']); assert.deepEqual(cat('X999'), ['extra']);
  assert.match(bill.rows[1].reason, /价格没问题，差异来自称重/);
  assert.match(bill.rows[2].reason, /应为 ¥4，账单收 ¥6/);
  assert.deepEqual(bill.missing, [d.id]);
  assert.equal(bill.total, 27);
  const listed = (await data()).shipBills.find(x => x.id === bill.id);
  assert.equal(listed.rows, undefined, '/api/data 里不带账单明细');
  // 认可 B002（按账单 5 元），B003 申诉，X999 不认
  const done = await ok(admin, 'POST', `/api/shipbills/${bill.id}/confirm`, { acts: { 1: 'ok', 2: 'dispute', 3: 'dispute' }, notes: { 2: '按合同应 4 元' }, finance: true });
  assert.equal(done.status, '已确认'); assert.equal(done.payable, 9); assert.equal(done.disputed, 3);
  let D = await data();
  const st = id => D.shipments.find(x => x.id === id);
  assert.equal(st(a.id).status, '已对账'); assert.equal(st(a.id).billFee, 4);
  assert.equal(st(b.id).status, '已对账'); assert.equal(st(b.id).billFee, 5);
  assert.equal(st(c.id).status, '申诉中'); assert.equal(st(c.id).disputeNote, '按合同应 4 元');
  assert.equal(st(d.id).status, '待对账');
  assert.equal(D.finance.find(f => f.ref === bill.no).amount, 9);
  assert.equal((await call(admin, 'PUT', '/api/shipments/' + a.id, { weight: 9 })).http, 400, '已对账的运单不能改');
  await ok(admin, 'POST', `/api/shipments/${c.id}/resolve`, { fee: 4, note: '快递已同意按 4 元' });
  D = await data();
  assert.equal(st(c.id).status, '已对账'); assert.equal(st(c.id).billFee, 4);
  assert.equal(D.finance.filter(f => f.ref === bill.no).length, 2);
  assert.equal((await call(admin, 'DELETE', '/api/shipbills/' + bill.id)).http, 400, '已确认的账单不能删');
  const again = await ok(admin, 'POST', '/api/shipbills', { carrierId: shipCarrier.id, rows: [{ trackNo: 'B001', fee: 4 }] });
  assert.equal(again.rows[0].cat, 'dup'); assert.match(again.rows[0].reason, /已经在账单/);
  await ok(admin, 'DELETE', '/api/shipbills/' + again.id);
  await ok(admin, 'POST', `/api/shipbills/${bill.id}/undo`);
  D = await data();
  assert.equal(st(a.id).status, '待对账'); assert.equal(st(a.id).billFee, undefined);
  assert.equal(D.finance.filter(f => f.ref === bill.no).length, 0, '撤销后删掉生成的支出');
  await ok(admin, 'DELETE', '/api/shipbills/' + bill.id);
});

test('物流：权限按角色生效，出库员能登记运单但不能改报价和对账', async () => {
  await shipSetup();
  const clerk = await newUser('shipper1', 'r_out');
  const o = await shipOut(1);
  const r = await call(clerk, 'POST', '/api/shipments', { srcType: 'out', srcId: o.id, carrierId: shipCarrier.id, address: '上海', packages: [{ trackNo: 'P001' }] });
  assert.equal(r.http, 200, r.error);
  assert.equal((await call(clerk, 'PUT', '/api/carriers/' + shipCarrier.id, { name: 'x', zones: ZONES })).http, 403);
  assert.equal((await call(clerk, 'POST', '/api/shipbills', { carrierId: shipCarrier.id, rows: [{ trackNo: 'P001', fee: 1 }] })).http, 403);
  assert.equal((await call(admin, 'DELETE', '/api/carriers/' + shipCarrier.id)).http, 400, '有运单的快递不能删');
});
