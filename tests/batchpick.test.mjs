// 出库手动选批次：指定批次优先扣减，不够再按先到期先出补
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-batch-'));
const PORT = 24000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin, pid, batchA, batchB;

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
const batches = async () => (await ok(admin, 'GET', '/api/data')).data.batches.filter(b => b.productId === pid);
const stock = async () => (await ok(admin, 'GET', '/api/data')).data.products.find(p => p.id === pid).stock;

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
  const p = await ok(admin, 'POST', '/api/products', { name: '批次测试商品', unit: '个', batch: '1', cost: 10, price: 20 });
  pid = p.id;
  await ok(admin, 'POST', '/api/stockdocs', {
    dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1',
    items: [{ productId: pid, qty: 10, price: 10, batchNo: 'A', expDate: '2026-12-01' }],
  });
  await ok(admin, 'POST', '/api/stockdocs', {
    dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1',
    items: [{ productId: pid, qty: 10, price: 10, batchNo: 'B', expDate: '2027-01-01' }],
  });
  const bs = await batches();
  batchA = bs.find(b => b.no === 'A').id;
  batchB = bs.find(b => b.no === 'B').id;
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

test('默认按先到期先出（不指定批次）', async () => {
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '其他出库', date: '2026-11-17', wh: 'w1', items: [{ productId: pid, qty: 2 }] });
  const bs = await batches();
  assert.equal(bs.find(b => b.no === 'A').qty, 8, '先扣 A（更早到期）');
  assert.equal(bs.find(b => b.no === 'B').qty, 10);
});

test('指定批次：优先扣指定批次', async () => {
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '其他出库', date: '2026-11-17', wh: 'w1', items: [{ productId: pid, qty: 3, preferBatch: { id: batchB } }] });
  const bs = await batches();
  assert.equal(bs.find(b => b.no === 'B').qty, 7, 'B 被优先扣减');
  assert.equal(bs.find(b => b.no === 'A').qty, 8, 'A 不动');
});

test('指定批次不够：先扣完再按到期顺序补', async () => {
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '其他出库', date: '2026-11-17', wh: 'w1', items: [{ productId: pid, qty: 10, preferBatch: { id: batchB } }] });
  const bs = await batches();
  assert.equal(bs.find(b => b.no === 'B'), undefined, 'B 扣完删除');
  assert.equal(bs.find(b => b.no === 'A').qty, 5, '剩下 3 个从 A 补');
  assert.equal(await stock(), 5);
});

test('批次不属于这个商品时拒绝', async () => {
  const other = await ok(admin, 'POST', '/api/products', { name: '另一个批次商品', unit: '个', batch: '1' });
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1', items: [{ productId: other.id, qty: 1, price: 1, batchNo: 'X' }] });
  const ob = (await ok(admin, 'GET', '/api/data')).data.batches.find(b => b.productId === other.id);
  const r = await call(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '其他出库', date: '2026-11-17', wh: 'w1', items: [{ productId: pid, qty: 1, preferBatch: { id: ob.id } }] });
  assert.notEqual(r.http, 200);
});
