'use strict';
/**
 * x.erp 客户端
 * - 在本机 127.0.0.1 启动界面服务，并把 /api 请求转发到配置的服务端
 * - 以独立应用窗口（Edge/Chrome 应用模式）打开界面
 * - 用法：erp-client.exe [--no-browser] [--port <端口>] [--config <配置文件>]
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const NO_BROWSER = argv.includes('--no-browser');
const APP_DIR = path.join(process.env.APPDATA || os.homedir(), 'XERP');
const CFG_FILE = path.resolve(arg('config', path.join(APP_DIR, 'client.json')));
const BASE_PORT = +arg('port', 18686);
fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });

function log(...m) {
  try { fs.appendFileSync(path.join(path.dirname(CFG_FILE), 'client.log'), new Date().toLocaleString('zh-CN', { hour12: false }) + '  ' + m.join(' ') + '\n'); } catch (e) {}
}
let cfg = { server: '' };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^﻿/, ''))); } catch (e) {}
function normalize(s) {
  s = String(s || '').trim();
  if (!s) throw new Error('请填写服务器地址');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  if (!u.hostname) throw new Error('服务器地址格式不正确');
  return u.origin;
}

let INDEX_HTML = null;
function indexHtml() {
  if (INDEX_HTML) return INDEX_HTML;
  try { const sea = require('node:sea'); if (sea.isSea()) return (INDEX_HTML = sea.getAsset('index.html', 'utf8')); } catch (e) {}
  return (INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
}
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise(resolve => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8') || '{}')); } catch (e) { resolve({}); } }); });
}

// 把 /api/* 转发给服务端
function proxy(req, res) {
  if (!cfg.server) return json(res, 502, { error: '尚未配置服务器地址' });
  let target;
  try { target = new URL(req.url, cfg.server); } catch (e) { return json(res, 502, { error: '服务器地址格式不正确' }); }
  const lib = target.protocol === 'https:' ? https : http;
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  const preq = lib.request(target, { method: req.method, headers, timeout: 20000 }, pres => {
    res.writeHead(pres.statusCode, { 'Content-Type': pres.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' });
    pres.pipe(res);
  });
  preq.on('timeout', () => preq.destroy(new Error('连接超时')));
  preq.on('error', e => {
    if (res.headersSent) return res.end();
    const why = { ECONNREFUSED: '服务端未启动或端口不正确', ENOTFOUND: '找不到该主机', ETIMEDOUT: '连接超时', EHOSTUNREACH: '主机不可达', ECONNRESET: '连接被重置' }[e.code] || e.message;
    json(res, 502, { error: `无法连接服务器 ${cfg.server}：${why}` });
  });
  req.pipe(preq);
}

let lastBeat = Date.now() + 60e3, browserProc = null;
const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  if (p.startsWith('/api/')) return proxy(req, res);
  if (p === '/local/ping') return json(res, 200, { app: 'XERP-Client' });
  if (p === '/local/heartbeat') { lastBeat = Date.now(); return json(res, 200, { ok: true }); }
  if (p === '/local/config') {
    if (req.method === 'GET') return json(res, 200, { server: cfg.server });
    if (req.method === 'POST') {
      try {
        cfg.server = normalize((await readBody(req)).server);
        fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
        log('服务器地址已设置为', cfg.server);
        return json(res, 200, { server: cfg.server });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
  }
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(indexHtml());
  }
  res.writeHead(404); res.end();
});

function findBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  for (const r of rel) for (const base of pf) { const f = path.join(base, r); if (fs.existsSync(f)) return f; }
  return null;
}
function openWindow(port) {
  const url = `http://127.0.0.1:${port}/`;
  if (NO_BROWSER) return;
  const exe = findBrowser();
  if (exe) {
    const profile = path.join(process.env.LOCALAPPDATA || APP_DIR, 'XERP', 'Browser');
    browserProc = spawn(exe, ['--app=' + url, '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--disable-features=Translate'], { detached: true, stdio: 'ignore' });
    browserProc.on('exit', () => { browserProc = null; });
    browserProc.unref();
  } else {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  }
}
// 若已有本程序实例在运行，直接打开新窗口并退出
function probe(port) {
  return new Promise(resolve => {
    http.get({ host: '127.0.0.1', port, path: '/local/ping', timeout: 1500 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d).app === 'XERP-Client'); } catch (e) { resolve(false); } });
    }).on('error', () => resolve(false)).on('timeout', function () { this.destroy(); resolve(false); });
  });
}
function listen(port) {
  return new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('error', onErr); reject(e); };
    server.once('error', onErr);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', onErr); resolve(port); });
  });
}
(async () => {
  for (let port = BASE_PORT; port < BASE_PORT + 15; port++) {
    try {
      await listen(port);
      log('客户端已启动，端口', port, '服务器', cfg.server || '(未配置)');
      openWindow(port);
      // 窗口关闭且 3 分钟无心跳后自动退出
      if (!NO_BROWSER) setInterval(() => { if (!browserProc && Date.now() - lastBeat > 180e3) { log('窗口已关闭，客户端退出'); process.exit(0); } }, 15e3);
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') { log('启动失败', e.message); process.exit(1); }
      if (await probe(port)) { openWindow(port); setTimeout(() => process.exit(0), 1500); return; }
    }
  }
  log('启动失败：没有可用端口'); process.exit(1);
})();
