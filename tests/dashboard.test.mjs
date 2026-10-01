import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const url=process.env.SUSPENSION_TEST_URL||'http://127.0.0.1:5173';
const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const output=`output/dashboard-v${version}`;fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const errors=[],checks=[],evidence={};
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
const listen=p=>{p.on('pageerror',error=>errors.push(error.message));p.on('console',message=>{if(message.type()==='error')errors.push(message.text());});};
listen(page);
const dashboard=()=>page.evaluate(()=>window.suspensionLab.getDashboardState());
const chartState=()=>page.evaluate(()=>window.suspensionLab.getChartState());
const snapshot=()=>page.evaluate(()=>window.suspensionLab.snapshot());
const changeView=view=>page.evaluate(view=>window.suspensionLab.setWorkspaceView(view),view);
const box=id=>page.locator('#'+id).boundingBox();
const check=async(name,action)=>{await action();checks.push(name);console.log('PASS '+name);};
const stableChart=s=>({windowSeconds:s.windowSeconds,follow:s.follow,start:s.start,end:s.end,visibleSeries:s.visibleSeries});
async function ready(p=page){await p.goto(url,{waitUntil:'networkidle'});await p.waitForFunction(()=>window.suspensionLab?.getDashboardState);await p.evaluate(()=>window.suspensionLab.productReady);}
try {
  await ready();
  const entryScripts=await page.locator('script[type="module"][src]').evaluateAll(nodes=>nodes.map(node=>new URL(node.src).pathname));
  await check('desktop bench exposes current conditions and actual wheel telemetry',async()=>{
    await page.evaluate(()=>{window.suspensionLab.setRunning(false);window.suspensionLab.setConfig({holderMode:'fixed',speed:30,road:'bump'});window.suspensionLab.advance(2);});
    assert.equal((await dashboard()).settingsExpanded,true);
    assert.equal(await page.locator('#context-structure').textContent(),'더블 위시본');
    assert.equal(await page.locator('#context-holder').textContent(),'고정 홀더');
    assert.equal(await page.locator('#context-speed').textContent(),'30 km/h');
    assert.equal(await page.locator('#context-time').textContent(),'2.00 s');
    assert.match(await page.locator('#context-result-scope').textContent(),/실시간/);
    assert.match(await page.locator('#acceleration-label').textContent(),/휠/);
    const state=await snapshot();assert.equal(Number(await page.locator('#acceleration-value').textContent()),Number(state.wheelAcceleration.toFixed(1)));
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    assert.equal(await page.evaluate(()=>window.scrollY),0);
    const telemetry=await page.locator('.telemetry-section').boundingBox();
    evidence.desktopTelemetryBottom=telemetry.y+telemetry.height;
    assert.ok(telemetry.y+telemetry.height<=1000,'desktop telemetry should fit the initial 1000px view');
    await page.screenshot({path:output+'/desktop-bench.png'});
  });
  await check('settings toggle changes real layout without changing paused simulation',async()=>{
    const before=await snapshot();await page.locator('#dashboard-settings-toggle').click();
    assert.equal((await dashboard()).settingsExpanded,false);
    assert.equal(await page.locator('#dashboard-settings-panel').isVisible(),false);
    assert.equal(await page.locator('#dashboard-settings-toggle').getAttribute('aria-expanded'),'false');
    assert.deepEqual(await snapshot(),before);
    assert.ok((await box('viewport')).width>1200);
  });
  await check('analysis defaults to full width and overview plots share actual time-series data',async()=>{
    await changeView('analysis');
    assert.equal((await dashboard()).settingsExpanded,false);
    assert.equal((await dashboard()).chartLayout,'overview');
    const motion=await box('motion-chart'),force=await box('force-chart'),accel=await box('acceleration-chart');
    assert.ok(Math.abs(motion.y-force.y)<3,'overview plots must share the top row');
    assert.ok(force.x>motion.x+motion.width);assert.ok(accel.y>motion.y+motion.height);assert.ok(accel.width>motion.width*1.8);
    assert.ok(motion.width>550);
    assert.ok(await page.locator('#motion-chart [data-series="wheelY"]').count());
    assert.ok((await page.locator('#motion-chart [data-series="wheelY"]').getAttribute('d')).length>100);
    assert.match(await page.locator('#context-result-scope').textContent(),/그래프/);
    evidence.overview={motion,force,accel};
    await page.screenshot({path:output+'/desktop-analysis.png',fullPage:true});
  });
  await check('stacked layout and per-workspace settings survive reload',async()=>{
    await page.locator('#analysis-layout').selectOption('stacked');
    const motion=await box('motion-chart'),force=await box('force-chart');assert.ok(force.y>motion.y+motion.height);assert.ok(Math.abs(force.x-motion.x)<2);
    await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>window.suspensionLab?.getDashboardState);
    assert.equal((await dashboard()).chartLayout,'stacked');assert.equal((await dashboard()).settingsExpanded,false);
    await changeView('bench');assert.equal((await dashboard()).settingsExpanded,false);
    await changeView('analysis');await page.locator('#analysis-layout').selectOption('overview');
    await page.evaluate(()=>window.suspensionLab.advance(2));
  });
  await check('opening analysis settings resizes plots and remains scoped to that workspace',async()=>{
    const before=await box('motion-chart');await page.locator('#dashboard-settings-toggle').click();
    assert.equal((await dashboard()).settingsExpanded,true);assert.equal(await page.locator('#dashboard-settings-panel').isVisible(),true);
    assert.ok((await box('motion-chart')).width<before.width);
    await changeView('experiments');assert.equal((await dashboard()).settingsExpanded,false);
    await changeView('analysis');assert.equal((await dashboard()).settingsExpanded,true);
    await page.locator('#dashboard-settings-toggle').click();
  });
  await check('chart focus and Escape preserve plotting settings, samples and physics',async()=>{
    await page.locator('#chart-window').selectOption('4');
    await page.locator('button[data-series="rawRoadY"]').click();
    const beforeChart=stableChart(await chartState()),before=await snapshot();
    const samples=await page.evaluate(()=>window.suspensionLab.history());
    await page.locator('[data-chart-focus="motion"]').click();
    assert.equal((await dashboard()).focusedChart,'motion');
    assert.equal(await page.locator('[data-chart-panel="force"]').isVisible(),false);
    assert.equal(await page.locator('[data-chart-panel="acceleration"]').isVisible(),false);
    assert.ok((await box('motion-chart')).height>=420);
    assert.equal(await page.locator('#chart-focus-exit').isVisible(),true);
    assert.deepEqual(stableChart(await chartState()),beforeChart);assert.deepEqual(await snapshot(),before);
    assert.deepEqual(await page.evaluate(()=>window.suspensionLab.history()),samples);
    await page.screenshot({path:output+'/focused-motion.png',fullPage:true});
    await page.keyboard.press('Escape');assert.equal((await dashboard()).focusedChart,'none');
    assert.equal(await page.locator('[data-chart-panel="force"]').isVisible(),true);
    assert.deepEqual(stableChart(await chartState()),beforeChart);
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.chartFocus),'motion');
    await page.locator('button[data-series="rawRoadY"]').click();
  });
  await check('focus exits on tab navigation and return button restores all plots',async()=>{
    await page.locator('[data-chart-focus="force"]').click();await changeView('bench');assert.equal((await dashboard()).focusedChart,'none');
    await changeView('analysis');assert.equal(await page.locator('[data-chart-panel="force"]').isVisible(),true);
    await page.locator('[data-chart-focus="acceleration"]').click();await page.locator('#chart-focus-exit').click();
    assert.equal((await dashboard()).focusedChart,'none');
    for(const key of ['motion','force','acceleration'])assert.equal(await page.locator(`[data-chart-panel="${key}"]`).isVisible(),true);
  });
  await check('condition strip follows actual UI configuration and marks component tables',async()=>{
    await changeView('bench');if(!(await dashboard()).settingsExpanded)await page.locator('#dashboard-settings-toggle').click();
    await page.locator('#holder-mode').selectOption('sprung');assert.equal(await page.locator('#context-holder').textContent(),'탄성 차체');assert.match(await page.locator('#acceleration-label').textContent(),/차체/);
    await page.locator('#tab-road').click();await page.locator('[data-road="flat"]').click();
    const speed=page.locator('[data-config="speed"]');await speed.focus();await speed.press('Home');await speed.press('ArrowRight');
    const current=await page.evaluate(()=>window.suspensionLab.getConfig());assert.equal(await page.locator('#context-speed').textContent(),`${current.speed} km/h`);assert.equal(await page.locator('#context-road').textContent(),'평탄');
    const {COMPONENT_PROFILE_TEMPLATE}=await import('../src/component-curves.js');
    await page.evaluate(profile=>window.suspensionLab.setConfig({componentProfile:profile}),COMPONENT_PROFILE_TEMPLATE);
    assert.match(await page.locator('#context-profile').textContent(),/특성표/);assert.equal(await page.locator('#context-profile').getAttribute('data-warning'),'false');
    const normalColor=await page.locator('#context-profile').evaluate(node=>getComputedStyle(node).color);
    await page.evaluate(profile=>{window.suspensionLab.setConfig({road:'bump',speed:30,holderMode:'fixed',componentProfile:{...profile,damper:[[-.001,-2.8],[0,0],[.001,1.8]]}});window.suspensionLab.advance(2);},COMPONENT_PROFILE_TEMPLATE);
    assert.match(await page.locator('#context-profile').textContent(),/외삽/);assert.equal(await page.locator('#context-profile').getAttribute('data-warning'),'true');
    assert.notEqual(await page.locator('#context-profile').evaluate(node=>getComputedStyle(node).color),normalColor);
    await page.evaluate(()=>window.suspensionLab.setConfig({componentProfile:null}));assert.equal(await page.locator('#context-profile').textContent(),'계수 모델');
  });
  await check('keyboard layout controls do not start the simulation and tab arrows still work',async()=>{
    await page.locator('#dashboard-settings-toggle').focus();await page.keyboard.press('Space');assert.equal(await page.locator('#run-status').getAttribute('data-running'),'false');
    const nav=page.locator('.workspace-nav a[href="#test-bench"]');await nav.focus();await page.keyboard.press('ArrowRight');assert.equal((await dashboard()).view,'analysis');
    assert.equal(await page.locator('.workspace-nav a[href="#analysis-section"]').getAttribute('aria-selected'),'true');
  });
  await check('saved runs and comparison stay adjacent on desktop and stack without overflow on phone',async()=>{
    await changeView('experiments');
    for(const [name,damping] of [['기준 감쇠',1800],['감쇠 변경',3000]]){
      await page.evaluate(value=>window.suspensionLab.setConfig({holderMode:'sprung',speed:30,road:'bump',compressionDamping:value}),damping);
      await page.locator('#experiment-name').fill(name);await page.locator('#experiment-duration').fill('2');
      await page.locator('#record-experiment-btn').click();
      await page.waitForFunction(()=>!window.suspensionLab.getProductState().busy);
      assert.ok((await page.evaluate(()=>window.suspensionLab.getExperiments())).some(run=>run.name===name));
    }
    assert.equal(await page.locator('#experiment-overlay-chart path[data-experiment-id]').count(),2);
    const list=await page.locator('.experiment-records').boundingBox(),comparison=await page.locator('.selected-experiments').boundingBox();
    assert.ok(Math.abs(list.y-comparison.y)<2);assert.ok(comparison.x>=list.x+list.width);assert.ok(comparison.width>900);
    await page.evaluate(()=>window.suspensionLab.setConfig({speed:45}));
    assert.equal(await page.locator('#context-speed').textContent(),'45 km/h');
    assert.ok((await page.evaluate(()=>window.suspensionLab.getExperiments())).every(run=>run.config.speed===30));
    assert.match(await page.locator('#context-result-scope').textContent(),/기록별 전체/);
    const runs=await page.evaluate(()=>window.suspensionLab.getExperiments());
    for(const run of runs){const metric=page.locator('.selected-experiment').filter({has:page.locator('h4',{hasText:run.name})}).locator('.selected-stat strong').first();assert.match(await metric.textContent(),new RegExp(run.metrics.rmsBodyAcceleration.toFixed(2).replace('.','\\.')));}
    await page.locator('#toast').waitFor({state:'hidden',timeout:7000});
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:output+'/desktop-experiments.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    const mobileList=await page.locator('.experiment-records').boundingBox(),mobileComparison=await page.locator('.selected-experiments').boundingBox();
    assert.ok(mobileComparison.y>=mobileList.y+mobileList.height);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.equal(await page.locator('#experiment-overlay-chart path[data-experiment-id]').count(),2);
    await page.setViewportSize({width:1440,height:1000});evidence.recordReview={list,comparison,mobileList,mobileComparison};
  });
  await check('invalid or unavailable preference storage leaves controls usable',async()=>{
    for(const unavailable of [false,true]){
      const c=await browser.newContext({viewport:{width:1440,height:1000}});
      await c.addInitScript(unavailable=>{
        const key='suspension-lab-dashboard-v1';
        if(unavailable){const get=Storage.prototype.getItem,set=Storage.prototype.setItem;Storage.prototype.getItem=function(k){if(k===key)throw new Error('blocked test storage');return get.call(this,k);};Storage.prototype.setItem=function(k,v){if(k===key)throw new Error('blocked test storage');return set.call(this,k,v);};}
        else localStorage.setItem(key,JSON.stringify({chartLayout:'invalid',settingsExpanded:{bench:'false',analysis:5}}));
      },unavailable);
      const p=await c.newPage();listen(p);await ready(p);const state=await p.evaluate(()=>window.suspensionLab.getDashboardState());assert.equal(state.chartLayout,'overview');assert.equal(state.settingsExpanded,true);
      await p.locator('#dashboard-settings-toggle').click();assert.equal((await p.evaluate(()=>window.suspensionLab.getDashboardState())).settingsExpanded,false);await c.close();
    }
  });
  await check('desktop, laptop, tablet and phone have usable layouts and readable chart axes',async()=>{
    evidence.responsive=[];
    for(const [width,height] of [[1440,1000],[1280,900],[720,900],[390,844]]){
      const c=await browser.newContext({viewport:{width,height}}),p=await c.newPage();listen(p);await ready(p);
      const d=await p.evaluate(()=>window.suspensionLab.getDashboardState());assert.equal(d.settingsExpanded,width>850);
      assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      const canvas=await p.locator('#viewport canvas').boundingBox();assert.ok(canvas.width>280&&canvas.height>=280);
      await p.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await p.screenshot({path:`${output}/bench-${width}.png`});
      await p.evaluate(()=>{window.suspensionLab.advance(2);window.suspensionLab.setWorkspaceView('analysis');});
      assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      const axes=await p.locator('#motion-chart').evaluate(svg=>{const rect=svg.getBoundingClientRect();return [...svg.querySelectorAll('text')].map(text=>{const box=text.getBoundingClientRect();return {text:text.textContent,font:parseFloat(getComputedStyle(text).fontSize),inside:box.left>=rect.left-1&&box.right<=rect.right+1};});});
      assert.ok(axes.length>4);assert.ok(axes.every(axis=>axis.font>=12&&axis.inside),JSON.stringify(axes));
      await p.screenshot({path:`${output}/analysis-${width}.png`,fullPage:true});
      if(width<851){await p.locator('#dashboard-settings-toggle').click();assert.equal(await p.locator('#dashboard-settings-panel').isVisible(),true);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await p.locator('#dashboard-settings-toggle').click();}
      if(width===1440){await p.evaluate(()=>window.suspensionLab.setWorkspaceView('bench'));await p.locator('#structure').focus();await p.setViewportSize({width:390,height:844});await p.waitForFunction(()=>document.getElementById('dashboard-settings-panel').hidden);assert.equal(await p.evaluate(()=>document.activeElement.id),'dashboard-settings-toggle');}
      evidence.responsive.push({width,height,canvas,axes});await c.close();
    }
  });
  await check('dashboard interactions finish without JavaScript or browser console errors',async()=>assert.deepEqual(errors,[]));
  fs.writeFileSync(output+'/report.json',JSON.stringify({status:'passed',baseURL:url,entryScripts,checks,errors,evidence},null,2));
  console.log(`${checks.length} dashboard checks passed`);
} catch(error) {
  await page.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});
  fs.writeFileSync(output+'/report.json',JSON.stringify({status:'failed',checks,errors,evidence,failure:error.stack},null,2));
  throw error;
} finally {await context.close();await browser.close();}
