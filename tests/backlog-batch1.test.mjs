// 待办清单第一批回归测试：#142 客户开票资料、#145 反馈仅管理员、#151 默认密码提示、#153 删员工联动删账号、#154 删商品列引用单号
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-b1-'));
const PORT = 28000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, admin;

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
  assert.equal(r.http, 200, `${method} ${url} -> ${r.http} ${r.error || ''}`);
  return r;
}

before(async () => {
  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XERP_NO_DEMO: '1', XERP_STATS_URL: '', XERP_FEEDBACK_URL: '', XERP_CLOUD_URL: '' },
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/ping'); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  admin = (await ok(null, 'POST', '/api/login', { username: 'admin', password: 'admin123' })).token;
  await ok(admin, 'PUT', '/api/settings', { modules: ['inventory', 'products', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'reports', 'hr', 'shipping', 'agri'] });
});
after(() => { srv && srv.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });

test('#151 登录页默认密码提示：全新空库为 true，录入商品后自动变为 false', async () => {
  const p0 = await ok(null, 'GET', '/api/ping');
  assert.equal(p0.defaultPwd, true);
  await ok(admin, 'POST', '/api/products', { name: '初始化商品', unit: '个', cost: 5, price: 10 });
  const p1 = await ok(null, 'GET', '/api/ping');
  assert.equal(p1.defaultPwd, false);
});

test('#145 问题反馈接口仅管理员可访问，普通账号返回 403', async () => {
  const roles = (await ok(admin, 'GET', '/api/roles')).list;
  const staff = roles.find(r => r.id === 'r_staff') || roles[0];
  await ok(admin, 'POST', '/api/users', { username: 'normal1', name: '普通员', roleId: staff.id, password: 'user1234' });
  const tok = (await ok(null, 'POST', '/api/login', { username: 'normal1', password: 'user1234' })).token;
  assert.equal((await call(tok, 'GET', '/api/feedback')).http, 403);
  assert.equal((await call(tok, 'POST', '/api/feedback', { text: '普通人测试' })).http, 403);
  await ok(admin, 'GET', '/api/feedback');
});

test('#153 删除员工支持 ?delUser=1 同步删除关联登录账号并吊销会话', async () => {
  const roles = (await ok(admin, 'GET', '/api/roles')).list;
  const staff = roles.find(r => r.id === 'r_staff') || roles[0];
  const emp = await ok(admin, 'POST', '/api/employees', {
    name: '联动员工', dept: '销售部',
    account: { create: true, username: 'emp_sync1', password: 'emp12345', roleId: staff.id },
  });
  const empTok = (await ok(null, 'POST', '/api/login', { username: 'emp_sync1', password: 'emp12345' })).token;
  await ok(empTok, 'GET', '/api/data');
  await ok(admin, 'DELETE', `/api/employees/${emp.id}?delUser=1`);
  assert.equal((await call(empTok, 'GET', '/api/data')).http, 401);
  assert.equal((await call(null, 'POST', '/api/login', { username: 'emp_sync1', password: 'emp12345' })).http, 401);
});

test('#154 删除被引用商品时报错明确列出引用单据类型与单号', async () => {
  const p = await ok(admin, 'POST', '/api/products', { name: '被引用商品', unit: '个', cost: 10, price: 20 });
  const doc = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-26', wh: 'w1', items: [{ productId: p.id, qty: 5, price: 10 }] });
  const r = await call(admin, 'DELETE', `/api/products/${p.id}`);
  assert.equal(r.http, 400);
  assert.ok(r.error.includes(doc.no), `错误信息应包含单号 ${doc.no}，实际：${r.error}`);
  assert.match(r.error, /出入库单/);
});

test('#142 客户档案保存完整开票资料（抬头/税号/开户行/账号/注册地址/电话）', async () => {
  const c = await ok(admin, 'POST', '/api/customers', {
    name: '成都测试客户', contact: '李四', phone: '13800138000',
    invoiceTitle: '成都测试科技有限公司', taxId: '91510100MA61234567',
    bankName: '招商银行成都分行', bankAccount: '6225880100001234',
    regAddress: '成都市高新区天府大道 1 号', regPhone: '028-88886666',
  });
  const d = (await ok(admin, 'GET', '/api/data')).data;
  const saved = d.customers.find(x => x.id === c.id);
  assert.equal(saved.invoiceTitle, '成都测试科技有限公司');
  assert.equal(saved.taxId, '91510100MA61234567');
  assert.equal(saved.bankName, '招商银行成都分行');
  assert.equal(saved.bankAccount, '6225880100001234');
  assert.equal(saved.regAddress, '成都市高新区天府大道 1 号');
  assert.equal(saved.regPhone, '028-88886666');
});

test('#143 & #144 运单关联销售单优先带出订单收货地址、保存 customerId 与一票多件 subTracks', async () => {
  const c = await ok(admin, 'POST', '/api/customers', { name: '深圳物流客户', contact: '桂子', phone: '13900139000', address: '广东省深圳市福田区老地址1号' });
  const p = await ok(admin, 'POST', '/api/products', { name: '快递测试货', unit: '个', cost: 10, price: 30, weight: 1.5 });
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-26', wh: 'w1', items: [{ productId: p.id, qty: 10, price: 10 }] });
  const car = await ok(admin, 'POST', '/api/carriers', {
    name: '顺丰测试', enabled: true, zones: [{ name: '省内', provinces: ['广东', '浙江'], firstW: 1, firstFee: 10, nextW: 1, nextFee: 2 }],
  });
  // 销售单填写不同于客户档案的新收货地址（浙江省）
  const s = await ok(admin, 'POST', '/api/orders/sales', {
    partyId: c.id, date: '2026-11-26', address: '浙江省杭州市西湖区文三路90号',
    items: [{ productId: p.id, qty: 2, price: 30 }],
  });
  // 运费试算按来源销售单应优先使用订单地址（浙江），而不是客户档案地址（广东）
  const q = await ok(admin, 'POST', '/api/ship/quote', { srcType: 'sales', srcId: s.id });
  assert.equal(q.province, '浙江');
  assert.equal(q.address, '浙江省杭州市西湖区文三路90号');
  // 登记运单：带 customerId 和一票多件子单号（含重复和主单号，应自动清洗去重）
  const created = await ok(admin, 'POST', '/api/shipments', {
    carrierId: car.id, srcType: 'sales', srcId: s.id, customerId: c.id,
    subTracks: 'sf1001, sf1002, SF0001, sf1001',
    packages: [{ trackNo: 'SF0001', weight: 3 }],
  });
  const ship = created.list[0];
  assert.equal(ship.province, '浙江');
  assert.equal(ship.customerId, c.id);
  assert.deepEqual(ship.subTracks, ['SF1001', 'SF1002']);
});

test('#154 多单位灵活换算支持小数倍率（如 0.5）与大倍率', async () => {
  const p = await ok(admin, 'POST', '/api/products', {
    name: '灵活换算货', unit: '箱', dec: true, cost: 20, price: 30,
    units: [{ name: '半箱', rate: 0.5 }, { name: '托', rate: 8 }],
  });
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-26', wh: 'w1', items: [{ productId: p.id, unit: '半箱', qty: 3, price: 10 }] });
  const d = (await ok(admin, 'GET', '/api/data')).data;
  const saved = d.products.find(x => x.id === p.id);
  assert.equal(saved.stock, 1.5);
});

test('#158 门店自有配送：支持小工送货派单与客户自提记录', async () => {
  const d1 = await ok(admin, 'POST', '/api/deliveries', {
    date: '2026-11-26', mode: '小工送货', status: '待派送', driver: '小李', party: '冻品客户A', address: '福州市鼓楼区1号', srcType: 'sales', srcNo: 'XS20261126001', amount: 0,
  });
  await ok(admin, 'PUT', `/api/deliveries/${d1.id}`, {
    date: '2026-11-26', mode: '小工送货', status: '已完成', driver: '小李', party: '冻品客户A', address: '福州市鼓楼区1号', amount: 0,
  });
  const d = (await ok(admin, 'GET', '/api/data')).data;
  const rec = d.deliveries.find(x => x.id === d1.id);
  assert.equal(rec.mode, '小工送货');
  assert.equal(rec.status, '已完成');
});

test('#141/#147/#148/#155 粮食购销过磅：干粮折算公式、按点扣价、垫付运费扣除、出库混售分摊与作废冲回', async () => {
  const sup = await ok(admin, 'POST', '/api/suppliers', { name: '成都合作社', contact: '王社长', phone: '13600001111' });
  const cA = await ok(admin, 'POST', '/api/customers', { name: '粮站客户A', contact: '张A', phone: '13700001111' });
  const cB = await ok(admin, 'POST', '/api/customers', { name: '粮站客户B', contact: '李B', phone: '13700002222' });
  const corn = await ok(admin, 'POST', '/api/products', { name: '玉米', unit: '斤', dec: true, cost: 1.2, price: 1.4 });
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // 1) 干粮折算公式 + 供应商关联 + 入库类别 + 过磅照片
  // 潮粮 1000 斤，实际水分 20%，标准水分 14% -> 1000 * 0.8 / 0.86 = 930.233
  const g1 = await ok(admin, 'POST', '/api/graindocs', {
    dir: 'in', category: '烘干', partyType: 'supplier', partyId: sup.id, productId: corn.id, wh: 'w1',
    grossWeight: 1200, tareWeight: 200, calcMode: 'dry', moisture: 20, stdMoisture: 14, impurity: 0,
    unitPrice: 1.2, photos: [tinyPng],
  });
  assert.equal(g1.farmerName, '成都合作社');
  assert.equal(g1.category, '烘干');
  assert.equal(g1.netWeight, 930.233);
  assert.equal(g1.photos.length, 1);

  // 2) 按点扣价 + 我方垫付运费自动扣除
  // 1000 斤，水分 16%(超 2 点 × 0.02 = 0.04)，杂质 1%(1 × 0.02 = 0.02) -> 结算价 1.20 - 0.06 = 1.14 -> 货款 1140 - 垫付运费 100 = 1040
  const g2 = await ok(admin, 'POST', '/api/graindocs', {
    dir: 'in', category: '外购', farmerName: '老赵', productId: corn.id, wh: 'w1',
    grossWeight: 1000, tareWeight: 0, calcMode: 'price', moisture: 16, stdMoisture: 14, impurity: 1,
    unitPrice: 1.2, moisturePricePerPt: 0.02, impurityPricePerPt: 0.02,
    freightFee: 100, freightPayer: 'self',
  });
  assert.equal(g2.unitPrice, 1.14);
  assert.equal(g2.grossAmount, 1140);
  assert.equal(g2.totalAmount, 1040);

  // 3) 粮食出库 + 正负偏差 + 客户混合销售按自称重量比例分摊
  // 干粮 500 斤 + 偏差 -10 斤 = 490 斤，单价 1.5 -> 总额 735；客户 A 自称 300、客户 B 自称 100 -> 比例 75% / 25%
  const g3 = await ok(admin, 'POST', '/api/graindocs', {
    dir: 'out', partyType: 'customer', partyId: cA.id, productId: corn.id, wh: 'w1',
    grossWeight: 500, tareWeight: 0, calcMode: 'dry', moisture: 14, stdMoisture: 14, impurity: 0,
    deviation: -10, unitPrice: 1.5,
    splits: [
      { customerId: cA.id, selfWeight: 300, freightFee: 50, freightPayer: 'self' },
      { customerId: cB.id, selfWeight: 100, freightFee: 0, freightPayer: 'customer' },
    ],
  });
  assert.equal(g3.dir, 'out');
  assert.equal(g3.netWeight, 490);
  assert.equal(g3.splits.length, 2);
  assert.equal(g3.splits[0].ratio, 0.75);
  assert.equal(g3.splits[0].settleAmount, +(735 * 0.75 - 50).toFixed(2));
  assert.equal(g3.splits[1].ratio, 0.25);
  assert.equal(g3.splits[1].settleAmount, +(735 * 0.25).toFixed(2));

  // 作废出库单 -> 库存冲回
  const stockBeforeVoid = (await ok(admin, 'GET', '/api/data')).data.products.find(x => x.id === corn.id).stock;
  await ok(admin, 'POST', `/api/graindocs/${g3.id}/void`, { reason: '测试作废出库' });
  const stockAfterVoid = (await ok(admin, 'GET', '/api/data')).data.products.find(x => x.id === corn.id).stock;
  assert.equal(+(stockAfterVoid - stockBeforeVoid).toFixed(3), 490);
});

test('#8 合同管理：自定义合同模板与关联业务单据合同 CRUD', async () => {
  const tpl = await ok(admin, 'POST', '/api/contract-tpls', { name: '标准粮食合同', kind: '粮食购销合同', body: '甲方：{{company}} 乙方：{{party}} 金额：{{amount}}' });
  assert.ok(tpl.id);
  const ct = await ok(admin, 'POST', '/api/contracts', {
    title: '2026 玉米购销合同', kind: '粮食购销合同', partyName: '成都粮站', amount: 50000, tplId: tpl.id, content: '合同正文测试',
  });
  assert.match(ct.no, /^HT/);
  await ok(admin, 'PUT', `/api/contracts/${ct.id}`, { title: '2026 玉米购销合同', partyName: '成都粮站', status: '已完成', amount: 52000 });
  const d = (await ok(admin, 'GET', '/api/data')).data;
  const saved = d.contracts.find(x => x.id === ct.id);
  assert.equal(saved.status, '已完成');
  assert.equal(saved.amount, 52000);
});

test('#9 人事临工、考勤打卡奖惩与按月自动生成工资表及发薪入财务', async () => {
  const e1 = await ok(admin, 'POST', '/api/employees', { name: '临工甲', status: '临工', dailyWage: 200, tempRep: '王班长', dept: '生产部', position: '装卸工' });
  const e2 = await ok(admin, 'POST', '/api/employees', { name: '临工乙', status: '临工', dailyWage: 180, tempRep: '王班长', dept: '生产部', position: '装卸工' });
  await ok(admin, 'POST', '/api/attendance', { empId: e1.id, date: '2026-11-10', days: 2.5, overtime: 50, bonus: 100, fine: 20 });
  await ok(admin, 'POST', '/api/attendance', { empId: e2.id, date: '2026-11-10', days: 2, overtime: 0, bonus: 0, fine: 0 });
  const pr = await ok(admin, 'POST', '/api/payrolls/generate', { month: '2026-11' });
  const i1 = pr.items.find(x => x.empId === e1.id), i2 = pr.items.find(x => x.empId === e2.id);
  // e1: 2.5 * 200 + 50 + 100 - 20 = 630; e2: 2 * 180 = 360
  assert.equal(i1.netPay, 630);
  assert.equal(i1.tempRep, '王班长');
  assert.equal(i2.netPay, 360);
  await ok(admin, 'POST', `/api/payrolls/${pr.id}/pay`, {});
  const d = (await ok(admin, 'GET', '/api/data')).data;
  assert.ok(d.finance.some(f => f.ref === pr.no && f.category === '工资' && f.amount === pr.totalPay));
});

test('#10 固定资产台账与按月计提折旧联动财务支出', async () => {
  const fa = await ok(admin, 'POST', '/api/fixed-assets', {
    name: '烘干机一台', category: '农机设备', buyDate: '2026-11-01', origValue: 100000, salvageRate: 10, lifeMonths: 36, status: '使用中',
  });
  assert.match(fa.no, /^ZC/);
  const dep = await ok(admin, 'POST', '/api/fixed-assets/depreciate', { month: '2026-11' });
  // (100000 - 10000) / 36 = 2500
  assert.equal(dep.count, 1);
  assert.equal(dep.totalDep, 2500);
  // 同月不能重复计提
  const dup = await call(admin, 'POST', '/api/fixed-assets/depreciate', { month: '2026-11' });
  assert.equal(dup.http, 400);
  const d = (await ok(admin, 'GET', '/api/data')).data;
  const savedFa = d.fixedAssets.find(x => x.id === fa.id);
  assert.equal(savedFa.accumDep, 2500);
  assert.equal(savedFa.netValue, 97500);
  assert.ok(d.finance.some(f => f.ref === 'ZJ-2026-11' && f.category === '固定资产折旧' && f.amount === 2500));
});

test('#21 工程结算：材料清单直接扣库存、核算人工与杂项、收款入账及作废冲回库存', async () => {
  const mat = await ok(admin, 'POST', '/api/products', { name: '工程线管', unit: '根', cost: 10, price: 20 });
  await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-26', wh: 'w1', items: [{ productId: mat.id, qty: 20, price: 10 }] });
  const job = await ok(admin, 'POST', '/api/engjobs', {
    name: '水电改造工程', date: '2026-11-26', wh: 'w1',
    items: [{ productId: mat.id, qty: 5, price: 20 }],
    labors: [{ name: '电工', days: 2, rate: 300 }],
    miscs: [{ name: '辅材打胶', amount: 150 }],
  });
  // 材料 100 + 人工 600 + 杂项 150 = 850
  assert.equal(job.totalAmount, 850);
  assert.equal((await ok(admin, 'GET', '/api/data')).data.products.find(x => x.id === mat.id).stock, 15);
  // 作废工程单 -> 材料库存自动冲回 20
  await ok(admin, 'POST', `/api/engjobs/${job.id}/void`, {});
  assert.equal((await ok(admin, 'GET', '/api/data')).data.products.find(x => x.id === mat.id).stock, 20);
});

test('#11 田间管理：保存天地图 Key、导入地块坐标与登记农事日志', async () => {
  await ok(admin, 'PUT', '/api/settings', { tiandituKey: 'tdt_demo_key_12345' });
  const plot = await ok(admin, 'POST', '/api/field-plots', {
    name: '东村 1 号稻田', areaMu: 35.5, crop: '水稻', plantDate: '2026-04-15', owner: '老张',
    coords: [[104.06, 30.57], [104.07, 30.57], [104.07, 30.58], [104.06, 30.58]],
  });
  const log = await ok(admin, 'POST', '/api/farm-logs', {
    plotId: plot.id, date: '2026-11-26', task: '无人机飞防打药', owner: '老张', note: '完成 35.5 亩',
  });
  const d = await ok(admin, 'GET', '/api/data');
  assert.equal(d.settings.tiandituKey, 'tdt_demo_key_12345');
  assert.ok(d.data.fieldPlots.some(p => p.id === plot.id && p.coords.length === 4));
  assert.ok(d.data.farmLogs.some(l => l.id === log.id && l.plotName === '东村 1 号稻田'));
});
