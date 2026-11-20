// 单机版升级到多账套网关：沿用原数据目录，账号和业务数据不能丢
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-portal-upgrade-'));
let direct, portal, directBase, portalBase, log = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function waitPing(base, proc) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/api/ping');
      if (r.ok) return;
    } catch (e) {}
    if (proc && proc.exitCode !== null) throw new Error('服务提前退出：\n' + log);
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('服务没有启动：\n' + log);
}
async function call(base, token, method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  assert.equal(r.status, 200, `${method} ${url} -> ${r.status} ${out.error || ''}`);
  return out;
}

before(async () => {
  const directPort = await freePort();
  directBase = `http://127.0.0.1:${directPort}`;
  direct = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--data', DATA, '--port', String(directPort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XERP_NO_DEMO: '1', XERP_STATS_DELAY: '60000' },
  });
  direct.stdout.on('data', d => { log += d; });
  direct.stderr.on('data', d => { log += d; });
  await waitPing(directBase, direct);
  const login = await call(directBase, null, 'POST', '/api/login', { username: 'admin', password: 'admin123' });
  await call(directBase, login.token, 'POST', '/api/products', { sku: 'OLD-001', name: '升级前商品', unit: '个', price: 12 });
  direct.kill();
  await new Promise(r => direct.once('exit', r));

  const portalPort = await freePort(), basePort = await freePort();
  portalBase = `http://127.0.0.1:${portalPort}`;
  portal = spawn(process.execPath, [
    path.join(ROOT, 'src', 'portal.js'), '--data', DATA, '--port', String(portalPort), '--base-port', String(basePort),
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XERP_STATS_DELAY: '60000' } });
  portal.stdout.on('data', d => { log += d; });
  portal.stderr.on('data', d => { log += d; });
  await waitPing(portalBase, portal);
});

after(async () => {
  if (portal) portal.kill();
  if (direct) direct.kill();
  await new Promise(r => setTimeout(r, 1200));
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
});

test('旧版直接升级：原管理员账号和商品数据都保留', async () => {
  const login = await call(portalBase, null, 'POST', '/api/portal/login', { username: 'admin', password: 'admin123', company: 'default' });
  assert.equal(login.company.code, 'default');
  const d = await call(portalBase, login.token, 'GET', '/api/data');
  assert.equal(d.user.username, 'admin');
  assert.ok(d.data.products.some(p => p.sku === 'OLD-001'));
  assert.equal(fs.existsSync(path.join(DATA, 'registry.db')), true);
});
