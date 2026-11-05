// 在线演示模式（XERP_DEMO=1）：危险功能被屏蔽，普通业务照常可用
// 运行：node --test tests/demo.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-demo-'));
const PORT = 20000 + Math.floor(Math.random() * 20000), BASE = `http://127.0.0.1:${PORT}`;
let srv, token;
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { http: r.status, ...(await r.json().catch(() => ({}))) };
};

before(async () => {
  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(PORT)], { stdio: 'ignore', env: { ...process.env, XERP_DEMO: '1', XERP_STATS_URL: '', XERP_FEEDBACK_URL: '' } });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/ping')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
  token = (await call('POST', '/api/login', { username: 'admin', password: 'admin123' })).token;
  assert.ok(token, '演示账号 admin / admin123 能登录');
});
after(async () => {
  await new Promise(r => { srv.once('exit', r); srv.kill(); });
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}  // Windows 偶尔还占着文件，留给系统清理
});

test('首页带演示标记', async () => {
  const html = await (await fetch(BASE + '/')).text();
  assert.ok(html.includes('window.XERP_DEMO = 1'));
});

test('屏蔽改密码、账号、推送、快递鸟、导入备份、清空、留言', async () => {
  const blocked = [['POST', '/api/password', { old: 'admin123', password: 'x1234567' }], ['POST', '/api/users', { username: 'u1', password: '12345678', roleId: 'admin' }],
    ['PUT', '/api/users/xxx', {}], ['DELETE', '/api/users/xxx'], ['POST', '/api/roles', { name: 'r' }], ['PUT', '/api/settings/notify', { url: 'http://example.com' }],
    ['POST', '/api/settings/notify/test', {}], ['PUT', '/api/settings/kdn', {}], ['POST', '/api/settings/kdn/test', {}], ['POST', '/api/ship/eorder', {}],
    ['POST', '/api/restore', {}], ['POST', '/api/clear'], ['POST', '/api/feedback', { text: 'hi' }]];
  for (const [m, u, b] of blocked) {
    const r = await call(m, u, b);
    assert.equal(r.http, 403, `${m} ${u} 应被屏蔽`);
    assert.match(r.error, /在线演示/);
  }
  assert.ok((await call('POST', '/api/login', { username: 'admin', password: 'admin123' })).token, '密码没被改掉');
});

test('普通业务照常：看数据、建商品、记账', async () => {
  const d = await call('GET', '/api/data');
  assert.equal(d.http, 200);
  assert.ok(d.data.products.length > 0, '有演示数据');
  assert.equal((await call('POST', '/api/products', { sku: 'DEMO1', name: '演示商品', unit: '个', price: 1 })).http, 200);
  assert.equal((await call('POST', '/api/finance', { type: 'expense', category: '房租', amount: 1, date: '2026-11-05' })).http, 200);
  assert.equal((await call('GET', '/api/users')).http, 200, '账号列表可以看');
});

test('经本机代理时按 X-Forwarded-For 区分访客：一个人输错密码不会锁住别人', async () => {
  const login = (ip, password) => fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ username: 'admin', password }) }).then(r => r.status);
  for (let i = 0; i < 11; i++) await login('203.0.113.9', 'wrong');
  assert.equal(await login('203.0.113.9', 'admin123'), 429, '乱试的人被锁');
  assert.equal(await login('198.51.100.7', 'admin123'), 200, '别的访客照常登录');
});

test('演示版不能上传商品图片', async () => {
  const d = await call('GET', '/api/data');
  const r = await call('PUT', `/api/products/${d.data.products[0].id}/image`, { data: 'data:image/jpeg;base64,/9j/' });
  assert.equal(r.http, 403);
});
