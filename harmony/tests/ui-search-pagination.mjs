import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
let fail = true; const calls = [];
const providers = Object.fromEntries(['qq','netease'].map(source => [source, {
 async startQr(){return {image:'data:image/png;base64,TEST',secret:{}};},
 async pollQr(){return {status:'authorized',credential:{cookie:'test'},profile:{id:source,nickname:source}};},
 async search(_,query,page){
  calls.push([source,query,page]);
  if(source==='netease' && page===2 && fail){fail=false;throw Error('稍后重试');}
  const start=page===1?0:29, count=page===1?30:3;
  return {tracks:Array.from({length:count},(_,i)=>({id:query+'-'+(start+i),title:query+' '+source+' '+(start+i),album:'测试专辑',releaseDate:i===0?'2020-01-02':'',playCount:i===0?0:i===1?123456:null,favoriteCount:i===0?0:i===1?45678:null})),hasMore:page===1};
 }
}]));
const f=await fixture({providers}),c=f.client();await c.register();
for(const source of ['qq','netease']){const qr=(await c.request(`/providers/${source}/qr`,'POST',{})).data;await c.request(`/providers/${source}/qr/${qr.id}`,'POST',{});}
const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1360,height:900}});
await context.addCookies([{name:'harmony_session',value:c.cookie.split('=')[1],url:f.url}]);
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(f.url);await page.locator('#library-tab-own').waitFor();
 await page.locator('#search').fill('音乐');await page.locator('#search-form').evaluate(el=>el.requestSubmit());
 await page.waitForFunction(()=>document.querySelectorAll('tr[data-track]').length===60);
 assert.deepEqual(await page.locator('.song-table th').allTextContents(), ['#','歌曲 / 艺人','专辑名','发表时间','平台播放量','平台收藏量','来源','操作']);
 assert.equal(await page.locator('tbody .album-column').first().textContent(),'测试专辑');
 assert.equal(await page.locator('tbody .release-column').first().textContent(),'2020-01-02');
 assert.equal(await page.locator('tbody .plays-column').first().textContent(),'0');
 assert.equal(await page.locator('tbody .plays-column').nth(1).textContent(),'12.3 万');
 assert.equal(await page.locator('tbody .plays-column').nth(2).textContent(),'—');
 assert.equal(await page.locator('tbody .favorites-column').first().textContent(),'0');
 assert.equal(await page.locator('tbody .favorites-column').nth(1).textContent(),'4.6 万');
 assert.equal(await page.locator('tbody .favorites-column').nth(2).textContent(),'—');
 await page.setViewportSize({width:760,height:900});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:1360,height:900});
 await page.locator('[data-action=search-more]').click();
 await page.waitForFunction(()=>document.querySelectorAll('tr[data-track]').length===62);
 await page.getByRole('button',{name:'重试加载更多'}).waitFor();
 const before=calls.filter(c=>c[0]==='qq').length;
 await page.locator('[data-action=search-more]').click();
 await page.waitForFunction(()=>document.querySelectorAll('tr[data-track]').length===64);
 assert.equal(calls.filter(c=>c[0]==='qq').length,before);
 assert.equal(await page.locator('[data-action=search-more]').count(),0);
 await page.locator('[data-action=filter][data-id=qq]').click();
 await page.waitForFunction(()=>document.querySelectorAll('tr[data-track]').length===30);
 assert.equal(calls.at(-1)[2],1);
 await page.locator('[data-action=search-more]').click();await page.waitForFunction(()=>document.querySelectorAll('tr[data-track]').length===32);
 await page.screenshot({path:'test-results/search-pagination.png'});
 await page.locator('#search').fill('新歌曲');await page.locator('#search-form').evaluate(el=>el.requestSubmit());
 await page.waitForFunction(()=>document.querySelectorAll('tr[data-track]').length===30 && document.querySelector('tr[data-track]').textContent.includes('新歌曲'));
 assert.deepEqual(errors,[]);console.log('PASS: 双平台分页超30条、追加去重、部分失败原页重试、已完成平台不再请求、筛选与新搜索重置');
}finally{await browser.close();await f.close();}
