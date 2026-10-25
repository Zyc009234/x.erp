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
