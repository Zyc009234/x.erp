import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (!/\bsrc=/.test(attrs)) new vm.Script(body);
}
const p = {id:'p1', name:'商品', unit:'个', barcode:'single', units:[{name:'箱', rate:12, barcode:'box'}]};
const counts = {p1:''};
const input = {dataset:{pid:'p1'}, value:'', closest:() => ({})};
const tb = {isConnected:true, querySelectorAll:() => [input]};
let visible = true, opened, paints = 0;
const button = {};
const context = vm.createContext({
  window:{}, counts, tb, scanSession:'session',
  o:{wh:'wh1', lines:[{productId:'p1', book:30}]}, META:{},
  $:s => s === '#ckScan' ? button : {classList:{contains:() => visible}},
  whs:() => [{id:'wh1', name:'主仓'}],
  NATIVE:{scanInventory:(...args) => {opened = args;}},
  findProduct:code => ['single', 'box'].includes(code) ? p : null,
  cnt:() => counts.p1 === '' ? null : Number(counts.p1),
  curBook:line => line.book,
  paint:() => {paints++;}, summary:() => {}, filter:() => {},
});
const units = html.slice(html.indexOf('const unitsOf ='), html.indexOf('// 300 个'));
const callback = html.slice(html.indexOf('  const addScan ='), html.indexOf("  $('#ckQ').addEventListener('keydown'"));
vm.runInContext(units + callback, context);
button.onclick();
assert.deepEqual(opened, ['session', '主仓']);
const scan = code => context.window.__xerpInventoryScan('session', code);
assert.equal(scan('single').counted, 1);
assert.equal(scan('box').add, 12);
assert.equal(counts.p1, '13');
assert.equal(input.value, '13');
assert.equal(scan(' single ').counted, 14);
assert.equal(scan('unknown').error, '本盘点单中没有该商品');
counts.p1 = 'invalid';
assert.ok(scan('single').error);
assert.equal(counts.p1, 'invalid');
counts.p1 = '14';
assert.ok(context.window.__xerpInventoryScan('old-session', 'single').error);
visible = false;
assert.ok(scan('single').error);
visible = true;
tb.isConnected = false;
assert.ok(scan('single').error);
assert.equal(counts.p1, '14');
assert.equal(paints, 3);
console.log('PASS: inline JavaScript syntax; single/box quantities; draft input; invalid quantity; unknown barcode; stale/closed document');
