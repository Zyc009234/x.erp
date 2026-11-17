// 库存周边流程：选批出库后作废、调拨、盘点、审核流
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-flow-'));
const PORT = 25000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin, pid, bA, bB;

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
const batchQty = async no => ((await data()).batches.find(b => b.productId === pid && b.no === no) || {}).qty;
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
  const p = await ok(admin, 'POST', '/api/products', { name: '流程测试商品', unit: '个', batch: '1', cost: 10, price: 20 });
  pid = p.id;
  for (const [no, exp] of [['A', '2026-12-01'], ['B', '2027-01-01']]) {
    await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1', items: [{ productId: pid, qty: 10, price: 10, batchNo: no, expDate: exp }] });
  }
  const bs = (await data()).batches.filter(b => b.productId === pid);
  bA = bs.find(b => b.no === 'A').id;
  bB = bs.find(b => b.no === 'B').id;
  await ok(admin, 'POST', '/api/warehouses', { name: '二号仓' });
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

test('选批出库后作废：库存和批次都退回原批次', async () => {
  const doc = await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '其他出库', date: '2026-11-17', wh: 'w1', items: [{ productId: pid, qty: 4, preferBatch: { id: bB } }] });
  assert.equal(await batchQty('B'), 6);
  assert.equal(await batchQty('A'), 10);
  await ok(admin, 'POST', `/api/stockdocs/${doc.id}/void`, { reason: '测试作废' });
  assert.equal(await batchQty('B'), 10, 'B 批次退回');
  assert.equal(await batchQty('A'), 10);
  assert.equal(await stock(), 20);
});

test('调拨：批次随货转到目标仓', async () => {
  const w2 = (await data()).warehouses.find(w => w.name === '二号仓').id;
  const r = await ok(admin, 'POST', '/api/transfers', { from: 'w1', to: w2, date: '2026-11-17', items: [{ productId: pid, qty: 5 }] });
  assert.equal(await stock(), 20, '总库存不变');
  const d = await data();
  assert.equal(((d.products.find(p => p.id === pid).wh) || {})[w2] || 0, 5, '目标仓有 5');
  await ok(admin, 'POST', `/api/transfers/${r.id}/void`, { reason: '调拨作废' });
  const d2 = await data();
  assert.equal(((d2.products.find(p => p.id === pid).wh) || {})[w2] || 0, 0, '作废后目标仓退回');
});

test('盘点盘亏：按先到期先出扣批次', async () => {
  const chk = await ok(admin, 'POST', '/api/checkdocs', { wh: 'w1', productIds: [pid] });
  await ok(admin, 'PUT', `/api/checkdocs/${chk.id}`, { lines: [{ productId: pid, counted: 17 }] });
  await ok(admin, 'POST', `/api/checkdocs/${chk.id}/post`, {});
  assert.equal(await stock(), 17);
  assert.equal(await batchQty('A'), 7, '先扣 A');
});

test('开启出库审核：待审核不动库存，审核后才扣', async () => {
  await ok(admin, 'PUT', '/api/settings', { modules: ['inventory', 'products', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'reports'] });
  await ok(admin, 'PUT', '/api/settings/doc-approve', { in: false, out: true }).catch(() => {});
  const doc = await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '其他出库', date: '2026-11-17', wh: 'w1', items: [{ productId: pid, qty: 2, preferBatch: { id: bA } }] });
  if (doc.status === '待审核') {
    assert.equal(await stock(), 17, '待审核不动库存');
    await ok(admin, 'POST', `/api/stockdocs/${doc.id}/approve`, {});
    assert.equal(await stock(), 15, '审核后扣库存');
    assert.equal(await batchQty('A'), 5, '审核后扣指定批次');
  }
});
