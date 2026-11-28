import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function startServer(dataDir) {
  const port = await freePort();
  const proc = spawn(NODE, [path.join(ROOT, 'src/server.js'), '--port', String(port), '--data', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) return { port, proc, stop: () => { try { proc.kill('SIGTERM'); } catch {} } }; } catch {}
    await new Promise(r => setTimeout(r, 80));
  }
  try { proc.kill('SIGKILL'); } catch {}
  throw new Error('server start failed');
}

async function startPortal(dataDir) {
  const port = await freePort(), basePort = await freePort();
  const proc = spawn(NODE, [path.join(ROOT, 'src/portal.js'), '--port', String(port), '--data', dataDir, '--base-port', String(basePort)], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/portal/me`); if (r.status === 200 || r.status === 401) return { port, proc, stop: () => { try { proc.kill('SIGTERM'); } catch {} } }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  try { proc.kill('SIGKILL'); } catch {}
  throw new Error('portal start failed');
}

async function login(port, username, password) {
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const d = await r.json();
  if (!r.ok) throw new Error(`login ${username} failed: ${JSON.stringify(d)}`);
  return {
    token: d.token, user: d.user,
    req: async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + d.token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = {}; try { data = await res.json(); } catch {}
      return { status: res.status, data };
    }
  };
}

test('Portal #1 & #2: 多账套密码隔离（不覆盖无关用户） + 忽略伪造 X-Forwarded-For 限流', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-19-portal-'));
  const portal = await startPortal(dir);
  try {
    const pReq = async (method, p, body, token, extraHeaders = {}) => {
      const res = await fetch(`http://127.0.0.1:${portal.port}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = {}; try { data = await res.json(); } catch {}
      return { status: res.status, data };
    };

    // #2: 伪造不同 X-Forwarded-For 头不能绕过门户登录限流
    for (let i = 0; i < 8; i++) {
      const r = await pReq('POST', '/api/portal/login', { username: 'victim_user', password: 'bad' }, null, { 'X-Forwarded-For': `10.0.0.${i + 1}` });
      assert.equal(r.status, 401);
    }
    const rBlocked = await pReq('POST', '/api/portal/login', { username: 'victim_user', password: 'bad' }, null, { 'X-Forwarded-For': '10.0.0.99' });
    assert.equal(rBlocked.status, 429, '更换伪造 X-Forwarded-For 仍应被限流返回 429');

    // #1: 真实双账套验证 —— 用户 alice 在账套 A 改密码后，全局管理员在账套 B 修改 bob 不应把 alice 的全局密码覆盖回旧密码
    const admLogin = await pReq('POST', '/api/portal/login', { username: 'admin', password: 'admin123' });
    assert.equal(admLogin.status, 200);
    const admTok = admLogin.data.token;

    // 创建第二个账套 co2
    const c2 = await pReq('POST', '/api/portal/companies', { code: 'co2', name: '账套二' }, admTok);
    assert.equal(c2.status, 200);
    const compsRes = (await pReq('GET', '/api/portal/companies', undefined, admTok)).data;
    const comps = Array.isArray(compsRes) ? compsRes : (compsRes.companies || []);
    const co1 = comps.find(x => x.code === 'default'), co2 = comps.find(x => x.code === 'co2');

    // 通过门户成员接口在 default 和 co2 分别加入 alice（密码 oldpassword1），并在 co2 加入 bob（密码 bobpassword1）
    const uAlice1 = await pReq('POST', '/api/portal/members', { company: 'default', username: 'alice', name: 'Alice', password: 'oldpassword1', role: 'user' }, admTok);
    assert.equal(uAlice1.status, 200);
    const uAlice2 = await pReq('POST', '/api/portal/members', { company: 'co2', username: 'alice', name: 'Alice', password: 'oldpassword1', role: 'user' }, admTok);
    assert.equal(uAlice2.status, 200);
    const uBob = await pReq('POST', '/api/portal/members', { company: 'co2', username: 'bob', name: 'Bob', password: 'bobpassword1', role: 'user' }, admTok);
    assert.equal(uBob.status, 200);
    // 让 alice 先登录一次 co2（确保 co2 本地库已落库 alice 的旧密码哈希），再切回 default 改密码
    const aliceCo2Login = await pReq('POST', '/api/portal/login', { username: 'alice', password: 'oldpassword1', company: 'co2' });
    assert.equal(aliceCo2Login.status, 200);

    // alice 登录账套 default 并修改自己的密码为 newpassword2（此时 co2 本地库里仍是旧密码）
    const aliceLogin = await pReq('POST', '/api/portal/login', { username: 'alice', password: 'oldpassword1', company: 'default' });
    assert.equal(aliceLogin.status, 200);
    const aliceChg = await pReq('POST', '/api/password', { oldPassword: 'oldpassword1', newPassword: 'newpassword2' }, aliceLogin.data.token);
    assert.equal(aliceChg.status, 200);

    // 全局管理员切到 co2 修改 bob 的密码
    assert.equal((await pReq('POST', '/api/portal/switch', { company: 'co2' }, admTok)).status, 200);
    const bobCo2Login = await pReq('POST', '/api/portal/login', { username: 'bob', password: 'bobpassword1', company: 'co2' });
    assert.equal(bobCo2Login.status, 200);
    const co2Users = (await pReq('GET', '/api/users', undefined, admTok)).data;
    const bobLocal = co2Users.find(u => u.username === 'bob');
    assert.ok(bobLocal, 'co2 中存在 bob');
    assert.equal((await pReq('PUT', `/api/users/${bobLocal.id}`, { name: 'Bob2', roleId: bobLocal.roleId || 'admin', password: 'bobpassword2' }, admTok)).status, 200);

    // 验证 alice 的新密码仍然有效，没有被 co2 里的旧密码覆盖！
    const aliceRelogin = await pReq('POST', '/api/portal/login', { username: 'alice', password: 'newpassword2' });
    assert.equal(aliceRelogin.status, 200, '全局管理员在账套 B 改 bob 不应把 alice 的全局密码覆盖回旧密码');
    const aliceOldLogin = await pReq('POST', '/api/portal/login', { username: 'alice', password: 'oldpassword1' });
    assert.equal(aliceOldLogin.status, 401, 'alice 旧密码应已失效');
  } finally {
    portal.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('Server #3-#14: 配送权限、分批发货幂等、作废外部编号、退货行级限额、粮食待审作废与脱敏、备用金统计、申诉与暂存面单', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-19-srv-'));
  const srv = await startServer(dir);
  try {
    const admin = await login(srv.port, 'admin', 'admin123');
    const allMods = Object.keys((await admin.req('GET', '/api/data')).data.meta?.modules || {});
    await admin.req('PUT', '/api/settings', { modules: [...new Set([...allMods, 'agri', 'shipping'])] });

    const rSales = (await admin.req('POST', '/api/roles', { name: '销售员', perms: ['sales', 'parties', 'shipping'] })).data;
    await admin.req('POST', '/api/users', { username: 'sa1', name: '销售1', password: 'password123', roleId: rSales.id });
    await admin.req('POST', '/api/users', { username: 'sa2', name: '销售2', password: 'password123', roleId: rSales.id });
    const u1 = await login(srv.port, 'sa1', 'password123');
    const u2 = await login(srv.port, 'sa2', 'password123');

    // #3 [P1]: 配送记录保存写入 creatorId，且修改/删除禁止越权
    const c1 = (await u1.req('POST', '/api/customers', { name: '客户1' })).data;
    const c2 = (await u2.req('POST', '/api/customers', { name: '客户2' })).data;
    const deliv1 = (await u1.req('POST', '/api/deliveries', { date: '2026-11-28', driver: '小王', party: c1.name, customerId: c1.id })).data;
    assert.equal(deliv1.creatorId, u1.user.id, '新建配送应写入 creatorId');
    assert.equal((await u2.req('PUT', `/api/deliveries/${deliv1.id}`, { driver: '篡改', customerId: c2.id })).status, 403, 'u2 试图改 customerId 绕过归属限制应被拒 403');
    assert.equal((await u2.req('DELETE', `/api/deliveries/${deliv1.id}`)).status, 403, 'u2 删除他人配送应被拒 403');

    // #4 & #5 [P2]: 带 checkoutId 的销售单仍允许分批发货 + 作废后 checkoutId 不可复用 + 超长拒绝
    const prod = (await admin.req('POST', '/api/products', { name: '货品A', sku: 'PA-1', unit: '个', cost: 10, price: 20, stock: 100 })).data;
    assert.equal((await admin.req('POST', '/api/orders/sales', { partyId: c1.id, date: '2026-11-28', checkoutId: 'x'.repeat(65), items: [{ productId: prod.id, qty: 1, price: 20 }] })).status, 400, '超长 checkoutId 应拒绝');

    const so = (await admin.req('POST', '/api/orders/sales', { partyId: c1.id, date: '2026-11-28', checkoutId: 'chk-split-1', items: [{ productId: prod.id, qty: 10, price: 20 }] })).data;
    const sh1 = await admin.req('POST', `/api/orders/sales/${so.id}/ship`, { wh: 'w1', items: [{ productId: prod.id, qty: 2 }] });
    assert.equal(sh1.status, 200);
    assert.equal(sh1.data.lastStockDocStatus, '正常', '#14 响应返回本次出库单状态');
    const sh2 = await admin.req('POST', `/api/orders/sales/${so.id}/ship`, { wh: 'w1', items: [{ productId: prod.id, qty: 8 }] });
    assert.equal(sh2.status, 200);
    assert.equal(sh2.data.status, '已发货', '#4 带 checkoutId 的销售单应能正常完成分批发货');

    // 作废单据后相同 checkoutId 不得重建新单
    const soVoid = (await admin.req('POST', '/api/orders/sales', { partyId: c1.id, date: '2026-11-28', checkoutId: 'chk-void-1', items: [{ productId: prod.id, qty: 1, price: 20 }] })).data;
    assert.equal((await admin.req('POST', `/api/orders/sales/${soVoid.id}/cancel`, {})).status, 200);
    const soRetry = await admin.req('POST', '/api/orders/sales', { partyId: c1.id, date: '2026-11-28', checkoutId: 'chk-void-1', items: [{ productId: prod.id, qty: 1, price: 20 }] });
    assert.equal(soRetry.data.id, soVoid.id, '#5 作废后重试同 checkoutId 应返回原已作废单而非新建');

    // #6 [P2]: 退货保存 srcLine 且校验行级可退数量
    const sup = (await admin.req('POST', '/api/suppliers', { name: '供货商1' })).data;
    const po = (await admin.req('POST', '/api/orders/purchase', {
      partyId: sup.id, date: '2026-11-28',
      items: [{ productId: prod.id, qty: 2, price: 10 }, { productId: prod.id, qty: 2, price: 30 }]
    })).data;
    await admin.req('POST', `/api/orders/purchase/${po.id}/approve`, {});
    await admin.req('POST', `/api/orders/purchase/${po.id}/inbound`, {});
    // 第 2 行只有 2 件，试图按第 2 行退 3 件应被拒绝
    assert.equal((await admin.req('POST', '/api/orders/purchaseReturn', {
      partyId: sup.id, srcId: po.id, date: '2026-11-28',
      items: [{ productId: prod.id, qty: 3, price: 30, srcLine: 1 }]
    })).status, 400, '#6 超出来源行数量应被拒绝');
    const pret = (await admin.req('POST', '/api/orders/purchaseReturn', {
      partyId: sup.id, srcId: po.id, date: '2026-11-28',
      items: [{ productId: prod.id, qty: 1, price: 30, srcLine: 1 }]
    })).data;
    assert.equal(pret.items[0].srcLine, 1, '#6 退货明细应持久保存 srcLine');
    assert.equal(pret.items[0].cost, 30);

    // #7 [P1] & #8 & #9 [P2]: 待审粮食单作废不变动库存 + 审核同步真实成本 + 接口脱敏
    await admin.req('PUT', '/api/settings', { docApprove: { in: true, out: true } });
    const stockBefore = (await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === prod.id).stock;
    const gdPend = (await admin.req('POST', '/api/graindocs', {
      dir: 'out', date: '2026-11-28', productId: prod.id, farmerName: '粮商',
      grossWeight: 120, tareWeight: 100, calcMode: 'deduct', moisture: 14, stdMoisture: 14, impurity: 0, unitPrice: 3
    })).data;
    assert.equal((await admin.req('POST', `/api/graindocs/${gdPend.id}/void`, { reason: '待审作废' })).status, 200);
    const stockAfterVoid = (await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === prod.id).stock;
    assert.equal(stockAfterVoid, stockBefore, '#7 待审核售粮单作废不应凭空增加库存');

    // 无 inv.cost 权限的农业账号调用 pay/void 不应泄露 unitCost (#9)
    const rAgri = (await admin.req('POST', '/api/roles', { name: '农业无成本', perms: ['agri'] })).data;
    await admin.req('POST', '/api/users', { username: 'ag_nocost', name: '农技', password: 'password123', roleId: rAgri.id });
    const uAg = await login(srv.port, 'ag_nocost', 'password123');
    const gd2 = (await admin.req('POST', '/api/graindocs', {
      dir: 'out', date: '2026-11-28', productId: prod.id, farmerName: '粮商2',
      grossWeight: 110, tareWeight: 100, calcMode: 'deduct', moisture: 14, stdMoisture: 14, impurity: 0, unitPrice: 3
    })).data;
    const vResp = await uAg.req('POST', `/api/graindocs/${gd2.id}/void`, { reason: '作废' });
    assert.equal(vResp.status, 200);
    assert.equal('unitCost' in vResp.data, false, '#9 作废接口响应应脱敏 unitCost');
    await admin.req('PUT', '/api/settings', { docApprove: { in: false, out: false } });

    // #10 & #11 [P2]: 备用金发放标记 nonExpense: true，且兼容无发放流水的历史备用金
    const acctId = (await admin.req('GET', '/api/data')).data.data.accounts[0].id;
    const adv = (await admin.req('POST', '/api/advances', { applicant: '管理员', amount: 200, purpose: '差旅', date: '2026-11-28' })).data;
    await admin.req('POST', `/api/advances/${adv.id}/approve`, {});
    const advPaid = (await admin.req('POST', `/api/advances/${adv.id}/pay`, { account: acctId, date: '2026-11-28' })).data;
    assert.ok(advPaid.payFinanceId, '#11 备用金发放应记录 payFinanceId');
    const finAll = (await admin.req('GET', '/api/data')).data.data.finance;
    const advFin = finAll.find(f => f.id === advPaid.payFinanceId);
    assert.equal(advFin.nonExpense, true, '#10 备用金发放流水应标记 nonExpense: true 不重复计入经营费用');

    // #13 [P2]: 暂存异常面单查询接口可用
    const orphList = await admin.req('GET', '/api/shipments/orphan-labels');
    assert.equal(orphList.status, 200);
    assert.ok(Array.isArray(orphList.data));
  } finally {
    srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('前端 #14 #15 & Android #16 #17 #18 静态校验', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  assert.ok(html.includes('res.lastStockDocStatus !== \'待审核\''), '#14 按本次出库单生效状态登记物流/配送');
  assert.ok(html.includes('const totalDiscCents = Math.max(0, Math.round((+(o.discount || 0)) * 100))'), '#15 多页打印按各页金额比例分摊优惠');
  assert.ok(html.includes('!f.nonCash && f.category !== \'固定资产折旧\'') && html.includes('!f.nonExpense'), '#10 财务与报表区分资金流与经营费用');

  const mainJava = fs.readFileSync(path.join(ROOT, 'android-scanner/src/com/xerp/scanner/MainActivity.java'), 'utf8');
  assert.ok(mainJava.indexOf('t.onCompanySwitched();') < mainJava.indexOf('ApiClient.fetchData(store);'), '#16 切账套成功后先清购物车再拉新数据');

  const edJava = fs.readFileSync(path.join(ROOT, 'android-scanner/src/com/xerp/scanner/ProductEditorSheet.java'), 'utf8');
  assert.ok(edJava.includes('etPkgRate.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL)'), '#17 主编辑表单辅助单位倍率支持小数键盘');

  const apiJava = fs.readFileSync(path.join(ROOT, 'android-scanner/src/com/xerp/scanner/ApiClient.java'), 'utf8');
  assert.ok(apiJava.includes('class ResponseTooLargeException extends IOException') && apiJava.indexOf('instanceof ResponseTooLargeException') < apiJava.indexOf('instanceof IOException'), '#18 独立异常类型优先于 IOException 提示');
});
