import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

const url=process.env.SUSPENSION_TEST_URL || 'http://127.0.0.1:5175';
const suffix=process.env.SUSPENSION_TEST_OUTPUT_SUFFIX||'';
if(suffix&&!/^[a-z0-9-]+$/.test(suffix))throw new Error('Invalid test output suffix');
const output='output/offline-release'+(suffix?'-'+suffix:'');
const results=[];
const browser=await chromium.launch({ headless:true });
const context=await browser.newContext({ viewport:{width:1440,height:1000} });
const page=await context.newPage();
const errors=[],external=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('request',request=>{const address=request.url();if(address.startsWith('http')&&new URL(address).origin!==new URL(url).origin)external.push(address);});
function rawRequest(pathname,method='GET') { return new Promise((resolve,reject)=>{const parsed=new URL(url);const request=http.request({hostname:parsed.hostname,port:parsed.port,path:pathname,method},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,text,headers:response.headers}));});request.on('error',reject);request.end();}); }
try {
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.suspensionLab);
  const manifest=await (await context.request.get(url+'/manifest.webmanifest')).json();
  assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');
  for(const icon of manifest.icons)assert.equal((await context.request.get(url+'/'+icon.src.replace(/^\//,''))).status(),200);
  assert.match(await (await context.request.get(url+'/THREE-LICENSE.txt')).text(),/MIT License/);
  results.push('배포 매니페스트 · 아이콘 · Three.js 라이선스');

  const ready=await page.evaluate(()=>window.suspensionLab.offlineReady);
  assert.equal(ready.available,true);
  await page.waitForFunction(()=>navigator.serviceWorker.controller);
  const assets=await (await context.request.get(url+'/asset-manifest.json')).json();
  const cached=await page.evaluate(async()=>{const keys=await caches.keys();const cache=await caches.open(keys.find(key=>key.startsWith('suspension-lab-')));return (await cache.keys()).map(request=>new URL(request.url).pathname);});
  for(const asset of ['/', '/manifest.webmanifest','/app-icon-192.png','/app-icon-512.png',...assets])assert.ok(cached.includes(asset),asset+' must be precached');
  results.push('서비스 워커 활성화 · 전체 정적 에셋 사전 캐시');

  await context.setOffline(true);
  await page.reload({waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.suspensionLab);
  await page.evaluate(()=>window.suspensionLab.productReady);
  await page.locator('.workspace-nav a[href="#experiment-workspace"]').click();
  await page.locator('#experiment-duration').fill('1');
  await page.locator('#experiment-name').fill('오프라인 배포 검증');
  await page.locator('#record-experiment-btn').click();
  await page.waitForFunction(()=>window.suspensionLab.getExperiments().some(run=>run.name==='오프라인 배포 검증'));
  assert.ok(await page.evaluate(()=>window.suspensionLab.getProductState().recordCount>=1));
  await page.locator('#experiment-overlay-chart').scrollIntoViewIfNeeded();
  const plot=await page.locator('#experiment-overlay-chart').boundingBox();
  await page.mouse.move(plot.x+plot.width/2,plot.y+plot.height/2);
  assert.match(await page.locator('#experiment-overlay-readout').textContent(),/오프라인 배포 검증/);
  await page.mouse.move(1,1);
  assert.match(await page.locator('#experiment-overlay-readout').textContent(),/^포인터를 올려/);
  results.push('네트워크 차단 후 새로고침 · 계산 · IndexedDB 시험 기록');
  fs.mkdirSync(output,{recursive:true});
  await page.screenshot({path:output+'/offline.png',fullPage:true});
  await context.setOffline(false);
  await page.setViewportSize({width:390,height:844});
  await page.locator('.workspace-nav a[href="#engineering-validation"]').click();
  await page.locator('#component-profile-clear-btn').click();
  await page.waitForTimeout(120);
  const textBounds=await page.locator('#component-profile-chart').evaluate(svg=>{
    const text=svg.querySelector('text'),a=svg.getBoundingClientRect(),b=text.getBoundingClientRect();
    return {text:text.textContent,inside:b.left>=a.left&&b.right<=a.right&&b.top>=a.top&&b.bottom<=a.bottom};
  });
  assert.equal(textBounds.text,'부품 특성표를 가져오세요.');assert.ok(textBounds.inside);
  await page.locator('#component-profile-chart').screenshot({path:output+'/empty-mobile.png'});

  assert.equal(errors.length,0,errors.join('\n'));assert.equal(external.length,0,external.join('\n'));
  results.push('배포 CSP에서 콘솔 오류 0 · 외부 네트워크 요청 0');
  const head=await rawRequest('/','HEAD');assert.equal(head.status,200);assert.equal(head.text,'');assert.ok(head.headers['content-security-policy']);
  assert.equal((await rawRequest('/','POST')).status,405);
  results.push('배포 서버 HEAD · 허용 메서드 · 보안 헤더');
  for(const target of ['/..%2Fpackage.json','/%2e%2e%5cpackage.json'])assert.equal((await rawRequest(target)).status,403);
  assert.equal((await rawRequest('/%ZZ')).status,400);
  assert.equal((await rawRequest('/package.json')).status,404);
  results.push('서버 외부 경로 · 잘못된 인코딩 접근 차단');
  const entryScripts=await page.locator('script[type="module"][src]').evaluateAll(nodes=>nodes.map(node=>new URL(node.src).pathname));
  fs.writeFileSync(output+'/report.json',JSON.stringify({baseURL:url,entryScripts,passed:results.length,checks:results,errors,external},null,2));
  console.log(JSON.stringify({passed:results.length,checks:results},null,2));
} finally {await context.close();await browser.close();}
