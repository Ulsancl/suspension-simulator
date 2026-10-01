import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/physics.js';
import { ExperimentLibrary, runExperiment, MODEL_VERSION, experimentCSV } from '../src/experiments.js';
import { getConsumerGuide, runConsumerGuide, describeGuideResults, findConsumerGuideTrials } from '../src/consumer-guide.js';
import { buildReport } from '../src/product.js';

const immediate = async () => {};
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }; };
const existingRecord = () => runExperiment({ holderMode: 'fixed', road: 'pothole' }, { duration: 1, name: '현재 사용자의 기존 기록' });

test('guided first experiment changes only rebound damping and does not modify current settings or retained work', async () => {
  const adapter=storage(),library=new ExperimentLibrary({storage:adapter});await library.ready();
  const existing=existingRecord();await library.save(existing);
  const current=normalizeConfig({ structure:'multilink',springType:'air',holderMode:'fixed',road:'step',speed:77,reboundDamping:5600 });
  const original=structuredClone(current),progress=[];
  const result=await runConsumerGuide(library,{scheduler:immediate,onProgress:value=>progress.push(value)});
  assert.equal(result.ok,true);assert.equal(result.persisted,true);assert.equal(result.trials.length,2);
  assert.deepEqual(current,original);assert.deepEqual(library.get(existing.id),existing);
  const [a,b]=result.trials;
  assert.equal(a.modelVersion,MODEL_VERSION);assert.equal(b.modelVersion,MODEL_VERSION);
  assert.equal(a.duration,8);assert.equal(b.duration,8);
  assert.equal(a.config.holderMode,'sprung');assert.equal(a.config.singleEvent,true);
  assert.equal(a.config.reboundDamping,900);assert.equal(b.config.reboundDamping,4200);
  assert.deepEqual(Object.entries(a.config).filter(([key])=>key!=='reboundDamping'),Object.entries(b.config).filter(([key])=>key!=='reboundDamping'));
  assert.ok(progress.some(value=>value.trialIndex===0));assert.ok(progress.some(value=>value.trialIndex===1));
  assert.equal(progress.at(-1).phase,'saving');
  assert.ok(b.kpis.settlingTime<a.kpis.settlingTime,'example explains faster decay');
  assert.ok(b.metrics.rmsBodyAcceleration>a.metrics.rmsBodyAcceleration,'larger damping does not imply every result improves');
  assert.ok(b.metrics.contactLossPct<a.metrics.contactLossPct,'contact is described independently of acceleration');
  const independent=runExperiment(a.config,{duration:8});
  assert.deepEqual(a.history,independent.history);assert.deepEqual(a.metrics,independent.metrics);
  assert.equal(result.comparison.rows[0].bodyRMS,a.metrics.rmsBodyAcceleration);
  assert.equal(result.comparison.rows[1].contactLossPct,b.metrics.contactLossPct);
  assert.match(result.comparison.sentences[1],/커졌습니다/);
  assert.match(result.comparison.note,/최적 설정이나 안전 판정이 아닙니다/);
});

test('capacity is checked before any computation and keeps every previous record', async () => {
  const library=new ExperimentLibrary({storage:storage(),maxRuns:2});await library.ready();
  const existing=existingRecord();await library.save(existing);let computations=0;
  const result=await runConsumerGuide(library,{scheduler:async()=>{computations++;}});
  assert.equal(result.ok,false);assert.equal(result.reason,'capacity');assert.equal(result.required,2);
  assert.equal(computations,0);assert.deepEqual(library.list(),[existing]);
});

test('cancelling after completed A or during B never saves a partial pair or changes previous work', async () => {
  for(const phase of ['after-a','during-b']){
    const adapter=storage(),library=new ExperimentLibrary({storage:adapter});await library.ready();
    const existing=existingRecord();await library.save(existing);const persistedBefore=[...adapter.values];
    const controller=new AbortController();let completed=0;
    await assert.rejects(()=>runConsumerGuide(library,{scheduler:immediate,signal:controller.signal,
      onTrial:(run,index)=>{completed++;if(phase==='after-a'&&index===0)controller.abort();},
      onProgress:value=>{if(phase==='during-b'&&value.trialIndex===1)controller.abort();},
    }),{name:'AbortError'});
    assert.equal(completed,1);assert.deepEqual(library.list(),[existing]);assert.deepEqual([...adapter.values],persistedBefore);
  }
});

test('absence of a settling estimate is shown honestly instead of zero seconds', async () => {
  const library=new ExperimentLibrary({storage:null});await library.ready();
  const result=await runConsumerGuide(library,{scheduler:immediate});
  const altered=structuredClone(result.trials);
  altered[0].kpis.settlingTime=null;altered[0].kpis.settling.status='not-observed';
  const description=describeGuideResults(altered);
  assert.equal(description.rows[0].settlingSeconds,null);
  assert.match(description.rows[0].settlingLabel,/確認|확인하지 못함/);
  assert.doesNotMatch(description.rows[0].settlingLabel,/약 0\.00초/);
  assert.match(description.sentences[0],/확인하지 못한 기록/);
});

test('guided records, plain interpretation, CSV and report survive project export/import and relaunch', async () => {
  const adapter=storage(),library=new ExperimentLibrary({storage:adapter});await library.ready();
  const result=await runConsumerGuide(library,{scheduler:immediate});
  const userConfig=normalizeConfig({road:'mixed',speed:51,springType:'air'});
  const project=library.exportProject(userConfig,{name:'처음 해본 A/B 체험'});
  assert.deepEqual(project.config,userConfig);
  const target=new ExperimentLibrary({storage:storage()});await target.ready();await target.importProject(JSON.stringify(project));
  assert.deepEqual(target.list(),result.trials);
  const recovered=findConsumerGuideTrials(target.list());
  assert.deepEqual(recovered,result.trials);assert.deepEqual(describeGuideResults(recovered),result.comparison);
  const reloaded=new ExperimentLibrary({storage:adapter});await reloaded.ready();
  assert.deepEqual(findConsumerGuideTrials(reloaded.list()),result.trials);
  assert.equal(experimentCSV(recovered[0]).trim().split('\n').length,recovered[0].history.length+1);
  const report=buildReport(recovered,project.name);
  assert.match(report,/처음 해본 A\/B 체험/);assert.match(report,/A · 작은 리바운드 감쇠/);assert.match(report,/B · 큰 리바운드 감쇠/);
  assert.match(report,/quarter-car-1\.3/);
  assert.match(report,/A\/B 예시에서 관찰한 차이/);assert.match(report,/차체 가속도 크기\(RMS\)/);assert.match(report,/안전 판정이 아닙니다/);
  const unrelated=structuredClone(recovered);unrelated[1].config.roadHeight=.08;
  assert.equal(findConsumerGuideTrials(unrelated),null);
  unrelated[1]=structuredClone(recovered[1]);unrelated[1].modelVersion='quarter-car-1.2';
  assert.equal(findConsumerGuideTrials(unrelated),null);
});

test('example condition descriptions are detached and cannot alter the next experiment',()=>{
  const first=getConsumerGuide();first.config.reboundDamping=0;first.candidates[1]=0;
  const next=getConsumerGuide();assert.equal(next.config.reboundDamping,900);assert.deepEqual(next.candidates,[900,4200]);
});
