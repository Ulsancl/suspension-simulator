import './style.css';
import { SuspensionSimulation, DEFAULT_CONFIG, normalizeConfig } from './physics.js';
import { SuspensionScene } from './scene.js';
import { AnalysisCharts } from './charts.js';
import { initProduct } from './product.js';
import { initEngineering } from './engineering-ui.js';
import { initWorkspace } from './workspace.js';
import { initOffline } from './offline.js';
import { initDashboard } from './dashboard.js';
import { initDesktop } from './desktop.js';
import { advancePlayback } from './playback-clock.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const names = { wishbone: '더블 위시본', multilink: '멀티링크', macpherson: '맥퍼슨', bump: '범프', step: '턱', pothole: '홀', washboard: '요철', flat: '평탄', mixed: '혼합' };
const number = (v, digits = 1) => Number.isFinite(v) ? (Math.abs(v) < .5 * 10 ** -digits ? 0 : v).toFixed(digits) : '—';
let config = { ...DEFAULT_CONFIG };
try { const saved = JSON.parse(localStorage.getItem('suspension-lab-config')); if (saved && typeof saved === 'object') { const candidate = normalizeConfig(saved); new SuspensionSimulation(candidate); config = candidate; } } catch { /* Use the reproducible default if storage is unavailable. */ }
const sim = new SuspensionSimulation(config);
const workspace = initWorkspace();
const charts = new AnalysisCharts();
const dashboard = initDashboard({getView:workspace.getView,getChartState:()=>charts.getState(),repaint:()=>charts.paint()});
let running = false, singleRun = false, scene, last = performance.now(), uiElapsed = 0;
let comparisons = { A: null, B: null };
let appliedSceneOptions = '';
let product, engineering;

function message(text, error = false) {
  let toast = $('#toast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; toast.setAttribute('role', 'status'); toast.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:100;max-width:90vw;padding:13px 20px;border:1px solid #42575b;border-radius:10px;background:#18232a;color:#e7efed;font-size:13px;box-shadow:0 8px 30px #0006'; document.body.appendChild(toast); }
  toast.textContent = text; toast.style.borderColor = error ? '#e67958' : '#42575b'; toast.hidden = false;
  clearTimeout(message.timer); message.timer = setTimeout(() => { toast.hidden = true; }, 4500);
}
function setRunning(value) {
  running = !!value; last = performance.now();
  $('#run-btn').innerHTML = running ? '<span aria-hidden="true">Ⅱ</span> 일시정지' : '<span aria-hidden="true">▶</span> 시뮬레이션 시작';
  $('#run-btn').setAttribute('aria-pressed', String(running));
  $('#run-status').textContent = running ? 'RUNNING · 시험 중' : 'READY · 일시정지';
  $('#run-status').dataset.running = String(running);
}
function outputValue(key, value) {
  if (['springRate', 'tireRate'].includes(key)) return `${number(value / 1000, 0)} kN/m`;
  if (['compressionDamping', 'reboundDamping'].includes(key)) return `${number(value, 0)} N·s/m`;
  if (['roadHeight', 'travelBump', 'travelRebound'].includes(key)) return `${number(value * 1000, 0)} mm`;
  if (key === 'tireRadius') return `${number(value * 1000, 0)} mm`;
  if (['sprungMass', 'unsprungMass'].includes(key)) return `${number(value, 0)} kg`;
  if (key === 'speed') return `${number(value, 0)} km/h`;
  if (key === 'airPressure') return `${number(value, 1)} bar`;
  if (key === 'airVolume') return `${number(value, 1)} L`;
  if (key === 'motionRatio') return number(value, 2);
  return `${number(value, 1)} m`;
}
function syncControls() {
  const c = sim.config;
  for (const input of $$('[data-config]')) input.value = c[input.dataset.config];
  for (const output of $$('[data-output]')) output.textContent = outputValue(output.dataset.output, c[output.dataset.output]);
  const autoRatio = $('#auto-motion-ratio');
  if (autoRatio) autoRatio.checked = c.autoMotionRatio !== false;
  const manualRatio = $('[data-config="motionRatio"]');
  if (manualRatio) manualRatio.disabled = c.autoMotionRatio !== false;
  const ratioOutput = $('[data-output="motionRatio"]');
  if (ratioOutput) ratioOutput.textContent = `${number(sim.state.effectiveMotionRatio ?? c.motionRatio, 2)}${c.autoMotionRatio !== false ? ' · 자동' : ''}`;
  if ($('#motion-ratio-note')) $('#motion-ratio-note').textContent = `휠 강성 ${number((sim.state.effectiveWheelRate || 0) / 1000, 2)} kN/m · 정적 자세 기준. 직접 입력하려면 자동 계산을 끄세요.`;
  $('[data-config="springRate"]').disabled = c.springType === 'air' || !!c.componentProfile?.spring;
  for (const key of ['compressionDamping','reboundDamping']) { const input = $(`[data-config="${key}"]`); input.disabled = !!c.componentProfile?.damper; input.title = c.componentProfile?.damper ? '입력한 댐퍼 특성표를 사용합니다. 계수 조절은 특성표 해제 후 적용됩니다.' : ''; }
  for (const key of ['airPressure','airVolume']) $('[data-config="'+key+'"]').disabled = !!c.componentProfile?.spring;
  $('[data-config="springRate"]').title = c.springType === 'air' ? '에어 스프링의 강성은 압력과 챔버 용적에서 계산합니다.' : '';
  $('#structure').value = c.structure; $('#spring-type').value = c.springType; $('#holder-mode').value = c.holderMode;
  $('#time-scale').value = String(c.timeScale);
  $('#air-controls').hidden = c.springType !== 'air';
  for (const card of $$('[data-road]')) { const active = card.dataset.road === c.road; card.classList.toggle('active', active); card.setAttribute('aria-pressed', String(active)); }
  $('#structure-label').textContent = names[c.structure];
  const descriptions = {
    wishbone: '상·하 삼각형 암 · 이중 피벗 · 볼 조인트',
    multilink: '독립 링크 로드 · 조절 슬리브 · 로드 엔드',
    macpherson: '일체형 스트럿 · 상부 마운트 · 하부 컨트롤 암',
  };
  if ($('#structure-description')) $('#structure-description').textContent = descriptions[c.structure];
  $('#speed-label').textContent = `${number(c.speed, 0)} km/h · ${names[c.road]}`;
  const fixed = c.holderMode === 'fixed';
  if ($('#acceleration-label')) $('#acceleration-label').textContent = fixed ? '휠 수직 가속도' : '차체 수직 가속도';
  const accelerationHint = $('#acceleration-value')?.closest('.metric-card')?.querySelector('small');
  if (accelerationHint) accelerationHint.textContent = fixed ? '고정 시험대 · 휠 응답' : '승차감 · 차체 응답';
  if ($('#rms-label')) $('#rms-label').textContent = fixed ? '휠 가속도 RMS' : '차체 가속도 RMS';
  if ($('#peak-label')) $('#peak-label').textContent = fixed ? '휠 최대 가속도' : '차체 최대 가속도';
}
function setConfig(patch) {
  try { const candidate = normalizeConfig({ ...sim.config, ...patch }); new SuspensionSimulation(candidate); config = candidate; }
  catch (error) { message(`설정 적용 실패: ${error.message}`, true); syncControls(); return { ...sim.config }; }
  sim.reset(config); singleRun = false;
  scene?.buildRig(sim.config); syncControls();
  try { localStorage.setItem('suspension-lab-config', JSON.stringify(sim.config)); } catch { /* Local saving is optional. */ }
  update(); product?.configurationChanged(); return { ...sim.config };
}
function reset() { sim.reset(sim.config); singleRun = false; setRunning(false); update(); }
function options() {
  const next = { links: $('#show-links').checked, forces: $('#show-forces').checked, labels: $('#show-labels').checked };
  const signature = JSON.stringify(next);
  if (scene && signature !== appliedSceneOptions) { scene.setOptions(next); appliedSceneOptions = signature; }
}

function update(forceCharts = false) {
  const s = sim.snapshot(), c = sim.config, m = sim.metrics();
  const geometry = scene?.update(s, c);
  $('#travel-value').textContent = number(s.travel * 1000, 1);
  $('#acceleration-value').textContent = number(c.holderMode === 'fixed' ? s.wheelAcceleration : s.bodyAcceleration, 1);
  $('#contact-value').textContent = number(s.contactForce / 1000, 2);
  $('#camber-value').textContent = number(geometry?.camber || 0, 2);
  $('#contact-status').textContent = s.bottomed ? '스트로크 한계' : s.contact ? '접지 중' : '접지 이탈';
  $('#contact-status').dataset.contact = String(s.contact && !s.bottomed);
  $('#contact-status').classList.toggle('lost', !s.contact || s.bottomed || s.toppedOut);
  if (s.toppedOut) $('#contact-status').textContent = '신장 스트로크 한계';
  $('#rms-value').textContent = `${number(c.holderMode === 'fixed' ? m.rmsWheelAcceleration : m.rmsBodyAcceleration, 2)} m/s²`;
  $('#peak-value').textContent = `${number(c.holderMode === 'fixed' ? m.peakWheelAcceleration : m.peakBodyAcceleration, 2)} m/s²`;
  $('#contact-loss-value').textContent = `${number(m.contactLossPct, 1)} %`;
  $('#duration-value').textContent = `${number(s.time, 1)} s`;
  charts.update(sim.history, s, c);
  if (forceCharts) charts.paint();
  engineering?.update(c, m);
  dashboard.update(s,c,m);
  if ($('#render-detail-summary')) $('#render-detail-summary').textContent = ({standard:'BALANCED · 실시간 렌더링',high:'HIGH DETAIL · 스튜디오 렌더링',ultra:'ULTRA DETAIL · 정밀 렌더링'}[$('#render-quality')?.value] || 'HIGH DETAIL · 스튜디오 렌더링');
  options();
}
function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function capture(name) {
  const c = { ...sim.config, singleEvent: false }, trial = new SuspensionSimulation(c);
  // Each capture repeats the same six simulation seconds, from static equilibrium.
  trial.advance(6);
  comparisons[name] = { config: c, metrics: trial.metrics() };
  $(`#save-${name.toLowerCase()}-btn`).classList.add('saved');
  $(`#save-${name.toLowerCase()}-btn`).textContent = `${name} 저장됨 ✓`;
  const { A, B } = comparisons;
  const describe = (entry) => `${names[entry.config.structure]} · ${entry.config.springType} · ${number(entry.metrics.peakTravel * 1000, 1)} mm · 접지 이탈 ${number(entry.metrics.contactLossPct, 1)}%`;
  if (!A || !B) $('#compare-summary').textContent = `${name}: ${describe(comparisons[name])} / 설정을 바꾼 뒤 다른 슬롯에 저장하세요. (동일한 6초 시험)`;
  else {
    const sameRoad = ['road', 'roadHeight', 'roadWidth', 'roadSpacing', 'speed', 'holderMode'].every(key => A.config[key] === B.config[key]);
    const fixed = A.config.holderMode === 'fixed', k = fixed ? 'rmsWheelAcceleration' : 'rmsBodyAcceleration';
    const a = A.metrics[k], b = B.metrics[k], delta = a > .001 ? ` (${number((b / a - 1) * 100, 1)}%)` : '';
    $('#compare-summary').textContent = `6초 시험 · A ${number(a, 2)} → B ${number(b, 2)} m/s²${delta} · 최대 스트로크 ${number(A.metrics.peakTravel * 1000, 1)} → ${number(B.metrics.peakTravel * 1000, 1)} mm · 접지 이탈 ${number(A.metrics.contactLossPct, 1)} → ${number(B.metrics.contactLossPct, 1)}%${sameRoad ? '' : ' · 노면/속도/홀더 조건이 달라 직접 비교에 주의하세요.'}`;
  }
  message(`${name} 설정으로 6초 시험을 실행해 비교 결과를 저장했습니다.`);
}

for (const input of $$('[data-config]')) input.addEventListener('input', () => setConfig({ [input.dataset.config]: Number(input.value) }));
$('#auto-motion-ratio')?.addEventListener('change', event => setConfig({ autoMotionRatio: event.target.checked }));
for (const [id, key] of [['structure', 'structure'], ['spring-type', 'springType'], ['holder-mode', 'holderMode']]) $(`#${id}`).addEventListener('change', event => setConfig({ [key]: event.target.value }));
$('#time-scale').addEventListener('change', event => { sim.config.timeScale = Number(event.target.value); config.timeScale = sim.config.timeScale; });
for (const card of $$('[data-road]')) card.addEventListener('click', () => setConfig({ road: card.dataset.road, singleEvent: false }));
$('#tab-setup').addEventListener('click', () => tabs(false));
$('#tab-road').addEventListener('click', () => tabs(true));
function tabs(road) {
  $('#setup-panel').hidden = road; $('#road-panel').hidden = !road;
  $('#tab-setup').classList.toggle('active', !road); $('#tab-road').classList.toggle('active', road);
  $('#tab-setup').setAttribute('aria-selected', String(!road)); $('#tab-road').setAttribute('aria-selected', String(road));
}
$('#run-btn').addEventListener('click', () => { if (sim.config.singleEvent && !singleRun) setConfig({ singleEvent: false }); setRunning(!running); });
$('#reset-btn').addEventListener('click', reset);
$('#single-event-btn').addEventListener('click', () => {
  if (sim.config.road === 'flat') { message('노면을 범프·턱·홀 등으로 선택해 주세요.'); return; }
  if (sim.config.speed === 0) { message('단일 통과 시험을 위해 벨트 속도를 0보다 크게 설정해 주세요.'); return; }
  setConfig({ singleEvent: true }); singleRun = true; setRunning(true); message('장애물 1회 통과 후 자동으로 정지합니다.');
});
for (const button of $$('[data-camera]')) button.addEventListener('click', () => { scene?.setCamera(button.dataset.camera); $$('[data-camera]').forEach(b => { const active = b === button; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); });
$('#fit-btn').addEventListener('click', () => { scene?.setCamera('iso'); $$('[data-camera]').forEach(b => { const active = b.dataset.camera === 'iso'; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); }); });
for (const input of [$('#show-links'), $('#show-forces'), $('#show-labels')]) input.addEventListener('change', () => { options(); scene?.render(); });
$('#render-quality')?.addEventListener('change', event => { scene?.setQuality?.(event.target.value); update(true); });
$('#save-a-btn').addEventListener('click', () => capture('A')); $('#save-b-btn').addEventListener('click', () => capture('B'));
$('#export-csv-btn').addEventListener('click', () => { if (sim.history.length < 2) { message('시험을 실행한 후 CSV를 저장해 주세요.'); return; } download('\uFEFF' + sim.exportCSV(), 'suspension-results.csv', 'text/csv;charset=utf-8'); });
$('#export-config-btn').addEventListener('click', () => download(JSON.stringify({ format: 'suspension-lab/v1', savedAt: new Date().toISOString(), config: sim.config, comparisons }, null, 2), 'suspension-config.json', 'application/json'));
$('#import-config-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 1000000) throw new Error('설정 파일은 1MB 이하여야 합니다.');
    const data = JSON.parse(await file.text());
    if (data?.format && data.format !== 'suspension-lab/v1') throw new Error('지원되지 않는 설정 형식입니다.');
    const candidate = data.config || data;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !Object.keys(DEFAULT_CONFIG).some(key => Object.hasOwn(candidate, key))) throw new Error('유효한 서스펜션 설정이 없습니다.');
    for (const [key, value] of Object.entries(candidate)) if (typeof DEFAULT_CONFIG[key] === 'number' && (!Number.isFinite(value) || typeof value !== 'number')) throw new Error(`${key} 값은 유한한 숫자여야 합니다.`);
    setRunning(false); setConfig({ ...DEFAULT_CONFIG, ...candidate }); message('설정을 불러왔습니다. 정적 평형에서 시험을 시작하세요.');
  } catch (error) { message(`불러오기 실패: ${error.message}`, true); }
  event.target.value = '';
});
$('#help-btn').addEventListener('click', () => $('#help-dialog').showModal());
$('#close-help-btn').addEventListener('click', () => $('#help-dialog').close());
$('#help-dialog').addEventListener('click', event => { if (event.target === $('#help-dialog')) $('#help-dialog').close(); });
document.addEventListener('keydown', event => {
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName) || $('#help-dialog').open) return;
  if (event.code === 'Space') { event.preventDefault(); setRunning(!running); }
  if (event.code === 'KeyR') reset();
  if (event.code === 'KeyF') { const promise = document.fullscreenElement ? document.exitFullscreen() : $('#viewport').requestFullscreen(); promise?.catch(() => message('이 환경에서는 전체 화면을 사용할 수 없습니다.')); }
});
document.addEventListener('visibilitychange', () => { last = performance.now(); });
$('#viewport').addEventListener('scene-error', event => { setRunning(false); message(event.detail, true); });
try {
  scene = new SuspensionScene($('#viewport'), sim.config); scene.setQuality?.($('#render-quality')?.value || 'high'); $('#viewport-loading').hidden = true;
} catch (error) {
  $('#viewport-loading').textContent = `3D 그래픽을 시작하지 못했습니다. 브라우저의 하드웨어 가속을 확인해 주세요. (${error.message})`;
  console.error(error);
}
syncControls(); setRunning(false); update();
product = initProduct({ getConfig: () => ({ ...sim.config }), setConfig, setRunning, getScene: () => scene, notify: message });
initDesktop({ notify: message });
engineering = initEngineering({ getConfig: () => sim.config, setConfig, getMetrics: () => sim.metrics(), getRun: () => product.library.get(product.getState().selected[0]) || product.library.list()[0], notify: message });
const offlineReady = initOffline(message);

function tick(now) {
  const dt = Math.max(0, (now - last) / 1000); last = now;
  if (running && !document.hidden) {
    const clock=advancePlayback(sim,dt,()=>{
      if(singleRun&&sim.state.distance>=sim.config.roadSpacing+sim.config.roadWidth){singleRun=false;setRunning(false);message('장애물 1회 통과 시험을 완료했습니다.');return false;}
      return true;
    });
    if(clock.stalled){setRunning(false);message('화면이 오래 지연되어 시험을 일시정지했습니다. 시작 버튼을 눌러 이어가세요.');}
  }
  uiElapsed += Math.min(dt,.1);
  if (uiElapsed >= 1 / 30) { update(); uiElapsed = 0; } else { scene?.controls.update(); if (scene?.dirty) scene.render(); }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
document.addEventListener('visibilitychange',()=>{last=performance.now();});
window.suspensionLab = {
  sim, getConfig: () => ({ ...sim.config }), setConfig, reset,
  advance: (seconds) => { sim.advance(seconds); update(true); return sim.snapshot(); },
  snapshot: () => sim.snapshot(), history: () => sim.history.map(r => ({ ...r })), setRunning,
  getComparisons: () => structuredClone(comparisons),
  getChartState: () => charts.getState(),
  getSceneDiagnostics: () => scene?.getDiagnostics?.() || {},
  productReady: product.ready,
  getProductState: product.getState, getExperiments: product.getRecords, getSweep: product.getSweep,
  getMeasurementState: engineering.getState, getMeasurementResult: engineering.getResult,
  getLinearProperties: engineering.getProperties, getBenchmarks: engineering.getBenchmark,
  getWorkspaceView: workspace.getView, setWorkspaceView: workspace.show,
  getDashboardState: dashboard.getState,
  offlineReady,
};
window.advanceTime = (ms) => { if (running) sim.advance(ms / 1000 * sim.config.timeScale); update(true); };
window.render_game_to_text = () => JSON.stringify({ mode: running ? 'running' : 'paused', coordinateSystem: 'SI; X=road direction, Y=up, Z=wheel axle; wheelY/bodyY relative to loaded static equilibrium; travel=wheelY-bodyY', config: sim.config, state: sim.snapshot(), metrics: sim.metrics(), dashboard: dashboard.getState(), chartView: charts.getState() });
