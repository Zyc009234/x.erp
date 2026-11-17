// 打印模板：权限可分配、多套模板（新建/切换/删除）、测试打印用当前模板
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-tpl-'));
const PORT = 27000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin, tplUser, printUser;

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
const login = async (u, p) => (await ok(null, 'POST', '/api/login', { username: u, password: p })).token;

before(async () => {
  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XERP_STATS_URL: '', XERP_FEEDBACK_URL: '', XERP_CLOUD_URL: '' },
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/ping'); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  admin = await login('admin', 'admin123');
  await ok(admin, 'PUT', '/api/settings', { modules: ['inventory', 'products', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'reports'] });
  const r1 = await ok(admin, 'POST', '/api/roles', { name: '模板管理员', perms: ['tpl.edit'] });
  await ok(admin, 'POST', '/api/users', { username: 'u_tpl', name: 'u_tpl', roleId: r1.id, password: 'test123456' });
  tplUser = await login('u_tpl', 'test123456');
  const r2 = await ok(admin, 'POST', '/api/roles', { name: '只能打印', perms: ['inv.print'] });
  await ok(admin, 'POST', '/api/users', { username: 'u_print', name: 'u_print', roleId: r2.id, password: 'test123456' });
  printUser = await login('u_print', 'test123456');
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

const tpl = { title: '送货单', paper: 'a4l', font: 'hei', meta: { no: true, party: true }, cols: [{ k: 'idx', on: true }, { k: 'name', on: true }] };

test('有 tpl.edit 权限就能改模板，没有就不行', async () => {
  assert.equal((await call(printUser, 'PUT', '/api/settings/print', { kind: 'sales', tpl })).http, 403);
  const r = await ok(tplUser, 'PUT', '/api/settings/print', { kind: 'sales', tpl });
  assert.equal(r.sales.title, '送货单');
});

test('新建 / 切换 / 删除多套模板', async () => {
  let r = await ok(admin, 'PUT', '/api/settings/print', { kind: 'sales', create: true, name: '大客户版', tpl });
  assert.equal(r.list.length, 1);
  const id = r.active;
  assert.ok(id);
  assert.equal(r.sales.title, '送货单');

  r = await ok(admin, 'PUT', '/api/settings/print', { kind: 'sales', create: true, name: '内部版', tpl: { ...tpl, title: '内部销售单' } });
  assert.equal(r.list.length, 2);
  assert.equal(r.sales.title, '内部销售单', '新建后当前模板切到新的');

  // 切回第一套
  const first = r.list.find(x => x.name === '大客户版');
  r = await ok(admin, 'PUT', '/api/settings/print', { kind: 'sales', id: first.id, name: first.name, tpl: first.tpl });
  assert.equal(r.active, first.id);
  assert.equal(r.sales.title, '送货单');

  // 数据里能看到列表和当前选中
  const d = await ok(admin, 'GET', '/api/data');
  assert.equal(d.settings.printTplList.sales.length, 2);
  assert.equal(d.settings.printTplActive.sales, first.id);

  // 删除当前模板 → 回到默认
  r = await ok(admin, 'PUT', '/api/settings/print', { kind: 'sales', del: first.id });
  assert.equal(r.list.length, 1);
  assert.equal(r.active, '');
  assert.ok(!('sales' in r) || r.sales === undefined, '删除当前模板后打印回到默认样式');
});

test('每套模板最多 10 个', async () => {
  let r;
  for (let i = 0; i < 11; i++) {
    r = await call(admin, 'PUT', '/api/settings/print', { kind: 'purchase', create: true, name: 'T' + i, tpl });
    if (i < 10) assert.equal(r.http, 200, r.error || '');
  }
  assert.equal(r.http, 400);
});
