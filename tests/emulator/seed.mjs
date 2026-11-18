import {writeFileSync} from 'node:fs';
const endpoint = 'http://127.0.0.1:18686';
let token;
async function api(path, body) {
  const res = await fetch(endpoint+path,{
    method: body === undefined ? 'GET' : 'POST',
    headers:{'content-type':'application/json',...(token&&{Authorization:'Bearer '+token})},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(path + ' ' + JSON.stringify(data));
  return data;
}
({token} = await api('/api/login', {username:'admin', password:'admin123'}));
const fixture = (await api('/api/data')).data;
const p = fixture.products.find(x=>x.sku==='EMU-001') ?? await api('/api/products',{
  sku:'EMU-001', name:'测试商品 · 纸杯', unit:'个', category:'模拟器扫码测试',
  barcode:'XERP-EMU-SINGLE', stock:30, units:[{name:'箱', rate:12, barcode:'XERP-EMU-BOX'}]
});
const check = await api('/api/checkdocs', {productIds:[p.id], remark:'Android 模拟器扫码验证'});
writeFileSync(new URL('./fixture.json',import.meta.url),JSON.stringify({p,check}));
console.log({product:p.id, doc:check.no, id:check.id, book:check.lines[0].book});
