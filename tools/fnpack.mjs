// 生成 / 更新仓库根目录的 fnpack.json（FnDepot 第三方应用源，V2 协议）
// 用法：node tools/fnpack.mjs            按 fnos/pkg/manifest 里的版本，读 dist/xerp-<版本>.fpk 算校验值
// 每次发版打完 fpk 后运行一次，连同 fnpack.json 一起提交；官网也要放一份（/xerp/fnpack.json）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'fnpack.json');
const KEEP = 3;  // 源里保留最近几个版本，方便用户回退
const RAW = 'https://raw.githubusercontent.com/Zyc009234/x.erp/main';

const manifest = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'fnos/pkg/manifest'), 'utf8').split(/\r?\n/)
  .map(l => /^(\w+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const ver = manifest.version, fpk = path.join(ROOT, 'dist', `xerp-${ver}.fpk`);
if (!fs.existsSync(fpk)) throw new Error('找不到 ' + fpk + '，先运行 fnos/build-fnos.ps1');
const buf = fs.readFileSync(fpk);

const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const releases = { ...(old?.apps?.xerp?.releases || {}) };
const tz = d => new Date(d.getTime() + 8 * 3600e3).toISOString().replace(/\.\d+Z$/, '+08:00');
releases[ver] = {
  changelog: manifest.changelog || '',
  updated_at: releases[ver]?.updated_at && releases[ver].packages.all.sha256 === crypto.createHash('sha256').update(buf).digest('hex') ? releases[ver].updated_at : tz(new Date()),
  packages: {
    all: {
      // 官网下载，国内比 GitHub 快；同一个文件也在 GitHub Release 里
      download_url: `https://www.zhaoyoucai.xyz/downloads/xerp-${ver}.fpk`,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
    },
  },
};
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const kept = Object.keys(releases).sort(cmp).slice(-KEEP);

const src = {
  schema_version: '2',
  source_info: {
    name: 'x.erp 官方源',
    author: 'Zyc009234',
    homepage: 'https://www.zhaoyoucai.xyz/xerp/',
    description: 'x.erp 免费开源进销存的官方发布源，每次发版自动更新。',
  },
  apps: {
    xerp: {
      display_name: manifest.display_name || 'x.erp',
      desc: '免费开源（AGPL-3.0）的进销存系统，面向小店和中小企业：商品与条码、采购单、销售单、退货、收款付款、多仓库库存与调拨盘点、缺货预警、财务流水、统计报表、员工账号与权限。电脑和手机浏览器都能用，数据全部保存在 NAS 本地，每天自动备份。安装后浏览器打开 http://NAS地址:8686 ，首次登录账号 admin，密码为安装时设置的密码。',
      platform: ['all'],
      categories: ['生活服务', '系统工具'],
      icon_url: `${RAW}/docs/icon.png`,
      preview_urls: ['dashboard', 'sales', 'inventory', 'payments', 'mobile'].map(n => `${RAW}/docs/screenshots/${n}.png`),
      readme_url: `${RAW}/README.md`,
      bug_report_url: 'https://www.zhaoyoucai.xyz/xerp/',
      maintainer: 'Zyc009234',
      maintainer_url: 'https://github.com/Zyc009234/x.erp',
      run_as: 'package',
      install_type: '',
      is_docker: false,
      service_port: manifest.service_port || '8686',
      releases: Object.fromEntries(kept.reverse().map(v => [v, releases[v]])),
    },
  },
};
fs.writeFileSync(OUT, JSON.stringify(src, null, 2) + '\n');
console.log('fnpack.json 已更新：', kept.join(', '), '·', ver, src.apps.xerp.releases[ver].packages.all.sha256.slice(0, 12), buf.length, 'bytes');
