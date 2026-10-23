'use strict';
/**
 * x.erp 专业版订单后台（发码方本机使用）
 *
 *   node tools/orders.js [--port 8690] [--no-open]
 *
 * 在本机打开一个只有自己能访问的网页（仅监听 127.0.0.1）：记录谁买了、付了多少、什么时候付的，
 * 确认收款后一键签发授权码，并生成可直接发给客户的微信消息；支持续费、搜索、导出。
 *
 * 数据：%USERPROFILE%\.xerp-license\orders.json（和私钥在同一目录，密钥备份工具会一起备份）
 * 用 license.js 命令行签发过的授权码，启动时会自动补进订单列表。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const lic = require('./license.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DB = path.join(lic.DIR, 'orders.json');
const TOKEN = crypto.randomBytes(16).toString('hex');
const today = () => lic.ymd(new Date());

// ---------- 数据 ----------
function load() {
  if (!fs.existsSync(DB)) return { orders: [] };
  return JSON.parse(fs.readFileSync(DB, 'utf8'));
}
function save(db) {
  fs.mkdirSync(lic.DIR, { recursive: true });
  if (fs.existsSync(DB)) fs.copyFileSync(DB, DB + '.bak');
  fs.writeFileSync(DB + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB + '.tmp', DB);
}
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function nextNo(db) {
  const prefix = 'D' + today().replace(/-/g, '') + '-';
  const n = db.orders.filter(o => o.no.startsWith(prefix)).length + 1;
  return prefix + String(n).padStart(3, '0');
}
// 命令行签发、但还不在订单里的授权码，补成订单（金额未知，留空）
function importIssued(db) {
  if (!fs.existsSync(lic.LOG)) return 0;
  const known = new Set(db.orders.flatMap(o => o.licenses.map(l => l.id)));
  let n = 0;
  for (const [id, to, iat, upd, note, key] of parseCsv(fs.readFileSync(lic.LOG, 'utf8')).slice(1)) {
    if (!id || !key || known.has(id)) continue;
    db.orders.push({
      no: nextNo(db), customer: to, contact: '', phone: '', note: [note, '从签发记录导入'].filter(Boolean).join('；'),
      status: 'active', createdAt: new Date().toISOString(),
      licenses: [{ id, key, iat, upd, years: null, kind: 'new', amount: null, pay: '', paidAt: iat }],
    });
    known.add(id); n++;
  }
  return n;
}

// ---------- 业务 ----------
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const money = v => { if (v === '' || v == null) return null; const n = Number(v); if (!(n >= 0 && n < 1e7)) throw new Error('金额不正确'); return Math.round(n * 100) / 100; };
const date = v => { v = str(v, 10) || today(); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('日期格式应为 2026-10-23'); return v; };
const latest = o => o.licenses.reduce((a, l) => (!a || l.upd > a.upd ? l : a), null);
const findOrder = (db, no) => db.orders.find(o => o.no === no) || (() => { throw new Error('找不到订单 ' + no); })();

function payment(b) {
  return { amount: money(b.amount), pay: str(b.pay, 20), paidAt: date(b.paidAt), years: Number(b.years) || 1 };
}
function createOrder(b) {
  const db = load();
  const customer = str(b.customer, 60);
  if (!customer) throw new Error('请填写客户（公司名称）');
  const p = payment(b);
  const r = lic.issue({ to: customer, years: p.years, note: '订单后台' });
  const o = {
    no: nextNo(db), customer, contact: str(b.contact, 60), phone: str(b.phone, 30), note: str(b.note, 500),
    status: 'active', createdAt: new Date().toISOString(),
    licenses: [{ id: r.id, key: r.key, iat: r.iat, upd: r.upd, kind: 'new', ...p }],
  };
  db.orders.push(o); save(db);
  return { order: o, license: o.licenses[0] };
}
function renewOrder(no, b) {
  const db = load(), o = findOrder(db, no);
  if (o.status === 'void') throw new Error('订单已作废，不能续费');
  const p = payment(b), last = latest(o);
  const r = lic.issue({ to: o.customer, years: p.years, note: '续费 ' + o.no, from: last && last.upd });
  const l = { id: r.id, key: r.key, iat: r.iat, upd: r.upd, kind: 'renew', ...p };
  o.licenses.push(l); save(db);
  return { order: o, license: l };
}
function editOrder(no, b) {
  const db = load(), o = findOrder(db, no);
  for (const k of ['contact', 'phone']) if (k in b) o[k] = str(b[k], 60);
  if ('note' in b) o.note = str(b.note, 500);
  if (o.status === 'void' && b.restore) { o.status = 'active'; delete o.voidReason; }
  save(db); return { order: o };
}
function voidOrder(no, b) {
  const db = load(), o = findOrder(db, no);
  o.status = 'void'; o.voidReason = str(b.reason, 200); o.voidAt = today();
  save(db); return { order: o };
}
function exportCsv() {
  const head = ['订单号', '客户', '微信', '电话', '类型', '金额', '付款方式', '付款日期', '授权编号', '签发日期', '免费升级截止', '订单状态', '备注', '授权码'];
  const rows = load().orders.flatMap(o => o.licenses.map(l => [o.no, o.customer, o.contact, o.phone, l.kind === 'renew' ? '续费' : '新购',
    l.amount ?? '', l.pay, l.paidAt, l.id, l.iat, l.upd, o.status === 'void' ? '已作废' : '正常', o.note, l.key]));
  return '﻿' + [head, ...rows].map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n') + '\r\n';
}

// ---------- 服务 ----------
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) { bad(new Error('请求太大')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new Error('请求格式错误')); } });
  });
}

let PORT = Number(arg('port', process.env.XERP_ORDERS_PORT || 8690));
const server = http.createServer(async (req, res) => {
  // 只认 127.0.0.1 / localhost 访问，防止别的网页借浏览器调用（DNS rebinding）
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE.replace('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
    if (req.headers['x-token'] !== TOKEN && url.searchParams.get('t') !== TOKEN) return send(res, 403, { error: '页面已过期，请关掉重新打开订单后台' });
    if (req.method === 'GET' && url.pathname === '/api/data') {
      return send(res, 200, { orders: load().orders, today: today(), keyDir: lic.DIR, hasKey: fs.existsSync(lic.PRIV) });
    }
    if (req.method === 'GET' && url.pathname === '/api/export.csv') {
      return send(res, 200, exportCsv(), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('x.erp订单-' + today() + '.csv')}` });
    }
    if (req.method === 'POST') {
      const b = await readBody(req);
      let m;
      if (url.pathname === '/api/orders') return send(res, 200, createOrder(b));
      if ((m = /^\/api\/orders\/([\w-]+)\/renew$/.exec(url.pathname))) return send(res, 200, renewOrder(m[1], b));
      if ((m = /^\/api\/orders\/([\w-]+)\/void$/.exec(url.pathname))) return send(res, 200, voidOrder(m[1], b));
      if ((m = /^\/api\/orders\/([\w-]+)$/.exec(url.pathname))) return send(res, 200, editOrder(m[1], b));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

function start() {
  const db = load(), n = importIssued(db);
  if (n) save(db);
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && PORT < 8700) { PORT++; return start(); }
    console.error(e.message); process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`x.erp 订单后台已启动：${url}\n数据文件：${DB}${n ? `\n已从签发记录补入 ${n} 条订单` : ''}\n\n用完关掉这个窗口即可。`);
    if (!fs.existsSync(lic.PRIV)) console.log(`\n⚠ 没找到授权私钥 ${lic.PRIV}，暂时不能发码。`);
    if (!argv.includes('--no-open') && process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  });
}
start();

// ---------- 页面 ----------
const PAGE = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>x.erp 订单后台</title>
<style>
:root{--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--mute:#6e6e73;--line:#e5e5ea;--acc:#0071e3;--ok:#1a7f37;--warn:#b35900;--bad:#c9341f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:5}
header h1{font-size:17px;margin:0}.sp{flex:1}
main{max-width:1180px;margin:0 auto;padding:20px 24px 60px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.stat{background:var(--card);border-radius:12px;padding:14px 16px}.stat b{display:block;font-size:22px}.stat span{color:var(--mute);font-size:12px}
.card{background:var(--card);border-radius:12px;padding:16px 18px;margin-bottom:16px}
.card h2{font-size:15px;margin:0 0 12px}
.tablewrap{overflow-x:auto}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px 12px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mute)}
label.wide{grid-column:span 2}
input,select,textarea{font:inherit;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 9px;background:#fff;width:100%}
input:focus,select:focus,textarea:focus{outline:2px solid #0071e333;border-color:var(--acc)}
button{font:inherit;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;background:#e8e8ed;color:var(--fg)}
button.pri{background:var(--acc);color:#fff}button.danger{color:var(--bad)}button.link{background:none;padding:2px 6px;color:var(--acc)}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tools{display:flex;gap:10px;align-items:center;margin-bottom:10px}.tools input{max-width:320px}.tools select{width:auto}.tools .sub{white-space:nowrap}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--mute);font-weight:500}td.num{text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;font-size:12px;border-radius:6px;padding:1px 7px;background:#e8f5ec;color:var(--ok)}
.tag.warn{background:#fff3e0;color:var(--warn)}.tag.bad{background:#fde8e5;color:var(--bad)}.tag.void{background:#eee;color:var(--mute)}
.sub{color:var(--mute);font-size:12px}
tr.detail td{background:#fafafa}
.lic{display:grid;grid-template-columns:80px 90px 1fr auto;gap:4px 12px;align-items:center;padding:6px 0;border-top:1px dashed var(--line)}
.key{font-family:Consolas,monospace;font-size:12px;word-break:break-all;color:#333}
.modal{position:fixed;inset:0;background:#0006;display:none;align-items:center;justify-content:center;z-index:10}
.modal.show{display:flex}.box{background:#fff;border-radius:14px;padding:20px 22px;width:min(620px,94vw);max-height:90vh;overflow:auto}
.box h3{margin:0 0 12px;font-size:16px}
.msg{white-space:pre-wrap;word-break:break-all;background:#f5f5f7;border-radius:8px;padding:12px;font-size:13px;margin:10px 0}
.toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:#1d1d1f;color:#fff;padding:9px 16px;border-radius:10px;opacity:0;transition:.2s;pointer-events:none;z-index:20}
.toast.show{opacity:1}
.warnbar{background:#fde8e5;color:var(--bad);padding:10px 14px;border-radius:10px;margin-bottom:16px;display:none}
@media(max-width:800px){.stats,.grid{grid-template-columns:1fr 1fr}}
</style></head><body>
<header><h1>x.erp 订单后台</h1><span class="sub">只在本机运行 · 数据存在私钥同一目录</span><span class="sp"></span>
<button onclick="exportCsv()">导出 Excel（CSV）</button></header>
<main>
<div class="warnbar" id="nokey"></div>
<div class="stats" id="stats"></div>

<div class="card">
  <h2>新订单：确认收款后发码</h2>
  <form id="newForm" class="grid" autocomplete="off">
    <label class="wide">客户（公司 / 店名，会写进授权码）*<input name="customer" required maxlength="60" placeholder="例如：张三的便利店"></label>
    <label>微信号 / 昵称<input name="contact" maxlength="60"></label>
    <label>电话<input name="phone" maxlength="30"></label>
    <label>金额（元）<input name="amount" type="number" min="0" step="0.01" value="299"></label>
    <label>付款方式<select name="pay"><option>微信</option><option>支付宝</option><option>转账</option><option>其他</option></select></label>
    <label>付款日期<input name="paidAt" type="date"></label>
    <label>免费升级年数<select name="years"><option value="1">1 年</option><option value="2">2 年</option><option value="3">3 年</option></select></label>
    <label class="wide" style="grid-column:span 3">备注<input name="note" maxlength="500" placeholder="开票信息、装在哪台 NAS 等"></label>
    <div class="row" style="align-items:flex-end"><button class="pri" type="submit">确认已收款，发码</button></div>
  </form>
</div>

<div class="card">
  <div class="tools"><input id="q" placeholder="搜索 客户 / 微信 / 电话 / 订单号 / 授权编号" oninput="render()">
    <select id="f" onchange="render()"><option value="">全部</option><option value="soon">30 天内升级到期</option><option value="exp">升级已到期</option><option value="void">已作废</option></select>
    <span class="sp"></span><span class="sub" id="count"></span></div>
  <div class="tablewrap"><table><thead><tr><th>订单号</th><th>客户</th><th>联系方式</th><th class="num">累计金额</th><th>免费升级截止</th><th>状态</th><th></th></tr></thead>
  <tbody id="list"></tbody></table></div>
</div>
</main>

<div class="modal" id="modal"><div class="box" id="box"></div></div>
<div class="toast" id="toast"></div>

<script>
const TOKEN = '__TOKEN__';
let DATA = { orders: [] }, open = new Set();
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const yuan = n => n == null ? '—' : '¥' + Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const toast = t => { const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), 1800); };

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify(body) } : { headers: { 'X-Token': TOKEN } });
  const j = await r.json().catch(() => ({ error: '服务没有响应，订单后台窗口是不是关了？' }));
  if (!r.ok || j.error) throw new Error(j.error || '出错了');
  return j;
}
async function reload() { DATA = await api('/api/data'); render(); }

const latest = o => o.licenses.reduce((a, l) => (!a || l.upd > a.upd ? l : a), null);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
function state(o) {
  if (o.status === 'void') return ['void', '已作废'];
  const u = latest(o)?.upd || '';
  if (u < DATA.today) return ['bad', '升级已到期'];
  if (u <= addDays(DATA.today, 30)) return ['warn', '30 天内到期'];
  return ['', '正常'];
}
const total = o => o.licenses.reduce((s, l) => s + (l.amount || 0), 0);

function render() {
  const ords = DATA.orders, t = DATA.today, ym = t.slice(0, 7);
  const live = ords.filter(o => o.status !== 'void');
  const all = live.flatMap(o => o.licenses);
  $('#stats').innerHTML = [
    [live.length, '有效订单'],
    [yuan(all.reduce((s, l) => s + (l.amount || 0), 0)), '累计收入'],
    [yuan(all.filter(l => (l.paidAt || '').startsWith(ym)).reduce((s, l) => s + (l.amount || 0), 0)), '本月收入'],
    [live.filter(o => state(o)[0] === 'warn').length, '30 天内升级到期（可提醒续费）'],
  ].map(([v, k]) => '<div class="stat"><b>' + esc(v) + '</b><span>' + k + '</span></div>').join('');
  $('#nokey').style.display = DATA.hasKey ? 'none' : 'block';
  $('#nokey').textContent = '没找到授权私钥（' + DATA.keyDir + '\\private.pem），现在不能发码。请先用密钥备份恢复，或运行 node tools/license.js init。';

  const q = $('#q').value.trim().toLowerCase(), f = $('#f').value;
  const rows = ords.filter(o => {
    const s = state(o)[0];
    if (f === 'soon' && s !== 'warn') return false;
    if (f === 'exp' && s !== 'bad') return false;
    if (f === 'void' && s !== 'void') return false;
    if (!q) return true;
    return [o.no, o.customer, o.contact, o.phone, o.note, ...o.licenses.map(l => l.id)].join(' ').toLowerCase().includes(q);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#count').textContent = '共 ' + rows.length + ' 条';
  $('#list').innerHTML = rows.map(o => {
    const [cls, txt] = state(o), l = latest(o), isOpen = open.has(o.no);
    return '<tr><td>' + esc(o.no) + '</td><td><b>' + esc(o.customer) + '</b>' + (o.note ? '<div class="sub">' + esc(o.note) + '</div>' : '') + '</td>'
      + '<td>' + esc(o.contact || '—') + (o.phone ? '<div class="sub">' + esc(o.phone) + '</div>' : '') + '</td>'
      + '<td class="num">' + yuan(total(o)) + '<div class="sub">' + o.licenses.length + ' 次付款</div></td>'
      + '<td>' + esc(l?.upd || '—') + '</td><td><span class="tag ' + cls + '">' + txt + '</span></td>'
      + '<td style="white-space:nowrap"><button class="link" onclick="toggle(\'' + o.no + '\')">' + (isOpen ? '收起' : '授权码') + '</button>'
      + (o.status === 'void' ? '<button class="link" onclick="restore(\'' + o.no + '\')">恢复</button>'
        : '<button class="link" onclick="renew(\'' + o.no + '\')">续费</button><button class="link" onclick="edit(\'' + o.no + '\')">编辑</button>')
      + '</td></tr>'
      + (isOpen ? '<tr class="detail"><td></td><td colspan="6">' + o.licenses.slice().reverse().map(x =>
        '<div class="lic"><span>' + (x.kind === 'renew' ? '续费' : '新购') + ' ' + yuan(x.amount) + '</span><span class="sub">' + esc(x.pay || '') + ' ' + esc(x.paidAt || '') + '</span>'
        + '<div><div class="sub">编号 ' + esc(x.id) + ' · 签发 ' + esc(x.iat) + ' · 免费升级至 ' + esc(x.upd) + '</div><div class="key">' + esc(x.key) + '</div></div>'
        + '<div class="row"><button onclick="copyKey(\'' + o.no + '\',\'' + x.id + '\')">复制授权码</button><button onclick="copyMsg(\'' + o.no + '\',\'' + x.id + '\')">复制微信消息</button></div></div>').join('')
        + (o.status === 'void' ? '<div class="sub">作废于 ' + esc(o.voidAt) + '：' + esc(o.voidReason || '') + '</div>'
          : '<div style="margin-top:8px"><button class="danger" onclick="voidIt(\'' + o.no + '\')">作废订单（退款时用）</button></div>')
        + '</td></tr>' : '');
  }).join('') || '<tr><td colspan="7" class="sub" style="text-align:center;padding:30px">还没有订单。收到第一笔款后，在上面填好客户名称，点「确认已收款，发码」。</td></tr>';
}

function message(o, l) {
  return '您好，感谢购买 x.erp 专业版！授权码如下（请完整复制，以 XERP- 开头）：\n\n' + l.key
    + '\n\n激活方法：打开 x.erp → 系统设置 → 专业版，粘贴授权码，点「激活」。\n'
    + '授权对象：' + o.customer + '\n'
    + '免费升级截止：' + l.upd + '（在此之前发布的新版本都能免费升级；到期后已经装好的版本照常使用）\n'
    + '一个授权码用于一套 x.erp，局域网里多少人用都可以。有问题随时找我。';
}
const find = (no, id) => { const o = DATA.orders.find(x => x.no === no); return [o, o.licenses.find(x => x.id === id)]; };
async function copy(t) {
  try { await navigator.clipboard.writeText(t); }
  catch { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); }
}
async function copyKey(no, id) { await copy(find(no, id)[1].key); toast('授权码已复制'); }
async function copyMsg(no, id) { const [o, l] = find(no, id); await copy(message(o, l)); toast('微信消息已复制，去微信里粘贴发送'); }
function toggle(no) { open.has(no) ? open.delete(no) : open.add(no); render(); }

function modal(html) { $('#box').innerHTML = html; $('#modal').classList.add('show'); }
function closeModal() { $('#modal').classList.remove('show'); }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function showIssued(o, l, title) {
  open.add(o.no); render();
  modal('<h3>' + title + '</h3><div class="sub">' + esc(o.customer) + ' · 编号 ' + esc(l.id) + ' · 免费升级至 ' + esc(l.upd) + '</div>'
    + '<div class="msg">' + esc(message(o, l)) + '</div>'
    + '<div class="row"><button class="pri" onclick="copyMsg(\'' + o.no + '\',\'' + l.id + '\')">复制整段微信消息</button>'
    + '<button onclick="copyKey(\'' + o.no + '\',\'' + l.id + '\')">只复制授权码</button><span class="sp" style="flex:1"></span><button onclick="closeModal()">关闭</button></div>');
}

$('#newForm').paidAt.value = new Date().toLocaleDateString('sv');
$('#newForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  if (!confirm('确认已经收到「' + fd.customer + '」的 ' + (fd.amount || 0) + ' 元，现在签发授权码？')) return;
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    const r = await api('/api/orders', fd);
    e.target.reset(); e.target.paidAt.value = new Date().toLocaleDateString('sv');
    await reload(); showIssued(r.order, r.license, '已发码 ✓');
  } catch (err) { alert(err.message); } finally { btn.disabled = false; }
});

function renew(no) {
  const o = DATA.orders.find(x => x.no === no), l = latest(o);
  const from = l.upd > DATA.today ? l.upd : DATA.today;
  modal('<h3>续费：' + esc(o.customer) + '</h3><p class="sub">当前免费升级截止 ' + esc(l.upd) + '。新授权码从 ' + from + ' 起顺延，客户把新码粘贴到 x.erp 里替换旧码即可。</p>'
    + '<form id="renewForm" class="grid" style="grid-template-columns:1fr 1fr">'
    + '<label>金额（元）<input name="amount" type="number" min="0" step="0.01" value="' + (l.amount ?? 299) + '"></label>'
    + '<label>付款方式<select name="pay"><option>微信</option><option>支付宝</option><option>转账</option><option>其他</option></select></label>'
    + '<label>付款日期<input name="paidAt" type="date" value="' + new Date().toLocaleDateString('sv') + '"></label>'
    + '<label>顺延年数<select name="years"><option value="1">1 年</option><option value="2">2 年</option><option value="3">3 年</option></select></label>'
    + '</form><div class="row" style="margin-top:14px"><button class="pri" id="renewBtn">确认已收款，发新码</button><button onclick="closeModal()">取消</button></div>');
  $('#renewBtn').onclick = async () => {
    $('#renewBtn').disabled = true;
    try { const r = await api('/api/orders/' + no + '/renew', Object.fromEntries(new FormData($('#renewForm')))); await reload(); showIssued(r.order, r.license, '续费成功，新授权码 ✓'); }
    catch (err) { alert(err.message); $('#renewBtn').disabled = false; }
  };
}
function edit(no) {
  const o = DATA.orders.find(x => x.no === no);
  modal('<h3>编辑：' + esc(o.customer) + '</h3><p class="sub">客户名称已经写进授权码，不能改；要改名请作废后重新下单。</p>'
    + '<form id="editForm" class="grid" style="grid-template-columns:1fr 1fr">'
    + '<label>微信号 / 昵称<input name="contact" value="' + esc(o.contact) + '"></label><label>电话<input name="phone" value="' + esc(o.phone) + '"></label>'
    + '<label style="grid-column:span 2">备注<textarea name="note" rows="3">' + esc(o.note) + '</textarea></label></form>'
    + '<div class="row" style="margin-top:14px"><button class="pri" id="editBtn">保存</button><button onclick="closeModal()">取消</button></div>');
  $('#editBtn').onclick = async () => {
    try { await api('/api/orders/' + no, Object.fromEntries(new FormData($('#editForm')))); closeModal(); await reload(); toast('已保存'); } catch (err) { alert(err.message); }
  };
}
async function voidIt(no) {
  const reason = prompt('作废原因（例如：已退款）。\n注意：授权码是离线校验的，作废只是在这里做记录，客户手里的码仍然能用。');
  if (reason === null) return;
  try { await api('/api/orders/' + no + '/void', { reason }); await reload(); toast('已作废'); } catch (err) { alert(err.message); }
}
async function restore(no) {
  if (!confirm('恢复这个订单为正常？')) return;
  try { await api('/api/orders/' + no, { restore: true }); await reload(); toast('已恢复'); } catch (err) { alert(err.message); }
}
function exportCsv() { location.href = '/api/export.csv?t=' + TOKEN; }
reload().catch(e => alert(e.message));
</script></body></html>`;
