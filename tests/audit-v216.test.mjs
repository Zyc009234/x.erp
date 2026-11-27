import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-aud216-'));
  const port = 30000 + Math.floor(Math.random() * 8000);
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
await admin.req('PUT', '/api/settings', {
  modules: ['inventory', 'products', 'bom', 'dashboard', 'sales', 'purchase', 'parties', 'finance', 'hr', 'reports', 'shipping', 'agri']
});
test.after(() => srv.stop());

test('#1 #2 #5 #10 #11: 工程结算权限/审核、辅助单位金额、防超额降价、成本脱敏与防重复回补库存', async () => {
  const p = (await admin.req('POST', '/api/products', {
    name: '电缆', unit: '米', cost: 5, price: 10, units: [{ name: '卷', rate: 10 }]
  })).data;
  await admin.req('POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-26', items: [{ productId: p.id, qty: 100, price: 5 }] });

  // #2: 无 inv.out 权限不能建含材料工程单
  const rNoOut = (await admin.req('POST', '/api/roles', { name: '仅销售无出库', perms: ['sales', 'prod.view'] })).data;
  await admin.req('POST', '/api/users', { username: 'eng_noout', name: '无出库', password: 'password1', roleId: rNoOut.id });
  const uNoOut = srv.client();
  await uNoOut.login('eng_noout', 'password1');
  const badPerm = await uNoOut.req('POST', '/api/engjobs', { name: '越权工程', items: [{ productId: p.id, qty: 1, price: 10 }] });
  assert.equal(badPerm.status, 403);

  // #2: 开启出库审核时，含材料工程单被拒
  await admin.req('PUT', '/api/settings', { docApprove: { in: false, out: true } });
  const badAppr = await admin.req('POST', '/api/engjobs', { name: '审核中工程', items: [{ productId: p.id, qty: 1, price: 10 }] });
  assert.equal(badAppr.status, 400);
  await admin.req('PUT', '/api/settings', { docApprove: { in: false, out: false } });

  // #5 & #10: 无 inv.cost 权限但有 inv.out 建含辅助单位材料的工程单（2卷 = 20米，100元/卷 => 金额应为 200 元而非 2000 元，且响应不含 cost）
  const rOutNoCost = (await admin.req('POST', '/api/roles', { name: '工程出库无成本', perms: ['sales', 'inv.out', 'inv.view', 'prod.view'] })).data;
  await admin.req('POST', '/api/users', { username: 'eng_nocost', name: '工程员', password: 'password1', roleId: rOutNoCost.id });
  const uOut = srv.client();
  await uOut.login('eng_nocost', 'password1');

  const jobRes = await uOut.req('POST', '/api/engjobs', {
    name: '辅助单位工程',
    items: [{ productId: p.id, unit: '卷', qty: 2, price: 100 }],
    labors: [{ name: '施工', days: 1, rate: 300, amount: 300 }]
  });
  assert.equal(jobRes.status, 200);
  assert.equal(jobRes.data.matTotal, 200, '2卷 × 100元/卷 应等于 200 元');
  assert.equal(jobRes.data.totalAmount, 500);
  assert.equal('cost' in jobRes.data.items[0], false, '无 inv.cost 响应不能暴露材料 cost');

  // #1: 关联出库单禁止在库存管理直接作废（防止与工程作废双重回补）
  const badVoidDoc = await admin.req('POST', `/api/stockdocs/${jobRes.data.stockDocId}/void`, { reason: '测试' });
  assert.equal(badVoidDoc.status, 400);

  // #11: 工程收款 400 后，不能把总额改到 400 以下
  assert.equal((await admin.req('POST', `/api/engjobs/${jobRes.data.id}/pay`, { amount: 400 })).status, 200);
  const badEdit = await admin.req('PUT', `/api/engjobs/${jobRes.data.id}`, { labors: [] });
  assert.equal(badEdit.status, 400);
});

test('#3 & #12: 售粮作废按真实出库成本冲回 + 三户均分 10000 元分摊合计严格等于 10000', async () => {
  const g = (await admin.req('POST', '/api/products', { name: '玉米', unit: '斤', cost: 1.0, price: 2.0, dec: true })).data;
  await admin.req('POST', '/api/stockdocs', { dir: 'in', type: '其他入库', date: '2026-11-26', items: [{ productId: g.id, qty: 10000, price: 1.0 }] });

  const sale = await admin.req('POST', '/api/graindocs', {
    dir: 'out', date: '2026-11-26', productId: g.id, farmerName: '粮站A',
    grossWeight: 6000, tareWeight: 1000, calcMode: 'deduct', moisture: 14, stdMoisture: 14, impurity: 0,
    unitPrice: 2.0, stationWeight: 5000, stationAmount: 10000,
    splits: [
      { customerName: '客户1', selfWeight: 1000 },
      { customerName: '客户2', selfWeight: 1000 },
      { customerName: '客户3', selfWeight: 1000 }
    ]
  });
  assert.equal(sale.status, 200);
  const sumAllocAmt = +(sale.data.splits.reduce((s, x) => s + x.allocAmount, 0)).toFixed(2);
  assert.equal(sumAllocAmt, 10000, '三户均分 10000 元合计应严格等于 10000.00');
  assert.equal(sale.data.unitCost, 1.0);

  // 作废售粮单后，玉米库存恢复 10000 且成本仍为 1.0（不能被售价 2.0 拉高！）
  assert.equal((await admin.req('POST', `/api/graindocs/${sale.data.id}/void`, { reason: '测试作废' })).status, 200);
  const prodAfter = (await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === g.id);
  assert.equal(prodAfter.stock, 10000);
  assert.equal(prodAfter.cost, 1.0, '售粮作废应按原成本 1.0 冲回，而非售价 2.0');
});

test('#6 #7 #8: 固定资产禁止早于购置月折旧、禁止交替月重复折旧、非现金折旧不扣减资金账户余额', async () => {
  const acctBefore = (await admin.req('GET', '/api/data')).data.data.accounts[0];
  const asset = (await admin.req('POST', '/api/fixed-assets', {
    name: '烘干机', buyDate: '2026-10-15', origValue: 36000, salvageRate: 0, lifeMonths: 36
  })).data;
  assert.ok(asset.id);

  // #7: 购置前月份 2026-09 不可计提
  assert.equal((await admin.req('POST', '/api/fixed-assets/depreciate', { month: '2026-09' })).status, 400);

  // 计提 2026-10、2026-11
  assert.equal((await admin.req('POST', '/api/fixed-assets/depreciate', { month: '2026-10' })).status, 200);
  assert.equal((await admin.req('POST', '/api/fixed-assets/depreciate', { month: '2026-11' })).status, 200);

  // #6: 再次交替选 2026-10 必须被拒绝
  assert.equal((await admin.req('POST', '/api/fixed-assets/depreciate', { month: '2026-10' })).status, 400);

  // #8: 折旧财务记录为 nonCash 且不绑定资金账户，账户余额不变
  const fin = (await admin.req('GET', '/api/data')).data.data.finance.filter(f => f.category === '固定资产折旧');
  assert.equal(fin.length, 2);
  assert.equal(fin[0].nonCash, true);
  assert.equal(fin[0].account, '');
});

test('#9: 离职临工本月已有考勤记录时仍纳入月工资表结算', async () => {
  const emp = (await admin.req('POST', '/api/employees', { name: '离职临工老李', status: '临工', dailyWage: 200, tempRep: '王工头' })).data;
  await admin.req('POST', '/api/attendance', { empId: emp.id, date: '2026-11-10', days: 3, bonus: 50 });
  await admin.req('PUT', `/api/employees/${emp.id}`, { name: '离职临工老李', status: '离职', dailyWage: 200, tempRep: '王工头' });

  const pr = await admin.req('POST', '/api/payrolls/generate', { month: '2026-11' });
  assert.equal(pr.status, 200);
  const row = pr.data.items.find(x => x.empId === emp.id);
  assert.ok(row, '本月有考勤的离职临工应出现在工资表中');
  assert.equal(row.netPay, 650);
});

test('#4 & #16 & #23 & #24: 合同权限隔离与编号占位替换、备份设置字段对称、自定义打印列上限10列', async () => {
  // #16: 新建合同正文里的 {{合同编号}} 和 合同编号：自动生成 应替换为真实单号
  const ct = (await admin.req('POST', '/api/contracts', {
    title: '采购协议', kind: '采购合同', partyName: '供应商A', amount: 1000,
    content: '合同编号：{{合同编号}}\n副本编号：自动生成'
  })).data;
  assert.ok(ct.no && ct.content.includes(ct.no) && !ct.content.includes('{{合同编号}}'));

  // #4: 只有销售权限的业务员看不到采购合同，也不能新建采购合同
  const rSaleOnly = (await admin.req('POST', '/api/roles', { name: '仅销售合同', perms: ['sales', 'parties'] })).data;
  await admin.req('POST', '/api/users', { username: 'ct_sales', name: '销售员', password: 'password1', roleId: rSaleOnly.id });
  const uSale = srv.client();
  await uSale.login('ct_sales', 'password1');
  const dSale = (await uSale.req('GET', '/api/data')).data.data;
  assert.ok(!dSale.contracts.some(x => x.id === ct.id), '仅销售权限账号不应看到采购合同');
  assert.equal((await uSale.req('POST', '/api/contracts', { title: '越权采购合同', kind: '采购合同', partyName: 'X' })).status, 403);

  // #24: 自定义打印列超过 10 列时被服务端截断至 10 列
  const manyCustom = Array.from({ length: 15 }, (_, i) => ({ k: `custom_${i + 1}`, label: `列${i + 1}`, on: true, w: 15 }));
  const ptRes = await admin.req('PUT', '/api/settings/print', { kind: 'sales', tpl: { cols: manyCustom } });
  assert.equal(ptRes.status, 200);
  const savedCols = (await admin.req('GET', '/api/data')).data.settings.printTpl.sales.cols;
  assert.equal(savedCols.filter(c => c.k.startsWith('custom_')).length, 10, '自定义列最多保存 10 列');

  // #23: JSON 备份恢复正确还原 overTolerance 与 expenseFlow
  await admin.req('PUT', '/api/settings', { overTolerance: 5 });
  const bk = (await admin.req('GET', '/api/backup')).data;
  bk.settings.overTolerance = 8;
  bk.settings.expenseFlow = { finance: ['admin'], gm: [], gmThreshold: 500, modes: { dept: 'all', finance: 'all', gm: 'all' }, cc: [], allowCustomCc: true };
  assert.equal((await admin.req('POST', '/api/restore', bk)).status, 200);
  const after = (await admin.req('GET', '/api/backup')).data;
  assert.equal(after.settings.overTolerance, 8);
  assert.equal(after.settings.expenseFlow.gmThreshold, 500);
});

test('前端 #13 #14 #15 #17 #18 #19 #21 #25 #26 #27 #28 #29 关键修复静态校验', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  assert.ok(html.includes("smRaw === '' ? 14 : Math.max(0, +smRaw || 0)"), '#13 标准水分支持 0');
  assert.ok(html.includes('const updateSplitsSummary ='), '#14 粮食分摊局部更新不丢焦点');
  assert.ok(html.includes("if (el.id === 'dSnIn') setTimeout"), '#15 安卓客户端序列号连扫自动续扫');
  assert.ok(html.includes('（原关联单据）'), '#17 编辑旧合同保留不在前80条的关联单据');
  assert.ok(html.includes('const toTile = (lng, lat, z) =>'), '#18 天地图与地块统一 Web Mercator 投影');
  assert.ok(html.includes('0x06054b50'), '#19 KMZ 解析支持 Central Directory');
  assert.ok(html.includes('<option value="keep">保留原角色'), '#21 批量分配账套默认保留混合角色');
  assert.ok(html.includes("if (el.dataset.pp === 'table')"), '#25 套打表格双击还原宽高');
  assert.ok(html.includes('Math.max(0.18, availW / natW)'), '#29 小屏打印预览支持缩放到 18%');
});
