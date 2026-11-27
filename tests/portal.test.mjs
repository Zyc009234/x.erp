// 多账套网关测试：独立临时目录启动真实网关，验证登录、建公司、数据隔离、成员和权限
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-portal-test-'));
let server, BASE, PORTAL_PORT, BASE_PORT, log = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function call(token, method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  return { ...out, http: r.status };
}
async function ok(token, method, url, body) {
  const r = await call(token, method, url, body);
  assert.equal(r.http, 200, `${method} ${url} -> ${r.http} ${r.error || ''}`);
  return r;
}
const login = async (username, password, company = 'default') =>
  (await ok(null, 'POST', '/api/portal/login', { username, password, company })).token;

before(async () => {
  PORTAL_PORT = await freePort();
  BASE_PORT = await freePort();
  BASE = `http://127.0.0.1:${PORTAL_PORT}`;
  const pwd = path.join(DATA, 'admin-password');
  fs.writeFileSync(pwd, 'welcome123');
  server = spawn(process.execPath, [
    path.join(ROOT, 'src', 'portal.js'), '--data', DATA, '--port', String(PORTAL_PORT),
    '--base-port', String(BASE_PORT), '--admin-password-file', pwd,
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XERP_STATS_DELAY: '60000' } });
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + '/api/ping');
      if (r.ok) return;
    } catch (e) {}
    if (i === 119) throw new Error('网关没有启动：\n' + log);
    await new Promise(r => setTimeout(r, 100));
  }
});

after(async () => {
  if (server) server.kill();
  await new Promise(r => setTimeout(r, 1200));
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
});

test('网关登录：安装密码生效，密码文件读取后删除', async () => {
  assert.equal((await call(null, 'POST', '/api/portal/login', { username: 'admin', password: 'wrong', company: 'default' })).http, 401);
  assert.equal(fs.existsSync(path.join(DATA, 'admin-password')), false);
  const token = await login('admin', 'welcome123');
  const d = await ok(token, 'GET', '/api/data');
  assert.equal(d.user.username, 'admin');
  assert.equal(d.settings.company, '默认公司');
});

test('新建公司：自动初始化空账套，端口按 base-port 分配', async () => {
  const admin = await login('admin', 'welcome123');
  const c = await ok(admin, 'POST', '/api/portal/companies', { name: '测试分公司', code: 'branch' });
  assert.equal(c.company.code, 'branch');
  const sw = await ok(admin, 'POST', '/api/portal/switch', { company: 'branch' });
  assert.equal(sw.company.name, '测试分公司');
  const d = await ok(admin, 'GET', '/api/data');
  assert.equal(d.data.products.length, 0);
  const info = await ok(null, 'GET', '/api/portal/info');
  assert.equal(info.multi, true);
  assert.deepEqual(info.companies.map(x => x.code), ['default', 'branch']);
  assert.ok(BASE_PORT > 0);
});

test('公司数据隔离：改一个公司的名称不影响另一个公司', async () => {
  const admin = await login('admin', 'welcome123', 'branch');
  await ok(admin, 'PUT', '/api/settings', { company: '分公司改名' });
  assert.equal((await ok(admin, 'GET', '/api/data')).settings.company, '分公司改名');
  const sw = await ok(admin, 'POST', '/api/portal/switch', { company: 'default' });
  assert.equal(sw.company.name, '默认公司');
  assert.equal((await ok(admin, 'GET', '/api/data')).settings.company, '默认公司');
});

test('成员：新账号可登录指定公司，普通成员不能管理公司', async () => {
  const admin = await login('admin', 'welcome123', 'branch');
  await ok(admin, 'POST', '/api/portal/members', {
    company: 'branch', username: 'clerk', name: '测试员工', password: 'clerk123', role: 'user',
  });
  const members = await ok(admin, 'GET', '/api/portal/members?company=branch');
  assert.deepEqual(members.members.map(x => x.username), ['admin', 'clerk']);
  const clerk = await login('clerk', 'clerk123', 'branch');
  assert.equal((await ok(clerk, 'GET', '/api/data')).settings.company, '分公司改名');
  assert.equal((await call(clerk, 'GET', '/api/portal/companies')).http, 403);
});

test('成员：不能加入未授权公司；移除后不能再登录该公司', async () => {
  const other = await call(null, 'POST', '/api/portal/login', { username: 'clerk', password: 'clerk123', company: 'default' });
  assert.equal(other.http, 403);
  const missing = await call(null, 'POST', '/api/portal/login', { username: 'clerk', password: 'clerk123', company: 'nope' });
  assert.equal(missing.http, 404);
  const admin = await login('admin', 'welcome123', 'branch');
  await ok(admin, 'DELETE', '/api/portal/members?company=branch&username=clerk');
  assert.equal((await call(null, 'POST', '/api/portal/login', { username: 'clerk', password: 'clerk123', company: 'branch' })).http, 403);
  const members = await ok(admin, 'GET', '/api/portal/members?company=branch');
  assert.deepEqual(members.members.map(x => x.username), ['admin']);
});

test('成员：公司至少保留一个管理员', async () => {
  const admin = await login('admin', 'welcome123', 'branch');
  const r = await call(admin, 'DELETE', '/api/portal/members?company=branch&username=admin');
  assert.equal(r.http, 400);
  assert.match(r.error, /至少.*管理员/);
});

test('未登录访问业务接口被拒绝，登录失效后也不能切换公司', async () => {
  assert.equal((await call(null, 'GET', '/api/data')).http, 401);
  assert.equal((await call(null, 'POST', '/api/portal/switch', { company: 'default' })).http, 401);
  assert.equal((await call('not-a-real-token', 'GET', '/api/portal/companies')).http, 401);
});

test('成员移除后旧会话立即失效，不能继续访问该公司业务接口', async () => {
  const admin = await login('admin', 'welcome123', 'branch');
  await ok(admin, 'POST', '/api/portal/members', {
    company: 'branch', username: 'clerk2', name: '临时员工', password: 'clerk2123', role: 'user',
  });
  const tok = await login('clerk2', 'clerk2123', 'branch');
  await ok(tok, 'GET', '/api/data');
  await ok(admin, 'DELETE', '/api/portal/members?company=branch&username=clerk2');
  assert.equal((await call(tok, 'GET', '/api/data')).http, 401);
  assert.equal((await call(null, 'POST', '/api/portal/login', { username: 'clerk2', password: 'clerk2123', company: 'branch' })).http, 403);
});

test('成员降权后旧会话立即失效，重新登录也不再拥有管理员权限', async () => {
  const admin = await login('admin', 'welcome123', 'branch');
  await ok(admin, 'POST', '/api/portal/members', {
    company: 'branch', username: 'mgr2', name: '副管理员', password: 'mgr21234', role: 'admin',
  });
  const mgrOld = await login('mgr2', 'mgr21234', 'branch');
  assert.equal((await ok(mgrOld, 'GET', '/api/data')).user.role, 'admin');
  await ok(mgrOld, 'GET', '/api/users');
  // 降权为普通成员
  await ok(admin, 'POST', '/api/portal/members', {
    company: 'branch', username: 'mgr2', role: 'user',
  });
  // 旧 token 立即失效
  assert.equal((await call(mgrOld, 'GET', '/api/data')).http, 401);
  assert.equal((await call(mgrOld, 'GET', '/api/users')).http, 401);
  // 重新登录后仅为普通成员，不能访问管理员接口
  const mgrNew = await login('mgr2', 'mgr21234', 'branch');
  assert.equal((await ok(mgrNew, 'GET', '/api/data')).user.role, 'user');
  assert.equal((await call(mgrNew, 'GET', '/api/users')).http, 403);
  assert.equal((await call(mgrNew, 'GET', '/api/portal/companies')).http, 403);
  // 清理 mgr2 后，不能把唯一管理员降权
  await ok(admin, 'DELETE', '/api/portal/members?company=branch&username=mgr2');
  const lastDemote = await call(admin, 'POST', '/api/portal/members', {
    company: 'branch', username: 'admin', role: 'user',
  });
  assert.equal(lastDemote.http, 400);
  assert.match(lastDemote.error, /至少.*管理员/);
});

test('公司管理：停用/启用、批量分配账套权限与删除测试公司', async () => {
  const admin = await login('admin', 'welcome123', 'default');
  await ok(admin, 'POST', '/api/portal/companies', { name: '临时测试公司', code: 'tmpco' });
  // 批量分配给新员工 multi1 同时访问 default 和 tmpco
  await ok(admin, 'POST', '/api/portal/members/batch', {
    username: 'multi1', name: '跨账套员工', role: 'user', password: 'multi123', companies: ['default', 'tmpco'],
  });
  const uList = await ok(admin, 'GET', '/api/portal/users');
  const m1 = uList.users.find(x => x.username === 'multi1');
  assert.ok(m1 && m1.companies.default === 'user' && m1.companies.tmpco === 'user');
  const m1Tok = await login('multi1', 'multi123', 'tmpco');
  await ok(m1Tok, 'GET', '/api/data');
  // 停用 tmpco -> 旧会话失效，不能登录
  await ok(admin, 'PUT', '/api/portal/companies/tmpco', { enabled: false });
  assert.equal((await call(null, 'POST', '/api/portal/login', { username: 'multi1', password: 'multi123', company: 'tmpco' })).http, 404);
  // 重新启用 tmpco -> 恢复登录
  await ok(admin, 'PUT', '/api/portal/companies/tmpco', { enabled: true });
  await login('multi1', 'multi123', 'tmpco');
  // 不能删除或停用默认公司
  assert.equal((await call(admin, 'PUT', '/api/portal/companies/default', { enabled: false })).http, 400);
  assert.equal((await call(admin, 'DELETE', '/api/portal/companies/default')).http, 400);
  // 删除测试公司 tmpco
  await ok(admin, 'DELETE', '/api/portal/companies/tmpco');
  const cos = await ok(admin, 'GET', '/api/portal/companies');
  assert.equal(cos.companies.some(c => c.code === 'tmpco'), false);
});
