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

async function startServer(dataDir) {
  const port = await freePort();
  const proc = spawn(NODE, [path.join(ROOT, 'src/server.js'), '--port', String(port), '--data', dataDir], {
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

test('#160-#165 全部 5 项新功能端到端回归测试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-batch2-'));
  const srv = await startServer(dir);
  try {
    const admin = await login(srv.port, 'admin', 'admin123');
    const allModKeys = Object.keys((await admin.req('GET', '/api/data')).data.meta?.modules || {});
    await admin.req('PUT', '/api/settings', { modules: [...new Set([...allModKeys, 'agri'])] });

    // ---------- #160/#161 序列号提交后修改并同步关联单据与流水 ----------
    const pSn = (await admin.req('POST', '/api/products', { name: '主板', sku: 'MB-01', unit: '块', serial: true, cost: 200, price: 350 })).data;
    assert.equal((await admin.req('POST', '/api/stockdocs', {
      dir: 'in', type: '采购入库', date: '2026-11-28',
      items: [{ productId: pSn.id, qty: 2, price: 200, serials: ['SN-WRONG-01', 'SN-OK-02'] }]
    })).status, 200);
    assert.equal((await admin.req('POST', '/api/stockdocs', {
      dir: 'out', type: '销售出库', date: '2026-11-28',
      items: [{ productId: pSn.id, qty: 1, sale: 350, serials: ['SN-WRONG-01'] }]
    })).status, 200);

    const d0 = (await admin.req('GET', '/api/data')).data.data;
    const snRec = d0.serials.find(r => r.sn === 'SN-WRONG-01');
    assert.ok(snRec, '已登记序列号 SN-WRONG-01');

    // 重复序列号修改应被拒绝
    assert.equal((await admin.req('PUT', `/api/serials/${snRec.id}`, { sn: 'SN-OK-02' })).status, 400);

    // 正确修正序列号并同步全部单据与流水
    const editSn = await admin.req('PUT', `/api/serials/${snRec.id}`, { sn: 'SN-FIXED-01', reason: '录入笔误' });
    assert.equal(editSn.status, 200);
    assert.equal(editSn.data.sn, 'SN-FIXED-01');
    assert.ok(editSn.data.updatedRefs >= 4, '应同步更新出入库单与出入库流水');

    const d1 = (await admin.req('GET', '/api/data')).data.data;
    assert.ok(!d1.serials.some(r => r.sn === 'SN-WRONG-01'), '旧序列号已不存在');
    assert.ok(d1.serials.some(r => r.sn === 'SN-FIXED-01'), '新序列号存在');
    assert.ok(d1.stockDocs.every(doc => doc.items.every(i => !(i.serials || []).includes('SN-WRONG-01'))), '出入库单均不再含旧序列号');
    assert.ok(d1.stockLogs.every(l => !(l.serials || []).includes('SN-WRONG-01')), '库存流水均不再含旧序列号');

    // ---------- #162 维修工单完整流转（登记→追加领料→流转→收款→作废冲回） ----------
    const pPart = (await admin.req('POST', '/api/products', { name: '电机配件', sku: 'PT-01', unit: '个', cost: 50, price: 100, stock: 20 })).data;
    const cust = (await admin.req('POST', '/api/customers', { name: '维修客户A', phone: '13800001111' })).data;
    const rpRes = await admin.req('POST', '/api/repairs', {
      deviceName: '电动三轮车', deviceModel: 'X8', serialNo: 'DEV-888', customerId: cust.id,
      faultDesc: '电机异响', laborFee: 80, otherFee: 20, parts: [{ productId: pPart.id, qty: 2, price: 100 }]
    });
    assert.equal(rpRes.status, 200, '新建维修工单失败: ' + JSON.stringify(rpRes.data));
    const rp = rpRes.data;
    assert.equal(rp.totalAmount, 300, '配件200 + 工时80 + 其他20 = 300');
    assert.ok(rp.stockDocId, '领料自动生成出库单');
    assert.equal((await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === pPart.id).stock, 18, '领用 2 个配件后库存应为 18');

    // 状态流转 + 追加领料 1 个配件
    const rpUpd = await admin.req('PUT', `/api/repairs/${rp.id}`, {
      status: '已完工', diagnosis: '更换电机轴承', addParts: [{ productId: pPart.id, qty: 1, price: 100 }]
    });
    assert.equal(rpUpd.status, 200);
    assert.equal(rpUpd.data.status, '已完工');
    assert.equal(rpUpd.data.totalAmount, 400);
    assert.equal((await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === pPart.id).stock, 17, '追加领料后库存应为 17');

    // 维修收款
    const acctId = d1.accounts[0].id;
    const rpPay = await admin.req('POST', `/api/repairs/${rp.id}/pay`, { amount: 400, account: acctId });
    assert.equal(rpPay.status, 200);
    assert.equal(rpPay.data.paid, 400);

    // 另一张工单作废冲回库存
    const rp2 = (await admin.req('POST', '/api/repairs', {
      deviceName: '打印机', customerId: cust.id, parts: [{ productId: pPart.id, qty: 2, price: 100 }]
    })).data;
    assert.equal((await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === pPart.id).stock, 15);
    assert.equal((await admin.req('POST', `/api/repairs/${rp2.id}/void`, { reason: '客户取消' })).status, 200);
    assert.equal((await admin.req('GET', '/api/data')).data.data.products.find(x => x.id === pPart.id).stock, 17, '作废维修工单应冲回配件库存');

    // ---------- #163 田间管理批量地块 + 关联领料出库单 ----------
    const pl1 = (await admin.req('POST', '/api/field-plots', { name: '东区1号田', areaMu: 12.5, crop: '水稻', coords: [[104.06, 30.57], [104.07, 30.57], [104.07, 30.58]] })).data;
    const pl2 = (await admin.req('POST', '/api/field-plots', { name: '东区2号田', areaMu: 8.5, crop: '水稻', coords: [[104.08, 30.57], [104.09, 30.57], [104.09, 30.58]] })).data;
    const outFarm = (await admin.req('POST', '/api/stockdocs', {
      dir: 'out', type: '领料出库', date: '2026-11-28', project: '春耕施肥',
      items: [{ productId: pPart.id, qty: 3 }]
    })).data;
    const flRes = await admin.req('POST', '/api/farm-logs', {
      plotIds: [pl1.id, pl2.id], date: '2026-11-28', crop: '水稻', task: '无人机飞防施肥', stockDocId: outFarm.id
    });
    assert.equal(flRes.status, 200);
    assert.equal(flRes.data.plotName, '东区1号田、东区2号田');
    assert.equal(flRes.data.stockDocNo, outFarm.no);
    assert.equal(flRes.data.materials.length, 1);
    assert.equal(flRes.data.materials[0].qty, 3);

    // ---------- #164 销售出库与销售订单打通 ----------
    const sdAuto = await admin.req('POST', '/api/stockdocs', {
      dir: 'out', type: '销售出库', date: '2026-11-28', party: cust.name, autoCreateSale: true,
      items: [{ productId: pPart.id, qty: 2, sale: 120 }]
    });
    assert.equal(sdAuto.status, 200, '同步生成销售单失败: ' + JSON.stringify(sdAuto.data));
    assert.equal(sdAuto.data.srcOrderKind, 'sales');
    assert.ok(sdAuto.data.srcOrderId, '销售出库单应已关联自动生成的销售订单');

    const sdManual = (await admin.req('POST', '/api/stockdocs', {
      dir: 'out', type: '销售出库', date: '2026-11-28', party: cust.name,
      items: [{ productId: pPart.id, qty: 1, sale: 120 }]
    })).data;
    assert.ok(!sdManual.srcOrderId);
    const linkRes = await admin.req('POST', `/api/stockdocs/${sdManual.id}/link-sale`, { customerId: cust.id });
    assert.equal(linkRes.status, 200);
    assert.equal(linkRes.data.sale.status, '已完成');
    assert.equal(linkRes.data.stockDoc.srcOrderId, linkRes.data.sale.id);

    // ---------- #165 58mm / 80mm 热敏购物小票打印模板 ----------
    assert.equal((await admin.req('PUT', '/api/settings/print', { kind: 'sales', tpl: { paper: 'pos58', receiptBarcode: true, footer: '谢谢惠顾' } })).status, 200);
    const pt58 = (await admin.req('GET', '/api/data')).data.settings.printTpl.sales;
    assert.equal(pt58.paper, 'pos58');
    assert.equal(pt58.receiptBarcode, true);
    assert.equal((await admin.req('PUT', '/api/settings/print', { kind: 'out', tpl: { paper: 'pos80' } })).status, 200);
    assert.equal((await admin.req('GET', '/api/data')).data.settings.printTpl.out.paper, 'pos80');

    // ---------- 采购上传采购单据备查 & 支付上传支付单备查 ----------
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const sup = (await admin.req('POST', '/api/suppliers', { name: '凭证供应商' })).data;
    const po = (await admin.req('POST', '/api/orders/purchase', {
      partyId: sup.id, date: '2026-11-28', items: [{ productId: pPart.id, qty: 2, price: 50 }]
    })).data;
    const poUp = await admin.req('POST', `/api/orders/purchase/${po.id}/images`, { data: tinyPng });
    assert.equal(poUp.status, 200);
    assert.equal(poUp.data.imgs.length, 1);
    const poImgRes = await fetch(`http://127.0.0.1:${srv.port}/api/orders/purchase/${po.id}/images/${poUp.data.key}`, {
      headers: { Authorization: 'Bearer ' + admin.token }
    });
    assert.equal(poImgRes.status, 200);
    assert.equal(poImgRes.headers.get('content-type'), 'image/png');
    assert.equal((await admin.req('DELETE', `/api/orders/purchase/${po.id}/images/${poUp.data.key}`)).status, 200);

    // 采购付款返回 lastFinanceId，并可上传/读取/删除支付单凭证
    const payRes = await admin.req('POST', `/api/orders/purchase/${po.id}/pay`, { amount: 100, account: acctId, date: '2026-11-28' });
    assert.equal(payRes.status, 200);
    assert.ok(payRes.data.lastFinanceId, '订单支付应返回新建的 lastFinanceId');
    const finUp = await admin.req('POST', `/api/finance/${payRes.data.lastFinanceId}/images`, { data: tinyPng });
    assert.equal(finUp.status, 200);
    assert.equal(finUp.data.imgs.length, 1);
    const finImgRes = await fetch(`http://127.0.0.1:${srv.port}/api/finance/${payRes.data.lastFinanceId}/images/${finUp.data.key}`, {
      headers: { Authorization: 'Bearer ' + admin.token }
    });
    assert.equal(finImgRes.status, 200);
    assert.equal(finImgRes.headers.get('content-type'), 'image/png');
    assert.equal((await admin.req('DELETE', `/api/finance/${payRes.data.lastFinanceId}/images/${finUp.data.key}`)).status, 200);
  } finally {
    srv.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('#160-#165 前端 UI 静态校验', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  assert.ok(html.includes('function snEdit(id)'), '#160/#161 序列号修改弹窗');
  assert.ok(html.includes('function pageRepairs()') && html.includes('function repairView(id)'), '#162 维修工单页面与详情流转');
  assert.ok(html.includes('function extractTdtKey(raw)') && html.includes('function exportPlotsKml(') && html.includes('plotDrawBtn') && html.includes('mapFullBtn'), '#163 天地图提取tk/导出KML/勾画/全屏');
  assert.ok(html.includes('dAutoSale') && html.includes('docLinkSale'), '#164 销售出库同步与补转销售单');
  assert.ok(html.includes("pos58:['58mm 热敏小票'") && html.includes("pos80:['80mm 热敏小票'") && html.includes('function receiptBarcodeSvg('), '#165 58mm/80mm 热敏小票与条码');
  assert.ok(html.includes('let lastInput = null;\nif (NATIVE)'), '安卓客户端 lastInput 应提升到顶层作用域');
  assert.ok(html.includes('function grainSettleModal()') && html.includes('grainSettlePrint') && html.includes('粮食${isOut ? \'销售\' : \'收购\'}过磅结算单'), '粮食单车与多车汇总结算单打印');

  // 农资二维码解析真实场景全面测试
  const m = html.match(/\/\* __AGRI_QR_CORE_START__ \*\/([\s\S]*?)\/\* __AGRI_QR_CORE_END__ \*\//);
  assert.ok(m, '找到 parseAgriQr 核心代码块');
  const parseAgriQr = new Function(`${m[1]}; return parseAgriQr;`)();

  // 1. 真实百农思达农资追溯码（含中文前缀“追溯网址：”及无 http:// 前缀）
  const qReal1 = parseAgriQr('追溯网址：http://bainongsida.com/c/z.aspx?m=c01&c=12120132131251895405020465177544');
  assert.ok(qReal1 && qReal1.matched, '带“追溯网址：”前缀的真实百农思达农资码应成功识别');
  assert.equal(qReal1.barcode, '121201321312');
  assert.equal(qReal1.traceCode, '12120132131251895405020465177544');
  assert.equal(qReal1.regNo, 'PD2120132');
  const qReal2 = parseAgriQr('bainongsida.com/c/z.aspx?m=c01&c=12120132131251895405020465177544');
  assert.equal(qReal2.barcode, '121201321312', '无 http:// 前缀同样识别出相同条码');

  // 2. 国家 32 位农药追溯 URL（两瓶不同随机码 -> 同商品条码前 12 位一致 + 拆出 PD 证号与生产日期）
  const q1 = parseAgriQr('http://www.chinapesticide.org.cn/qr/12018123100126050111111111111111');
  const q2 = parseAgriQr('http://www.chinapesticide.org.cn/qr/12018123100126050199999999999999');
  assert.equal(q1.barcode, '120181231001');
  assert.equal(q2.barcode, '120181231001', '同款农药第二瓶应得到相同商品条码前缀');
  assert.equal(q1.regNo, 'PD2018123');
  assert.equal(q1.prodDate, '2026-05-01');

  // 2. 厂家自定义追溯短链与带查询参数 URL
  const q3 = parseAgriQr('https://qr.nongzi.cn/t/NZ88990011');
  assert.equal(q3.barcode, 'NZ88990011');
  const q4 = parseAgriQr('https://z.xxx.com/trace?code=6901234567890&batch=B202601&name=%E9%98%BF%E7%BB%B4%E8%8F%8C%E7%B4%A0');
  assert.equal(q4.barcode, '6901234567890');
  assert.equal(q4.batchNo, 'B202601');
  assert.equal(q4.name, '阿维菌素');

  // 3. 普通 69 商品条码
  const q5 = parseAgriQr('6901234567890');
  assert.equal(q5.barcode, '6901234567890');

  // 4. 键值对文本
  const q6 = parseAgriQr('品名: 吡虫啉\n规格: 100ml\n登记证号: PD20190001\n批号: 202605');
  assert.equal(q6.name, '吡虫啉');
  assert.equal(q6.spec, '100ml');
  assert.equal(q6.regNo, 'PD20190001');
  assert.equal(q6.batchNo, '202605');
});
