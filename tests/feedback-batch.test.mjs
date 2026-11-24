// 用户反馈 #124–#135 综合回归测试：覆盖全部 12 项修复与新功能
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-fb12-'));
const PORT = 24000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const TD = localToday();

let srv, fbSrv, fbPort, admin, acctId, wh1Id, wh2Id;
const fbPosted = [];
const fbStore = [];

async function call(token, method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ...(Array.isArray(j) ? { list: j } : j), http: r.status };
}
async function ok(token, method, url, body) {
  const r = await call(token, method, url, body);
  assert.equal(r.http, 200, `${method} ${url} → ${r.http} ${r.error || ''}`);
  return r;
}
const login = async (username, password) => (await ok(null, 'POST', '/api/login', { username, password })).token;

before(async () => {
  fbSrv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const b = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/mine') return res.end(JSON.stringify(fbStore));
      const fid = fbStore.length + 1;
      fbPosted.push(b);
      const imgs = Array.isArray(b.images) && b.images.length ? b.images : (b.image ? [b.image] : []);
      fbStore.push({ fid, reply: '收到反馈', replied: TD + ' 10:00', public: false, image: imgs[0] || '', images: imgs });
      res.end(JSON.stringify({ fid }));
    });
  });
  await new Promise(resolve => fbSrv.listen(0, '127.0.0.1', () => { fbPort = fbSrv.address().port; resolve(); }));

  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XERP_PLAT: 'win32', XERP_STATS_URL: '', XERP_FEEDBACK_URL: `http://127.0.0.1:${fbPort}`, XERP_CLOUD_URL: '' },
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/ping'); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  admin = await login('admin', 'admin123');
  await ok(admin, 'PUT', '/api/settings', {
    modules: ['inventory', 'products', 'bom', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'hr', 'reports', 'agri'],
  });
  const initData = await ok(admin, 'GET', '/api/data');
  acctId = initData.data.accounts[0].id;
  wh1Id = initData.meta.defaultWh;
  const wh2 = await ok(admin, 'POST', '/api/warehouses', { name: '二号粮仓' });
  wh2Id = wh2.id;
});

after(() => {
  srv && srv.kill();
  fbSrv && fbSrv.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
});

test('#133 出入库待审核/已驳回单据可修改与删除；作废单据与作废冲回标记 voided 并从前端统计排除', async () => {
  const prod = await ok(admin, 'POST', '/api/products', { sku: 'T133-1', name: '测试螺母', unit: '个', cost: 2, price: 5, stock: 10 });

  // 开启入库审核
  await ok(admin, 'PUT', '/api/settings', { docApprove: { in: true, out: false } });
  const pend = await ok(admin, 'POST', '/api/stockdocs', {
    dir: 'in', type: '采购入库', date: TD, wh: wh1Id, party: '测试供货',
    items: [{ productId: prod.id, qty: 20, price: 3 }],
  });
  assert.equal(pend.status, '待审核');

  // 修改待审核入库单（20 -> 35）
  const edited = await ok(admin, 'PUT', `/api/stockdocs/${pend.id}`, {
    dir: 'in', type: '其他入库', date: TD, wh: wh1Id, party: '修改供货商', remark: '改单测试',
    items: [{ productId: prod.id, qty: 35, price: 4 }],
  });
  assert.equal(edited.status, '待审核');
  assert.equal(edited.type, '其他入库');
  assert.equal(edited.items[0].qty, 35);

  // 驳回后再次修改并删除
  await ok(admin, 'POST', `/api/stockdocs/${pend.id}/reject`, { reason: '数量不对' });
  const reEdited = await ok(admin, 'PUT', `/api/stockdocs/${pend.id}`, {
    dir: 'in', type: '其他入库', date: TD, wh: wh1Id, party: '重新提交',
    items: [{ productId: prod.id, qty: 15, price: 4 }],
  });
  assert.equal(reEdited.status, '待审核');
  await ok(admin, 'DELETE', `/api/stockdocs/${pend.id}`);
  assert.equal((await ok(admin, 'GET', '/api/data')).data.stockDocs.some(x => x.id === pend.id), false);

  // 关闭审核，建正常入库单与调拨单并作废，验证 stockLogs 带 voided: true
  await ok(admin, 'PUT', '/api/settings', { docApprove: { in: false, out: false } });
  const normalIn = await ok(admin, 'POST', '/api/stockdocs', {
    dir: 'in', type: '其他入库', date: TD, wh: wh1Id,
    items: [{ productId: prod.id, qty: 50, price: 2 }],
  });
  await ok(admin, 'POST', `/api/stockdocs/${normalIn.id}/void`, { reason: '录错了' });

  const tr = await ok(admin, 'POST', '/api/transfers', {
    from: wh1Id, to: wh2Id, date: TD, items: [{ productId: prod.id, qty: 5 }],
  });
  await ok(admin, 'POST', `/api/transfers/${tr.id}/void`, { reason: '撤销调拨' });

  const d1 = await ok(admin, 'GET', '/api/data');
  const logsIn = d1.data.stockLogs.filter(l => l.ref === normalIn.no);
  const logsTr = d1.data.stockLogs.filter(l => l.ref === tr.no);
  assert.equal(logsIn.length, 2);
  assert.ok(logsIn.every(l => l.voided === true), '入库原流水和作废冲回流水都应标记 voided: true');
  assert.equal(logsTr.length, 4);
  assert.ok(logsTr.every(l => l.voided === true), '调拨流水和作废冲回流水都应标记 voided: true');

  // 删除已作废单据会清理对应冲回流水
  await ok(admin, 'DELETE', `/api/stockdocs/${normalIn.id}`);
  const d2 = await ok(admin, 'GET', '/api/data');
  assert.equal(d2.data.stockDocs.some(x => x.id === normalIn.id), false);

  // 提取前端 __VOID_LOG_CORE__ 验证新旧作废记录都会被过滤
  const s = html.indexOf('/* __VOID_LOG_CORE_START__ */'), e = html.indexOf('/* __VOID_LOG_CORE_END__ */');
  assert.ok(s > 0 && e > s);
  const ctx = vm.createContext({ db: { stockDocs: [{ no: 'RK_OLD_VOID', status: '已作废' }], transferDocs: [], grainDocs: [] } });
  vm.runInContext(html.slice(s, e), ctx);
  assert.equal(ctx.isVoidedLog({ kind: '其他入库', ref: 'RK_OLD_VOID' }), true, '无 voided 标记但关联单号已作废的历史流水也应排除');
  assert.equal(ctx.isVoidedLog({ kind: '作废冲回', ref: 'ANY' }), true);
  assert.equal(ctx.isVoidedLog({ kind: '其他入库', ref: 'RK_OK' }), false);
});

test('#127 销售退货与采购退货审核后同步生成仓库出入库单；未退款作废仓库单退回原退货单，已退款禁止作废', async () => {
  const p = await ok(admin, 'POST', '/api/products', { sku: 'T127-1', name: '退货同步商品', unit: '箱', cost: 10, price: 20, stock: 30 });
  const cu = await ok(admin, 'POST', '/api/customers', { name: '退货客户A' });
  const su = await ok(admin, 'POST', '/api/suppliers', { name: '退货供应商A' });

  // 创建只有 inv.view 权限（无 inv.others）的普通仓管员角色
  const rWhView = await ok(admin, 'POST', '/api/roles', { name: '仓管查看员127', perms: ['inv.view'] });
  await ok(admin, 'POST', '/api/users', { username: 'wh127', name: '仓管127', roleId: rWhView.id, password: 'test123456' });
  const whTok = await login('wh127', 'test123456');

  // 销售发货 10 -> 销售退货 4 -> 审核入库
  const so = await ok(admin, 'POST', '/api/orders/sales', { partyId: cu.id, date: TD, items: [{ productId: p.id, qty: 10, price: 20 }] });
  await ok(admin, 'POST', `/api/orders/sales/${so.id}/ship`, { wh: wh1Id, items: [{ line: 0, productId: p.id, qty: 10 }] });
  const sr = await ok(admin, 'POST', '/api/orders/salesReturn', { partyId: cu.id, srcId: so.id, date: TD, items: [{ productId: p.id, qty: 4, price: 20 }] });
  const srPosted = await ok(admin, 'POST', `/api/orders/salesReturn/${sr.id}/post`, { wh: wh1Id, note: '验收完好退货' });
  assert.ok(srPosted.stockDocId && srPosted.stockDocNo, '销售退货审核后应关联生成入库单');

  const whData = await ok(whTok, 'GET', '/api/data');
  const linkedIn = whData.data.stockDocs.find(d => d.id === srPosted.stockDocId);
  assert.ok(linkedIn, '仓库人员应能在出入库单里看到销售退货生成的入库单');
  assert.equal(linkedIn.type, '销售退货');
  assert.equal(linkedIn.dir, 'in');

  // 从仓库作废未退款的退货入库单 -> 退货单回到待入库，库存扣回
  await ok(admin, 'POST', `/api/stockdocs/${linkedIn.id}/void`, { reason: '退货清点不符' });
  const afterVoid = await ok(admin, 'GET', '/api/data');
  assert.equal(afterVoid.data.salesReturns.find(x => x.id === sr.id).status, '待入库');
  assert.equal(afterVoid.data.products.find(x => x.id === p.id).stock, 20);

  // 重新入库并退款 -> 再作废仓库入库单应拒绝
  const srRePosted = await ok(admin, 'POST', `/api/orders/salesReturn/${sr.id}/post`, { wh: wh1Id, note: '复核入库' });
  await ok(admin, 'POST', `/api/orders/salesReturn/${sr.id}/pay`, { amount: 80, date: TD, account: acctId });
  const blockVoid = await call(admin, 'POST', `/api/stockdocs/${srRePosted.stockDocId}/void`, { reason: '尝试强行作废' });
  assert.equal(blockVoid.http, 400);

  // 采购入库 10 -> 采购退货 3 -> 审核出库
  const po = await ok(admin, 'POST', '/api/orders/purchase', { partyId: su.id, date: TD, items: [{ productId: p.id, qty: 10, price: 10 }] });
  await ok(admin, 'POST', `/api/orders/purchase/${po.id}/approve`, {});
  await ok(admin, 'POST', `/api/orders/purchase/${po.id}/inbound`, { wh: wh1Id, items: [{ line: 0, productId: p.id, qty: 10 }] });
  const pr = await ok(admin, 'POST', '/api/orders/purchaseReturn', { partyId: su.id, srcId: po.id, date: TD, items: [{ productId: p.id, qty: 3, price: 10 }] });
  const prPosted = await ok(admin, 'POST', `/api/orders/purchaseReturn/${pr.id}/post`, { wh: wh1Id, note: '采购退回出库' });
  const adminData = await ok(admin, 'GET', '/api/data');
  const linkedOut = adminData.data.stockDocs.find(d => d.id === prPosted.stockDocId);
  assert.ok(linkedOut && linkedOut.dir === 'out' && linkedOut.type === '采购退货');
});

test('#132 采购/销售超量容差设置与提前「完成发货/完成收货」', async () => {
  const p = await ok(admin, 'POST', '/api/products', { sku: 'T132-1', name: '容差测试米', unit: '斤', cost: 2, price: 4, stock: 100 });
  const cu = await ok(admin, 'POST', '/api/customers', { name: '容差客户' });
  const su = await ok(admin, 'POST', '/api/suppliers', { name: '容差供应商' });

  await ok(admin, 'PUT', '/api/settings', { overTolerancePct: 20 });

  // 采购 100 斤：入库 115（超 15%，在 20% 容差内）应允许，且状态进入已入库
  const po1 = await ok(admin, 'POST', '/api/orders/purchase', { partyId: su.id, date: TD, items: [{ productId: p.id, qty: 100, price: 2 }] });
  await ok(admin, 'POST', `/api/orders/purchase/${po1.id}/approve`, {});
  const in1 = await ok(admin, 'POST', `/api/orders/purchase/${po1.id}/inbound`, { wh: wh1Id, allowOver: true, items: [{ line: 0, productId: p.id, qty: 115 }] });
  assert.equal(in1.status, '已入库');

  // 采购 100 斤：入库 125（超 25%，超过 20% 容差）应被拒绝
  const po2 = await ok(admin, 'POST', '/api/orders/purchase', { partyId: su.id, date: TD, items: [{ productId: p.id, qty: 100, price: 2 }] });
  await ok(admin, 'POST', `/api/orders/purchase/${po2.id}/approve`, {});
  const tooMuch = await call(admin, 'POST', `/api/orders/purchase/${po2.id}/inbound`, { wh: wh1Id, allowOver: true, items: [{ line: 0, productId: p.id, qty: 125 }] });
  assert.equal(tooMuch.http, 400);

  // 销售 50 斤：实发 42 斤后点「完成发货」（syncQty: true） -> 订单按 42 斤结算并标记 earlyClosed
  const so = await ok(admin, 'POST', '/api/orders/sales', { partyId: cu.id, date: TD, items: [{ productId: p.id, qty: 50, price: 4 }] });
  await ok(admin, 'POST', `/api/orders/sales/${so.id}/ship`, { wh: wh1Id, items: [{ line: 0, productId: p.id, qty: 42 }] });
  const closedSo = await ok(admin, 'POST', `/api/orders/sales/${so.id}/finish-fulfill`, { syncQty: true });
  assert.equal(closedSo.status, '已发货');
  assert.equal(closedSo.earlyClosed, true);
  assert.equal(closedSo.items[0].qty, 42);
  assert.equal((await call(admin, 'POST', `/api/orders/sales/${so.id}/pay`, { amount: 169, date: TD, account: acctId })).http, 400);
  await ok(admin, 'POST', `/api/orders/sales/${so.id}/pay`, { amount: 168, date: TD, account: acctId });

  // 采购 po2：实收 80 斤后「完成收货」（syncQty: false） -> 保留原数量 100，状态已入库
  await ok(admin, 'POST', `/api/orders/purchase/${po2.id}/inbound`, { wh: wh1Id, items: [{ line: 0, productId: p.id, qty: 80 }] });
  const closedPo = await ok(admin, 'POST', `/api/orders/purchase/${po2.id}/finish-fulfill`, { syncQty: false });
  assert.equal(closedPo.status, '已入库');
  assert.equal(closedPo.earlyClosed, true);
  assert.equal(closedPo.items[0].qty, 100);
});

test('#131 发票管理 CRUD、税额自动换算与作废前防删除校验', async () => {
  const cu = await ok(admin, 'POST', '/api/customers', { name: '开票客户公司' });
  const p = await ok(admin, 'POST', '/api/products', { sku: 'T131-1', name: '发票商品', unit: '套', cost: 50, price: 113, stock: 10 });
  const so = await ok(admin, 'POST', '/api/orders/sales', { partyId: cu.id, date: TD, items: [{ productId: p.id, qty: 1, price: 113 }] });

  const inv = await ok(admin, 'POST', '/api/invoices', {
    dir: 'out', invType: '增值税专用发票', invNo: '88001122', date: TD,
    partyId: cu.id, orderKind: 'sales', orderId: so.id,
    amount: 113, taxRate: 13, status: '已开具', title: '设备一套',
  });
  assert.equal(inv.netAmount, 100);
  assert.equal(inv.taxAmount, 13);
  assert.equal(inv.orderNo, so.no);

  // 已开具发票禁止直接删除
  const delFail = await call(admin, 'DELETE', `/api/invoices/${inv.id}`);
  assert.equal(delFail.http, 400);

  // 作废后再删除
  const voided = await ok(admin, 'PUT', `/api/invoices/${inv.id}`, { ...inv, status: '已作废' });
  assert.equal(voided.status, '已作废');
  await ok(admin, 'DELETE', `/api/invoices/${inv.id}`);
  const d = await ok(admin, 'GET', '/api/data');
  assert.equal(d.data.invoices.some(x => x.id === inv.id), false);
});

test('#128 & #130 业务员客户隔离与统计报表个人数据隔离（不暴露公司经营支出/采购成本/他人业绩）', async () => {
  await ok(admin, 'POST', '/api/users', { username: 'sales_a', name: '业务员甲', roleId: 'r_sales', password: 'test123456' });
  await ok(admin, 'POST', '/api/users', { username: 'sales_b', name: '业务员乙', roleId: 'r_sales', password: 'test123456' });
  const tokA = await login('sales_a', 'test123456');
  const tokB = await login('sales_b', 'test123456');

  const p = await ok(admin, 'POST', '/api/products', { sku: 'T128-1', name: '通用试剂', unit: '瓶', cost: 40, price: 100, stock: 50 });
  const sup = await ok(admin, 'POST', '/api/suppliers', { name: '保密原料商' });
  const po = await ok(admin, 'POST', '/api/orders/purchase', { partyId: sup.id, date: TD, items: [{ productId: p.id, qty: 10, price: 40 }] });
  await ok(admin, 'POST', '/api/finance', { type: 'expense', category: '房租', amount: 8888, date: TD, account: acctId, note: '公司机密租金' });

  // 甲建客户与销售单并收款
  const custA = await ok(tokA, 'POST', '/api/customers', { name: '甲的专属客户' });
  const custB = await ok(tokB, 'POST', '/api/customers', { name: '乙的专属客户' });
  const soA = await ok(tokA, 'POST', '/api/orders/sales', { partyId: custA.id, date: TD, items: [{ productId: p.id, qty: 2, price: 100 }] });
  await ok(tokA, 'POST', `/api/orders/sales/${soA.id}/pay`, { amount: 200, date: TD, account: acctId });

  // 乙看不到甲的客户和订单，且修改/删/跟进/下单均 403
  const dataB = await ok(tokB, 'GET', '/api/data');
  assert.equal(dataB.data.customers.some(c => c.id === custA.id), false);
  assert.equal(dataB.data.sales.some(o => o.id === soA.id), false);
  assert.equal((await call(tokB, 'PUT', `/api/customers/${custA.id}`, { name: '篡改' })).http, 403);
  assert.equal((await call(tokB, 'DELETE', `/api/customers/${custA.id}`)).http, 403);
  assert.equal((await call(tokB, 'POST', `/api/customers/${custA.id}/followups`, { text: '撬单' })).http, 403);
  assert.equal((await call(tokB, 'POST', '/api/orders/sales', { partyId: custA.id, date: TD, items: [{ productId: p.id, qty: 1, price: 100 }] })).http, 403);

  // #130 甲看 /api/data 时看不到采购单、看不到公司房租支出、看不到乙的数据，只能看自己的销售额与收款
  const dataA = await ok(tokA, 'GET', '/api/data');
  assert.equal(dataA.data.purchases.length, 0, '无采购权限且无全部报表权限时不应返回公司采购单');
  assert.equal(dataA.data.finance.some(f => f.category === '房租'), false, '业务员不应收到公司经营支出');
  assert.ok(dataA.data.finance.some(f => f.ref === soA.no && f.amount === 200), '业务员应能看到自己的销售收款');

  // 管理员可改派客户负责人给乙 -> 乙即可看到该客户
  await ok(admin, 'PUT', `/api/customers/${custA.id}`, { name: '甲的专属客户', ownerId: dataB.user.id });
  const dataB2 = await ok(tokB, 'GET', '/api/data');
  assert.equal(dataB2.data.customers.some(c => c.id === custA.id), true);
  assert.equal(dataB2.data.sales.some(o => o.id === soA.id), true);
});

test('#129 人事管理新增员工可联动开登录账号及自定义角色，删用户自动解绑员工', async () => {
  // 1) 使用预置角色联动开号
  const emp1 = await ok(admin, 'POST', '/api/employees', {
    name: '新员工一', phone: '13800001111', dept: '销售部', position: '顾问',
    account: { create: true, username: 'emp_one', password: 'pwd123456', roleId: 'r_sales' },
  });
  assert.ok(emp1.userId && emp1.username === 'emp_one');
  const tok1 = await login('emp_one', 'pwd123456');
  assert.equal((await ok(tok1, 'GET', '/api/data')).user.name, '新员工一');

  // 2) 创建员工同时新建自定义角色
  const emp2 = await ok(admin, 'POST', '/api/employees', {
    name: '农资收粮员', dept: '收购站', position: '司磅员',
    account: {
      create: true, username: 'emp_agri', password: 'pwd123456', roleId: '__new__',
      newRole: { name: '司磅收粮角色', descr: '仅操作粮食收购', perms: ['prod.view', 'agri'] },
    },
  });
  assert.ok(emp2.userId);
  const tok2 = await login('emp_agri', 'pwd123456');
  const d2 = await ok(tok2, 'GET', '/api/data');
  assert.deepEqual(d2.user.perms.sort(), ['agri', 'prod.view']);

  // 删除账号后员工档案自动解绑 userId / username
  await ok(admin, 'DELETE', `/api/users/${emp2.userId}`);
  const afterDel = await ok(admin, 'GET', '/api/data');
  const e2Rec = afterDel.data.employees.find(e => e.id === emp2.id);
  assert.ok(e2Rec && !e2Rec.userId && !e2Rec.username);
});

test('#124 & #125 多图反馈（最多 4 张）发送、校验与回复同步', async () => {
  const tinypng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const tooMany = await call(admin, 'POST', '/api/feedback', { text: '5张超限测试', images: [tinypng, tinypng, tinypng, tinypng, tinypng] });
  assert.equal(tooMany.http, 400);

  fbPosted.length = 0;
  await ok(admin, 'POST', '/api/feedback', { text: '支持多图反馈测试', nick: '测试员', images: [tinypng, tinypng] });
  assert.equal(fbPosted.length, 1);
  assert.equal(fbPosted[0].images.length, 2);
  assert.equal(fbPosted[0].image, tinypng);

  const got = await ok(admin, 'GET', '/api/feedback');
  const latest = got.list[0];
  assert.equal(latest.images.length, 2);
  assert.equal(latest.reply, '收到反馈');
});

test('#134 农资/农药二维码解析（JSON / 中文键值对 / PD登记证号 / 32位追溯码URL / 普通条码不误判）', () => {
  const s = html.indexOf('/* __AGRI_QR_CORE_START__ */'), e = html.indexOf('/* __AGRI_QR_CORE_END__ */');
  assert.ok(s > 0 && e > s);
  const ctx = vm.createContext({});
  vm.runInContext(html.slice(s, e), ctx);

  const rJson = ctx.parseAgriQr('{"name":"草甘膦水剂","spec":"1L*12瓶","batchNo":"BN2026","prodDate":"2026/1/5","expDate":"2028.1.4","regNo":"pd20201234","manufacturer":"绿丰农化"}');
  assert.equal(rJson.matched, true);
  assert.equal(rJson.name, '草甘膦水剂');
  assert.equal(rJson.prodDate, '2026-01-05');
  assert.equal(rJson.expDate, '2028-01-04');
  assert.equal(rJson.regNo, 'PD20201234');

  const rKv = ctx.parseAgriQr('品名：阿维菌素\n规格：500ml\n批号：A998\n生产日期：2026年03月08日\n农药登记证号：PD20190001\n生产厂家：北方生物');
  assert.equal(rKv.name, '阿维菌素');
  assert.equal(rKv.spec, '500ml');
  assert.equal(rKv.batchNo, 'A998');
  assert.equal(rKv.prodDate, '2026-03-08');
  assert.equal(rKv.regNo, 'PD20190001');
  assert.equal(rKv.manufacturer, '北方生物');

  const rTrace = ctx.parseAgriQr('https://www.nongyao.gov.cn/t?code=12345678901234567890123456789012');
  assert.equal(rTrace.matched, true);
  assert.equal(rTrace.traceCode, '12345678901234567890123456789012');
  assert.equal(rTrace.barcode, '12345678901234567890123456789012');

  const rPd = ctx.parseAgriQr('登记信息 PD20180099 合格');
  assert.equal(rPd.matched, true);
  assert.equal(rPd.regNo, 'PD20180099');

  assert.equal(ctx.parseAgriQr('6901234567890'), null);
});

test('#135 农业/粮食收购过磅、扣水扣杂、入库同步、农户分段结算与作废冲回', async () => {
  const corn = await ok(admin, 'POST', '/api/products', { sku: 'GRAIN-YM', name: '玉米', unit: '公斤', cost: 2.4, price: 2.8, stock: 0, dec: '1' });

  // 毛重 5000 - 皮重 1000 = 4000kg；水份 16% (超标准14% 计2%) + 杂质 1% = 扣3% (120kg) -> 净重 3880kg × ¥2.5 = ¥9700
  const gd = await ok(admin, 'POST', '/api/graindocs', {
    date: TD, wh: wh1Id, productId: corn.id,
    farmerName: '王大爷', farmerPhone: '13911112222', plateNo: '鲁A88990',
    grossWeight: 5000, tareWeight: 1000, moisture: 16, stdMoisture: 14, impurity: 1,
    unitPrice: 2.5, payNow: 3000, account: acctId,
  });
  assert.equal(gd.rawNet, 4000);
  assert.equal(gd.deductWeight, 120);
  assert.equal(gd.netWeight, 3880);
  assert.equal(gd.totalAmount, 9700);
  assert.equal(gd.paid, 3000);

  let snap = await ok(admin, 'GET', '/api/data');
  assert.equal(snap.data.products.find(x => x.id === corn.id).stock, 3880);
  const linkedDoc = snap.data.stockDocs.find(d => d.id === gd.stockDocId);
  assert.ok(linkedDoc && linkedDoc.type === '农产品收购' && linkedDoc.items[0].qty === 3880);
  assert.ok(snap.data.finance.some(f => f.ref === gd.no && f.category === '农产品收购' && f.amount === 3000));

  // 不能直接从库存管理作废收粮单关联入库单
  assert.equal((await call(admin, 'POST', `/api/stockdocs/${linkedDoc.id}/void`, { reason: '测试' })).http, 400);

  // 结算尾款 ¥6700 -> 有付款记录时不能作废收粮单 -> 删光付款后作废，库存归 0，关联入库单和流水均标记作废
  await ok(admin, 'POST', `/api/graindocs/${gd.id}/pay`, { amount: 6700, date: TD, account: acctId });
  assert.equal((await call(admin, 'POST', `/api/graindocs/${gd.id}/void`, { reason: '有付款' })).http, 400);

  snap = await ok(admin, 'GET', '/api/data');
  const pays = snap.data.finance.filter(f => f.ref === gd.no && f.category === '农产品收购');
  assert.equal(pays.length, 2);
  for (const pf of pays) await ok(admin, 'DELETE', `/api/graindocs/${gd.id}/pays/${pf.id}`);

  const voided = await ok(admin, 'POST', `/api/graindocs/${gd.id}/void`, { reason: '重过磅作废' });
  assert.equal(voided.status, '已作废');
  snap = await ok(admin, 'GET', '/api/data');
  assert.equal(snap.data.products.find(x => x.id === corn.id).stock, 0);
  assert.equal(snap.data.stockDocs.find(d => d.id === gd.stockDocId).status, '已作废');
  const gLogs = snap.data.stockLogs.filter(l => l.ref === gd.no);
  assert.equal(gLogs.length, 2);
  assert.ok(gLogs.every(l => l.voided === true));
});

test('#126 条码标签日期/操作员及前端页面关键元素校验', () => {
  for (const marker of ['lbShowDate', 'lbDateLabel', 'lbDate', 'lbShowOp', 'lbOp', 'docsShowVoid', 'logsShowVoid', 'invModal', 'pageAgri', 'empAccCreate', 'fbImgs', 'accept="image/*" multiple', 'parseAgriQr']) {
    assert.ok(html.includes(marker), `index.html 缺少关键功能标识: ${marker}`);
  }
});
