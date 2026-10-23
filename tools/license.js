'use strict';
/**
 * x.erp 专业版授权码工具（发码方使用，私钥只保存在本机，不要提交到仓库）
 *
 *   node tools/license.js init                          生成密钥对，打印公钥（粘贴到 src/server.js 的 LICENSE_PUBKEY）
 *   node tools/license.js issue --to "客户名称" [--years 1] [--note 备注]
 *                                                       签发授权码：永久使用，--years 年内发布的新版本可免费升级
 *   node tools/license.js verify <授权码>                校验授权码并显示内容
 *   node tools/license.js list                          列出已签发的授权码
 *   node tools/orders.js                                打开本机订单后台（记录订单、一键发码、续费、查询）
 *
 * 私钥位置：%USERPROFILE%\.xerp-license\private.pem（可用环境变量 XERP_LICENSE_DIR 修改）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DIR = process.env.XERP_LICENSE_DIR || path.join(os.homedir(), '.xerp-license');
const PRIV = path.join(DIR, 'private.pem'), PUB = path.join(DIR, 'public.pem'), LOG = path.join(DIR, 'issued.csv');
const argv = process.argv.slice(2), cmd = argv[0];
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const die = m => { console.error(m); process.exit(1); };

function verify(key, pubPem) {
  const m = /^XERP-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(key).trim());
  if (!m) return null;
  if (!crypto.verify(null, Buffer.from(m[1]), pubPem, Buffer.from(m[2], 'base64url'))) return null;
  return JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
}

// 签发并记入 issued.csv。from：免费升级期从哪天起算（续费时传上一个授权码的截止日，不早于今天）
function issue({ to, years = 1, note = '', from } = {}) {
  if (!fs.existsSync(PRIV)) throw new Error('还没有私钥，请先运行：node tools/license.js init');
  to = String(to || '').trim();
  if (!to) throw new Error('请指定授权对象');
  years = Number(years);
  if (!(years > 0 && years <= 20)) throw new Error('年数需在 0 ~ 20 之间');
  const now = new Date(), today = ymd(now);
  const upd = new Date((from && from > today ? from : today) + 'T00:00:00');
  upd.setFullYear(upd.getFullYear() + Math.floor(years)); upd.setDate(upd.getDate() + Math.round((years % 1) * 365));
  const payload = { id: crypto.randomBytes(5).toString('hex').toUpperCase(), to, ed: 'pro', iat: today, upd: ymd(upd) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), fs.readFileSync(PRIV, 'utf8')).toString('base64url');
  const key = `XERP-${body}.${sig}`;
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '﻿编号,授权对象,签发日期,免费升级截止,备注,授权码\n');
  fs.appendFileSync(LOG, [payload.id, to, payload.iat, payload.upd, note, key].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',') + '\n');
  return { ...payload, key };
}

module.exports = { DIR, PRIV, PUB, LOG, verify, issue, ymd };

if (require.main !== module) {
  // 被 orders.js 等引用时只导出函数
} else if (cmd === 'init') {
  if (fs.existsSync(PRIV)) die('私钥已存在：' + PRIV + '\n重新生成会让已经发出去的授权码全部失效。确实要重来，请先手动删除它。');
  fs.mkdirSync(DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('已生成密钥对：' + DIR + '\n请务必备份 private.pem（丢失后无法再签发授权码）。\n\n公钥：\n' + fs.readFileSync(PUB, 'utf8'));
} else if (cmd === 'issue') {
  const to = arg('to') || die('请用 --to 指定授权对象，例如 --to "张三的便利店"');
  let r;
  try { r = issue({ to, years: arg('years', 1), note: arg('note', '') }); } catch (e) { die(e.message); }
  console.log(`授权对象：${to}\n编号：${r.id}\n免费升级截止：${r.upd}\n\n${r.key}\n\n（已记录到 ${LOG}）`);
} else if (cmd === 'verify') {
  const pub = fs.existsSync(PUB) ? fs.readFileSync(PUB, 'utf8') : die('找不到公钥：' + PUB);
  const p = verify(argv[1] || '', pub);
  console.log(p ? '有效：' + JSON.stringify(p, null, 2) : '无效的授权码');
  process.exit(p ? 0 : 1);
} else if (cmd === 'list') {
  console.log(fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '还没有签发过授权码');
} else {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
}
