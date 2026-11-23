// 钉钉式会签：逐条流程测试（会签 / 或签 / 驳回 / 前加签 / 后加签 / 转交 / 催办 / 抄送 / 撤回 / 权限 / 跳过申请人 / 三步流程）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-apv-'));
const PORT = 23000 + Math.floor(Math.random() * 12000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin, head1, head2, fin, gm2, extra, staff;

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
const login = async (username, password) => (await ok(null, 'POST', '/api/login', { username, password })).token;
async function newUser(username) {
  await ok(admin, 'POST', '/api/users', { username, name: username, roleId: 'r_staff', password: 'test123456' });
  return login(username, 'test123456');
}
const setFlow = (body) => ok(admin, 'PUT', '/api/settings/expense-flow', {
  deptHeads: { 销售部: ['u_head1', 'u_head2'] }, finance: ['u_fin'], gm: ['u_gm'], gmThreshold: 1000,
  modes: { dept: 'all', finance: 'all', gm: 'all' }, ...body,
});
const mk = (extra = {}) => ok(staff, 'POST', '/api/expenses', {
  applicant: 'u_staff', dept: '销售部', date: '2026-11-17', reason: '流程测试',
  lines: [{ category: '差旅', amount: 100 }], ...extra,
});

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
  await ok(admin, 'PUT', '/api/settings', { modules: ['inventory', 'products', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'hr', 'reports'] });
  head1 = await newUser('u_head1');
  head2 = await newUser('u_head2');
  fin = await newUser('u_fin');
  gm2 = await newUser('u_gm');
  extra = await newUser('u_extra');
  const role = await ok(admin, 'POST', '/api/roles', { name: '报销员9', perms: ['expense'] });
  await ok(admin, 'POST', '/api/users', { username: 'u_staff', name: 'u_staff', roleId: role.id, password: 'test123456' });
  staff = await login('u_staff', 'test123456');
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

test('流程1 会签：两人都同意才进入下一步', async () => {
  await setFlow({});
  let o = await mk();
  assert.equal(o.approval.steps[0].mode, 'all');
  o = await ok(head1, 'POST', `/api/expenses/${o.id}/approve`, { comment: '一人同意' });
  assert.equal(o.status, '待审批');
  assert.equal(o.approval.current, 0);
  o = await ok(head2, 'POST', `/api/expenses/${o.id}/approve`, {});
  assert.equal(o.approval.current, 1, '两人同意后进入财务');
});

test('流程2 或签：一人同意即通过', async () => {
  await setFlow({ modes: { dept: 'any', finance: 'all', gm: 'all' } });
  let o = await mk();
  assert.equal(o.approval.steps[0].mode, 'any');
  o = await ok(head1, 'POST', `/api/expenses/${o.id}/approve`, {});
  assert.equal(o.approval.current, 1, '或签一人同意直接进入财务');
});

test('流程3 驳回：任一审批人驳回即结束', async () => {
  await setFlow({});
  let o = await mk();
  o = await ok(head1, 'POST', `/api/expenses/${o.id}/reject`, { reason: '票据不全' });
  assert.equal(o.status, '已驳回');
  assert.equal(o.rejectReason, '票据不全');
  assert.equal((await call(head2, 'POST', `/api/expenses/${o.id}/approve`, {})).http, 400, '已驳回后不能再审批');
});

test('流程4 前加签：被加签人先审，再回到原审批人', async () => {
  await setFlow({});
  let o = await mk();
  o = await ok(head1, 'POST', `/api/expenses/${o.id}/addsigner`, { who: 'u_extra', position: 'before' });
  assert.equal(o.approval.steps[0].approvers[0], 'u_extra', '前加签插到当前节点之前');
  o = await ok(extra, 'POST', `/api/expenses/${o.id}/approve`, {});
  assert.equal(o.approval.steps[1].name, '部门负责人', '加签审完回到原节点');
  assert.equal(o.approval.current, 1);
});

test('流程5 后加签：当前人审完再由被加签人审', async () => {
  await setFlow({});
  let o = await mk();
  o = await ok(head1, 'POST', `/api/expenses/${o.id}/addsigner`, { who: 'u_extra', position: 'after' });
  assert.equal(o.approval.steps[1].approvers[0], 'u_extra', '后加签排在当前节点之后');
  o = await ok(head1, 'POST', `/api/expenses/${o.id}/approve`, {});
  o = await ok(head2, 'POST', `/api/expenses/${o.id}/approve`, {});
  assert.equal(o.approval.current, 1, '部门节点通过后进入加签节点');
  o = await ok(extra, 'POST', `/api/expenses/${o.id}/approve`, {});
  assert.equal(o.approval.steps[2].name, '财务', '加签节点通过后进入财务');
});

test('流程6 转交：原审批人被替换', async () => {
  await setFlow({});
  let o = await mk();
  o = await ok(head2, 'POST', `/api/expenses/${o.id}/transfer`, { to: 'u_extra' });
  assert.deepEqual(o.approval.steps[0].approvers.sort(), ['u_extra', 'u_head1']);
  assert.equal(o.approval.log.length, 1);
  assert.equal(o.approval.log[0].type, 'transfer');
  o = await ok(extra, 'POST', `/api/expenses/${o.id}/approve`, {});
  o = await ok(head1, 'POST', `/api/expenses/${o.id}/approve`, {});
  assert.equal(o.approval.current, 1);
});

test('流程7 催办：提交人可催，10 分钟内限一次，其他人不能催', async () => {
  await setFlow({});
  let o = await mk();
  assert.equal((await call(head1, 'POST', `/api/expenses/${o.id}/urge`, {})).http, 403, '非提交人不能催办');
  o = await ok(staff, 'POST', `/api/expenses/${o.id}/urge`, {});
  assert.equal(o.approval.urges.length, 1);
  assert.equal((await call(staff, 'POST', `/api/expenses/${o.id}/urge`, {})).http, 400, '10 分钟内重复催办被拒');
});

test('流程8 撤回：撤回→修改→重新提交', async () => {
  await setFlow({});
  let o = await mk();
  assert.equal((await call(head1, 'POST', `/api/expenses/${o.id}/withdraw`, {})).http, 403, '非提交人不能撤回');
  o = await ok(staff, 'POST', `/api/expenses/${o.id}/withdraw`, {});
  assert.equal(o.status, '已撤回');
  o = await ok(staff, 'PUT', `/api/expenses/${o.id}`, { applicant: 'u_staff', dept: '销售部', date: '2026-11-17', reason: '改完再提', lines: [{ category: '交通费', amount: 60 }] });
  assert.equal(o.status, '待审批');
  assert.equal(o.reason, '改完再提');
  assert.equal(o.approval.current, 0, '重新提交后流程从头开始');
});

test('流程9 抄送：保存并在数据里可见', async () => {
  await setFlow({});
  const o = await mk({ cc: 'u_gm, u_extra' });
  assert.deepEqual(o.cc, ['u_gm', 'u_extra']);
});

test('流程10 权限：非当前节点的人不能审批/加签/转交', async () => {
  await setFlow({});
  const o = await mk();
  assert.equal((await call(fin, 'POST', `/api/expenses/${o.id}/approve`, {})).http, 403, '财务不能越过部门节点');
  assert.equal((await call(fin, 'POST', `/api/expenses/${o.id}/addsigner`, { who: 'u_extra' })).http, 403);
  assert.equal((await call(fin, 'POST', `/api/expenses/${o.id}/transfer`, { to: 'u_extra' })).http, 403);
  await ok(head1, 'POST', `/api/expenses/${o.id}/approve`, {});
  assert.equal((await call(head1, 'POST', `/api/expenses/${o.id}/approve`, {})).http, 400, '同一个人不能重复同意');
});

test('流程11 申请人自动跳过自己的节点', async () => {
  await setFlow({ deptHeads: { 销售部: ['u_staff', 'u_head1'] } });
  const o = await mk();
  assert.deepEqual(o.approval.steps[0].approvers, ['u_head1'], '申请人不在审批人里');
});

test('流程12 三步流程与总经理金额门槛', async () => {
  await setFlow({ gmThreshold: 1000 });
  const small = await mk({ lines: [{ category: '差旅', amount: 500 }] });
  assert.equal(small.approval.steps.length, 2, '低于门槛不经过总经理');
  const big = await mk({ lines: [{ category: '差旅', amount: 1500 }] });
  assert.equal(big.approval.steps.length, 3, '达到门槛加总经理节点');
  assert.equal(big.approval.steps[2].name, '总经理');
});

test('流程13 管理员固定抄送与禁止报销人自填抄送', async () => {
  await setFlow({ cc: ['u_cc'], allowCustomCc: false });
  const oLocked = await mk({ cc: 'u_extra, u_cc' });
  assert.deepEqual(oLocked.cc, ['u_cc'], '关闭自定义抄送后忽略提交人自填');

  await setFlow({ cc: ['u_cc'], allowCustomCc: true });
  const oMerged = await mk({ cc: 'u_extra, u_cc' });
  assert.deepEqual(oMerged.cc, ['u_cc', 'u_extra'], '开启自定义抄送后自动合并管理员固定抄送且去重');
});

test('流程14 抄送人只读可见（无全局报销/审批权限也能看，但不能审批或篡改）', async () => {
  const roRole = await ok(admin, 'POST', '/api/roles', { name: '仅仓储只读', perms: ['inv.view'] });
  await ok(admin, 'POST', '/api/users', { username: 'u_cc', name: '老板抄送', roleId: roRole.id, password: 'test123456' });
  const ccTok = await login('u_cc', 'test123456');

  await setFlow({ cc: [], allowCustomCc: true });
  const hidden = await mk({ reason: '未抄送的单' });
  const shown = await mk({ reason: '抄送给老板', cc: 'u_cc' });

  const ccData = await ok(ccTok, 'GET', '/api/data');
  assert.ok(ccData.data.expenses.some(x => x.id === shown.id), '抄送人能看到抄送自己的报销单');
  assert.ok(!ccData.data.expenses.some(x => x.id === hidden.id), '抄送人看不到未抄送给自己的报销单');

  assert.equal((await call(ccTok, 'POST', `/api/expenses/${shown.id}/approve`, {})).http, 403, '抄送人不能审批');
  assert.equal((await call(ccTok, 'PUT', `/api/expenses/${shown.id}`, { applicant: 'u_staff', date: '2026-11-17', reason: '篡改', lines: [{ category: '差旅', amount: 1 }] })).http, 403, '抄送人不能修改');
  assert.equal((await call(ccTok, 'POST', `/api/expenses/${shown.id}/void`, {})).http, 403, '抄送人不能作废');
  assert.equal((await call(ccTok, 'GET', `/api/expenses/${shown.id}/images/nonexist`)).http, 404, '抄送人通过附件查看鉴权（非403）');
});

test('流程15 指定审批人无需全局审批权限也可审批当前节点，且普通账号可获取审批流程设置', async () => {
  const mgrRole = await ok(admin, 'POST', '/api/roles', { name: '无财务权限主管', perms: ['inv.view', 'sales'] });
  await ok(admin, 'POST', '/api/users', { username: 'u_mgr', name: '指定审批人', roleId: mgrRole.id, password: 'test123456' });
  const mgrTok = await login('u_mgr', 'test123456');

  await setFlow({ deptHeads: { 销售部: ['u_head1'] }, finance: ['u_mgr'], gm: [], gmThreshold: 0, cc: ['u_extra'], allowCustomCc: false });
  const staffData = await ok(staff, 'GET', '/api/data');
  assert.deepEqual(staffData.settings.expenseFlow.cc, ['u_extra'], '普通账号也能获取非敏感报销流程配置');
  assert.equal(staffData.settings.expenseFlow.allowCustomCc, false);

  const o = await mk({ reason: '指定无全局权限主管审批' });
  const mgrDataBefore = await ok(mgrTok, 'GET', '/api/data');
  assert.ok(mgrDataBefore.data.expenses.some(x => x.id === o.id), '流程中的指定审批人能看到待审批报销单');

  assert.equal((await call(mgrTok, 'POST', `/api/expenses/${o.id}/approve`, {})).http, 403, '未轮到自己节点时不能越级审批');
  await ok(head1, 'POST', `/api/expenses/${o.id}/approve`, {});
  const done = await ok(mgrTok, 'POST', `/api/expenses/${o.id}/approve`, { comment: '指定审批人同意' });
  assert.equal(done.status, '已批准', '轮到当前节点时指定审批人无需 exp.approve 权限即可批准通过');
});
