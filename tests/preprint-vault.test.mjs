import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('加密套打模板隔离与自由数据框校验', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xerp-pv-'));
  const port = 19890 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [path.join(root, 'src/server.js'), '--data', dir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const req = async (method, url, body, token) => {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  try {
    for (let i = 0; i < 40; i++) {
      try { const p = await fetch(`http://127.0.0.1:${port}/api/ping`); if (p.ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 120));
    }
    const login = await req('POST', '/api/login', { username: 'admin', password: 'admin123' });
    assert.equal(login.status, 200);
    const token = login.data.token;

    // 1. 未激活前：无套打权限、无隐藏模板
    const d0 = await req('GET', '/api/data', null, token);
    assert.ok(!(d0.data.settings.features || []).includes('preprint'));
    assert.equal(((d0.data.settings.printTplList || {}).sales || []).length, 0);

    // 2. 错误的 PT 激活码与非法格式均拒绝
    const bad1 = await req('POST', '/api/settings/redeem', { code: 'PT-AAAA-BBBB-CCCC' }, token);
    assert.equal(bad1.status, 400);
    const bad2 = await req('POST', '/api/settings/redeem', { code: 'INVALID-CODE' }, token);
    assert.equal(bad2.status, 400);

    // 3. 未激活套打时禁止保存 preprint=true 模板
    const noFeat = await req('PUT', '/api/settings/print', {
      kind: 'sales',
      tpl: { preprint: true, hideTableTotal: true, boxes: [{ id: 'b1', name: '单号', bind: 'order.no', x: 10, y: 10, fontSize: 12 }] }
    }, token);
    assert.equal(noFeat.status, 403);

    // 4. 普通模板即使携带 boxes / hideTable / hideTableTotal 也会被服务端剥离（仅套打模式可用）
    const normalSave = await req('PUT', '/api/settings/print', {
      kind: 'sales',
      tpl: { preprint: false, hideTable: true, hideTableTotal: true, boxes: [{ id: 'b1', name: '单号', bind: 'order.no', x: 10, y: 10, fontSize: 12 }] }
    }, token);
    assert.equal(normalSave.status, 200);
    assert.equal(normalSave.data.defaultTpl.hideTable, false);
    assert.equal(normalSave.data.defaultTpl.hideTableTotal, false);
    assert.deepEqual(normalSave.data.defaultTpl.boxes, []);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
