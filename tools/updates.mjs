// 生成应用内「检查更新」用的 updates.json（打完 fpk / exe / apk 后运行）
// 用法：node tools/updates.mjs
// 发布时把 dist/updates.json 放到官网 /xerp/updates.json；安装包放 /downloads/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'fnos/pkg/manifest'), 'utf8').split(/\r?\n/)
  .map(l => /^(\w+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const ver = manifest.version;
const base = process.env.UPDATE_BASE_URL || 'https://www.zhaoyoucai.xyz/downloads/';
const pkg = (file, kind) => {
  const f = path.join(ROOT, 'dist', file);
  if (!fs.existsSync(f)) throw new Error('找不到 ' + f + '，先把对应安装包打出来');
  const buf = fs.readFileSync(f);
  return { version: ver, url: base + file, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, file, kind };
};
const notes = String(manifest.changelog || '').replace(/^.*?：/, '').split(/[；;]\s*/).map(s => s.replace(/^\d+）\s*/, '').trim()).filter(Boolean);
const out = {
  schema: 1,
  latest: ver,
  publishedAt: new Date(Date.now() + 8 * 3600e3).toISOString().replace(/\.\d+Z$/, '+08:00'),
  notes,
  packages: {
    fnos: pkg(`xerp-${ver}.fpk`, 'fpk'),
    windows: pkg(`xerp-${ver}-windows-x64-setup.exe`, 'exe'),
    android: pkg(`xerp-${ver}-android.apk`, 'apk'),
    docker: { version: ver, kind: 'docker', image: `ghcr.io/zyc009234/xerp:${ver}` }
  }
};
const file = path.join(ROOT, 'dist', 'updates.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'updates.json'), JSON.stringify(out, null, 2) + '\n');
console.log('已生成', file, '和仓库根目录 updates.json ·', ver);
