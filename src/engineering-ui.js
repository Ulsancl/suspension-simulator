import { SuspensionSimulation } from './physics.js';
import { linearQuarterCarProperties, runBenchmarkSuite, parseMeasurementCSV, compareMeasurement } from './engineering.js';
import { validateComponentProfile, COMPONENT_PROFILE_TEMPLATE } from './component-curves.js';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,d=3)=>Number.isFinite(v)?v.toFixed(d):'—';
function download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function linePlot(series,{W,H,title,unit,xUnit='s',offsetY=0}){
  const L=60,R=18,T=35+offsetY,B=38,pw=W-L-R,ph=H-35-B;
  let xmin=Infinity,xmax=-Infinity,min=0,max=0;
  for(const s of series)for(const p of s.points){xmin=Math.min(xmin,p[0]);xmax=Math.max(xmax,p[0]);min=Math.min(min,p[1]);max=Math.max(max,p[1]);}
  if(!Number.isFinite(xmin))return '';
  if(xmax===xmin)xmax=xmin+1;const gap=Math.max(max-min,1e-4),raw=gap*1.2/4,power=10**Math.floor(Math.log10(raw)),fraction=raw/power,step=(fraction<=1?1:fraction<=2?2:fraction<=2.5?2.5:fraction<=5?5:10)*power;
  min=min<0?Math.floor((min-gap*.08)/step)*step:0;max=Math.ceil((max+gap*.12)/step)*step;
  const x=v=>L+(v-xmin)/(xmax-xmin)*pw,y=v=>T+ph-(v-min)/(max-min)*ph;
  let out=`<text x="${L}" y="${offsetY+16}" font-size="13" fill="#cddfec">${escape(title)} · ${escape(unit)}</text><rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="#101923" rx="4"/>`;
  let digits=0;while(digits<5&&Math.abs(step*10**digits-Math.round(step*10**digits))>1e-7)digits++;
  for(let v=min,i=0;v<=max+step*.01&&i<10;v+=step,i++)out+=`<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="#344456" stroke-dasharray="3 5"/><text x="${L-10}" y="${y(v)+4}" text-anchor="end" font-size="13">${fmt(v,digits)}</text>`;
  for(let i=0;i<=4;i++){const t=xmin+(xmax-xmin)*i/4;out+=`<text x="${x(t)}" y="${offsetY+H-23}" text-anchor="middle" font-size="13">${fmt(t,Math.abs(xmax-xmin)<1?3:1)}</text>`;}
  out+=`<text x="${W-R}" y="${offsetY+H-7}" text-anchor="end" font-size="13">${escape(xUnit)}</text>`;
  series.forEach(s=>{const stride=Math.max(1,Math.floor(s.points.length/(pw*2))),kept=[];for(let i=0;i<s.points.length;i+=stride){const bucket=s.points.slice(i,i+stride),extrema=[bucket[0],bucket.reduce((a,b)=>a[1]<b[1]?a:b),bucket.reduce((a,b)=>a[1]>b[1]?a:b),bucket.at(-1)];kept.push(...[...new Set(extrema)].sort((a,b)=>a[0]-b[0]));}const path=kept.map((p,i)=>`${i?'L':'M'}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join('');out+=`<path data-validation-series="${escape(s.key)}" d="${path}" stroke="${s.color}" fill="none" stroke-width="2"/>`;});return out;
}
export function initEngineering({getConfig,setConfig,getMetrics,getRun,notify}){
  let measurement=null,result=null,sourceText='',lastConfig=null,properties=null,vehicleName='';
  const benchmark=runBenchmarkSuite();
  const vehicle=$('#vehicle-name');try{vehicleName=localStorage.getItem('suspension-lab-vehicle-name')||'';}catch{}if(vehicle)vehicle.value=vehicleName;
  vehicle?.addEventListener('input',()=>{vehicleName=vehicle.value.trim().slice(0,80);try{localStorage.setItem('suspension-lab-vehicle-name',vehicleName);}catch{}});
  function renderProfile(){
    const svg=$('#component-profile-chart');if(!svg)return;const profile=getConfig().componentProfile,W=Math.max(300,Math.round(svg.clientWidth||900));
    const plots=profile?[profile.spring?{title:'스프링 축력',unit:'N',xUnit:'압축량 (m)',points:profile.spring}:null,profile.damper?{title:'댐퍼 축력',unit:'N',xUnit:'압축(+) / 신장(−) 속도 (m/s)',points:profile.damper}:null].filter(Boolean):[];
    const desiredHeight=plots.length>1?440:260;const parent=svg.parentElement;if(parent.style.height!==`${desiredHeight}px`)parent.style.height=`${desiredHeight}px`;
    const H=desiredHeight;svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.innerHTML=plots.length?plots.map((plot,i)=>linePlot([{key:plot.title,color:i?'#f3b277':'#79baff',points:plot.points}],{...plot,W,H:H/plots.length,offsetY:i*H/plots.length})).join(''):`<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="13">부품 특성표를 가져오세요.</text>`;
  }
  function renderMeasurement(){
    const svg=$('#measurement-chart');if(!svg)return;const W=Math.max(300,Math.round(svg.clientWidth||900)),H=Math.max(270,Math.round(svg.clientHeight||300));svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    if(!result){svg.innerHTML=`<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="13">기록한 실험과 실측 CSV를 대조하세요.</text>`;return;}
    svg.innerHTML=linePlot([{key:'simulated',color:'#79baff',points:result.residuals.map(row=>[row.time,row.simulated])},{key:'measured',color:'#f3b277',points:result.residuals.map(row=>[row.time,row.measured])}],{W,H,title:'계산(파랑) / 입력 데이터(주황)',unit:result.unit});
  }
  function update(config=getConfig(),metrics=getMetrics()){
    if(lastConfig!==config){lastConfig=config;properties=linearQuarterCarProperties(config);
      const element=$('#model-benchmark-summary');if(element)element.innerHTML=`<div class="benchmark-properties"><strong>모델 ${escape(properties.modelVersion)}</strong><p>유효 모션 비율 ${fmt(properties.effectiveMotionRatio)} · 휠 접선 강성 ${fmt(properties.wheelRate/1000,2)} kN/m</p><p>${config.holderMode==='fixed'?`고정 홀더의 무감쇠 휠 모드 ${fmt(properties.fixedHolderFrequencyHz)} Hz`:`무감쇠 저주파 모드 ${fmt(properties.naturalFrequenciesHz[0])} Hz · 고주파 모드 ${fmt(properties.naturalFrequenciesHz[1])} Hz`}</p><p>${escape(properties.limitations[0])}</p></div><table><thead><tr><th>계산 기준 검증</th><th>결과</th><th>최대 오차</th></tr></thead><tbody>${benchmark.checks.map(check=>`<tr><td>${escape(check.name)}</td><td>${check.passed?'통과':'실패'}</td><td>${check.error.toExponential(3)} ${escape(check.unit)}</td></tr>`).join('')}</tbody></table><p>${escape(benchmark.method)}</p>`;
      renderProfile();
    }
    const status=$('#component-profile-status'),profile=config.componentProfile;if(status)status.textContent=profile?`${profile.name} · ${profile.source} · ${profile.spring?'스프링 특성표 적용':''}${profile.spring&&profile.damper?' / ':''}${profile.damper?'댐퍼 특성표 적용':''} · 측정 범위 외삽 ${fmt(metrics.curveExtrapolationPct||0,2)}% (전체 계산 시간)`: '입력된 부품 특성표가 없습니다. 설정한 강성과 감쇠 계수로 계산합니다.';
  }
  async function importMeasurement(file){
    try{if(file.size>16*1024*1024)throw new Error('실측 CSV는 16MB 이하여야 합니다.');const text=await file.text(),parsed=parseMeasurementCSV(text,{channel:$('#measurement-channel').value,sourceName:file.name});sourceText=text;measurement=parsed;result=null;$('#measurement-status').textContent=`${parsed.sourceName} · ${parsed.sampleCount}개 샘플 · ${fmt(parsed.duration)} s · 입력 ${parsed.sourceUnits.value} → 계산 ${parsed.unit}`;$('#measurement-summary').textContent='비교할 실험 기록을 선택한 뒤 대조 버튼을 누르세요.';$('#measurement-report-btn').disabled=true;$('#measurement-compare-btn').disabled=false;renderMeasurement();notify('데이터의 시간 순서와 명시된 단위를 확인했습니다.');return parsed;}
    catch(error){notify(`CSV 입력 실패: ${error.message}`,true);throw error;}
  }
  function compare(){
    try{if(!measurement)throw new Error('실측 CSV를 먼저 가져오세요.');const run=getRun();if(!run)throw new Error('표준 실험을 기록하고 비교할 기록을 선택하세요.');const offset=Number($('#measurement-time-offset').value);if(!Number.isFinite(offset)||Math.abs(offset)>10)throw new Error('시간 오프셋은 -10~10초 범위여야 합니다.');result=compareMeasurement(run,measurement,{channel:$('#measurement-channel').value,timeOffset:offset});result.experimentName=run.name;result.vehicleName=vehicle?.value||'';
      const card=(label,value,unit='')=>`<div class="selected-stat"><span>${label}</span><strong>${value}<small>${unit}</small></strong></div>`;
      $('#measurement-summary').innerHTML=card('RMSE',fmt(result.rmse),escape(result.unit))+card('MAE',fmt(result.mae),escape(result.unit))+card('최대 |잔차|',fmt(result.peakError),escape(result.unit))+card('R²',result.r2===null?'정의 안 됨':fmt(result.r2))+`<p>${escape(run.name)} · ${result.sampleCount}개 중첩 샘플 · ${fmt(result.window.start)}–${fmt(result.window.end)} s · 시간 오프셋 ${fmt(result.timeOffset)} s. 잔차 = 계산−입력 데이터. 입력 조건과 센서 교정은 별도로 확인해야 합니다.</p>`;
      $('#measurement-report-btn').disabled=false;renderMeasurement();notify('선택 기록과 입력 데이터의 겹치는 구간을 대조했습니다.');return result;
    }catch(error){notify(`대조 실패: ${error.message}`,true);throw error;}
  }
  async function importProfile(file){
    try{if(file.size>2*1024*1024)throw new Error('부품 곡선 JSON은 2MB 이하여야 합니다.');const profile=validateComponentProfile(JSON.parse(await file.text())),candidate={...getConfig(),componentProfile:profile};new SuspensionSimulation(candidate);setConfig(candidate);update();notify('부품 특성표를 해석에 적용하고 정적 평형을 다시 맞췄습니다.');return profile;}catch(error){notify(`부품 특성표 입력 실패: ${error.message}`,true);throw error;}
  }
  $('#measurement-import-btn')?.addEventListener('click',()=>$('#measurement-file').click());
  $('#measurement-file')?.addEventListener('change',e=>{const file=e.target.files?.[0];if(file)void importMeasurement(file).catch(()=>{});e.target.value='';});
  $('#measurement-channel')?.addEventListener('change',()=>{if(!sourceText)return;try{const parsed=parseMeasurementCSV(sourceText,{channel:$('#measurement-channel').value,sourceName:measurement.sourceName});measurement=parsed;result=null;$('#measurement-report-btn').disabled=true;$('#measurement-compare-btn').disabled=false;renderMeasurement();$('#measurement-status').textContent=`${parsed.sourceName} · ${parsed.channel} · ${parsed.sampleCount} samples · ${parsed.unit}`;}catch{$('#measurement-compare-btn').disabled=true;$('#measurement-status').textContent=`기존 파일의 채널은 ${measurement.channel}입니다. 선택한 ${$('#measurement-channel').value} 채널의 CSV를 새로 가져오세요. 이전 비교 결과는 유지됩니다.`;}});
  $('#measurement-compare-btn')?.addEventListener('click',()=>{try{compare();}catch{}});
  $('#measurement-report-btn')?.addEventListener('click',()=>{if(result)download(JSON.stringify({format:'suspension-lab-validation/v1',...result,measurementSource:measurement.sourceName,method:result.method,limitations:result.limitations,benchmark,linearProperties:properties}), 'suspension-validation.json','application/json');});
  $('#component-profile-template-btn')?.addEventListener('click',()=>download(JSON.stringify(COMPONENT_PROFILE_TEMPLATE,null,2),'component-profile-example.json','application/json'));
  $('#component-profile-import-btn')?.addEventListener('click',()=>$('#component-profile-file').click());
  $('#component-profile-file')?.addEventListener('change',e=>{const file=e.target.files?.[0];if(file)void importProfile(file).catch(()=>{});e.target.value='';});
  $('#component-profile-clear-btn')?.addEventListener('click',()=>{setConfig({componentProfile:null});update();notify('부품 특성표를 해제하고 설정 계수로 복귀했습니다.');});
  for(const selector of ['#component-profile-chart','#measurement-chart']){const svg=$(selector);if(svg)new ResizeObserver(()=>{if(selector.includes('component'))renderProfile();else renderMeasurement();}).observe(svg);}
  update();renderMeasurement();
  return {update,importMeasurement,compare,importProfile,getState:()=>({hasMeasurement:!!measurement,sourceName:measurement?.sourceName||null,channel:measurement?.channel||null,hasResult:!!result,vehicleName:vehicle?.value||'',benchmarkPassed:benchmark.passed}),getResult:()=>result,getProperties:()=>properties,getBenchmark:()=>benchmark};
}
