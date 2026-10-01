const STORAGE_KEY = 'suspension-lab-dashboard-v1';
const VIEWS = ['bench', 'analysis', 'experiments', 'validation'];
const CHARTS = ['motion', 'force', 'acceleration'];
const LABELS = {
  wishbone:'더블 위시본', multilink:'멀티링크', macpherson:'맥퍼슨',
  coil:'코일', progressive:'점진형 코일', air:'에어',
  bump:'범프', step:'턱', pothole:'홀', washboard:'연속 요철', flat:'평탄', mixed:'혼합',
};
const element = id => document.getElementById(id);
function setText(id, value) { const node=element(id);if(node&&node.textContent!==value)node.textContent=value; }

export function initDashboard({ getView, getChartState, repaint }) {
  let preferences = { settingsExpanded:{}, chartLayout:'overview' };
  let focusedChart = 'none';
  let scrollBeforeFocus = 0;
  let snapshot = null, config = null, metrics = null;
  try {
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY));
    if(saved&&typeof saved==='object') {
      if(['overview','stacked'].includes(saved.chartLayout))preferences.chartLayout=saved.chartLayout;
      for(const view of VIEWS)if(typeof saved.settingsExpanded?.[view]==='boolean')preferences.settingsExpanded[view]=saved.settingsExpanded[view];
    }
  } catch { /* Layout remains usable when browser storage is unavailable. */ }
  const wide = window.matchMedia('(min-width:851px)');
  const expanded = () => preferences.settingsExpanded[getView()] ?? (getView()==='bench'&&wide.matches);
  const persist = () => { try { localStorage.setItem(STORAGE_KEY,JSON.stringify(preferences)); } catch { /* View preferences are optional. */ } };
  const resize = () => { repaint();window.dispatchEvent(new Event('resize')); };

  function apply() {
    const open=expanded(), button=element('dashboard-settings-toggle'), panel=element('dashboard-settings-panel')||document.querySelector('.control-panel');
    document.body.dataset.settingsCollapsed=String(!open);
    document.body.dataset.chartLayout=preferences.chartLayout;
    document.body.dataset.focusedChart=focusedChart;
    if(!open&&panel?.contains(document.activeElement))button?.focus({preventScroll:true});
    if(panel)panel.hidden=!open;
    if(button) {
      button.setAttribute('aria-expanded',String(open));
      button.setAttribute('aria-controls',panel?.id||'dashboard-settings-panel');
      const label=button.querySelector('[data-settings-toggle-label]');
      const text=open?'설정 접기':'설정 열기';
      if(label)label.textContent=text;else button.textContent=text;
      button.setAttribute('aria-label',open?'시험 설정 패널 접기':'시험 설정 패널 열기');
    }
    const selector=element('analysis-layout');if(selector)selector.value=preferences.chartLayout;
    for(const button of document.querySelectorAll('[data-chart-focus]'))button.setAttribute('aria-pressed',String(button.dataset.chartFocus===focusedChart));
    const exit=element('chart-focus-exit');if(exit)exit.hidden=focusedChart==='none';
    updateContext();resize();
  }
  function focusChart(chart, restoreFocus=true) {
    const previous=focusedChart;
    if(previous==='none'&&CHARTS.includes(chart))scrollBeforeFocus=window.scrollY;
    focusedChart=CHARTS.includes(chart)?chart:'none';
    apply();
    if(focusedChart!=='none') {
      element('analysis-section')?.scrollIntoView({block:'start',behavior:'instant'});
      element('chart-focus-exit')?.focus({preventScroll:true});
    } else if(restoreFocus&&CHARTS.includes(previous)){
      window.scrollTo({top:scrollBeforeFocus,behavior:'instant'});
      document.querySelector(`[data-chart-focus="${previous}"]`)?.focus({preventScroll:true});
    }
  }
  function updateContext() {
    if(!config||!snapshot)return;
    setText('context-structure',LABELS[config.structure]||'—');
    setText('context-spring',LABELS[config.springType]||'—');
    setText('context-road',LABELS[config.road]||'—');
    setText('context-speed',`${Number(config.speed).toFixed(0)} km/h`);
    setText('context-holder',config.holderMode==='fixed'?'고정 홀더':'탄성 차체');
    setText('context-time',`${snapshot.time.toFixed(2)} s`);
    const profile=element('context-profile');
    if(profile) {
      const outOfRange=!!config.componentProfile&&(metrics?.curveExtrapolationPct>0);
      const text=config.componentProfile?(outOfRange?'특성표 · 외삽 포함':'특성표 적용'):'계수 모델';
      if(profile.textContent!==text)profile.textContent=text;
      profile.dataset.warning=String(outOfRange);
      profile.title=config.componentProfile?`${config.componentProfile.name}${outOfRange?' · 현재 시험에서 입력 범위 밖 평가 발생':''}`:'기본 스프링·댐퍼 계수 사용';
    }
    const view=getView(), chart=getChartState();
    const scope=view==='bench'?'실시간 샘플':view==='analysis'?`그래프 ${chart.start.toFixed(1)}–${chart.end.toFixed(1)} s`:view==='experiments'?'기록별 전체 시험':'저장 기록 ↔ 입력 CSV';
    setText('context-result-scope',scope);
  }
  element('dashboard-settings-toggle')?.addEventListener('click',()=>{preferences.settingsExpanded[getView()]=!expanded();persist();apply();});
  element('analysis-layout')?.addEventListener('change',event=>{
    if(!['overview','stacked'].includes(event.target.value))return;
    preferences.chartLayout=event.target.value;persist();apply();
  });
  for(const button of document.querySelectorAll('[data-chart-focus]'))button.addEventListener('click',()=>focusChart(button.dataset.chartFocus));
  element('chart-focus-exit')?.addEventListener('click',()=>focusChart(null));
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&focusedChart!=='none'&&!document.querySelector('dialog[open]')&&!document.fullscreenElement){event.preventDefault();focusChart(null);}
  });
  window.addEventListener('workspacechange',()=>{if(getView()!=='analysis')focusedChart='none';apply();});
  wide.addEventListener('change',apply);
  apply();
  return {
    update(state,currentConfig,currentMetrics) { snapshot=state;config=currentConfig;metrics=currentMetrics;updateContext(); },
    getState:()=>({view:getView(),settingsExpanded:expanded(),chartLayout:preferences.chartLayout,focusedChart}),
  };
}
