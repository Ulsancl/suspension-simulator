import { DEFAULT_CONFIG } from './physics.js';
import { ExperimentLibrary, runExperimentAsync, runDampingSweep, isLegacyExperiment } from './experiments.js';
import { getDesktop } from './desktop.js';
import { runConsumerGuide, describeGuideResults, findConsumerGuideTrials } from './consumer-guide.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (value, digits = 2) => Number.isFinite(value) ? (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toFixed(digits) : '—';
const names = {wishbone:'더블 위시본',multilink:'멀티링크',macpherson:'맥퍼슨',coil:'코일',progressive:'점진형 코일',air:'에어',fixed:'고정 홀더',sprung:'탄성 차체',bump:'범프',step:'턱',pothole:'홀',washboard:'연속 요철',flat:'평탄',mixed:'혼합'};
const colors = ['#79baff','#f3b277','#54dfc5'];
const cleanName = value => String(value || '새 프로젝트').replace(/[\u0000-\u001f]/g, '').trim().slice(0,80) || '새 프로젝트';
const fileName = value => cleanName(value).replace(/[<>:"/\\|?*]/g,'_').replace(/[. ]+$/,'') || 'suspension';
const primaryRMS = run => run.config.holderMode === 'fixed' ? run.metrics.rmsWheelAcceleration : run.metrics.rmsBodyAcceleration;
export const PRESETS = {
  reference:{...DEFAULT_CONFIG},
  comfort:{...DEFAULT_CONFIG,holderMode:'sprung',springRate:22000,compressionDamping:1100,reboundDamping:2000,travelBump:.13,travelRebound:.12},
  sport:{...DEFAULT_CONFIG,holderMode:'sprung',springType:'progressive',springRate:42000,compressionDamping:2300,reboundDamping:3600,speed:50,roadHeight:.045},
  offroad:{...DEFAULT_CONFIG,holderMode:'sprung',structure:'multilink',springType:'air',airPressure:6,airVolume:5,tireRadius:.41,travelBump:.18,travelRebound:.16,road:'mixed',speed:20,roadHeight:.09},
};
const presetNames = {reference:'기준 시험대',comfort:'컴포트',sport:'스포츠',offroad:'험로'};

function download(contents, name, type) {
  const blob = contents instanceof Blob ? contents : new Blob([contents],{type});
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function sameConditions(runs) {
  return runs.length < 2 || runs.slice(1).every(run => ['road','roadHeight','roadWidth','roadSpacing','speed','holderMode','sprungMass','unsprungMass','tireRate','tireRadius','singleEvent'].every(key=>run.config[key]===runs[0].config[key]) && run.duration===runs[0].duration);
}
function metricCards(run) {
  return `<div class="selected-stat"><span>${run.config.holderMode==='fixed'?'휠':'차체'} 가속도 RMS</span><strong>${fmt(primaryRMS(run))}<small>m/s²</small></strong></div><div class="selected-stat"><span>최대 |스트로크|</span><strong>${fmt(run.metrics.peakTravel*1000,1)}<small>mm</small></strong></div><div class="selected-stat"><span>접지 이탈</span><strong>${fmt(run.metrics.contactLossPct,1)}<small>%</small></strong></div><div class="selected-stat"><span>최대 접지력</span><strong>${fmt(run.metrics.peakContactForce/1000)}<small>kN</small></strong></div>`;
}
function seriesFor(run, mode) {
  if(mode==='acceleration') return {key:run.config.holderMode==='fixed'?'wheelAcceleration':'bodyAcceleration',scale:1,unit:'m/s²',label:run.config.holderMode==='fixed'?'휠 가속도':'차체 가속도'};
  if(mode==='contactForce') return {key:'contactForce',scale:.001,unit:'kN',label:'접지력'};
  return {key:'travel',scale:1000,unit:'mm',label:'압축(+) / 신장(−)'};
}
function niceStep(range) {
  const raw=Math.max(range/5,1e-8), power=10**Math.floor(Math.log10(raw)), fraction=raw/power;
  return (fraction<=1?1:fraction<=2?2:fraction<=2.5?2.5:fraction<=5?5:10)*power;
}
export function comparisonSVG(runs, mode='travel', W=1000, H=300, cursorTime=null) {
  const L=W<500?55:70,R=20,T=28,B=45,pw=W-L-R,ph=H-T-B;
  if(!runs.length) return `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#91a5b8" font-size="14">실험을 기록하고 비교할 항목을 선택하세요.</text>`;
  const duration=Math.max(...runs.map(run=>run.duration)), unit=seriesFor(runs[0],mode).unit;
  let min=0,max=mode==='contactForce'?.5:1;
  for(const run of runs){const s=seriesFor(run,mode);for(const row of run.history){min=Math.min(min,row[s.key]*s.scale);max=Math.max(max,row[s.key]*s.scale);}}
  const gap=Math.max(1,max-min),step=niceStep(gap*1.15),lo=mode==='contactForce'?0:Math.floor((min-gap*.06)/step)*step,hi=Math.ceil((max+gap*.08)/step)*step;
  const x=t=>L+t/duration*pw,y=v=>T+ph-(v-lo)/(hi-lo)*ph;
  let html=`<defs><clipPath id="experiment-plot-clip"><rect x="${L}" y="${T}" width="${pw}" height="${ph}"/></clipPath></defs><rect x="${L}" y="${T}" width="${pw}" height="${ph}" rx="5" fill="#101923"/><text x="${L}" y="16" fill="#a1b0c1" font-size="13">${unit}</text>`;
  let digits=0;while(digits<4&&Math.abs(step*10**digits-Math.round(step*10**digits))>1e-7)digits++;
  for(let v=lo,i=0;v<=hi+step*.01&&i<15;v+=step,i++)html+=`<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="#344456" stroke-dasharray="3 5"/><text x="${L-10}" y="${y(v)+4}" text-anchor="end" fill="#a1b0c1" font-size="13">${fmt(v,digits)}</text>`;
  const ticks=W<500?4:8;
  for(let i=0;i<=ticks;i++){const t=duration*i/ticks;html+=`<text x="${x(t)}" y="${H-20}" text-anchor="middle" fill="#a1b0c1" font-size="13">${fmt(t,1)}</text>`;}
  html+=`<text x="${W-R}" y="${H-3}" text-anchor="end" fill="#8da0b4" font-size="13">시험 시간 (s)</text>`;
  runs.forEach((run,index)=>{
    const s=seriesFor(run,mode),bucket=Math.max(1,Math.floor(run.history.length/pw)),sampled=[];
    for(let i=0;i<run.history.length;i+=bucket){const rows=run.history.slice(i,i+bucket),extrema=[rows[0],rows.reduce((a,b)=>a[s.key]<b[s.key]?a:b),rows.reduce((a,b)=>a[s.key]>b[s.key]?a:b),rows.at(-1)];sampled.push(...[...new Set(extrema)].sort((a,b)=>a.time-b.time));}
    const d=sampled.map((row,i)=>`${i?'L':'M'}${x(row.time).toFixed(2)},${y(row[s.key]*s.scale).toFixed(2)}`).join('');
    html+=`<path data-experiment-id="${escape(run.id)}" d="${d}" stroke="${colors[index%colors.length]}" stroke-width="2" fill="none" clip-path="url(#experiment-plot-clip)"/>`;
  });
  if(cursorTime!==null)html+=`<line data-experiment-cursor="true" x1="${x(cursorTime)}" x2="${x(cursorTime)}" y1="${T}" y2="${H-B}" stroke="#eff5ff" stroke-dasharray="4 3"/>`;
  return html;
}
function csv(run) {
  const keys=Object.keys(run.history[0]||{});return '\uFEFF'+keys.join(',')+'\r\n'+run.history.map(row=>keys.map(key=>typeof row[key]==='boolean'?Number(row[key]):row[key]).join(',')).join('\r\n');
}
export function buildReport(runs, projectName) {
  const legend=runs.map((run,i)=>`<span style="display:inline-block;margin-right:20px;color:${colors[i]}">● ${escape(run.name)}</span>`).join('');
  let sections=runs.map((run,i)=>`<section><h2>${i+1}. ${escape(run.name)}</h2><p>${escape(names[run.config.structure])} · ${escape(names[run.config.springType])} · ${escape(names[run.config.holderMode])} · ${escape(names[run.config.road])} · ${fmt(run.config.speed,0)} km/h · ${fmt(run.duration,1)} s</p><div class="metrics">${metricCards(run)}</div><table><tbody>${Object.entries(run.config).map(([k,v])=>`<tr><th>${escape(k)}</th><td>${escape(typeof v==='object'?JSON.stringify(v):v)}</td></tr>`).join('')}</tbody></table><p>모델 ${escape(run.modelVersion)} · 기록 ${escape(run.id)} · ${escape(run.createdAt)} · ${run.history.length} samples</p></section>`).join('');
  const guideTrials=findConsumerGuideTrials(runs);
  if(guideTrials){const comparison=describeGuideResults(guideTrials);sections=`<section><h2>A/B 예시에서 관찰한 차이</h2><p>리바운드 감쇠만 900 → 4,200 N·s/m로 바꾼 동일 조건의 8초 범프 시험입니다.</p><ul>${comparison.sentences.map(sentence=>`<li>${escape(sentence)}</li>`).join('')}</ul><p>${escape(comparison.note)}</p></section>`+sections;}
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(projectName)} — 실험 보고서</title><style>body{font:14px/1.7 system-ui,sans-serif;max-width:1040px;margin:40px auto;padding:0 24px;color:#1b2a3b}h1{font-size:30px}h2{margin-top:28px}section{break-inside:avoid;border-top:1px solid #c4ced8;padding-top:10px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.selected-stat{background:#edf2f6;padding:16px;border-radius:8px}.selected-stat span{display:block;color:#5b6b7a}.selected-stat strong{font-size:22px;display:block}.selected-stat small{font-size:12px;margin-left:5px}td{overflow-wrap:anywhere}table{table-layout:fixed;border-collapse:collapse;width:100%;font-size:12px}th,td{padding:5px 12px;text-align:left;border-bottom:1px solid #e1e7ec}th{width:45%}svg{width:100%;height:300px;background:#101923;border-radius:8px}.note{padding:16px;background:#eef3f7;border-left:3px solid #628db7}@media print{body{margin:0;max-width:none}button{display:none}svg{-webkit-print-color-adjust:exact;print-color-adjust:exact}section{break-before:auto}}@media(max-width:600px){.metrics{grid-template-columns:repeat(2,1fr)}}</style><body><p>SUSPENSION LAB · 실험 비교 보고서</p><h1>${escape(projectName)}</h1><p>${escape(new Date().toLocaleString('ko-KR'))} · ${runs.length}개 실험 · 동일한 정적 평형에서 시작한 계산 결과</p><button onclick="window.print()">인쇄 / PDF 저장</button><p class="note">${sameConditions(runs)?'노면·속도·홀더·질량·시험 시간 조건이 일치합니다.':'조건이 다른 실험이 포함되어 있습니다. 노면·속도·홀더·질량·시간을 확인한 뒤 비교하세요.'} RMS와 접지 이탈은 각 실험 전체 시간을 대상으로 계산합니다. ${runs.some(run=>run.metrics.curveExtrapolationPct>0)?'부품 곡선 범위를 벗어난 계산이 포함됩니다. 기록별 외삽 비율과 원본 특성표를 확인하세요.':''} 수직 ¼ 차량 축약 해석 모델이며 실차 검증이나 부품 강도 해석을 대체하지 않습니다.</p><h2>서스펜션 스트로크 비교</h2><svg viewBox="0 0 1000 300" role="img" aria-label="실험별 스트로크 비교">${comparisonSVG(runs,'travel')}</svg>${legend}${sections}<p>단위: SI (speed: km/h, airPressure: bar, airVolume: L). 생성한 HTML 파일은 네트워크 연결 없이 열 수 있습니다.</p></body></html>`;
}

export function initProduct({getConfig,setConfig,setRunning,getScene,notify}) {
  const library=new ExperimentLibrary();
  const desktop=getDesktop(),savedStatus=desktop?'이 앱에 자동 저장됨':'이 브라우저에 자동 저장됨';
  let selected=[],lastSweep=null,busy=false,mutationBusy=false,controller=null,ready=false,projectName='서스펜션 프로젝트',cursorTime=null,fileOperation=false;
  let guideState={phase:'idle',progress:0,runIds:[],comparison:null,error:null};
  const isBusy=()=>busy||mutationBusy;
  try{projectName=cleanName(localStorage.getItem('suspension-lab-project-name')||projectName);}catch{}
  const projectInput=$('#project-name');if(projectInput)projectInput.value=projectName;
  const selectedRuns=()=>selected.map(id=>library.get(id)).filter(Boolean);
  const status=(text,state='saved')=>{const element=$('#project-save-status');if(element){element.textContent=text;element.dataset.state=state;}};
  const storeName=()=>{try{localStorage.setItem('suspension-lab-project-name',projectName);}catch{status('메모리 사용 · 파일 저장 권장','warning');}};
  const recoveryReasons={
    'legacy-model':'이전 모델 기록입니다. 원래 결과를 읽기 전용으로 보관하며 새 시험은 현재 모델에서 계산합니다.',
    'unsupported-schema':'이 앱이 지원하지 않는 저장 형식입니다. 원문을 내려받아 이 형식을 지원하는 앱에서 여세요.',
    'unsupported-model':'이 앱이 지원하지 않는 모델 버전입니다. 원문을 보관하며 현재 모델로 자동 재계산하지 않습니다.',
    'unknown-model':'모델 버전을 확인할 수 없습니다. 원문을 보관했으며 계산 결과로 가져오지 않았습니다.',
    'corrupt-storage':'저장 원문의 형식 또는 값이 올바르지 않습니다. 원문을 보관했으며 결과를 가져오지 않았습니다.',
    'backup-failed':'원문 백업을 확인하지 못해 새 기록은 메모리에만 보관했습니다. 원문은 그대로 남아 있습니다. 프로젝트 파일과 원문을 각각 저장해 주세요.',
    'recovery-required':'저장 영역을 안전하게 확인하지 못해 새 기록은 메모리에만 보관합니다. 원문을 내려받고 프로젝트 파일을 저장해 주세요.',
  };
  const recoveryPanel=document.createElement('aside');recoveryPanel.id='experiment-recovery-panel';recoveryPanel.className='experiment-card';recoveryPanel.hidden=true;recoveryPanel.setAttribute('aria-label','이전 저장 원문 보관 및 복구');
  $('#experiment-list')?.before(recoveryPanel);
  function renderRecoveries(){
    const entries=library.getRecoveries();recoveryPanel.hidden=!entries.length;
    recoveryPanel.innerHTML=entries.length?`<strong>이전 저장 원문 보관</strong><p>새 작업과 따로 보관합니다. 원문 내려받기는 파일 내용을 바꾸지 않습니다. 읽을 수 있는 사본만 복구할 수 있습니다.</p>${entries.map(entry=>`<div><p>${escape(entry.modelVersion||'버전 확인 불가')} · ${escape(recoveryReasons[entry.reason]||'저장 공간을 확인하지 못했습니다. 원문은 보관합니다.')} ${entry.persisted?'백업 확인됨.':'원문 별도 저장 권장.'}</p><div class="experiment-card-actions"><button class="button button-small button-quiet" data-recovery-action="export" data-recovery-id="${escape(entry.id)}">원문 내려받기</button>${entry.restorable?`<button class="button button-small button-quiet" data-recovery-action="restore" data-recovery-id="${escape(entry.id)}">보관 기록 복구</button>`:''}</div></div>`).join('')}`:'';
  }
  recoveryPanel.addEventListener('click',async event=>{
    const button=event.target.closest('[data-recovery-action]');if(!button||isBusy()||fileOperation)return;
    const id=button.dataset.recoveryId;
    if(button.dataset.recoveryAction==='export'){try{download(library.exportRecovery(id),`suspension-original-${id.slice(0,12)}.json`,'application/json');}catch(error){notify(error.message,true);}return;}
    if(!confirm('현재 보관함을 원문 사본의 기록으로 교체할까요? 현재 작업은 프로젝트 파일로 먼저 저장하세요. 이전 모델 기록은 읽기 전용으로 열립니다.'))return;
    setMutationBusy(true);try{const result=await library.restoreRecovery(id);persistence(result);if(result.config){setRunning(false);setConfig(result.config);}if(result.name){projectName=cleanName(result.name);if(projectInput)projectInput.value=projectName;storeName();}selected=library.list().slice(0,3).map(run=>run.id);lastSweep=null;renderRecords();renderSweep();if(result.persisted)notify('원문 사본에서 보관 기록을 복구했습니다. 원문은 그대로 유지됩니다.');}catch(error){notify(`복구 실패: ${error.message}`,true);}finally{setMutationBusy(false);}
  });
  const persistence=result=>{renderRecoveries();if(result?.ok===false)throw new Error(result.reason==='capacity'?'보관함이 가득 찼습니다. 프로젝트를 저장한 뒤 새 프로젝트를 시작하거나 현재 모델의 기록을 삭제하세요.':result.reason==='read-only'?'이전 모델 기록은 읽기 전용입니다. 원문과 원래 계산 결과를 유지합니다.':result.reason||'기록을 저장하지 못했습니다.');if(result?.persisted===false){status('메모리 보관 · 프로젝트 파일 저장 권장','warning');notify(recoveryReasons[result.reason]||`${desktop?'앱':'브라우저'} 저장 공간을 사용할 수 없어 메모리에 보관했습니다. 프로젝트 파일을 저장해 주세요.`,true);}else status(savedStatus);};
  function renderGuide(){
    const start=$('#run-consumer-guide-btn'),cancel=$('#cancel-consumer-guide-btn'),view=$('#view-consumer-guide-btn'),message=$('#consumer-guide-status'),result=$('#consumer-guide-results');
    const active=guideState.phase==='computing'||guideState.phase==='saving',full=library.list().length+2>library.maxRuns;
    if(start){start.disabled=!ready||isBusy()||fileOperation||full;start.textContent=guideState.phase==='complete'?'A/B 예시 다시 실험하기':'A/B 예시 실험 해보기';}
    if(cancel){cancel.hidden=!active;cancel.disabled=guideState.phase==='saving';}
    const recordsPresent=guideState.runIds.length===2&&guideState.runIds.every(id=>library.get(id));
    if(view){view.hidden=!recordsPresent;view.disabled=isBusy()||fileOperation;}
    if(message)message.textContent=!ready?'실험 보관함을 준비하고 있습니다.':active?(guideState.phase==='saving'?'A와 B를 함께 보관하고 있습니다.':`A/B 예시 계산 중 · ${Math.round(guideState.progress*100)}%`):guideState.error||(full?'예시 기록 두 개를 보관할 공간이 필요합니다. 프로젝트를 저장한 뒤 새 프로젝트를 시작하거나 현재 기록을 정리하세요.':recordsPresent?'예시 두 기록을 보관했습니다. ‘결과 보기’로 비교하세요.':'현재 설정을 바꾸지 않고 예시 기록 두 개를 추가합니다.');
    if(!result)return;
    result.hidden=!recordsPresent;
    if(!recordsPresent)return;
    const comparison=guideState.comparison;
    result.innerHTML=`<h3>A와 B에서 무엇이 달라졌나요?</h3><div class="consumer-guide-row-grid">${comparison.rows.map(row=>`<div class="consumer-guide-row"><strong>${escape(row.label)} · ${fmt(row.damping,0)} N·s/m</strong><p>잔흔들림 정착 추정: ${escape(row.settlingLabel)}</p><p>차체 가속도 크기(RMS): ${fmt(row.bodyRMS)} m/s²</p><p>노면 접촉을 잃은 시간: ${fmt(row.contactLossPct)}%</p></div>`).join('')}</div><ul>${comparison.sentences.map(sentence=>`<li>${escape(sentence)}</li>`).join('')}</ul><p>RMS는 시험 전체에서 가속도가 얼마나 크게 변했는지 나타냅니다. 정착 시간은 요철 통과 뒤 작은 잔흔들림 상태가 유지된 첫 구간의 추정입니다.</p><p>${escape(comparison.note)}</p><div class="consumer-guide-result-actions"><button type="button" class="button button-small button-quiet" data-guide-action="compare">두 기록 그래프 보기</button><button type="button" class="button button-small button-quiet" data-guide-action="save">이 결과와 프로젝트 저장</button><span>다음에는 설정을 직접 조절하고 ‘시험 기록’으로 비교해 보세요.</span></div>`;
  }
  function recoverGuide(){
    const trials=findConsumerGuideTrials(library.list());
    if(trials)guideState={phase:'complete',progress:1,runIds:trials.map(run=>run.id),comparison:describeGuideResults(trials),error:null};
    else if(guideState.phase==='complete')guideState={phase:'idle',progress:0,runIds:[],comparison:null,error:null};
    renderGuide();
  }
  function showGuideComparison(){
    selected=guideState.runIds.filter(id=>library.get(id));cursorTime=null;
    if($('#experiment-overlay-mode'))$('#experiment-overlay-mode').value='acceleration';
    $('.workspace-nav a[href="#experiment-workspace"]')?.click();renderRecords();
    $('#selected-experiment-summary')?.scrollIntoView({block:'start',behavior:'smooth'});
  }
  async function guidedExperiment(){
    if(isBusy()||fileOperation||!ready)return;
    if(library.list().length+2>library.maxRuns){guideState.error='예시 기록 두 개를 보관할 공간이 필요합니다. 프로젝트를 먼저 저장하고 보관함을 정리하세요.';renderGuide();return;}
    const previous={...guideState};controller=new AbortController();guideState={phase:'computing',progress:0,runIds:[],comparison:null,error:null};setBusy(true);renderGuide();
    try{
      const result=await runConsumerGuide(library,{signal:controller.signal,onProgress:value=>{guideState.phase=value.phase;guideState.progress=value.overallProgress;renderGuide();}});
      persistence(result);guideState={phase:'complete',progress:1,runIds:result.trials.map(run=>run.id),comparison:result.comparison,error:null};renderRecords();showGuideComparison();
      if(result.persisted)notify('A/B 예시 두 개를 보관했습니다. 한 가지 감쇠 값이 바꾼 결과를 비교해 보세요.');
    }catch(error){guideState={...previous,error:error.name==='AbortError'?'체험을 중단했습니다. 기존 기록과 현재 설정은 그대로입니다.':error.message};renderGuide();if(error.name!=='AbortError')notify(error.message,true);}
    finally{controller=null;setBusy(false);renderGuide();}
  }
  function renderComparison(){
    const runs=selectedRuns(),svg=$('#experiment-overlay-chart'),mode=$('#experiment-overlay-mode')?.value||'travel';
    if(svg){const W=Math.max(300,Math.round(svg.clientWidth||1000)),H=Math.max(270,Math.round(svg.clientHeight||300));svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.innerHTML=comparisonSVG(runs,mode,W,H,cursorTime);}
    const readout=$('#experiment-overlay-readout');
    if(readout){
      if(cursorTime===null||!runs.length)readout.textContent='포인터를 올려 선택한 실험의 동일 시점 응답을 확인하세요.';
      else readout.textContent=`t ${fmt(cursorTime,3)} s · ${runs.map(run=>{const s=seriesFor(run,mode);const row=run.history.reduce((a,b)=>Math.abs(a.time-cursorTime)<Math.abs(b.time-cursorTime)?a:b);return `${run.name}: ${fmt(row[s.key]*s.scale)} ${s.unit}`;}).join(' · ')}`;
    }
    const legend=$('#experiment-overlay-legend');if(legend)legend.innerHTML=runs.map((run,i)=>`<span class="comparison-key" style="--series-color:${colors[i]}"><i></i>${escape(run.name)} · ${escape(seriesFor(run,mode).label)}</span>`).join('');
    const summary=$('#selected-experiment-summary');if(summary)summary.innerHTML=runs.length?`<div class="comparison-condition ${sameConditions(runs)?'matched':'mismatched'}">${sameConditions(runs)?'동일 조건 · 정적 평형 기준 비교':'조건 차이 있음 · 노면·속도·홀더·질량·시간을 확인하세요'}</div>${runs.map(run=>`<div class="selected-experiment"><h4>${escape(run.name)}</h4><div class="selected-stats">${metricCards(run)}</div></div>`).join('')}`:'<p class="empty-copy">기록의 비교 체크박스를 선택하면 최대 3개 실험의 응답을 같은 시간축에서 볼 수 있습니다.</p>';
    for(const id of ['experiment-report-btn','experiment-export-btn']){const b=$('#'+id);if(b)b.disabled=!runs.length||isBusy();}
  }
  function renderRecords(){
    const runs=library.list(),list=$('#experiment-list');selected=selected.filter(id=>runs.some(run=>run.id===id));
    if($('#experiment-count'))$('#experiment-count').textContent=`${runs.length} / 12`;
    if(list)list.innerHTML=runs.length?runs.map(run=>`<article class="experiment-card" data-record-id="${escape(run.id)}"><div class="experiment-card-header"><label class="experiment-selection"><input type="checkbox" data-compare-id="${escape(run.id)}" ${selected.includes(run.id)?'checked':''} aria-label="${escape(run.name)} 비교 선택"><span>${escape(run.name)}</span></label><span class="experiment-duration">${fmt(run.duration,1)} s</span></div><p>${escape(names[run.config.structure])} · ${escape(names[run.config.springType])} · ${escape(names[run.config.holderMode])} · ${fmt(run.config.speed,0)} km/h / ${escape(names[run.config.road])}</p><p>모델 ${escape(run.modelVersion)}${isLegacyExperiment(run)?' · 이전 계산 결과 · 읽기 전용':''}</p><div class="experiment-card-metrics"><span>RMS <strong>${fmt(primaryRMS(run))} m/s²</strong></span><span>스트로크 <strong>${fmt(run.metrics.peakTravel*1000,1)} mm</strong></span><span>접지 이탈 <strong>${fmt(run.metrics.contactLossPct,1)}%</strong></span></div><div class="experiment-card-actions"><button class="button button-small button-quiet" data-record-action="load" data-record-id="${escape(run.id)}" ${isLegacyExperiment(run)?'disabled title="이전 모델 설정을 현재 모델에 자동 적용하지 않습니다."':''}>설정 적용</button><button class="button button-small button-quiet" data-record-action="export" data-record-id="${escape(run.id)}">CSV</button><button class="button button-small button-quiet" data-record-action="delete" data-record-id="${escape(run.id)}" aria-label="${escape(run.name)} 기록 삭제" ${isLegacyExperiment(run)?'disabled title="이전 기록은 원래 결과를 유지합니다. 새 프로젝트를 시작하면 현재 보관함을 비울 수 있습니다."':''}>삭제</button></div></article>`).join(''):'<div class="experiment-empty"><strong>아직 기록한 실험이 없습니다.</strong><p>프리셋 또는 직접 설정한 조건으로 표준 시험을 실행해 보세요. 실험대의 현재 재생 위치와 관계없이 평형점에서 다시 계산합니다.</p></div>';
    renderRecoveries();
    recoverGuide();renderComparison();
  }
  function renderBusy(){const blocked=isBusy();desktop?.setBusy(blocked);for(const id of ['record-experiment-btn','run-sweep-btn','new-project-btn','open-project-btn']){const b=$('#'+id);if(b)b.disabled=blocked || (id==='run-sweep-btn' && !!getConfig().componentProfile?.damper);}if($('#save-project-btn'))$('#save-project-btn').disabled=mutationBusy;if($('#cancel-sweep-btn'))$('#cancel-sweep-btn').hidden=!busy;renderGuide();renderComparison();}
  function setBusy(value){busy=value;renderBusy();}
  function setMutationBusy(value){mutationBusy=value;renderBusy();}
  const progress=(fraction,text)=>{const e=$('#experiment-progress');if(e){e.textContent=text||`${Math.round(fraction*100)}% · 시험 계산 중`;e.dataset.progress=String(fraction);}};
  async function record(){
    if(isBusy()||fileOperation||!ready)return;const duration=Number($('#experiment-duration')?.value||8),name=cleanName($('#experiment-name')?.value||`실험 ${library.list().length+1}`),config={...getConfig()};
    controller=new AbortController();setBusy(true);setRunning(false);progress(0,'정적 평형에서 표준 시험을 계산합니다.');
    try{const run=await runExperimentAsync(config,{duration,name,signal:controller.signal,onProgress:f=>progress(typeof f==='number'?f:f.progress||0)});const result=await library.save(run);persistence(result);selected=[run.id,...selected.filter(id=>id!==run.id)].slice(0,3);renderRecords();progress(1,`${run.name} · ${fmt(run.duration,1)}초 시험 완료`);if(result.persisted)notify('실험 기록과 전체 응답 데이터를 보관했습니다.');}
    catch(error){progress(0,error.name==='AbortError'?'시험 계산을 취소했습니다.':error.message);if(error.name!=='AbortError')notify(error.message,true);}
    finally{controller=null;setBusy(false);}
  }
  function renderSweep(){
    const element=$('#sweep-results');if(!element)return;if(!lastSweep){element.innerHTML='';return;}
    const trials=lastSweep.trials, winnerId=lastSweep.recommendation?.trialId;
    element.innerHTML=`<div class="sweep-method">${escape(lastSweep.method?.description||lastSweep.method||'같은 노면·시간·홀더 조건에서 선택한 감쇠 값만 바꿉니다. 접지 이탈이 적은 후보부터 RMS를 비교합니다.')}</div><div class="sweep-table-scroll"><table class="sweep-table"><thead><tr><th>감쇠 값 (N·s/m)</th><th>${lastSweep.config.holderMode==='fixed'?'휠':'차체'} RMS (m/s²)</th><th>스트로크 (mm)</th><th>접지 이탈 (%)</th><th>작업</th></tr></thead><tbody>${trials.map(run=>`<tr ${run.id===winnerId?'class="recommended"':''}><td>${fmt(run.config[lastSweep.coefficient||$('#sweep-parameter').value],0)}</td><td>${fmt(primaryRMS(run))}</td><td>${fmt(run.metrics.peakTravel*1000,1)}</td><td>${fmt(run.metrics.contactLossPct,1)}</td><td><button class="button button-small button-quiet" data-sweep-load="${escape(run.id)}">설정 적용</button></td></tr>`).join('')}</tbody></table></div><p class="sweep-note">이 순위는 현재 노면과 축약 모델에서의 비교입니다. 다른 속도·노면에서는 결과가 달라집니다.</p>`;
  }
  async function sweep(){
    if(isBusy()||fileOperation||!ready)return;
    const min=Number($('#sweep-min').value),max=Number($('#sweep-max').value),count=Number($('#sweep-count').value),coefficient=$('#sweep-parameter').value,duration=Number($('#experiment-duration').value||8);
    if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<=min||max>(coefficient==='compressionDamping'?16000:20000)||!Number.isInteger(count)||count<3||count>7){notify('감쇠 범위와 후보 수를 확인하세요. 최대값은 최소값보다 커야 하며 후보는 3–7개입니다.',true);return;}
    if(library.list().length+count>12){notify(`후보 ${count}개를 보관할 공간이 필요합니다. 기존 프로젝트를 저장하고 기록 일부를 삭제하세요.`,true);return;}
    const candidates=Array.from({length:count},(_,i)=>min+(max-min)*i/(count-1)),config={...getConfig()};
    controller=new AbortController();setBusy(true);setRunning(false);progress(0,'감쇠 후보를 동일 조건에서 순서대로 계산합니다.');
    try{const result=await runDampingSweep(config,{coefficient,candidates,duration,name:cleanName($('#experiment-name').value||'감쇠 비교'),signal:controller.signal,onProgress:p=>progress(typeof p==='number'?p:p.overallProgress||0)});lastSweep={...result,coefficient};const saved=await library.saveBatch(result.trials);persistence(saved);selected=result.trials.slice(0,3).map(run=>run.id);renderRecords();renderSweep();progress(1,`${count}개 후보 비교 완료 · 각 ${fmt(duration,1)}초`);if(saved.persisted)notify('감쇠 후보별 계산과 비교 기록을 저장했습니다.');}
    catch(error){progress(0,error.name==='AbortError'?'비교 시험을 취소했습니다.':error.message);if(error.name!=='AbortError')notify(error.message,true);}
    finally{controller=null;setBusy(false);}
  }
  async function saveProject(){
    if(fileOperation||mutationBusy||!ready)return;
    try{
      projectName=cleanName(projectInput?.value||projectName);storeName();
      const data=library.exportProject(getConfig(),{name:projectName});data.vehicleName=$('#vehicle-name')?.value?.slice(0,80)||'';
      const contents=JSON.stringify(data),name=`${fileName(projectName)}.suspension.json`;
      if(desktop){fileOperation=true;const result=await desktop.saveProject({contents,name});if(result.canceled)return;status('프로젝트 파일 저장됨');}
      else{download(contents,name,'application/json');status('프로젝트 파일 내보냄');}
      notify('설정과 모든 보관 기록을 프로젝트 파일로 저장했습니다.');
    }catch(error){notify(`프로젝트 저장 실패: ${error.message}`,true);}
    finally{fileOperation=false;}
  }
  async function openProject(){
    if(isBusy()||fileOperation||!ready)return;
    if(!desktop){$('#project-import-file')?.click();return;}
    fileOperation=true;
    try{const result=await desktop.openProject();if(result.canceled)return;if(typeof result.content!=='string')throw new Error('프로젝트 파일을 읽지 못했습니다.');await importProject(new Blob([result.content],{type:'application/json'}),true);}
    catch(error){notify(`프로젝트 열기 실패: ${error.message}`,true);}
    finally{fileOperation=false;}
  }
  async function importProject(file,fromDesktopDialog=false){
    if(isBusy()||(fileOperation&&!fromDesktopDialog))return;
    setMutationBusy(true);
    try{if(file.size>40*1024*1024)throw new Error('프로젝트 파일은 40MB 이하여야 합니다.');const raw=await file.text();const result=await library.importProject(raw);const data=JSON.parse(raw);persistence(result);setRunning(false);setConfig(result.config||data.config);if($('#vehicle-name')){$('#vehicle-name').value=typeof data.vehicleName==='string'?data.vehicleName.slice(0,80):'';$('#vehicle-name').dispatchEvent(new Event('input'));}projectName=cleanName(data.name||data.project?.name||'가져온 프로젝트');if(projectInput)projectInput.value=projectName;storeName();selected=library.list().slice(0,3).map(run=>run.id);lastSweep=null;renderRecords();renderSweep();if(result.persisted)notify('프로젝트의 설정과 기록을 복원했습니다.');}
    catch(error){renderRecoveries();notify(`프로젝트 열기 실패: ${error.message}`,true);}
    finally{setMutationBusy(false);}
  }
  projectInput?.addEventListener('input',()=>{projectName=cleanName(projectInput.value);storeName();status(library.status.persisted?savedStatus:'메모리 보관 · 파일 저장 권장',library.status.persisted?'saved':'warning');});
  $('#save-project-btn')?.addEventListener('click',saveProject);
  $('#open-project-btn')?.addEventListener('click',()=>void openProject());
  $('#project-import-file')?.addEventListener('change',e=>{const file=e.target.files?.[0];if(file)void importProject(file);e.target.value='';});
  $('#new-project-btn')?.addEventListener('click',async()=>{if(isBusy()||fileOperation)return;if(library.list().length&&!confirm('현재 보관 기록을 비우고 새 프로젝트를 시작할까요? 필요한 기록은 프로젝트 파일로 먼저 저장하세요.'))return;setMutationBusy(true);try{persistence(await library.clear());selected=[];lastSweep=null;projectName='새 프로젝트';if(projectInput)projectInput.value=projectName;storeName();setRunning(false);setConfig(DEFAULT_CONFIG);renderRecords();renderSweep();progress(0,'새 프로젝트 준비 완료');}catch(error){notify(error.message,true);}finally{setMutationBusy(false);}});
  for(const button of document.querySelectorAll('[data-preset]'))button.addEventListener('click',()=>{if(isBusy()||fileOperation)return;const key=button.dataset.preset;if(!PRESETS[key])return;setRunning(false);setConfig(PRESETS[key]);if($('#experiment-name'))$('#experiment-name').value=presetNames[key];notify(`${presetNames[key]} 대표 조건을 적용했습니다.`);});
  $('#record-experiment-btn')?.addEventListener('click',()=>void record());
  $('#run-consumer-guide-btn')?.addEventListener('click',()=>void guidedExperiment());
  $('#cancel-consumer-guide-btn')?.addEventListener('click',()=>controller?.abort());
  $('#view-consumer-guide-btn')?.addEventListener('click',()=>{if(!isBusy()&&!fileOperation)showGuideComparison();});
  $('#consumer-guide-results')?.addEventListener('click',event=>{const action=event.target.closest('[data-guide-action]')?.dataset.guideAction;if(isBusy()||fileOperation)return;if(action==='compare')showGuideComparison();if(action==='save')void saveProject();});
  $('#run-sweep-btn')?.addEventListener('click',()=>void sweep());
  $('#cancel-sweep-btn')?.addEventListener('click',()=>controller?.abort());
  $('#experiment-list')?.addEventListener('change',event=>{const id=event.target.dataset.compareId;if(!id)return;if(event.target.checked){if(selected.length>=3){event.target.checked=false;notify('동시에 비교할 수 있는 기록은 최대 3개입니다.');return;}selected.push(id);}else selected=selected.filter(value=>value!==id);cursorTime=null;renderComparison();});
  $('#experiment-list')?.addEventListener('click',async event=>{const button=event.target.closest('[data-record-action]');if(!button||button.disabled||isBusy()||fileOperation)return;const run=library.get(button.dataset.recordId);if(!run)return;try{if(button.dataset.recordAction==='load'){if(isLegacyExperiment(run))return;setRunning(false);setConfig(run.config);notify(`${run.name}의 시험 조건을 적용했습니다.`);}else if(button.dataset.recordAction==='export')download(csv(run),`${fileName(run.name)}.csv`,'text/csv;charset=utf-8');else if(button.dataset.recordAction==='delete'){setMutationBusy(true);try{persistence(await library.remove(run.id));renderRecords();}finally{setMutationBusy(false);}}}catch(error){notify(error.message,true);}});
  $('#sweep-results')?.addEventListener('click',event=>{const id=event.target.closest('[data-sweep-load]')?.dataset.sweepLoad,run=lastSweep?.trials.find(value=>value.id===id);if(run&&!isBusy()&&!fileOperation){setRunning(false);setConfig(run.config);notify(`${run.name}의 감쇠 설정을 적용했습니다.`);}});
  $('#experiment-overlay-mode')?.addEventListener('change',()=>{cursorTime=null;renderComparison();});
  const overlay=$('#experiment-overlay-chart');
  if(overlay){new ResizeObserver(renderComparison).observe(overlay);overlay.addEventListener('pointermove',event=>{const runs=selectedRuns();if(!runs.length)return;const rect=overlay.getBoundingClientRect(),left=rect.width<500?55:70;cursorTime=Math.max(0,Math.min(1,(event.clientX-rect.left-left)/(rect.width-left-20)))*Math.max(...runs.map(run=>run.duration));renderComparison();});overlay.addEventListener('pointerleave',()=>{cursorTime=null;renderComparison();});}
  $('#experiment-report-btn')?.addEventListener('click',()=>download(buildReport(selectedRuns(),projectName),`${fileName(projectName)}-report.html`,'text/html;charset=utf-8'));
  $('#experiment-export-btn')?.addEventListener('click',()=>download(JSON.stringify({format:'suspension-lab-records/v1',runs:selectedRuns()}),`${fileName(projectName)}-records.json`,'application/json'));
  $('#studio-mode')?.addEventListener('change',e=>getScene()?.setStudioMode?.(e.target.value));
  $('#view-component')?.addEventListener('change',e=>getScene()?.setComponentFocus?.(e.target.value));
  $('#capture-view-btn')?.addEventListener('click',()=>{try{const data=getScene()?.capturePNG();if(!data)throw new Error('3D 화면을 먼저 준비해 주세요.');const a=document.createElement('a');a.href=data;a.download=`${fileName(projectName)}-view.png`;a.click();if(!desktop)notify('현재 3D 화면을 PNG로 저장했습니다.');}catch(error){notify(error.message,true);}});
  $('#export-model-btn')?.addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{const data=await getScene()?.exportGLB();if(!(data instanceof ArrayBuffer))throw new Error('3D 모델을 내보내지 못했습니다.');download(data,`${fileName(projectName)}-rig.glb`,'model/gltf-binary');if(!desktop)notify('현재 형상과 모델 정보를 GLB로 저장했습니다.');}catch(error){notify(error.message,true);}finally{button.disabled=false;}});
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'){e.preventDefault();void saveProject();}if((e.ctrlKey||e.metaKey)&&e.code==='KeyO'){e.preventDefault();void openProject();}});
  const readyPromise=library.ready().then(result=>{if(result.ok===false||result.reason==='legacy-model')notify(recoveryReasons[result.reason]||'저장 공간을 읽지 못했습니다. 새 작업은 프로젝트 파일로 저장해 주세요.',result.ok===false);if(result.fallbackReason)notify('기본 앱 저장 공간을 사용할 수 없어 대체 저장 공간을 사용합니다. 기존 원문은 기본 저장 공간에 그대로 남아 있습니다.',true);ready=true;selected=library.list().slice(0,3).map(run=>run.id);renderRecords();status(result.persisted?(result.reason==='legacy-model'?'이전 기록 읽기 전용 · 새 시험 별도 저장':savedStatus):'메모리 보관 · 파일 저장 권장',result.persisted?'saved':'warning');}).catch(error=>{ready=true;renderRecords();status('메모리 사용 · 파일 저장 권장','warning');notify(error.message,true);});
  return {ready:readyPromise,library,record,sweep,guidedExperiment,saveProject,openProject,importProject,configurationChanged(){if(ready)status(library.status.persisted?savedStatus:'메모리 보관 · 파일 저장 권장',library.status.persisted?'saved':'warning');renderBusy();},getState:()=>({ready,busy:isBusy(),projectName,selected:[...selected],recordCount:library.list().length,sweepCount:lastSweep?.trials.length||0,guide:{phase:guideState.phase,runIds:[...guideState.runIds],progress:guideState.progress}}),getRecords:()=>library.list(),getSweep:()=>lastSweep};
}
