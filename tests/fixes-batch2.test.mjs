// 打印模板 / 采购入库一致 / 成本权限拆分 / 出库默认售价 / 备用金同步 / 人事关联账号与部门 综合测试
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-b2-'));
const PORT = 26000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const TD = new Date().toISOString().slice(0, 10);
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let srv, admin, acctId, whId;

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
const login = async (username, password) => (await ok(null, 'POST', '/api/login', { username, password })).token;
async function newUser(username, roleId, name = username) {
  const u = await ok(admin, 'POST', '/api/users', { username, name, roleId, password: 'test123456' });
  const token = await login(username, 'test123456');
  return { id: u.id, username, name, token };
}

before(async () => {
  srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(PORT)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XERP_PLAT: 'win32', XERP_STATS_URL: '', XERP_FEEDBACK_URL: '', XERP_CLOUD_URL: '' },
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/api/ping')).ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  admin = await login('admin', 'admin123');
  await ok(admin, 'PUT', '/api/settings', {
    modules: ['inventory', 'products', 'bom', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'hr', 'reports'],
  });
  const init = await ok(admin, 'GET', '/api/data');
  acctId = init.data.accounts.find(a => !a.off).id;
  whId = init.meta.defaultWh;
});

after(() => {
  srv && srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
});

test('1. 打印模板：logoPos、二等分纸自定义宽度 215mm、费用报销单模板与字号上限 24 及页面标记', async () => {
  // 保存 expense 模板（含 inline logo、215mm、22px 字号、category/applicant/dept）
  const r1 = await ok(admin, 'PUT', '/api/settings/print', {
    kind: 'expense',
    tpl: {
      title: '费用报销单测试',
      paper: 'half',
      paperW: 215,
      fontSize: 22,
      logo: PNG_1PX,
      logoPos: 'inline',
      cols: [
        { k: 'category', label: '费用类别', on: true },
        { k: 'amount', label: '金额', on: true },
        { k: 'note', label: '说明', on: true },
      ],
      meta: { no: true, date: true, applicant: true, dept: true },
    },
  });
  const t1 = r1.expense;
  assert.equal(t1.title, '费用报销单测试');
  assert.equal(t1.paper, 'half');
  assert.equal(t1.paperW, 215);
  assert.equal(t1.fontSize, 22);
  assert.equal(t1.logoPos, 'inline');
  assert.ok(t1.cols.some(c => c.k === 'category' && c.on));
  assert.equal(t1.meta.applicant, true);
  assert.equal(t1.meta.dept, true);

  // 测试 left/right/top 及有效边界 [120, 300]（超界回落 0，logoPos 默认 inline）、fontSize 上限 24
  for (const pos of ['left', 'right', 'top', 'inline']) {
    const rp = await ok(admin, 'PUT', '/api/settings/print', {
      kind: 'expense',
      tpl: { paper: 'half', paperW: 210, fontSize: 18, logoPos: pos },
    });
    assert.equal(rp.expense.logoPos, pos);
    assert.equal(rp.expense.paperW, 210);
  }
  const boundMin = await ok(admin, 'PUT', '/api/settings/print', {
    kind: 'expense',
    tpl: { paper: 'half', paperW: 120, fontSize: 99, logoPos: 'badpos' },
  });
  assert.equal(boundMin.expense.paperW, 120);
  assert.equal(boundMin.expense.fontSize, 24);
  assert.equal(boundMin.expense.logoPos, 'inline');

  const boundMax = await ok(admin, 'PUT', '/api/settings/print', {
    kind: 'expense',
    tpl: { paper: 'half', paperW: 300, fontSize: 24, logoPos: 'inline' },
  });
  assert.equal(boundMax.expense.paperW, 300);
  assert.equal(boundMax.expense.fontSize, 24);

  const outOfRange = await ok(admin, 'PUT', '/api/settings/print', {
    kind: 'expense',
    tpl: { paper: 'half', paperW: 80, fontSize: 8 },
  });
  assert.equal(outOfRange.expense.paperW, 0);
  assert.equal(outOfRange.expense.fontSize, 10);

  const tooWide = await ok(admin, 'PUT', '/api/settings/print', {
    kind: 'expense',
    tpl: { paper: 'half', paperW: 500 },
  });
  assert.equal(tooWide.expense.paperW, 0);

  // 前端 UI 关键标记
  for (const marker of [
    's-logo-inline',
    's-logo-left',
    'tpLogoPos',
    'tpPaperW',
    '215mm',
    "expense:{name:'费用报销单'",
    'id="xPaper"',
    "tplPickHtml('expense', 'xTpl')",
    'outSalePrice',
    'canCost',
    'canSalePrice',
    'docCanShowMoney',
    '(db.advances || []).length > 0',
  ]) {
    assert.ok(HTML.includes(marker), `index.html 缺少预期标记: ${marker}`);
  }
});

test('2. 采购价=入库价：总价 210.90 四种录单方式入库后均为 210.90', async () => {
  const sup = await ok(admin, 'POST', '/api/suppliers', { name: '精准采购供应商' });

  const cases = [
    { name: '行优惠凑210.9', items: [{ qty: 60, price: 3.52, lineDiscount: 0.30 }] },
    { name: '三位小数单价3.515', items: [{ qty: 60, price: 3.515 }] },
    { name: '整单优惠凑210.9', discount: 0.01, items: [{ qty: 7, price: 30.13 }] },
    { name: '单价0+负行优惠', items: [{ qty: 60, price: 0, lineDiscount: -210.90 }] },
  ];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const p = await ok(admin, 'POST', '/api/products', {
      sku: `PO2109-${i}`, name: `测试物料${i}`, unit: '个', cost: 0, price: 10, stock: 0,
    });
    const po = await ok(admin, 'POST', '/api/orders/purchase', {
      partyId: sup.id,
      date: TD,
      ...(c.discount !== undefined ? { discount: c.discount } : {}),
      items: c.items.map(it => ({ ...it, productId: p.id })),
    });
    const poTotal = Math.round((po.items.reduce((s, it) => s + it.qty * it.price - (it.lineDiscount || 0), 0) - (po.discount || 0)) * 100) / 100;
    assert.equal(poTotal, 210.9, `${c.name}: 订单总价应为 210.9`);

    await ok(admin, 'POST', `/api/orders/purchase/${po.id}/approve`, {});
    const qty = c.items[0].qty;
    await ok(admin, 'POST', `/api/orders/purchase/${po.id}/inbound`, {
      wh: whId,
      items: [{ line: 0, productId: p.id, qty }],
    });

    const d = await ok(admin, 'GET', '/api/data');
    const inDoc = d.data.stockDocs.find(x => x.srcOrderId === po.id && x.dir === 'in');
    assert.ok(inDoc, `${c.name}: 应生成入库单`);
    const docLine = inDoc.items[0];
    const inTotal = Math.round(docLine.qty * docLine.price * 100) / 100;
    assert.equal(inTotal, 210.9, `${c.name}: 入库金额应严格等于 210.90，实际为 ${inTotal} (unit=${docLine.price})`);
  }
});

test('3. 成本权限拆分 + 出库/销售默认销售价：无 inv.cost 看不到成本但能看销售价、按销售价开单', async () => {
  // 准备商品与 BOM
  const raw = await ok(admin, 'POST', '/api/products', { sku: 'PERM-RAW', name: '原料A', unit: '个', cost: 12, price: 25, stock: 100 });
  const fp = await ok(admin, 'POST', '/api/products', { sku: 'PERM-FP', name: '成品B', unit: '件', cost: 30, price: 88, stock: 50 });
  await ok(admin, 'PUT', `/api/products/${fp.id}/bom`, { lines: [{ productId: raw.id, qty: 2 }] });

  // 管理员先做一笔入库和一笔直接出库，产生 stockLogs 与 stockDocs 供权限剥离校验
  const directIn = await ok(admin, 'POST', '/api/stockdocs', {
    dir: 'in', type: '采购入库', wh: whId, items: [{ productId: fp.id, qty: 5, price: 32 }],
  });
  const directOutAdmin = await ok(admin, 'POST', '/api/stockdocs', {
    dir: 'out', type: '销售出库', wh: whId, items: [{ productId: fp.id, qty: 2, sale: 88 }],
  });

  // 3a) r_sales 业务员：看不到 cost，但能看到 price；创建销售单与发货时 outbound stockDoc 保留 sale
  const salesUser = await newUser('b2_sales', 'r_sales', '业务员小测');
  const dSales = (await ok(salesUser.token, 'GET', '/api/data')).data;
  const fpSales = dSales.products.find(x => x.id === fp.id);
  assert.equal(fpSales.cost, undefined, 'r_sales 不应看到商品成本价');
  assert.equal(fpSales.price, 88, 'r_sales 应能看到商品销售价');

  const cu = await ok(salesUser.token, 'POST', '/api/customers', { name: '权测客户' });
  const so = await ok(salesUser.token, 'POST', '/api/orders/sales', {
    partyId: cu.id, date: TD, items: [{ productId: fp.id, qty: 3, price: 88 }],
  });
  await ok(salesUser.token, 'POST', `/api/orders/sales/${so.id}/ship`, {
    wh: whId, items: [{ line: 0, productId: fp.id, qty: 3 }],
  });
  const dAdminAfterShip = (await ok(admin, 'GET', '/api/data')).data;
  const shipDoc = dAdminAfterShip.stockDocs.find(x => x.srcOrderId === so.id && x.dir === 'out');
  assert.ok(shipDoc, '销售发货应生成出库单');
  assert.equal(shipDoc.items[0].sale, 88, '销售发货出库单应保留销售单价 sale=88');

  // 3b) 自定义角色：无 inv.cost，但有 inv.price + inv.out + prod.edit + bom + inv.view + inv.others
  const customRole = await ok(admin, 'POST', '/api/roles', {
    name: '无成本可见售价角色',
    perms: ['prod.view', 'prod.edit', 'inv.view', 'inv.out', 'inv.others', 'inv.price', 'bom'],
  });
  const uNoCost = await newUser('b2_nocost', customRole.id, '无成本开单员');

  const dNoCost = (await ok(uNoCost.token, 'GET', '/api/data')).data;
  const fpNoCost = dNoCost.products.find(x => x.id === fp.id);
  assert.equal(fpNoCost.cost, undefined, '无 inv.cost 不应看到 product.cost');
  assert.equal(fpNoCost.price, 88, '有 inv.price 应看到 product.price');
  assert.equal(fpNoCost.bom[0].price, undefined, '无 inv.cost 不应看到 bom[].price');
  assert.ok(dNoCost.stockLogs.every(l => l.cost === undefined), '无 inv.cost 不应看到 stockLogs[].cost');

  const seenIn = dNoCost.stockDocs.find(x => x.id === directIn.id);
  assert.equal(seenIn.items[0].price, undefined, '无 inv.cost 不应看到入库单价/成本');
  const seenOut = dNoCost.stockDocs.find(x => x.id === directOutAdmin.id);
  assert.equal(seenOut.items[0].price, undefined, '无 inv.cost 不应看到出库成本 price');
  assert.equal(seenOut.items[0].sale, 88, '有 inv.price 应能看到出库销售价 sale');

  // 修改成本价 / 按 BOM 应用成本被拒绝 403
  assert.equal((await call(uNoCost.token, 'PUT', `/api/products/${fp.id}/cost`, { cost: 10, reason: '越权' })).http, 403);
  assert.equal((await call(uNoCost.token, 'PUT', `/api/products/${fp.id}/bom`, { lines: [{ productId: raw.id, qty: 2 }], applyCost: true })).http, 403);

  // 直接开出库单可带销售价 sale，且自己的返回里仍不含成本 price
  const selfOut = await ok(uNoCost.token, 'POST', '/api/stockdocs', {
    dir: 'out', type: '销售出库', wh: whId, items: [{ productId: fp.id, qty: 1, sale: fpNoCost.price }],
  });
  const dNoCost2 = (await ok(uNoCost.token, 'GET', '/api/data')).data;
  const selfOutSeen = dNoCost2.stockDocs.find(x => x.id === selfOut.id);
  assert.equal(selfOutSeen.items[0].sale, 88);
  assert.equal(selfOutSeen.items[0].price, undefined);

  // 3c) r_wh 仓管既没有 inv.cost 也没有 inv.price：两个价格都看不到
  const whUser = await newUser('b2_wh', 'r_wh', '仓管小张');
  const fpWh = (await ok(whUser.token, 'GET', '/api/data')).data.products.find(x => x.id === fp.id);
  assert.equal(fpWh.cost, undefined, 'r_wh 仍看不到 cost');
  assert.equal(fpWh.price, undefined, 'r_wh 仍看不到 price');
});

test('4. 备用金：管理员替他人登记并付款后同步到本人账号，并可正常冲销报销', async () => {
  const empRole = await ok(admin, 'POST', '/api/roles', {
    name: '普通报销员工',
    perms: ['prod.view', 'expense'],
  });
  const advEmp = await newUser('b2_adv_emp', empRole.id, '出差员工甲');
  const advOther = await newUser('b2_adv_other', empRole.id, '无关员工乙');

  // 管理员替 advEmp 登记一笔 500 元备用金并审批付款
  const adv = await ok(admin, 'POST', '/api/advances', {
    applicantUserId: advEmp.id,
    applicant: advEmp.name,
    date: TD,
    amount: 500,
    purpose: '华南巡检备用金',
  });
  assert.equal(adv.applicantUserId, advEmp.id);
  await ok(admin, 'POST', `/api/advances/${adv.id}/approve`, {});
  await ok(admin, 'POST', `/api/advances/${adv.id}/pay`, { date: TD, account: acctId });

  // 本人账号 GET /api/data 可看到这笔备用金，他人看不到
  const empData = (await ok(advEmp.token, 'GET', '/api/data')).data;
  assert.ok(empData.advances.some(a => a.id === adv.id && a.amount === 500), '本人账号应同步收到备用金');
  const otherData = (await ok(advOther.token, 'GET', '/api/data')).data;
  assert.equal(otherData.advances.some(a => a.id === adv.id), false, '其他人不应看到他人备用金');

  // 本人提交报销并冲销 200 元
  const exp = await ok(advEmp.token, 'POST', '/api/expenses', {
    applicant: advEmp.name,
    date: TD,
    reason: '车票报销',
    advanceId: adv.id,
    advanceOffset: 200,
    lines: [{ category: '差旅费', amount: 260 }],
  });
  assert.equal(exp.advanceId, adv.id);
  assert.equal(exp.advanceOffset, 200);
  await ok(admin, 'POST', `/api/expenses/${exp.id}/approve`, {});
  await ok(admin, 'POST', `/api/expenses/${exp.id}/pay`, { date: TD, account: acctId });

  const empData2 = (await ok(advEmp.token, 'GET', '/api/data')).data;
  const advAfter = empData2.advances.find(a => a.id === adv.id);
  assert.equal(advAfter.used, 200);
  assert.equal(advAfter.amount - advAfter.used, 300);

  // 无 expense 权限的账号（如 r_wh）收到管理员登记的备用金时，也能在 GET /api/data advances 中看到
  const whAdvUser = await newUser('b2_wh_adv', 'r_wh', '无报销权仓管');
  const advForWh = await ok(admin, 'POST', '/api/advances', {
    applicantUserId: whAdvUser.id,
    applicant: whAdvUser.name,
    date: TD,
    amount: 300,
    purpose: '采购零星备用金',
  });
  const whAdvData = (await ok(whAdvUser.token, 'GET', '/api/data')).data;
  assert.ok(whAdvData.advances.some(a => a.id === advForWh.id), '无 expense 权限但被登记了备用金的账号也应收到同步');
});

test('5. 人事关联登录账号与部门自动带出：名称同步、唯一性校验、改名联动与报销自动填部门', async () => {
  const hrRole = await ok(admin, 'POST', '/api/roles', {
    name: '人事测试员工',
    perms: ['prod.view', 'expense'],
  });
  const hrU1 = await newUser('b2_hr_u1', hrRole.id, '张三');
  const hrU2 = await newUser('b2_hr_u2', hrRole.id, '李四');

  // 新建员工关联 hrU1，故意传错 name，后端应以登录用户为准覆盖 name 和 username
  const emp1 = await ok(admin, 'POST', '/api/employees', {
    userId: hrU1.id,
    name: '错误手写名',
    dept: '研发部',
    position: '高级工程师',
    status: '在职',
  });
  assert.equal(emp1.userId, hrU1.id);
  assert.equal(emp1.name, '张三', '员工姓名应以关联登录用户为准');
  assert.equal(emp1.username, 'b2_hr_u1');
  assert.equal(emp1.dept, '研发部');

  // 不允许两个员工同时关联同一登录用户
  const dupLink = await call(admin, 'POST', '/api/employees', {
    userId: hrU1.id,
    name: '李四',
    dept: '市场部',
  });
  assert.equal(dupLink.http, 400, '重复关联同一登录账号应返回 400');

  // 关联第二个员工，然后尝试 PUT 改绑成 hrU1 也应 400
  const emp2 = await ok(admin, 'POST', '/api/employees', {
    userId: hrU2.id,
    name: '随意名',
    dept: '市场部',
  });
  assert.equal(emp2.name, '李四');
  const dupPut = await call(admin, 'PUT', `/api/employees/${emp2.id}`, {
    userId: hrU1.id,
    name: '张三',
    dept: '市场部',
  });
  assert.equal(dupPut.http, 400, '编辑改绑已占用登录账号应返回 400');

  // 管理员修改登录用户名称，联动员工档案同步改名
  await ok(admin, 'PUT', `/api/users/${hrU1.id}`, { name: '张三丰', roleId: hrRole.id });
  const dAfterRename = await ok(admin, 'GET', '/api/data');
  const emp1After = dAfterRename.data.employees.find(e => e.id === emp1.id);
  assert.equal(emp1After.name, '张三丰', '登录账号改名后关联员工应同步改名');

  // GET /api/data 返回 user.dept，GET /api/people 返回 dept
  const u1Data = await ok(hrU1.token, 'GET', '/api/data');
  assert.equal(u1Data.user.dept, '研发部');
  const peopleRes = await ok(hrU1.token, 'GET', '/api/people');
  const pU1 = peopleRes.list.find(x => x.id === hrU1.id);
  assert.equal(pU1.dept, '研发部');
  assert.equal(pU1.name, '张三丰');

  // 提交报销单不填 dept 时自动带出部门
  const autoExp = await ok(hrU1.token, 'POST', '/api/expenses', {
    applicant: '张三丰',
    date: TD,
    reason: '测试自动部门',
    lines: [{ category: '办公费', amount: 45 }],
  });
  assert.equal(autoExp.dept, '研发部', '报销单未传 dept 时应自动带出所属部门');
});

test('6. 全量审计修复回归：写接口脱敏、无成本开采购入库取净单价、默认0%容差、多批容差、删作废单清流水、备用金越权作废与粮食拒序列号', async () => {
  // 6a) 无 inv.cost 的写入接口返回也必须剥离 cost 与 stockDoc 成本 price，且不破坏库内原成本
  const adminProd = await ok(admin, 'POST', '/api/products', { sku: 'AUD-P1', name: '审计商品1', unit: '个', cost: 15, price: 30, stock: 10 });
  const matProd = await ok(admin, 'POST', '/api/products', { sku: 'AUD-MAT', name: '审计辅料', unit: '个', cost: 4, price: 8, stock: 20 });
  const writeRole = await ok(admin, 'POST', '/api/roles', {
    name: '无成本全写测',
    perms: ['prod.view', 'prod.edit', 'bom', 'inv.view', 'inv.out', 'inv.price', 'sales', 'parties', 'parties.all'],
  });
  const uWrite = await newUser('b2_audit_w', writeRole.id, '无成本写测');

  const pCreated = await ok(uWrite.token, 'POST', '/api/products', { sku: 'AUD-P2', name: '新建无成本返回', unit: '个', cost: 9, price: 30, stock: 0 });
  assert.equal(pCreated.cost, undefined, 'POST /api/products 返回不应泄露 cost');
  assert.equal(pCreated.price, 30);

  const pEdited = await ok(uWrite.token, 'PUT', `/api/products/${adminProd.id}`, { ...adminProd, price: 32, cost: 1 });
  assert.equal(pEdited.cost, undefined, 'PUT /api/products/:id 返回不应泄露 cost');
  assert.equal((await ok(admin, 'GET', '/api/data')).data.products.find(x => x.id === adminProd.id).cost, 15, '无 inv.cost 不得篡改原成本');

  const bomSaved = await ok(uWrite.token, 'PUT', `/api/products/${adminProd.id}/bom`, {
    lines: [{ productId: matProd.id, qty: 2 }, { name: '手工辅料', qty: 1, price: 3 }],
  });
  assert.equal(bomSaved.cost, undefined, 'PUT /api/products/:id/bom 返回不应泄露 cost');
  assert.equal(bomSaved.bom[1].price, undefined, 'PUT /api/products/:id/bom 返回不应泄露 BOM 物料价格');

  const cu = await ok(uWrite.token, 'POST', '/api/customers', { name: '审计客户' });
  const soResp = await ok(uWrite.token, 'POST', '/api/orders/sales', {
    partyId: cu.id, date: TD, items: [{ productId: adminProd.id, qty: 2, price: 32 }],
  });
  assert.equal(soResp.items[0].cost, undefined, 'POST /api/orders/sales 返回不应泄露 items[].cost');

  const outResp = await ok(uWrite.token, 'POST', '/api/stockdocs', {
    dir: 'out', type: '销售出库', wh: whId, items: [{ productId: adminProd.id, qty: 1, sale: 32 }],
  });
  assert.equal(outResp.items[0].price, undefined, 'POST /api/stockdocs 返回不应泄露成本 price');
  assert.equal(outResp.items[0].sale, 32, '有 inv.price 应保留出库售价 sale');

  // 6b) 采购员（无 inv.cost）从已审核采购单直接关联生成入库单且未传 price 时，取订单净单价而非商品当前成本
  const sup = await ok(admin, 'POST', '/api/suppliers', { name: '无成本入库供应商' });
  const pPo = await ok(admin, 'POST', '/api/products', { sku: 'AUD-PO', name: '净价入库商品', unit: '个', cost: 9.99, price: 20, stock: 0 });
  const poBuyerRole = await ok(admin, 'POST', '/api/roles', {
    name: '无成本采购入库员',
    perms: ['purchase', 'inv.view', 'inv.in', 'prod.view'],
  });
  const uPo = await newUser('b2_po_nocost', poBuyerRole.id, '无成本采购员');
  const po = await ok(uPo.token, 'POST', '/api/orders/purchase', {
    partyId: sup.id, date: TD, items: [{ productId: pPo.id, qty: 60, price: 3.52, lineDiscount: 0.30 }],
  });
  await ok(admin, 'POST', `/api/orders/purchase/${po.id}/approve`, {});
  const inFromPo = await ok(uPo.token, 'POST', '/api/stockdocs', {
    dir: 'in', type: '采购入库', wh: whId, srcOrderId: po.id, srcOrderKind: 'purchase',
    items: [{ productId: pPo.id, qty: 60 }],
  });
  assert.equal(inFromPo.items[0].price, undefined, '无 inv.cost 用户保存关联入库单返回仍应隐藏 cost/price');
  const adminCheckIn = (await ok(admin, 'GET', '/api/data')).data.stockDocs.find(x => x.id === inFromPo.id);
  const netInTotal = Math.round(adminCheckIn.items[0].qty * adminCheckIn.items[0].price * 100) / 100;
  assert.equal(netInTotal, 210.9, '关联采购单未传 price 时应按 PO 净单价入库 210.90');

  // 6c) 默认未设容差时为 0%（allowOver: true 也不放行）；设 20% 后分批累计上限按总量 120% 校验
  const pTol = await ok(admin, 'POST', '/api/products', { sku: 'AUD-TOL', name: '容差验证料', unit: '个', cost: 2, price: 5, stock: 0 });
  const poTol1 = await ok(admin, 'POST', '/api/orders/purchase', { partyId: sup.id, date: TD, items: [{ productId: pTol.id, qty: 100, price: 2 }] });
  await ok(admin, 'POST', `/api/orders/purchase/${poTol1.id}/approve`, {});
  assert.equal((await call(admin, 'POST', `/api/orders/purchase/${poTol1.id}/inbound`, { wh: whId, allowOver: true, items: [{ line: 0, productId: pTol.id, qty: 105 }] })).http, 400, '未设置容差时默认应为 0%，禁止超收');

  await ok(admin, 'PUT', '/api/settings', { overTolerancePct: 20 });
  await ok(admin, 'POST', `/api/orders/purchase/${poTol1.id}/inbound`, { wh: whId, allowOver: true, items: [{ line: 0, productId: pTol.id, qty: 80 }] });
  await ok(admin, 'POST', `/api/orders/purchase/${poTol1.id}/inbound`, { wh: whId, allowOver: true, items: [{ line: 0, productId: pTol.id, qty: 40 }] });

  const poTol2 = await ok(admin, 'POST', '/api/orders/purchase', { partyId: sup.id, date: TD, items: [{ productId: pTol.id, qty: 100, price: 2 }] });
  await ok(admin, 'POST', `/api/orders/purchase/${poTol2.id}/approve`, {});
  await ok(admin, 'POST', `/api/orders/purchase/${poTol2.id}/inbound`, { wh: whId, allowOver: true, items: [{ line: 0, productId: pTol.id, qty: 80 }] });
  assert.equal((await call(admin, 'POST', `/api/orders/purchase/${poTol2.id}/inbound`, { wh: whId, allowOver: true, items: [{ line: 0, productId: pTol.id, qty: 41 }] })).http, 400, '累计 121 超过 20% 容差上限 120 应被拒');
  await ok(admin, 'PUT', '/api/settings', { overTolerancePct: 0 });

  // 6d) 作废入库单并删除：清空所有同单号库存流水
  const docToVoidDel = await ok(admin, 'POST', '/api/stockdocs', { dir: 'in', type: '采购入库', wh: whId, items: [{ productId: pTol.id, qty: 5, price: 2 }] });
  await ok(admin, 'POST', `/api/stockdocs/${docToVoidDel.id}/void`, { reason: '测试删除作废单' });
  await ok(admin, 'DELETE', `/api/stockdocs/${docToVoidDel.id}`);
  const afterDelLogs = (await ok(admin, 'GET', '/api/data')).data.stockLogs.filter(l => l.ref === docToVoidDel.no);
  assert.equal(afterDelLogs.length, 0, '删除已作废单据应彻底清除该单据全部库存流水');

  // 6e) 备用金：传 applicantUserId 时以登录用户名为准；本人无权作废管理员代登记的待审备用金
  const advAuthUser = await newUser('b2_adv_auth', poBuyerRole.id, '真实姓名');
  const empRec = await ok(admin, 'POST', '/api/roles', { name: '仅报销权', perms: ['prod.view', 'expense'] });
  const advRecip = await newUser('b2_adv_recip', empRec.id, '李真实');
  const advPending = await ok(admin, 'POST', '/api/advances', {
    applicantUserId: advRecip.id, applicant: '过时手写名', date: TD, amount: 120, purpose: '备用金权测',
  });
  assert.equal(advPending.applicant, '李真实', '关联用户时领用人姓名应以登录账号为准');
  assert.equal((await call(advRecip.token, 'POST', `/api/advances/${advPending.id}/void`, {})).http, 403, '领用人不得作废他人替其提交的待审备用金');
  await ok(admin, 'POST', `/api/advances/${advPending.id}/void`, {});
  assert.ok(advAuthUser.id);

  // 6f) 粮食收购拒绝序列号管理商品
  await ok(admin, 'PUT', '/api/settings', { modules: ['inventory', 'products', 'bom', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'hr', 'reports', 'agri'] });
  const snProd = await ok(admin, 'POST', '/api/products', { sku: 'AUD-SN', name: '序列号物料', unit: '个', cost: 1, price: 2, stock: 0, serial: true });
  const badGrain = await call(admin, 'POST', '/api/graindocs', {
    date: TD, wh: whId, productId: snProd.id, farmerName: '测试农户', grossWeight: 100, tareWeight: 10, unitPrice: 2,
  });
  assert.equal(badGrain.http, 400, '序列号商品不能用于粮食过磅收购');

  // 6g) 前端源码关键修复标记检查
  for (const marker of [
    "o.srcOrderKind === 'grain' ? 'grainView'",
    "else cb.value = '1'",
    'PEOPLE = null; ROLES = [];',
    '/^\\/api\\/(users|employees|departments)/.test(path)',
  ]) {
    assert.ok(HTML.includes(marker), `index.html 缺少修复标记: ${marker}`);
  }
});
