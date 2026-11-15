// 新增功能回归测试：真实启动服务端，走 HTTP 接口
// 运行：node --test tests/features.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-feat-'));
const PORT = 22000 + Math.floor(Math.random() * 15000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin, head1, head2, fin, staff;

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
async function login(username, password) { return (await ok(null, 'POST', '/api/login', { username, password })).token; }
const data = async (token = admin) => (await ok(token, 'GET', '/api/data')).data;
const settings = async () => (await ok(admin, 'GET', '/api/data')).settings;
async function newUser(username, roleId = 'r_staff') {
  await ok(admin, 'POST', '/api/users', { username, name: username, roleId, password: 'test123456' });
  return login(username, 'test123456');
}
const acct = async () => (await data()).accounts[0].id;

before(async () => {
  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XERP_STATS_URL: '', XERP_FEEDBACK_URL: '', XERP_CLOUD_URL: '' },
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/ping'); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  admin = await login('admin', 'admin123');
  await ok(admin, 'PUT', '/api/settings', { modules: ['inventory', 'products', 'bom', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'hr', 'reports', 'shipping'] });
  head1 = await newUser('u_head1'); head2 = await newUser('u_head2'); fin = await newUser('u_fin');
  const clerkRole = await ok(admin, 'POST', '/api/roles', { name: '报销员测试', perms: ['expense'] });
  staff = await newUser('u_staff', clerkRole.id);
  await ok(admin, 'PUT', '/api/settings/expense-flow', { deptHeads: { 销售部: ['u_head1', 'u_head2'] }, finance: ['u_fin'], gm: [], gmThreshold: 1000 });
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

test('付款回单、备用金、会签、驳回、权限、生日、备份', async () => {
  // ---- 生日字段：合法身份证可保存，非法拒绝 ----
  const emps = (await data()).employees;
  let e = emps[0];
  const eb = { ...e, idCard: '110101199011201234' };
  let saved = await ok(admin, 'PUT', `/api/employees/${e.id}`, eb);
  assert.equal(saved.idCard, '110101199011201234');
  assert.equal((await call(admin, 'PUT', `/api/employees/${e.id}`, { ...eb, idCard: '123' })).http, 400);
  await ok(admin, 'PUT', '/api/settings', { birthdayDays: 30 });
  assert.equal((await settings()).birthdayDays, 30);
  assert.equal((await call(admin, 'PUT', '/api/settings', { birthdayDays: 0 })).http, 400);
  await ok(admin, 'PUT', '/api/settings', { birthdayDays: 7 });

  // ---- 备用金：申请 → 审批 → 发放 ----
  let a = await ok(staff, 'POST', '/api/advances', { applicant: 'u_staff', dept: '销售部', date: '2026-11-15', amount: 300, purpose: '测试备用金' });
  assert.equal(a.status, '待审批');
  assert.equal((await call(staff, 'POST', `/api/advances/${a.id}/approve`, {})).http, 403);
  a = await ok(head1, 'POST', `/api/advances/${a.id}/approve`, {});
  assert.equal(a.status, '已批准');
  a = await ok(admin, 'POST', `/api/advances/${a.id}/pay`, { date: '2026-11-15', account: await acct() });
  assert.equal(a.status, '已发放');

  // ---- 报销会签：部门负责人两人会签 → 财务；付款回单；备用金冲抵 ----
  let o = await ok(staff, 'POST', '/api/expenses', {
    applicant: 'u_staff', dept: '销售部', date: '2026-11-15', reason: '会签 + 备用金测试',
    lines: [{ category: '差旅', amount: 100 }], advanceId: a.id, advanceOffset: 50,
  });
  assert.equal(o.approval.steps.length, 2);
  assert.deepEqual(o.approval.steps[0].approvers.sort(), ['u_head1', 'u_head2']);
  assert.equal((await call(staff, 'POST', `/api/expenses/${o.id}/approve`, {})).http, 403, '普通员工不能审批');
  o = await ok(head1, 'POST', `/api/expenses/${o.id}/approve`, { comment: '部门同意' });
  assert.equal(o.status, '待审批');
  assert.equal(o.approval.current, 0, '会签必须两人都同意');
  o = await ok(head2, 'POST', `/api/expenses/${o.id}/approve`, { comment: '我也同意' });
  assert.equal(o.approval.current, 1);
  o = await ok(fin, 'POST', `/api/expenses/${o.id}/approve`, { comment: '财务同意' });
  assert.equal(o.status, '已批准');
  assert.match(o.approver, /u_head1/);
  assert.match(o.approver, /u_fin/);

  assert.equal((await call(admin, 'POST', `/api/expenses/${o.id}/payimages`, { data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' })).http, 400, '未付款不能上传回单');
  o = await ok(admin, 'POST', `/api/expenses/${o.id}/pay`, { date: '2026-11-15', account: await acct() });
  assert.equal(o.status, '已付款');
  assert.equal(o.advanceApplied, true);
  let adv = (await data()).advances.find(x => x.id === a.id);
  assert.equal(adv.used, 50); assert.equal(adv.status, '部分核销');
  const pi = await ok(admin, 'POST', `/api/expenses/${o.id}/payimages`, { data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' });
  assert.equal(pi.payImgs.length, 1);
  assert.equal((await call(staff, 'GET', `/api/expenses/${o.id}/payimages/${pi.payImgs[0]}`)).http, 200, '报销人可看付款回单');

  // 撤销付款 → 冲抵退回；重新付款 → 再冲抵
  o = await ok(admin, 'POST', `/api/expenses/${o.id}/unpay`, {});
  assert.equal(o.status, '已批准');
  adv = (await data()).advances.find(x => x.id === a.id);
  assert.equal(adv.used, 0); assert.equal(adv.status, '已发放');
  o = await ok(admin, 'POST', `/api/expenses/${o.id}/pay`, { date: '2026-11-15', account: await acct() });
  adv = (await data()).advances.find(x => x.id === a.id);
  assert.equal(adv.used, 50);

  // 退回剩余 250 → 已核销
  adv = await ok(admin, 'POST', `/api/advances/${a.id}/return`, { amount: 250 });
  assert.equal(adv.returned, 250); assert.equal(adv.status, '已核销');

  // ---- 驳回：任一会签人驳回即结束 ----
  let r = await ok(staff, 'POST', '/api/expenses', { applicant: 'u_staff', dept: '销售部', date: '2026-11-15', reason: '驳回测试', lines: [{ category: '交通费', amount: 20 }] });
  r = await ok(head1, 'POST', `/api/expenses/${r.id}/reject`, { reason: '不符合规定' });
  assert.equal(r.status, '已驳回'); assert.equal(r.rejectReason, '不符合规定');

  // ---- 多张报销单分次冲抵同一笔备用金 ----
  let a2 = await ok(staff, 'POST', '/api/advances', { applicant: 'u_staff', dept: '销售部', date: '2026-11-15', amount: 200, purpose: '多单冲抵' });
  a2 = await ok(head1, 'POST', `/api/advances/${a2.id}/approve`, {});
  a2 = await ok(admin, 'POST', `/api/advances/${a2.id}/pay`, { date: '2026-11-15', account: await acct() });
  for (const amount of [30, 20]) {
    let x = await ok(staff, 'POST', '/api/expenses', { applicant: 'u_staff', dept: '销售部', date: '2026-11-15', reason: '分次冲抵 ' + amount, lines: [{ category: '差旅', amount }], advanceId: a2.id, advanceOffset: amount });
    x = await ok(head1, 'POST', `/api/expenses/${x.id}/approve`, {});
    x = await ok(head2, 'POST', `/api/expenses/${x.id}/approve`, {});
    await ok(fin, 'POST', `/api/expenses/${x.id}/approve`, {});
    await ok(admin, 'POST', `/api/expenses/${x.id}/pay`, { date: '2026-11-15', account: await acct() });
  }
  a2 = (await data()).advances.find(x => x.id === a2.id);
  assert.equal(a2.used, 50); assert.equal(a2.expenseIds.length, 2);

  // ---- 备份包含备用金 ----
  const b = await ok(admin, 'GET', '/api/backup');
  assert.ok(Array.isArray(b.data.advances) && b.data.advances.length >= 2);
});
