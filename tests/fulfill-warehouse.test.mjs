import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const start = html.indexOf('function pickFulfillWh');
const end = html.indexOf('function orderFulfillModal');
assert.ok(start >= 0 && end > start, '找不到分批执行的默认仓库选择函数');

const context = vm.createContext({
  META: {defaultWh: 'w1'},
  whs: () => [
    {id: 'w1', name: '主仓'},
    {id: 'w2', name: '分仓'}
  ],
  whQty: (product, warehouse) => (product.stock[warehouse] || 0)
});
vm.runInContext(html.slice(start, end), context);

const lines = [
  {p: {stock: {w1: 5, w2: 0}}, left: 5},
  {p: {stock: {w1: 0, w2: 5}}, left: 5}
];
assert.equal(context.pickFulfillWh(lines, true), 'w1', '没有单个仓库满足全部明细时不应抛错');
assert.equal(context.pickFulfillWh([{p: {stock: {w1: 0, w2: 8}}, left: 8}], true), 'w2');
assert.equal(context.pickFulfillWh(lines, false), 'w1', '采购入库仍使用默认仓库');

console.log('PASS: fulfill default warehouse selection');
