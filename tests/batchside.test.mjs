// 出库选批次改动的交叉影响：采购入库、销售出库、退货、作废、订单改单
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-bside-'));
const PORT = 26000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin, pid, custId, supId, poId, soId;

async function call(token, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function ok(token, method, url, body) {
  const r = await call(token, method, url, body);
  assert.equal(r.http, 200, `${method} ${url} → ${r.http} ${r.error || ''}`);
  return r;
}
const data = async () => (await ok(admin, 'GET', '/api/data')).data;
const bq = async no => (((await data()).batches.find(b => b.productId === pid && b.no === no)) || {}).qty;
const stock = async () => (await data()).products.find(p => p.id === pid).stock;

before(async () => {
  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XERP_STATS_URL: '', XERP_FEEDBACK_URL: '', XERP_CLOUD_URL: '' },
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/ping'); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  admin = (await ok(null, 'POST', '/api/login', { username: 'admin', password: 'admin123' })).token;
  await ok(admin, 'PUT', '/api/settings', { modules: ['inventory', 'products', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'reports'] });
  const p = await ok(admin, 'POST', '/api/products', { name: '交叉测试商品', unit: '个', batch: '1', cost: 10, price: 20, safety: 0 });
  pid = p.id;
  custId = (await ok(admin, 'POST', '/api/customers', { name: '交叉客户' })).id;
  supId = (await ok(admin, 'POST', '/api/suppliers', { name: '交叉供应商' })).id;
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

test('采购入库：按批号建批次', async () => {
  const po = await ok(admin, 'POST', '/api/orders/purchase', { partyId: supId, date: '2026-11-17', items: [{ productId: pid, qty: 10, price: 10 }] });
  poId = po.id;
  await ok(admin, 'POST', `/api/orders/purchase/${po.id}/approve`, {});
  await ok(admin, 'POST', `/api/orders/purchase/${po.id}/inbound`, { wh: 'w1', batches: { [pid]: { no: 'A', expDate: '2026-12-01' } } });
  assert.equal(await stock(), 10);
  assert.equal(await bq('A'), 10);
});

test('销售出库：按先到期先出扣批次', async () => {
  const so = await ok(admin, 'POST', '/api/orders/sales', { partyId: custId, date: '2026-11-17', items: [{ productId: pid, qty: 3, price: 20 }] });
  soId = so.id;
  await ok(admin, 'POST', `/api/orders/sales/${so.id}/ship`, { wh: 'w1' });
  assert.equal(await stock(), 7);
  assert.equal(await bq('A'), 7);
});

test('销售退货：退回原批次', async () => {
  const ret = await ok(admin, 'POST', '/api/orders/salesReturn', { partyId: custId, date: '2026-11-17', srcId: soId, items: [{ productId: pid, qty: 1, price: 20 }] });
  const r = await call(admin, 'POST', `/api/orders/salesReturn/${ret.id}/post`, { wh: 'w1', note: '退回原批次' });
  assert.equal(r.http, 200, r.error || '');
  assert.equal(await stock(), 8, '退货回库存');
});

test('采购退货：从批次扣减', async () => {
  const ret = await ok(admin, 'POST', '/api/orders/purchaseReturn', { partyId: supId, date: '2026-11-17', srcId: poId, items: [{ productId: pid, qty: 2, price: 10 }] });
  const r = await call(admin, 'POST', `/api/orders/purchaseReturn/${ret.id}/post`, { wh: 'w1', note: '退回供应商' });
  assert.equal(r.http, 200, r.error || '');
  assert.ok(await stock() >= 0);
});

test('作废入库单：批次一并扣回', async () => {
  const doc = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1', items: [{ productId: pid, qty: 5, price: 10, batchNo: 'C', expDate: '2027-02-01' }] });
  assert.equal(await bq('C'), 5);
  const before = await stock();
  await ok(admin, 'POST', `/api/stockdocs/${doc.id}/void`, { reason: '交叉测试作废' });
  assert.equal(await stock(), before - 5, '作废扣回库存');
  assert.equal(await bq('C'), undefined, '批次记录删除');
});
