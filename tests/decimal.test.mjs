// 商品「允许小数数量」：两位小数，出入库/订单/调拨/盘点都生效；序列号商品仍必须整数
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-dec-'));
const PORT = 28000 + Math.floor(Math.random() * 7000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin, decP, intP, snP, custId;

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
const stockOf = async id => (await ok(admin, 'GET', '/api/data')).data.products.find(p => p.id === id).stock;

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
  decP = await ok(admin, 'POST', '/api/products', { sku: 'KG-1', name: '散装花生', unit: '公斤', dec: '1', cost: 8, price: 12 });
  intP = await ok(admin, 'POST', '/api/products', { sku: 'PC-1', name: '螺丝', unit: '个', cost: 1, price: 2 });
  snP = await ok(admin, 'POST', '/api/products', { sku: 'SN-1', name: '带序列号', unit: '个', serial: '1', cost: 10, price: 20 });
  custId = (await ok(admin, 'POST', '/api/customers', { name: '小数客户' })).id;
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

test('小数商品：入库 1.25、出库 0.5，库存 0.75', async () => {
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1', items: [{ productId: decP.id, qty: 1.25, price: 8 }] });
  assert.equal(await stockOf(decP.id), 1.25);
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'out', type: '其他出库', date: '2026-11-17', wh: 'w1', items: [{ productId: decP.id, qty: 0.5 }] });
  assert.equal(await stockOf(decP.id), 0.75);
});

test('最多两位小数：1.234 被拒', async () => {
  const r = await call(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1', items: [{ productId: decP.id, qty: 1.234, price: 8 }] });
  assert.equal(r.http, 400);
  assert.match(r.error || '', /两位小数/);
});

test('普通商品仍然只能整数', async () => {
  const r = await call(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1', items: [{ productId: intP.id, qty: 1.5, price: 1 }] });
  assert.equal(r.http, 400);
  assert.match(r.error || '', /正整数|允许小数/);
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1', items: [{ productId: intP.id, qty: 2, price: 1 }] });
});

test('序列号商品即使开了小数也必须整数', async () => {
  await ok(admin, 'PUT', `/api/products/${snP.id}`, { ...snP, dec: '1' });
  const r = await call(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-17', wh: 'w1', items: [{ productId: snP.id, qty: 1.5, price: 10, serials: 'A,B' }] });
  assert.equal(r.http, 400);
});

test('销售单 / 调拨 / 盘点同样支持小数', async () => {
  const so = await ok(admin, 'POST', '/api/orders/sales', { partyId: custId, date: '2026-11-17', items: [{ productId: decP.id, qty: 0.25, price: 12 }] });
  await ok(admin, 'POST', `/api/orders/sales/${so.id}/ship`, { wh: 'w1' });
  assert.equal(await stockOf(decP.id), 0.5);

  const w2 = (await ok(admin, 'POST', '/api/warehouses', { name: '小数仓' })).id;
  await ok(admin, 'POST', '/api/transfers', { from: 'w1', to: w2, date: '2026-11-17', items: [{ productId: decP.id, qty: 0.15 }] });
  const d = await ok(admin, 'GET', '/api/data');
  assert.equal(d.data.products.find(p => p.id === decP.id).wh[w2], 0.15);

  await ok(admin, 'POST', '/api/stock/' + decP.id, { mode: 'check', qty: 1.35, wh: 'w1' });
  assert.equal(await stockOf(decP.id), 1.5);
});
