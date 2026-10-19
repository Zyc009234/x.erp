'use strict';
// fnpack 在 Windows 上打包时文件权限均为 0666、manifest 为 CRLF 换行。
// 本脚本就地修正 .fpk（含内层 app.tgz）：目录与 cmd/* 设为 0755，其余 0644，文本配置统一 LF。
// 用法：node fix-fpk.js <file.fpk>
const fs = require('fs');
const zlib = require('zlib');

const TEXT = /^(manifest|config\/\w+|wizard\/\w+|cmd\/\w+|ui\/config)$/;

function octal(buf, off, len) { return parseInt(buf.toString('ascii', off, off + len).replace(/\0.*$/, '').trim() || '0', 8); }
function writeOctal(buf, off, len, val) { buf.write(val.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii'); }

function fixTar(tar, isOuter) {
  const out = [];
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const h = Buffer.from(tar.subarray(pos, pos + 512));
    if (h.every(b => b === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const full = (prefix ? prefix + '/' : '') + name;
    const type = String.fromCharCode(h[156] || 48);
    let size = octal(h, 124, 12);
    let data = tar.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;

    if (type === '5') writeOctal(h, 100, 8, 0o755);
    else if (type === '0') {
      writeOctal(h, 100, 8, isOuter && /^cmd\//.test(full) ? 0o755 : 0o644);
      if (TEXT.test(full)) data = Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
      if (isOuter && full === 'app.tgz') data = zlib.gzipSync(fixTar(zlib.gunzipSync(data), false), { level: 9 });
      size = data.length;
      writeOctal(h, 124, 12, size);
    }
    h.fill(0x20, 148, 156);
    writeOctal(h, 148, 7, h.reduce((s, b) => s + b, 0)); h[155] = 0x20;
    out.push(h, data, Buffer.alloc(Math.ceil(size / 512) * 512 - size));
  }
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

const file = process.argv[2];
if (!file) { console.error('usage: node fix-fpk.js <file.fpk>'); process.exit(1); }
fs.writeFileSync(file, zlib.gzipSync(fixTar(zlib.gunzipSync(fs.readFileSync(file)), true), { level: 9 }));
console.log('fixed: ' + file);
