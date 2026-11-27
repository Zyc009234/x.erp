import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-sec-'));
  const port = 29000 + Math.floor(Math.random() * 8000);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(ROOT, 'src/server.js'), '--data', dir, '--port', String(port)], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/ping'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 80));
  }
  return {
    client() {
      let token = '';
      return {
        async req(method, p, body) {
          const r = await fetch(base + p, {
            method,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
          });
          const data = await r.json().catch(() => ({}));
          return { status: r.status, data };
        },
        async login(username, password) {
          const r = await this.req('POST', '/api/login', { username, password });
          assert.equal(r.status, 200);
          token = r.data.token;
          return r.data;
        }
      };
    },
    stop() { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

const srv = await startServer();
const admin = srv.client();
await admin.login('admin', 'admin123');
await admin.req('PUT', '/api/settings', { modules: ['inventory', 'products', 'bom', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'hr', 'reports', 'shipping', 'agri'] });
test.after(() => srv.stop());

test('XSS-5: 临时送货日期校验拒绝脚本注入', async () => {
  const bad = await admin.req('POST', '/api/deliveries', { driver: '老王', date: '<img src=x onerror=alert(1)>' });
  assert.equal(bad.status, 400);
  const ok = await admin.req('POST', '/api/deliveries', { driver: '老王', date: '2026-11-26' });
  assert.equal(ok.status, 200);
});

test('Logic-1 & Logic-2 & Logic-8: 采购退货按折后净价冲库、提前完结按比例折算优惠、多单位余量补齐不翻倍', async () => {
  // 创建带箱/个单位的商品（1箱=10个）
  const p = (await admin.req('POST', '/api/products', {
    name: '审计测试商品', unit: '个', cost: 0, price: 20,
    units: [{ name: '箱', rate: 10 }]
  })).data;
  const sup = (await admin.req('POST', '/api/suppliers', { name: '审计供应商' })).data;
  const cust = (await admin.req('POST', '/api/customers', { name: '审计客户' })).data;

  // 1) 采购单：10个 × 10元，行优惠 20元（折后80元，净单价8元/个）
  const po = (await admin.req('POST', '/api/orders/purchase', {
    partyId: sup.id, date: '2026-11-26',
    items: [{ productId: p.id, qty: 10, price: 10, lineDiscount: 20 }]
  })).data;
  assert.equal((await admin.req('POST', `/api/orders/purchase/${po.id}/approve`, {})).status, 200);
  assert.equal((await admin.req('POST', `/api/orders/purchase/${po.id}/inbound`, {})).status, 200);

  // 采购退货 5个，应按净单价 8 元/个 冲减库存成本，而非优惠前 10 元/个
  const pret = (await admin.req('POST', '/api/orders/purchaseReturn', {
    partyId: sup.id, srcId: po.id, date: '2026-11-26',
    items: [{ productId: p.id, qty: 5, price: 8 }]
  })).data;
  assert.equal(pret.items[0].cost, 8);

  // 2) 多单位销售单：2箱（20个），先入足库存再发 15个（剩5个不能整除10），再不传 items 调发货，应按 5个 而不是 5箱(50个)
  await admin.req('POST', '/api/stockdocs', {
    dir: 'in', type: '其他入库', date: '2026-11-26',
    items: [{ productId: p.id, qty: 100, price: 8 }]
  });
  const so = (await admin.req('POST', '/api/orders/sales', {
    partyId: cust.id, date: '2026-11-26', discount: 40,
    items: [{ productId: p.id, unit: '箱', qty: 2, price: 200, lineDiscount: 20 }]
  })).data;
  // 先发 15 个（1.5箱）
  assert.equal((await admin.req('POST', `/api/orders/sales/${so.id}/ship`, {
    items: [{ line: 0, productId: p.id, unit: '个', qty: 15 }]
  })).status, 200);
  // 再不传 items 自动补齐剩余 5 个
  const ship2 = await admin.req('POST', `/api/orders/sales/${so.id}/ship`, {});
  assert.equal(ship2.status, 200);
  const docs = (await admin.req('GET', '/api/data')).data.data.stockDocs.filter(d => d.srcOrderId === so.id && d.status === '正常');
  const totalShipped = docs.reduce((s, d) => s + d.items.reduce((a, i) => a + i.qty, 0), 0);
  assert.equal(totalShipped, 20, '自动补齐剩余5个应总计20个，不能变成5箱50个');

  // 3) 提前完结（syncQty: true）：下单10个×100元，行优惠100元、整单优惠100元；实发5个后提前完结，优惠应按比例折半
  const so2 = (await admin.req('POST', '/api/orders/sales', {
    partyId: cust.id, date: '2026-11-26', discount: 100,
    items: [{ productId: p.id, qty: 10, price: 100, lineDiscount: 100 }]
  })).data;
  assert.equal((await admin.req('POST', `/api/orders/sales/${so2.id}/ship`, {
    items: [{ line: 0, productId: p.id, qty: 5 }]
  })).status, 200);
  const fin = await admin.req('POST', `/api/orders/sales/${so2.id}/finish-fulfill`, { syncQty: true });
  assert.equal(fin.status, 200);
  assert.equal(fin.data.items[0].qty, 5);
  assert.equal(fin.data.items[0].lineDiscount, 50);
  assert.equal(fin.data.discount, 50);
});

test('Perm-1 & Perm-2 & Perm-3 & Perm-4 & Perm-5 & Perm-6: 权限隔离与脱敏回归', async () => {
  // 创建两个业务员与受限角色
  const rSales = (await admin.req('POST', '/api/roles', { name: '受限业务员', perms: ['sales', 'parties', 'exp.approve', 'expense'] })).data;
  const rShip = (await admin.req('POST', '/api/roles', { name: '报价员', perms: ['ship.rate', 'ship.view'] })).data;
  const rNoCost = (await admin.req('POST', '/api/roles', { name: '无成本仓管', perms: ['inv.view', 'inv.in', 'inv.out', 'inv.transfer', 'inv.check', 'inv.checkpost', 'prod.view'] })).data;
  const rPostOnly = (await admin.req('POST', '/api/roles', { name: '仅盘点审核', perms: ['inv.view', 'inv.checkpost', 'inv.others', 'prod.view'] })).data;
  const rBomOutOnly = (await admin.req('POST', '/api/roles', { name: '仅出库BOM', perms: ['bom', 'inv.out', 'inv.view', 'prod.view'] })).data;

  await admin.req('POST', '/api/users', { username: 'rep_a', name: '业务A', password: 'password1', roleId: rSales.id });
  await admin.req('POST', '/api/users', { username: 'rep_b', name: '业务B', password: 'password1', roleId: rSales.id });
  await admin.req('POST', '/api/users', { username: 'ship_u', name: '报价员', password: 'password1', roleId: rShip.id });
  await admin.req('POST', '/api/users', { username: 'wh_nocost', name: '无成本仓管', password: 'password1', roleId: rNoCost.id });
  await admin.req('POST', '/api/users', { username: 'chk_post', name: '盘点审核员', password: 'password1', roleId: rPostOnly.id });
  await admin.req('POST', '/api/users', { username: 'bom_u', name: 'BOM员', password: 'password1', roleId: rBomOutOnly.id });

  const repA = srv.client(), repB = srv.client(), shipU = srv.client(), whU = srv.client(), chkPost = srv.client(), bomU = srv.client();
  await repA.login('rep_a', 'password1');
  await repB.login('rep_b', 'password1');
  await shipU.login('ship_u', 'password1');
  await whU.login('wh_nocost', 'password1');
  await chkPost.login('chk_post', 'password1');
  await bomU.login('bom_u', 'password1');

  // Perm-1: repB 不能通过批量导入专属价修改 repA 的客户
  const p = (await admin.req('POST', '/api/products', { sku: 'SKU_AUD_1', name: '专属价商品', unit: '个', cost: 12, price: 30 })).data;
  await repA.req('POST', '/api/customers', { name: '业务A专属客户' });
  const impBad = await repB.req('POST', '/api/prices/customers/import', {
    rows: [{ party: '业务A专属客户', product: 'SKU_AUD_1', price: 1 }]
  });
  assert.equal(impBad.status, 400);
  assert.match(impBad.data.error, /无权修改客户/);

  // Perm-2: 保存快递公司响应不返回明文 customerPwd
  const carRes = await shipU.req('POST', '/api/carriers', {
    name: '测试快递A', code: 'ZTO',
    zones: [{ name: '全国', provinces: [], first: 1, firstFee: 10, addStep: 1, addFee: 2 }],
    eo: { customerName: 'acc1', customerPwd: 'super_secret_pwd' }
  });
  assert.equal(carRes.status, 200);
  assert.equal(carRes.data.eo.customerPwd, '');
  assert.equal(carRes.data.eo.pwdSet, true);

  // Perm-3 & Perm-6: 调拨/盘点响应对无 inv.cost 脱敏；仅 inv.checkpost 不能在审核时改实盘数量
  const wh1 = (await admin.req('GET', '/api/data')).data.meta.defaultWh;
  const wh2 = (await admin.req('POST', '/api/warehouses', { name: '二号仓' })).data;
  await admin.req('POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-26', wh: wh1, items: [{ productId: p.id, qty: 20, price: 12 }] });
  const tr = await whU.req('POST', '/api/transfers', {
    from: wh1, to: wh2.id,
    items: [{ productId: p.id, qty: 5 }]
  });
  assert.equal(tr.status, 200);
  assert.equal('cost' in tr.data.items[0], false, '无 inv.cost 权限调拨响应不能暴露 cost');

  const chk = (await whU.req('POST', '/api/checkdocs', { wh: wh1, productIds: [p.id] })).data;
  // 仅 inv.checkpost 带 lines 提交审核应被拒 403
  const postBypass = await chkPost.req('POST', `/api/checkdocs/${chk.id}/post`, { lines: [{ productId: p.id, counted: 10 }] });
  assert.equal(postBypass.status, 403);
  // 正常录入后由无 inv.cost 仓管审核，响应也不含 cost
  await whU.req('PUT', `/api/checkdocs/${chk.id}`, { lines: [{ productId: p.id, counted: 14 }] });
  const posted = await whU.req('POST', `/api/checkdocs/${chk.id}/post`, {});
  assert.equal(posted.status, 200);
  assert.equal('cost' in posted.data.lines[0], false, '无 inv.cost 权限盘点审核响应不能暴露 cost');

  // Perm-4 & Perm-5: BOM 组装需要同时有 inv.in 和 inv.out；开启审核时被拒
  const mat = (await admin.req('POST', '/api/products', { name: 'BOM原料', unit: '个', cost: 5, price: 10 })).data;
  const fg = (await admin.req('POST', '/api/products', { name: 'BOM成品', unit: '套', cost: 0, price: 50 })).data;
  await admin.req('POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-26', items: [{ productId: mat.id, qty: 20, price: 5 }] });
  await admin.req('PUT', `/api/products/${fg.id}/bom`, { bom: [{ productId: mat.id, qty: 2 }] });

  const bomNoIn = await bomU.req('POST', '/api/bom/assemble', { productId: fg.id, qty: 1 });
  assert.equal(bomNoIn.status, 403);

  await admin.req('PUT', '/api/settings', { docApprove: { in: true, out: false } });
  const bomWithAppr = await admin.req('POST', '/api/bom/assemble', { productId: fg.id, qty: 1 });
  assert.equal(bomWithAppr.status, 400);
  assert.match(bomWithAppr.data.error, /已开启出入库审核/);
  await admin.req('PUT', '/api/settings', { docApprove: { in: false, out: false } });
});

test('Logic-5: 会签转交不允许转交给当前节点已有审批人或已审批人', async () => {
  await admin.req('PUT', '/api/settings', {
    expFlow: [{ name: '会签节点', mode: 'all', approvers: ['rep_a', 'rep_b'] }]
  });
  const repA = srv.client(), repB = srv.client();
  await repA.login('rep_a', 'password1');
  await repB.login('rep_b', 'password1');

  const exp = (await admin.req('POST', '/api/expenses', {
    date: '2026-11-26', applicant: '管理员', reason: '会签转交测试',
    lines: [{ category: '办公费', amount: 100 }]
  })).data;
  assert.equal((await repA.req('POST', `/api/expenses/${exp.id}/approve`, { comment: '同意' })).status, 200);
  // repB 尝试转交给已经审批过的 repA -> 应拒绝
  const trBad = await repB.req('POST', `/api/expenses/${exp.id}/transfer`, { to: 'rep_a' });
  assert.equal(trBad.status, 400);
});

test('XSS-6 & XSS-7 & XSS-8 & Logic-7: JSON 备份导出/恢复对称且清洗危险字段与脚本', async () => {
  const bk = (await admin.req('GET', '/api/backup')).data;
  assert.ok(Array.isArray(bk.roles), 'backup 应导出 roles');
  // 注入恶意 shipLabels HTML、恶意 id/no、恶意打印模板 logo
  bk.data.shipLabels = [{ id: 'lbl_xss_1', html: '<div>ok</div><script>alert(1)</script><img src=x onerror=alert(2)>' }];
  bk.data.products.push({ id: '"><img src=x>', name: '坏ID商品', unit: '个', stock: 0 });
  bk.settings.printTpl = { sales: { logo: 'javascript:alert(1)', cols: [{ k: 'name', w: '999;background:url(x)', al: 'evil' }] } };
  bk.settings.company = '恢复后的公司名';

  const rst = await admin.req('POST', '/api/restore', bk);
  assert.equal(rst.status, 200);

  const after = (await admin.req('GET', '/api/backup')).data;
  assert.equal(after.settings.company, '恢复后的公司名');
  assert.equal(after.settings.printTpl.sales.logo, '', '恶意 logo URL 应被清洗');
  assert.equal(after.settings.printTpl.sales.cols[0].al, '', '非法对齐方式应被清洗');
  const lbl = after.data.shipLabels.find(x => x.id === 'lbl_xss_1');
  assert.ok(lbl && !/<script/i.test(lbl.html) && !/onerror/i.test(lbl.html), '电子面单 HTML 脚本与事件应被清除');
  assert.ok(!after.data.products.some(p => p.id.includes('<')), '恶意产品 id 应被替换为安全 id');
});

test('前端 XSS / 逻辑 / 手机布局关键修复静态检查', () => {
  const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes("title:'修正商品成本 · ' + esc(p.name)"), 'XSS-1 修正成本标题应转义');
  assert.ok(html.includes("modalHead('专属价 · ' + esc(r.name))"), 'XSS-2 专属价标题应转义');
  assert.ok(html.includes("modalHead('成员管理 · ' + esc(name))"), 'XSS-3 公司成员管理标题应转义');
  assert.ok(html.includes('批准 ${esc(a.applicant)} 的备用金'), 'XSS-4 备用金审批确认框应转义');
  assert.ok(html.includes('sanitizeLabelHtmlClient'), 'XSS-8 前端打印面单应二次净化');
  assert.ok(html.includes('sum(db[C.party], p => +p.openingBalance || 0)'), 'Logic-3 应收应付汇总应包含期初余额');
  assert.ok(html.includes('const ppFinIds = new Set(pps.map(p => p.financeId)'), 'Logic-4 往来对账单应包含合并收付款且不重复计算');
  assert.ok(html.includes('html.mobile.native .content{padding-bottom:84px}'), 'Mobile-1 原生扫码按钮底部安全边距');
  assert.ok(html.includes('overflow-wrap:anywhere'), 'Mobile-6/7 卡片金额与长 Toast 自动折行');
});
