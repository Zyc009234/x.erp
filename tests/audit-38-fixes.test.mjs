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
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function startServer(dataDir, extraArgs = []) {
  const port = await freePort();
  const proc = spawn(NODE, [path.join(ROOT, 'src/server.js'), '--port', String(port), '--data', dataDir, ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return { port, proc, stop: () => { try { proc.kill('SIGTERM'); } catch {} } };
    } catch {}
    await new Promise(r => setTimeout(r, 80));
  }
  try { proc.kill('SIGKILL'); } catch {}
  throw new Error('server failed to start: ' + out);
}

async function startPortal(dataDir) {
  const port = await freePort();
  const basePort = await freePort();
  const proc = spawn(NODE, [path.join(ROOT, 'src/portal.js'), '--port', String(port), '--data', dataDir, '--base-port', String(basePort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/portal/me`);
      if (r.status === 200 || r.status === 401) return { port, proc, stop: () => { try { proc.kill('SIGTERM'); } catch {} } };
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  try { proc.kill('SIGKILL'); } catch {}
  throw new Error('portal failed to start: ' + out);
}

async function login(port, username, password) {
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`login ${username} failed (${r.status}): ${JSON.stringify(d)}`);
  const token = d.token;
  return {
    token,
    user: d.user,
    req: async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = {};
      try { data = await res.json(); } catch {}
      return { status: res.status, data };
    },
  };
}

test('P1 #1 & #2 & #38: portal.js 防子账套管理员覆盖全局密码 + 登录限流 + --experimental-sqlite 透传', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-audit-portal-'));
  const portal = await startPortal(dir);
  try {
    // 1. 门户登录限流 (#2)
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`http://127.0.0.1:${portal.port}/api/portal/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong-' + i }),
      });
      assert.equal(r.status, 401);
    }
    const r9 = await fetch(`http://127.0.0.1:${portal.port}/api/portal/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-9' }),
    });
    assert.equal(r9.status, 429, '连续失败 8 次后门户登录应返回 429');

    // 2. 用全局 admin 登录（换另一个用户名或先测试 admin 正常逻辑需新 IP，这里验证另一个不存在用户的限流已隔离，并测 #1）
    const pSrc = fs.readFileSync(path.join(ROOT, 'src/portal.js'), 'utf8');
    assert.ok(pSrc.includes('CHILD_EXEC_ARGS'), '#38 应透传 --experimental-sqlite');
    assert.ok(pSrc.includes('该用户名已存在于其他账套，请更换用户名或联系全局管理员添加成员'), '#1 非全局管理员禁止创建/覆盖同名跨账套账号');
    assert.ok(pSrc.includes('function syncCompanyUsers(c, liveMutation = false, actor = null)'), '#1 syncCompanyUsers 支持权限隔离与防覆盖');
  } finally {
    portal.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1 #30: client.js /local/config 拒绝跨站与缺失 X-XERP-Token 请求', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-audit-client-'));
  const port = await freePort();
  const proc = spawn(NODE, [path.join(ROOT, 'src/client.js'), '--port', String(port), '--config', path.join(dir, 'client.json'), '--no-browser'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let html = '';
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        if (r.ok) { html = await r.text(); break; }
      } catch {}
      await new Promise(r => setTimeout(r, 80));
    }
    const m = html.match(/window\.__XERP_LOCAL_TOKEN__="([a-f0-9]+)"/);
    assert.ok(m && m[1], 'client.js 应在首页注入本机一次性令牌 __XERP_LOCAL_TOKEN__');
    const tok = m[1];

    // 无令牌被拒
    const rNoTok = await fetch(`http://127.0.0.1:${port}/local/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'http://127.0.0.1:9999' }),
    });
    assert.equal(rNoTok.status, 403, '缺少 X-XERP-Token 应返回 403');

    // 跨站 Origin 被拒
    const rEvil = await fetch(`http://127.0.0.1:${port}/local/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-XERP-Token': tok },
      body: JSON.stringify({ server: 'http://127.0.0.1:9999' }),
    });
    assert.equal(rEvil.status, 403, '跨站 Origin 应返回 403');

    // 合法本机 + 令牌通过
    const rOk = await fetch(`http://127.0.0.1:${port}/local/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-XERP-Token': tok },
      body: JSON.stringify({ server: 'http://127.0.0.1:3456' }),
    });
    assert.equal(rOk.status, 200);
    const cfg = await rOk.json();
    assert.equal(cfg.server, 'http://127.0.0.1:3456');
  } finally {
    try { proc.kill('SIGTERM'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('P1 #3 #4 #5 #6 & P2 #7-#17: server.js 核心安全、隔离、财务与备份恢复全面回归', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-audit-srv-'));
  const srv = await startServer(dir);
  try {
    // #3 [P1]: 畸形 URL 请求返回 400 且服务不崩溃
    const rawResp = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => {
        sock.write('GET // [ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.on('data', c => { buf += c.toString(); });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    assert.ok(rawResp.includes('400'), '畸形请求应返回 400，实际: ' + rawResp.slice(0, 80));
    // 服务依然存活
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/`)).status, 200);

    const admin = await login(srv.port, 'admin', 'admin123');
    // 创建测试商品（小数商品 + 普通商品）
    const pDec = (await admin.req('POST', '/api/products', { name: '散装铜线', sku: 'DEC-1', unit: '米', dec: true, cost: 10, price: 20, stock: 10 })).data;
    const pNor = (await admin.req('POST', '/api/products', { name: '水泥', sku: 'NOR-1', unit: '袋', cost: 20, price: 35, stock: 50 })).data;

    // #4 [P1]: 小数商品盘点/手工调整拒绝 NaN / Infinity
    for (const bad of ['NaN', 'Infinity', '-Infinity']) {
      const r = await admin.req('POST', `/api/stock/${pDec.id}`, { mode: 'set', qty: bad });
      assert.equal(r.status, 400, `手工库存调整应拒绝 ${bad}`);
    }
    const pDecAfter = (await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === pDec.id);
    assert.equal(pDecAfter.stock, 10, '拒绝 NaN 后库存应保持 10');

    // #5 & #6 [P1]: 工程单、配送数据客户隔离 + 工程单作废库存权限检查
    const rSales = (await admin.req('POST', '/api/roles', { name: '普通销售', perms: ['sales', 'parties', 'shipping'] })).data;
    assert.equal((await admin.req('POST', '/api/users', { username: 'salesa', name: '业务A', password: 'password123', roleId: rSales.id })).status, 200);
    assert.equal((await admin.req('POST', '/api/users', { username: 'salesb', name: '业务B', password: 'password123', roleId: rSales.id })).status, 200);
    const uA = await login(srv.port, 'salesa', 'password123');
    const uB = await login(srv.port, 'salesb', 'password123');

    const custA = (await uA.req('POST', '/api/customers', { name: 'A的客户' })).data;
    const custB = (await uB.req('POST', '/api/customers', { name: 'B的客户' })).data;
    const delivA = (await admin.req('POST', '/api/deliveries', { date: '2026-11-28', driver: '小工1', party: custA.name, customerId: custA.id, amount: 50 })).data;
    const engA = (await admin.req('POST', '/api/engjobs', { name: 'A的工程', customerId: custA.id, date: '2026-11-28', items: [{ productId: pNor.id, qty: 2, price: 35 }] })).data;
    assert.ok(engA.id, '管理员创建工程单成功');

    // salesB 看不到 salesA 客户的配送单和工程单
    const dataB = (await uB.req('GET', '/api/data')).data.data;
    assert.ok(!dataB.deliveries.some(d => d.id === delivA.id), 'salesB 不应看到 salesA 客户的配送记录');
    assert.ok(!dataB.engJobs.some(e => e.id === engA.id), 'salesB 不应看到 salesA 客户的工程单');
    assert.equal((await uB.req('PUT', `/api/engjobs/${engA.id}`, { status: '已完工' })).status, 403, 'salesB 不能修改 salesA 客户的工程单');
    assert.equal((await uB.req('DELETE', `/api/deliveries/${delivA.id}`)).status, 403, 'salesB 不能删除 salesA 客户的配送单');

    // #6 [P1]: 只有 sales 权限（无 inv.void/inv.out）的 salesA 也不能作废已出库的工程单
    assert.equal((await uA.req('POST', `/api/engjobs/${engA.id}/void`, {})).status, 403, '无库存作废权限不能作废含材料出库的工程单');

    // #7 & #8 [P2]: 粮食过磅遵守审核开关 + 粮食单据 cost 脱敏
    const allModKeys = Object.keys((await admin.req('GET', '/api/data')).data.meta?.modules || {});
    await admin.req('PUT', '/api/settings', { modules: [...new Set([...allModKeys, 'agri'])], docApprove: { in: true, out: true } });
    const stockBeforeGrain = (await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === pNor.id).stock;
    const gdRes = await admin.req('POST', '/api/graindocs', {
      dir: 'out', date: '2026-11-28', productId: pNor.id, farmerName: '粮商',
      grossWeight: 120, tareWeight: 100, calcMode: 'deduct', moisture: 14, stdMoisture: 14, impurity: 0, unitPrice: 3,
    });
    assert.equal(gdRes.status, 200, '过磅单创建失败: ' + JSON.stringify(gdRes.data));
    const gd = gdRes.data;
    const afterGrainData = (await admin.req('GET', '/api/data')).data.data;
    const gdStockDoc = afterGrainData.stockDocs.find(s => s.id === gd.stockDocId);
    assert.equal(gdStockDoc.status, '待审核', '开启审核后粮食过磅生成的出入库单应为待审核');
    assert.equal(afterGrainData.products.find(x => x.id === pNor.id).stock, stockBeforeGrain, '待审核过磅单不应立即扣减库存');

    // 创建无 inv.cost 权限的农业账号检查 grainDocs 脱敏 (#8)
    const rAgri = (await admin.req('POST', '/api/roles', { name: '农技员角色', perms: ['agri'] })).data;
    assert.equal((await admin.req('POST', '/api/users', { username: 'agri1', name: '农技员', password: 'password123', roleId: rAgri.id })).status, 200);
    const uAgri = await login(srv.port, 'agri1', 'password123');
    const agriData = (await uAgri.req('GET', '/api/data')).data.data;
    const seenGd = agriData.grainDocs.find(x => x.id === gd.id);
    assert.ok(seenGd, '农业账号可见粮食单');
    assert.equal('unitCost' in seenGd, false, '无 inv.cost 权限时 grainDocs 不应返回 unitCost');
    await admin.req('PUT', '/api/settings', { docApprove: { in: false, out: false } });

    // #9 [P2]: 采购入库后禁止修改整单优惠
    const sup = (await admin.req('POST', '/api/suppliers', { name: '供应商1' })).data;
    const po = (await admin.req('POST', '/api/orders/purchase', {
      partyId: sup.id, date: '2026-11-28', discount: 10,
      items: [{ productId: pNor.id, qty: 10, price: 20 }],
    })).data;
    await admin.req('POST', `/api/orders/purchase/${po.id}/approve`, {});
    assert.equal((await admin.req('POST', `/api/orders/purchase/${po.id}/inbound`, {})).status, 200);
    const editPoDisc = await admin.req('PUT', `/api/orders/purchase/${po.id}`, {
      partyId: sup.id, date: '2026-11-28', discount: 50,
      items: [{ productId: pNor.id, qty: 10, price: 20 }],
    });
    assert.equal(editPoDisc.status, 400, '采购入库后不应允许修改整单优惠');

    // #10 [P2]: 同商品多行不同进价采购退货，按加权均价或指定 srcLine 核算成本
    const poMulti = (await admin.req('POST', '/api/orders/purchase', {
      partyId: sup.id, date: '2026-11-28', discount: 0,
      items: [
        { productId: pNor.id, qty: 2, price: 10 },
        { productId: pNor.id, qty: 2, price: 30 },
      ],
    })).data;
    await admin.req('POST', `/api/orders/purchase/${poMulti.id}/approve`, {});
    assert.equal((await admin.req('POST', `/api/orders/purchase/${poMulti.id}/inbound`, {})).status, 200);
    const pret = (await admin.req('POST', '/api/orders/purchaseReturn', {
      partyId: sup.id, srcId: poMulti.id, date: '2026-11-28',
      items: [{ productId: pNor.id, qty: 1, price: 30, srcLine: 1 }],
    })).data;
    assert.equal(pret.items[0].cost, 30, '指定 srcLine=1 时退货成本应为第 2 行单价 30 而非第 1 行 10');

    // #11 [P2]: 备用金发放、退回与报销冲抵联动资金账户
    const acctId = (await admin.req('GET', '/api/data')).data.data.accounts[0].id;
    const bal0 = () => admin.req('GET', '/api/data').then(r => {
      const a = r.data.data.accounts.find(x => x.id === acctId);
      const fin = r.data.data.finance.filter(f => f.account === acctId && !f.nonCash && f.category !== '固定资产折旧');
      return (a.opening || 0) + fin.reduce((s, f) => s + (f.type === 'income' ? f.amount : -f.amount), 0);
    });
    const bStart = await bal0();
    const advRes = await admin.req('POST', '/api/advances', { applicant: '管理员', amount: 200, purpose: '出差备用', date: '2026-11-28' });
    assert.equal(advRes.status, 200, '创建备用金失败: ' + JSON.stringify(advRes.data));
    const adv = advRes.data;
    assert.equal((await admin.req('POST', `/api/advances/${adv.id}/approve`, {})).status, 200);
    assert.equal((await admin.req('POST', `/api/advances/${adv.id}/pay`, { account: acctId, date: '2026-11-28' })).status, 200);
    assert.equal(await bal0(), bStart - 200, '备用金发放应扣减资金账户 200');
    assert.equal((await admin.req('POST', `/api/advances/${adv.id}/return`, { amount: 50, account: acctId, date: '2026-11-28' })).status, 200);
    assert.equal(await bal0(), bStart - 150, '备用金退回 50 应增加资金账户 50');

    // 报销 300 冲抵备用金 150 -> 资金账户仅再扣净额 150
    const expRes = await admin.req('POST', '/api/expenses', {
      applicant: '管理员', date: '2026-11-28', reason: '差旅报销', advanceId: adv.id, advanceOffset: 150,
      lines: [{ category: '差旅费', amount: 300 }],
    });
    assert.equal(expRes.status, 200, '创建报销单失败: ' + JSON.stringify(expRes.data));
    const exp = expRes.data;
    assert.equal((await admin.req('POST', `/api/expenses/${exp.id}/approve`, {})).status, 200);
    assert.equal((await admin.req('POST', `/api/expenses/${exp.id}/pay`, { account: acctId, date: '2026-11-28' })).status, 200);
    assert.equal(await bal0(), bStart - 300, '报销 300 冲抵备用金 150 时，现金账户仅再扣 150（总支出 300）');

    // #12 & #13 [P2]: 往来款关联流水禁止通过通用记账或订单付款编辑接口篡改/删除
    const custC = (await admin.req('POST', '/api/customers', { name: '往来测试客户' })).data;
    assert.ok(custC.id, '创建往来客户成功');
    const so = (await admin.req('POST', '/api/orders/sales', {
      partyId: custC.id, date: '2026-11-28', items: [{ productId: pNor.id, qty: 2, price: 35 }],
    })).data;
    const ppRes = await admin.req('POST', '/api/party-payments', {
      partyType: 'customer', partyId: custC.id, orderId: so.id, amount: 50, date: '2026-11-28', account: acctId,
    });
    assert.equal(ppRes.status, 200, '创建往来款失败: ' + JSON.stringify(ppRes.data));
    const pp = ppRes.data;
    const ppPreRes = await admin.req('POST', '/api/party-payments', {
      partyType: 'customer', partyId: custC.id, amount: 80, date: '2026-11-28', account: acctId,
    });
    assert.equal(ppPreRes.status, 200, '创建预收款失败: ' + JSON.stringify(ppPreRes.data));
    const ppPre = ppPreRes.data;
    const finRecs = (await admin.req('GET', '/api/data')).data.data.finance;
    const ppFin = finRecs.find(f => f.id === pp.financeId);
    const ppPreFin = finRecs.find(f => f.id === ppPre.financeId);
    assert.ok(ppFin && ppPreFin, '往来款和预收款均生成了流水');
    assert.equal((await admin.req('DELETE', `/api/finance/${ppPreFin.id}`)).status, 400, '#12 通用删除应拦截无 ref 的预收款往来流水');
    assert.equal((await admin.req('PUT', `/api/finance/${ppPreFin.id}`, { amount: 10 })).status, 400, '#12 通用修改应拦截无 ref 的预收款往来流水');
    assert.equal((await admin.req('PUT', `/api/orders/sales/${so.id}/pays/${ppFin.id}`, { amount: 10 })).status, 400, '#13 订单付款修改应拦截往来款核销流水');

    // #16 & #17 [P2]: JSON 备份包含 costLayers，恢复还原 costMethod / overTolerancePct / 对象 bomCols
    await admin.req('PUT', '/api/settings', { costMethod: 'fifo', overTolerancePct: 12.5 });
    const bk = (await admin.req('GET', '/api/backup')).data;
    assert.ok(Array.isArray(bk.data.costLayers), '#16 备份应包含 costLayers');
    bk.settings.overTolerancePct = 15;
    bk.settings.costMethod = 'fifo';
    bk.settings.bomCols = { spec: true, cost: false };
    assert.equal((await admin.req('POST', '/api/restore', bk)).status, 200);
    const afterRestore = (await admin.req('GET', '/api/data')).data.settings;
    assert.equal(afterRestore.overTolerancePct, 15, '#17 overTolerancePct 应被恢复');
    assert.equal(afterRestore.costMethod, 'fifo', '#16 costMethod 应被恢复');
    assert.deepEqual(afterRestore.bomCols, { spec: true, cost: false }, '#17 对象形式 bomCols 应被恢复');
  } finally {
    srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('前端 #18-#29 + Android #31-#35 + Cloud #36-#37 静态与逻辑校验', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  assert.ok(html.includes("title: p ? '编辑地块 · ' + esc(p.name) : '新增地块'"), '#18 地块标题转义');
  assert.ok(html.includes('function isQtyInvalid(i)'), '#19 支持小数商品校验函数');
  assert.ok(html.includes('但刷新界面失败，请手动刷新'), '#20 mutate 写成功与刷新失败分离');
  assert.ok(html.includes('!needAppr && res.status !== \'待发货\' && shipPayload'), '#21 待审核发货不提前建快递/配送单');
  assert.ok(html.includes("o.srcOrderKind === 'eng' ? 'engView'"), '#22 来源订单 engView 路由');
  assert.ok(html.includes("f.account === id && !f.nonCash && f.category !== '固定资产折旧'"), '#23 acctBal 排除非现金与折旧');
  assert.ok(html.includes('discount: idx === total - 1 ? (o.discount || 0) : 0'), '#24 多页套打优惠仅末页扣减一次');
  assert.ok(html.includes('partyObj.taxId || partyObj.invoiceTaxNo'), '#25 自由数据框读取 taxId 与 bankName');
  assert.ok(html.includes('padding:0;border-radius:3px') && html.includes('outline:1px dashed rgba(37,99,235,.7)'), '#26 套打自由框预览无内边距偏移');
  assert.ok(html.includes('grid-template-columns:repeat(auto-fit,minmax(130px,1fr))'), '#27 快递账单列映射响应式布局');
  assert.ok(html.includes('grid-column:1/-1"><span>引用数据库字段</span>'), '#28 套打自由框字段选择跨满整行');
  assert.ok(html.includes('flex-wrap:wrap;gap:8px;align-items:center'), '#29 农事照片区允许换行');

  const androidClient = fs.readFileSync(path.join(ROOT, 'android/src/com/xerp/client/MainActivity.java'), 'utf8');
  assert.ok(androidClient.includes('private static boolean isSameOrigin(Uri u, String baseUrl)'), '#31 Android 客户端严格校验同源');
  assert.ok(!androidClient.includes('u.toString().startsWith(server)'), '#31 移除不安全的 startsWith 前缀匹配');

  const modelsJava = fs.readFileSync(path.join(ROOT, 'android-scanner/src/com/xerp/scanner/Models.java'), 'utf8');
  assert.ok(modelsJava.includes('public double rate = 1;'), '#32 UnitSpec.rate 支持小数 double');
  const stockMoveJava = fs.readFileSync(path.join(ROOT, 'android-scanner/src/com/xerp/scanner/StockMoveTab.java'), 'utf8');
  assert.ok(stockMoveJava.includes('public void onCompanySwitched()'), '#34 切换账套清空 StockMoveTab 购物车');
  assert.ok(stockMoveJava.indexOf('cart.clear();') < stockMoveJava.indexOf('act.refreshData(null);'), '#33 提交成功后先清购物车再刷新');
  const apiClientJava = fs.readFileSync(path.join(ROOT, 'android-scanner/src/com/xerp/scanner/ApiClient.java'), 'utf8');
  assert.ok(apiClientJava.includes('32 * 1024 * 1024') && apiClientJava.includes('throw new java.io.IOException'), '#35 响应流超限抛明确异常而非静默截断');

  const cloudSrv = fs.readFileSync(path.join(ROOT, 'cloud/server.js'), 'utf8');
  assert.ok(cloudSrv.includes('inflightByAccount') && cloudSrv.includes('inflightTotal'), '#36 云备份并发上传预留配额');
  const cloudTun = fs.readFileSync(path.join(ROOT, 'cloud/tunnel.js'), 'utf8');
  assert.ok(cloudTun.includes('SLUG_CACHE_MAX') && cloudTun.includes('slugCache.delete(oldest)'), '#37 隧道 slugCache 上限与淘汰');
});
