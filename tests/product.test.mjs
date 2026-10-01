import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = process.env.SUSPENSION_TEST_OUTPUT_SUFFIX || '';
if (suffix && !/^[a-z0-9-]+$/.test(suffix)) throw new Error('Invalid test output suffix');
const outputDir = path.join(root, 'output', 'product' + (suffix ? '-' + suffix : ''));
const baseURL = process.env.SUSPENSION_TEST_URL || 'http://127.0.0.1:5173';
await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const checks = [], errors = [], evidence = {};
let entryScripts = [], referenceRun, referenceConfig, savedProject;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const state = () => page.evaluate(() => window.suspensionLab.getProductState());
const records = () => page.evaluate(() => window.suspensionLab.getExperiments());
const config = () => page.evaluate(() => window.suspensionLab.getConfig());
const snapshot = () => page.evaluate(() => window.suspensionLab.snapshot());
const patch = value => page.evaluate(value => window.suspensionLab.setConfig(value), value);
const advance = value => page.evaluate(value => window.suspensionLab.advance(value), value);
const diagnostics = () => page.evaluate(() => window.suspensionLab.getSceneDiagnostics());
const measurementState = () => page.evaluate(() => window.suspensionLab.getMeasurementState());
const measurementResult = () => page.evaluate(() => window.suspensionLab.getMeasurementResult());
const names = { project: '<img src=x onerror=window.__injected=1> & "시험"', run: '<script>window.__injected=1</script> & "시험"' };
const views = { bench: '#test-bench', analysis: '#analysis-section', experiments: '#experiment-workspace', validation: '#engineering-validation' };

async function view(name) {
  await page.locator(`.workspace-nav a[href="${views[name]}"]`).click();
  await page.waitForFunction(value => window.suspensionLab.getWorkspaceView() === value, name);
}

async function check(name, action) {
  await action(); checks.push(name); console.log(`PASS ${name}`);
}
function near(a, b, epsilon = 1e-8, description = 'values') {
  assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon, `${description}: ${a} ≈ ${b}, tolerance ${epsilon}`);
}
async function ready() {
  await page.waitForFunction(() => window.suspensionLab?.getProductState && window.suspensionLab?.getMeasurementResult);
  await page.evaluate(async () => { await window.suspensionLab.productReady; });
  await page.waitForFunction(() => window.suspensionLab.getProductState().ready);
  await page.evaluate(() => window.suspensionLab.setRunning(false));
}
async function idle(timeout = 45000) {
  await page.waitForFunction(() => !window.suspensionLab.getProductState().busy, {}, { timeout });
}
async function record(name, duration = 2) {
  await view('experiments');
  const before = (await records()).map(run => run.id);
  await page.locator('#experiment-name').fill(name);
  await page.locator('#experiment-duration').fill(String(duration));
  await page.locator('#record-experiment-btn').click();
  await idle();
  const added = (await records()).filter(run => !before.includes(run.id));
  assert.equal(added.length, 1, 'a completed standard test saves one record');
  return added[0];
}
async function selectRecords(ids) {
  await view('experiments');
  const selected = (await state()).selected;
  for (const id of selected) if (!ids.includes(id)) await page.locator(`[data-compare-id="${id}"]`).uncheck();
  for (const id of ids) await page.locator(`[data-compare-id="${id}"]`).check();
  assert.deepEqual([...((await state()).selected)].sort(), [...ids].sort());
}
async function download(selector, filename) {
  if (/record-action|experiment-report|experiment-export/.test(selector)) await view('experiments');
  if (/measurement-report/.test(selector)) await view('validation');
  if (/capture-view|export-model/.test(selector)) await view('bench');
  const waiting = page.waitForEvent('download', { timeout: 45000 });
  await page.locator(selector).click();
  const result = await waiting;
  assert.equal(await result.failure(), null);
  const target = path.join(outputDir, filename);
  await result.saveAs(target);
  return fs.readFile(target);
}
async function upload(selector, contents, filename, mimeType) {
  await page.locator(selector).setInputFiles({ name: filename, mimeType, buffer: Buffer.from(contents) });
}
async function toastContains(pattern) {
  await page.waitForFunction(source => new RegExp(source).test(document.querySelector('#toast')?.textContent || ''), pattern.source);
}
async function cleanCapture() {
  await page.evaluate(() => window.suspensionLab.setRunning(false));
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 7000 }).catch(() => {});
  await page.evaluate(() => {
    for (const detail of document.querySelectorAll('details')) detail.open = false;
    const sidebar = document.querySelector('.control-scroll'); if (sidebar) sidebar.scrollTop = 0;
    scrollTo(0, 0);
  });
  await page.waitForTimeout(150);
}
function parseCSV(buffer) {
  const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  return { headers, rows: lines.map(line => line.split(',')) };
}
function parseGLB(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x46546c67, 'glTF binary magic');
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.length);
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.readUInt32LE(16), 0x4e4f534a, 'first chunk is JSON');
  assert.equal(jsonLength % 4, 0);
  const doc = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trim());
  const binaryOffset = 20 + jsonLength;
  assert.equal(buffer.readUInt32LE(binaryOffset + 4), 0x004e4942);
  assert.ok(buffer.readUInt32LE(binaryOffset) > 10000, 'binary contains actual geometry');
  return doc;
}
function primaryRMS(run) { return run.config.holderMode === 'fixed' ? run.metrics.rmsWheelAcceleration : run.metrics.rmsBodyAcceleration; }

try {
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await ready();
  entryScripts = await page.locator('script[src]').evaluateAll(items => items.map(item => item.getAttribute('src')));
  await check('product workspace starts with available persistent storage and model benchmark', async () => {
    assert.equal((await state()).recordCount, 0, 'fresh isolated browser context');
    assert.equal((await measurementState()).benchmarkPassed, true);
    const storage = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name));
    assert.ok(storage.includes('suspension-lab-experiments'));
    evidence.storage = { database: 'suspension-lab-experiments', initialRecordCount: 0 };
    for (const name of Object.keys(views)) {
      await view(name);
      assert.equal(await page.locator(views[name]).isVisible(), true);
      assert.equal(await page.locator('.workspace-nav [aria-selected="true"]').count(), 1);
      for (const [other, selector] of Object.entries(views)) if (other !== name) assert.equal(await page.locator(selector).isVisible(), false);
    }
  });

  await check('four presets change actual physics and keep the loaded static equilibrium', async () => {
    await view('experiments');
    const expected = {
      comfort: { springRate: 22000, compressionDamping: 1100, reboundDamping: 2000 },
      sport: { springType: 'progressive', springRate: 42000, speed: 50 },
      offroad: { structure: 'multilink', springType: 'air', tireRadius: .41, road: 'mixed', airPressure: 6 },
      reference: { structure: 'wishbone', springType: 'coil' },
    };
    const presetEvidence = {};
    for (const [name, values] of Object.entries(expected)) {
      await page.locator(`[data-preset="${name}"]`).click();
      const current = await config(), initial = await snapshot();
      for (const [key, value] of Object.entries(values)) assert.equal(current[key], value);
      near(initial.bodyAcceleration, 0, 1e-8, `${name} body equilibrium`);
      near(initial.wheelAcceleration, 0, 1e-8, `${name} wheel equilibrium`);
      await advance(2);
      const currentHistory = await page.evaluate(() => window.suspensionLab.history());
      presetEvidence[name] = { config: current, peakTravel: Math.max(...currentHistory.map(row => Math.abs(row.travel))) };
    }
    assert.ok(new Set(Object.values(presetEvidence).map(value => value.peakTravel.toFixed(5))).size >= 3);
    evidence.presets = presetEvidence;
    await patch({ holderMode: 'sprung', road: 'bump', speed: 35, roadHeight: .05, roadSpacing: 3, roadWidth: .6, singleEvent: false, componentProfile: null });
    referenceConfig = await config();
  });

  await check('standard records have exact duration and deterministic histories independent of live playback', async () => {
    await advance(3.4);
    const liveBefore = await snapshot();
    referenceRun = await record(names.run, 2);
    near(referenceRun.duration, 2); near(referenceRun.history.at(-1).time, 2, 1e-7);
    assert.ok(referenceRun.history.length >= 240);
    assert.ok(referenceRun.metrics.peakTravel > .001);
    near((await snapshot()).time, liveBefore.time, 1e-9, 'recording does not rewrite live simulation time');
    await advance(1.1);
    const repeated = await record('반복 시험', 2);
    assert.deepEqual(repeated.config, referenceRun.config);
    assert.deepEqual(repeated.history, referenceRun.history);
    assert.deepEqual(repeated.metrics, referenceRun.metrics);
    assert.notEqual(repeated.id, referenceRun.id);
    assert.equal(await page.locator('#experiment-list script, #experiment-list img').count(), 0);
    assert.equal(await page.evaluate(() => window.__injected || 0), 0);
    evidence.determinism = { duration: 2, samples: referenceRun.history.length, bodyRMS: referenceRun.metrics.rmsBodyAcceleration, peakTravel: referenceRun.metrics.peakTravel };
  });

  await check('cancelling a standard test saves no partial history', async () => {
    const before = await records();
    await page.locator('#experiment-duration').fill('30');
    await page.locator('#record-experiment-btn').click();
    await page.waitForFunction(() => window.suspensionLab.getProductState().busy);
    await page.locator('#cancel-sweep-btn').click();
    await idle();
    assert.deepEqual(await records(), before);
    assert.match(await page.locator('#experiment-progress').textContent(), /취소/);
  });

  await check('IndexedDB records survive a complete page reload with unchanged histories', async () => {
    const before = await records();
    await page.reload({ waitUntil: 'networkidle' }); await ready();
    assert.deepEqual(await records(), before);
    assert.equal((await state()).recordCount, 2);
    evidence.storage.reloadRecordCount = 2;
  });

  await check('project download and import validate all records atomically and safely render names', async () => {
    await page.locator('#project-name').fill(names.project);
    savedProject = JSON.parse((await download('#save-project-btn', 'project.suspension.json')).toString('utf8'));
    assert.equal(savedProject.type, 'suspension-lab-project');
    assert.equal(savedProject.schemaVersion, 1); assert.equal(savedProject.modelVersion, 'quarter-car-1.3');
    assert.equal(savedProject.runs.length, 2);
    assert.deepEqual(savedProject.config, await config());
    const before = { config: await config(), records: await records(), state: await state() };
    const invalid = structuredClone(savedProject); invalid.runs.at(-1).history.at(-1).contactForce = -1;
    await upload('#project-import-file', JSON.stringify(invalid), 'malformed.suspension.json', 'application/json');
    await toastContains(/실패/);
    assert.deepEqual(await records(), before.records); assert.deepEqual(await config(), before.config);
    await patch({ speed: 77, springRate: 55000 });
    await upload('#project-import-file', JSON.stringify(savedProject), 'restored.suspension.json', 'application/json');
    await toastContains(/복원/); await idle();
    assert.deepEqual(await config(), savedProject.config);
    assert.deepEqual((await records()).map(run => run.id).sort(), savedProject.runs.map(run => run.id).sort());
    assert.equal(await page.locator('#project-name').inputValue(), (await state()).projectName);
    assert.equal(await page.locator('#experiment-list img, #experiment-list script').count(), 0);
    assert.equal(await page.evaluate(() => window.__injected || 0), 0);
  });

  await check('up to three overlays draw actual history with explicit units and mismatched-condition warning', async () => {
    await patch({ ...referenceConfig, springRate: 22000, compressionDamping: 1100, reboundDamping: 2000 });
    const comfort = await record('같은 노면 컴포트', 2);
    await patch({ ...referenceConfig, speed: 48, road: 'mixed', roadHeight: .07 });
    const differing = await record('다른 노면 조건', 2);
    const all = await records();
    await selectRecords([referenceRun.id, comfort.id, all.find(run => run.name === '반복 시험').id]);
    assert.equal(await page.locator('.comparison-condition.matched').count(), 1);
    await page.locator(`[data-compare-id="${differing.id}"]`).click();
    assert.equal((await state()).selected.length, 3);
    assert.equal(await page.locator(`[data-compare-id="${differing.id}"]`).isChecked(), false);
    await selectRecords([referenceRun.id, comfort.id, differing.id]);
    assert.equal(await page.locator('.comparison-condition.mismatched').count(), 1);
    const pathsByMode = {};
    for (const [mode, unit] of [['travel', 'mm'], ['acceleration', 'm/s²'], ['contactForce', 'kN']]) {
      await page.locator('#experiment-overlay-mode').selectOption(mode);
      const paths = await page.locator('#experiment-overlay-chart path[data-experiment-id]').evaluateAll(items => items.map(item => ({ id: item.dataset.experimentId, d: item.getAttribute('d') })));
      assert.equal(paths.length, 3);
      assert.deepEqual(paths.map(item => item.id).sort(), (await state()).selected.sort());
      assert.ok(paths.every(item => item.d.length > 500 && !/NaN|Infinity/.test(item.d)));
      assert.ok((await page.locator('#experiment-overlay-chart').textContent()).includes(unit));
      await page.locator('#experiment-overlay-chart').scrollIntoViewIfNeeded();
      const box = await page.locator('#experiment-overlay-chart').boundingBox();
      await page.mouse.move(box.x + box.width * .48, box.y + box.height * .4);
      assert.match(await page.locator('#experiment-overlay-readout').textContent(), /t [\d.]+ s/);
      assert.ok((await page.locator('#experiment-overlay-readout').textContent()).includes(unit));
      const cursor = await page.locator('#experiment-overlay-chart [data-experiment-cursor]').getAttribute('x1');
      const svgWidth = await page.locator('#experiment-overlay-chart').evaluate(element => element.viewBox.baseVal.width);
      const left = svgWidth < 500 ? 55 : 70, cursorTime = (Number(cursor) - left) / (svgWidth - left - 20) * 2;
      const nearest = referenceRun.history.reduce((a, b) => Math.abs(a.time - cursorTime) < Math.abs(b.time - cursorTime) ? a : b);
      const key = mode === 'travel' ? 'travel' : mode === 'acceleration' ? 'bodyAcceleration' : 'contactForce';
      const scale = mode === 'travel' ? 1000 : mode === 'contactForce' ? .001 : 1;
      assert.ok((await page.locator('#experiment-overlay-readout').textContent()).includes((nearest[key] * scale).toFixed(2)), 'cursor readout comes from nearest stored sample');
      await page.mouse.move(10, 10);
      assert.match(await page.locator('#experiment-overlay-readout').textContent(), /포인터를/);
      assert.equal(await page.locator('#experiment-overlay-chart [data-experiment-cursor]').count(), 0);
      pathsByMode[mode] = paths;
    }
    await page.locator('#experiment-overlay-chart').scrollIntoViewIfNeeded();
    const box = await page.locator('#experiment-overlay-chart').boundingBox();
    await page.mouse.move(box.x + box.width * .48, box.y + box.height * .4);
    assert.ok((await page.locator('#experiment-overlay-readout').textContent()).includes(referenceRun.name));
    await selectRecords([comfort.id, differing.id]);
    assert.match(await page.locator('#experiment-overlay-readout').textContent(), /포인터를/);
    assert.equal((await page.locator('#experiment-overlay-readout').textContent()).includes(referenceRun.name), false, 'removed record cannot leave a stale cursor value');
    await selectRecords([referenceRun.id, comfort.id, differing.id]);
    assert.notEqual(pathsByMode.travel[0].d, pathsByMode.acceleration[0].d);
    assert.notEqual(pathsByMode.acceleration[0].d, pathsByMode.contactForce[0].d);
    evidence.overlay = { maximumRecords: 3, unitModes: ['mm', 'm/s²', 'kN'], conditionWarning: true };
  });

  await check('damper sweep computes three distinct physical candidates and applies the explicit 1 percent comparison guard', async () => {
    await patch({ ...referenceConfig, road: 'mixed', speed: 45, roadHeight: .07, componentProfile: null });
    await page.locator('.sweep-panel summary').click();
    await page.locator('#experiment-duration').fill('2');
    await page.locator('#sweep-parameter').selectOption('compressionDamping');
    await page.locator('#sweep-min').fill('500'); await page.locator('#sweep-max').fill('4500'); await page.locator('#sweep-count').fill('3');
    const before = (await records()).length;
    await page.locator('#run-sweep-btn').click(); await idle();
    const sweep = await page.evaluate(() => window.suspensionLab.getSweep());
    assert.ok(sweep, 'completed sweep exposes results');
    assert.equal(sweep.trials.length, 3); assert.equal((await records()).length, before + 3);
    assert.deepEqual(sweep.trials.map(run => run.config.compressionDamping), [500, 2500, 4500]);
    assert.equal(new Set(sweep.trials.map(run => primaryRMS(run).toFixed(8))).size, 3);
    assert.ok(sweep.trials.every(run => run.duration === 2 && run.history.at(-1).time > 1.99));
    assert.equal(sweep.method.contactLossGuardPct, 1);
    for (const row of sweep.ranking) {
      const trial = sweep.trials.find(run => run.id === row.trialId);
      near(row.score, primaryRMS(trial)); near(row.contactLossPct, trial.kpis.contactLossPct);
      assert.equal(row.passesGuard, row.contactLossPct <= 1);
    }
    const sorted = [...sweep.ranking].sort((a, b) => Number(b.passesGuard) - Number(a.passesGuard) || (!a.passesGuard ? a.contactLossPct - b.contactLossPct : 0) || a.score - b.score || a.candidate - b.candidate);
    assert.deepEqual(sorted.map(row => row.trialId), sweep.ranking.map(row => row.trialId));
    assert.equal(sweep.recommendation?.trialId || null, sweep.ranking.find(row => row.passesGuard)?.trialId || null);
    assert.equal(await page.locator('#sweep-results tbody tr').count(), 3);
    evidence.sweep = { method: sweep.method, ranking: sweep.ranking, recommendation: sweep.recommendation };
  });

  await check('cancelling a sweep keeps the previous complete batch and recommendation', async () => {
    const before = await records(), previous = await page.evaluate(() => window.suspensionLab.getSweep());
    await page.locator('#experiment-duration').fill('30');
    await page.locator('#run-sweep-btn').click();
    await page.waitForFunction(() => window.suspensionLab.getProductState().busy);
    await page.locator('#cancel-sweep-btn').click(); await idle();
    assert.deepEqual(await records(), before);
    assert.deepEqual(await page.evaluate(() => window.suspensionLab.getSweep()), previous);
    assert.match(await page.locator('#experiment-progress').textContent(), /취소/);
  });

  await check('record CSV matches stored samples and offline HTML report contains the selected statistics with escaped text', async () => {
    await selectRecords([referenceRun.id]);
    const csv = parseCSV(await download(`[data-record-action="export"][data-record-id="${referenceRun.id}"]`, 'record.csv'));
    assert.equal(csv.rows.length, referenceRun.history.length);
    for (const key of ['time', 'travel', 'bodyAcceleration', 'contactForce']) {
      assert.ok(csv.headers.includes(key)); const index = csv.headers.indexOf(key);
      for (const i of [0, 30, csv.rows.length - 1]) near(Number(csv.rows[i][index]), referenceRun.history[i][key], 1e-7, `CSV ${key} sample ${i}`);
    }
    const report = (await download('#experiment-report-btn', 'experiment-report.html')).toString('utf8');
    const inspection = await page.evaluate(html => {
      const document = new DOMParser().parseFromString(html, 'text/html');
      return { text: document.body.textContent, scripts: document.querySelectorAll('script').length, images: document.querySelectorAll('img').length, paths: document.querySelectorAll('path[data-experiment-id]').length, external: [...document.querySelectorAll('[src],[href]')].map(item => item.getAttribute('src') || item.getAttribute('href')).filter(value => /^https?:/i.test(value)) };
    }, report);
    assert.equal(inspection.scripts, 0); assert.equal(inspection.images, 0); assert.equal(inspection.external.length, 0);
    assert.equal(inspection.paths, 1); assert.ok(inspection.text.includes(referenceRun.name));
    assert.ok(inspection.text.includes(primaryRMS(referenceRun).toFixed(2)));
    assert.ok(inspection.text.includes((referenceRun.metrics.peakTravel * 1000).toFixed(1)));
    assert.match(inspection.text, /실차 검증|차량 검증|축약/);
    assert.equal(await page.evaluate(() => window.__injected || 0), 0);
    const selected = JSON.parse((await download('#experiment-export-btn', 'selected-records.json')).toString('utf8'));
    assert.equal(selected.format, 'suspension-lab-records/v1'); assert.equal(selected.runs.length, 1);
    assert.equal(selected.runs[0].id, referenceRun.id); assert.deepEqual(selected.runs[0].history, referenceRun.history);
    evidence.exports = { csvRows: csv.rows.length, reportSelectedRecords: 1, reportScripts: 0 };
  });

  await check('explicit SI measurement CSV and user time offset reproduce a stored record without fitting', async () => {
    await selectRecords([referenceRun.id]);
    await view('validation');
    await page.locator('#measurement-channel').selectOption('bodyAcceleration');
    const samples = referenceRun.history.filter(row => row.time >= .2 && row.time <= 1.8);
    const csv = 'time_s,bodyAcceleration_m_s2,travel_mm\n' + samples.map(row => `${row.time - .15},${row.bodyAcceleration},${row.travel * 1000}`).join('\n');
    await fs.writeFile(path.join(outputDir, 'synthetic-measurement.csv'), csv);
    await upload('#measurement-file', csv, 'synthetic-measurement.csv', 'text/csv');
    await page.waitForFunction(() => window.suspensionLab.getMeasurementState().hasMeasurement);
    await page.locator('#measurement-time-offset').fill('0.05'); await page.locator('#measurement-compare-btn').click();
    const unaligned = await measurementResult(); assert.ok(unaligned.rmse > .01);
    await page.locator('#measurement-time-offset').fill('0.15'); await page.locator('#measurement-compare-btn').click();
    const aligned = await measurementResult();
    assert.equal(aligned.experimentId, referenceRun.id); assert.equal(aligned.channel, 'bodyAcceleration');
    assert.equal(aligned.unit, 'm/s²'); assert.equal(aligned.sourceUnits.value, 'm/s²');
    near(aligned.rmse, 0, 1e-9, 'aligned synthetic acceleration RMSE'); near(aligned.mae, 0, 1e-9);
    assert.ok(aligned.sampleCount >= samples.length - 1); near(aligned.timeOffset, .15);
    assert.match(aligned.method, /자동 피팅하지 않습니다/);
    assert.equal(await page.locator('#measurement-chart path').count() >= 2, true);
    await page.locator('#measurement-channel').selectOption('travel');
    await page.locator('#measurement-compare-btn').click();
    const travel = await measurementResult(); assert.equal(travel.unit, 'm'); assert.equal(travel.sourceUnits.value, 'mm'); near(travel.rmse, 0, 1e-10);
    evidence.measurement = { source: 'synthetic stored-record samples, not vehicle measurements', sampleCount: aligned.sampleCount, offsetSeconds: .15, unalignedRMSE: unaligned.rmse, alignedRMSE: aligned.rmse, travelRMSE: travel.rmse, sourceTravelUnit: 'mm', computedTravelUnit: 'm' };
  });

  await check('invalid measurement CSV preserves the previous valid dataset and result; validation JSON reports method and limitations', async () => {
    const before = await measurementState(), previous = await measurementResult();
    await upload('#measurement-file', 'time_s,travel_mm\n0,1\n0,2\n', 'invalid-measurement.csv', 'text/csv');
    await toastContains(/실패/);
    assert.deepEqual(await measurementState(), before); assert.deepEqual(await measurementResult(), previous);
    await page.locator('#vehicle-name').fill('합성 회귀 시험 · 실차 데이터 아님');
    await page.locator('#measurement-compare-btn').click();
    const report = JSON.parse((await download('#measurement-report-btn', 'measurement-validation.json')).toString('utf8'));
    assert.equal(report.format, 'suspension-lab-validation/v1'); near(report.rmse, 0, 1e-10);
    assert.equal(report.benchmark.passed, true); assert.match(report.limitations, /인증하지 않습니다/);
    assert.equal(report.measurementSource, 'synthetic-measurement.csv');
    // A new single-channel file must be importable even if the previous file lacks that channel.
    const validBeforeChannelChange = await measurementResult();
    await page.locator('#measurement-channel').selectOption('contactForce');
    assert.equal(await page.locator('#measurement-channel').inputValue(), 'contactForce');
    assert.equal(await page.locator('#measurement-compare-btn').isDisabled(), true);
    assert.deepEqual(await measurementResult(), validBeforeChannelChange);
    const source = referenceRun.history.filter(row => row.time >= .2 && row.time <= 1.8);
    const csv = 'time_s,contactForce_N\n' + source.map(row => `${row.time - .15},${row.contactForce}`).join('\n');
    await upload('#measurement-file', csv, 'contact-force-SI.csv', 'text/csv');
    await page.waitForFunction(() => window.suspensionLab.getMeasurementState().sourceName === 'contact-force-SI.csv');
    assert.equal(await page.locator('#measurement-compare-btn').isDisabled(), false);
    await page.locator('#measurement-compare-btn').click();
    const contact = await measurementResult(); assert.equal(contact.unit, 'N'); near(contact.rmse, 0, 1e-7);
  });

  await check('component force tables change real response while preserving static balance and disabling overridden coefficients', async () => {
    await view('validation');
    await patch({ ...referenceConfig, autoMotionRatio: false, motionRatio: 1, springRate: 32000, compressionDamping: 1500, reboundDamping: 2500, componentProfile: null });
    await advance(2); const baseline = await page.evaluate(() => window.suspensionLab.history());
    const profile = { format: 'suspension-components/v1', units: 'SI', name: '합성 부품 곡선 · 실측 아님', source: '회귀시험 생성값', spring: [[0,0],[.1,6000],[.2,12000],[.3,18000]], damper: [[-5,-50000],[-1,-10000],[0,0],[1,7000],[5,35000]] };
    await upload('#component-profile-file', JSON.stringify(profile), 'component-profile.json', 'application/json');
    await page.waitForFunction(() => !!window.suspensionLab.getConfig().componentProfile);
    const equilibrium = await snapshot();
    near(equilibrium.bodyAcceleration, 0, 1e-8); near(equilibrium.wheelAcceleration, 0, 1e-8);
    near(equilibrium.springForce, (await config()).sprungMass * 9.80665, 1e-6);
    for (const key of ['springRate', 'compressionDamping', 'reboundDamping']) assert.equal(await page.locator(`[data-config="${key}"]`).isDisabled(), true);
    await advance(2); const curveHistory = await page.evaluate(() => window.suspensionLab.history());
    assert.ok(Math.max(...curveHistory.map((row, i) => Math.abs(row.bodyAcceleration - baseline[i].bodyAcceleration))) > .1);
    assert.ok(curveHistory.every(row => typeof row.springCurveOutOfRange === 'boolean' && typeof row.damperCurveOutOfRange === 'boolean'));
    near((await snapshot()).effectiveWheelRate, 60000, 1e-5);
    assert.equal(await page.locator('#component-profile-chart path').count() >= 2, true);
    await cleanCapture();
    await page.locator('#component-profile-chart').screenshot({ path: path.join(outputDir, 'component-profile.png') });
    const before = await config();
    await upload('#component-profile-file', JSON.stringify({ ...profile, units: 'mm' }), 'bad-profile.json', 'application/json');
    await toastContains(/실패/); assert.deepEqual(await config(), before);
    evidence.componentProfile = { staticSpringForce: equilibrium.springForce, effectiveWheelRate: 60000, actualResponseChanges: true, source: 'synthetic regression values, not measured hardware' };
  });

  await check('component profiles and extrapolation flags round-trip in full project files', async () => {
    await view('validation');
    const profile = (await config()).componentProfile;
    await upload('#component-profile-file', JSON.stringify({ ...profile, damper: [[-.001,-10],[0,0],[.001,7]] }), 'narrow-profile.json', 'application/json');
    await toastContains(/適用|적용/);
    await advance(2);
    const history = await page.evaluate(() => window.suspensionLab.history());
    assert.ok(history.some(row => row.damperCurveOutOfRange), 'out-of-table evaluation is explicitly flagged');
    const curveRun = await record('곡선 범위 회귀 시험', 2);
    assert.ok(curveRun.metrics.curveExtrapolationPct > 0);
    assert.ok(curveRun.history.some(row => row.damperCurveOutOfRange));
    const project = JSON.parse((await download('#save-project-btn', 'profile-project.suspension.json')).toString('utf8'));
    assert.ok(project.config.componentProfile); assert.ok(project.runs.some(run => run.id === curveRun.id));
    assert.equal(project.vehicleName, '합성 회귀 시험 · 실차 데이터 아님');
    await view('validation');
    await page.locator('#component-profile-clear-btn').click();
    await page.locator('#vehicle-name').fill('복원 전 임시 이름');
    assert.equal((await config()).componentProfile, null);
    for (const key of ['springRate', 'compressionDamping', 'reboundDamping']) assert.equal(await page.locator(`[data-config="${key}"]`).isDisabled(), false);
    await upload('#project-import-file', JSON.stringify(project), 'profile-roundtrip.json', 'application/json');
    await toastContains(/복원/);
    assert.deepEqual((await config()).componentProfile, project.config.componentProfile);
    assert.equal((await measurementState()).vehicleName, project.vehicleName);
    const restored = (await records()).find(run => run.id === curveRun.id);
    assert.deepEqual(restored.history, curveRun.history);
    evidence.componentProfile.extrapolationPct = curveRun.metrics.curveExtrapolationPct;
  });

  await check('standard, high and ultra rendering use actual distinct postprocessing and shadow settings', async () => {
    await view('bench');
    const settings = {};
    for (const quality of ['standard', 'high', 'ultra']) {
      await page.locator('#render-quality').selectOption(quality); await page.waitForTimeout(180);
      settings[quality] = await diagnostics(); assert.equal(settings[quality].quality, quality);
    }
    assert.equal(settings.standard.shadowEnabled, false); assert.equal(settings.standard.postprocessing.ssao, false);
    assert.equal(settings.high.shadowEnabled, true); assert.equal(settings.high.shadowMapSize, 2048);
    assert.equal(settings.high.postprocessing.ssao, true); assert.equal(settings.high.postprocessing.samples, 16);
    assert.equal(settings.ultra.shadowMapSize, 4096); assert.equal(settings.ultra.postprocessing.samples, 32);
    assert.ok(settings.ultra.pixelRatio > settings.standard.pixelRatio);
    evidence.renderQuality = Object.fromEntries(Object.entries(settings).map(([name, d]) => [name, { pixelRatio: d.pixelRatio, shadowMapSize: d.shadowMapSize, postprocessing: d.postprocessing, canvas: d.canvas }]));
    await page.locator('#render-quality').selectOption('high');
  });

  await check('studio, technical, wheel and suspension inspection are real scene modes with appropriate visibility and framing', async () => {
    await page.locator('#studio-mode').selectOption('studio'); await page.locator('#view-component').selectOption('all');
    await cleanCapture();
    evidence.sceneAll = await diagnostics();
    await page.locator('#viewport').screenshot({ path: path.join(outputDir, 'scene-studio.png') });
    await page.locator('#studio-mode').selectOption('technical'); await page.waitForTimeout(100);
    const technical = await diagnostics(); assert.equal(technical.studioMode, 'technical'); assert.equal(technical.postprocessing.ssao, false);
    assert.notEqual(technical.environmentIntensity, evidence.sceneAll.environmentIntensity);
    await page.locator('#viewport').screenshot({ path: path.join(outputDir, 'scene-technical.png') });
    await page.locator('#studio-mode').selectOption('studio'); await page.locator('#view-component').selectOption('wheel');
    await page.waitForTimeout(100); const wheel = await diagnostics(); assert.equal(wheel.componentFocus, 'wheel'); assert.equal(wheel.wheelVisible, true);
    assert.notDeepEqual(wheel.fitBounds, evidence.sceneAll.fitBounds);
    await page.locator('#viewport').screenshot({ path: path.join(outputDir, 'scene-wheel.png') });
    await page.locator('#view-component').selectOption('suspension'); await page.waitForTimeout(100);
    const joints = await diagnostics(); assert.equal(joints.componentFocus, 'suspension'); assert.equal(joints.wheelVisible, false);
    assert.notDeepEqual(joints.fitBounds, wheel.fitBounds);
    await page.locator('#viewport').screenshot({ path: path.join(outputDir, 'scene-suspension.png') });
    evidence.inspection = { studio: evidence.sceneAll.studioMode, technical: technical.studioMode, wheel: wheel.componentFocus, suspension: joints.componentFocus };
    await page.locator('#view-component').selectOption('all');
  });

  await check('PNG export contains nonuniform rendered pixels at the actual canvas resolution', async () => {
    const png = await download('#capture-view-btn', 'rig-view.png');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const pixels = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 64, 64);
      const data = ctx.getImageData(0, 0, 64, 64).data, colors = new Set(); let min = 255, max = 0, opaque = 0;
      for (let i = 0; i < data.length; i += 4) { colors.add(`${data[i]},${data[i+1]},${data[i+2]}`); min = Math.min(min, data[i], data[i+1], data[i+2]); max = Math.max(max, data[i], data[i+1], data[i+2]); opaque += Number(data[i+3] === 255); }
      return { width: image.width, height: image.height, colors: colors.size, range: max - min, opaque };
    }, `data:image/png;base64,${png.toString('base64')}`);
    assert.ok(pixels.colors > 200 && pixels.range > 100 && pixels.opaque > 4000);
    const d = await diagnostics(); assert.equal(pixels.width, d.canvas.width); assert.equal(pixels.height, d.canvas.height);
    evidence.png = pixels;
  });

  await check('binary GLB export includes real meshes and explicit SI, gauge pressure and reduced-model scope metadata', async () => {
    await page.locator('#view-component').selectOption('wheel');
    const glb = await download('#export-model-btn', 'suspension-rig.glb');
    const document = parseGLB(glb), extras = document.scenes[document.scene || 0].extras;
    assert.ok(document.meshes.length > 10 && document.accessors.length > 10);
    assert.equal(extras.format, 'suspension-lab/glb-v1'); assert.equal(extras.units, 'm'); assert.equal(extras.unitSystem, 'SI');
    assert.equal(extras.quantityUnits.force, 'N'); assert.equal(extras.configUnits.airPressure, 'bar gauge');
    assert.match(extras.model, /quarter-car/); assert.match(extras.scope, /no multibody solver/); assert.match(extras.geometryLimits, /not a validated CAD/);
    assert.deepEqual(extras.config, await config()); assert.ok(extras.components.includes('engineered-holder'));
    assert.match(extras.exportIncludes, /Full selected assembly/);
    const nodes = document.nodes.map(node => node.name || '');
    assert.ok(nodes.includes('wheel-and-brake')); assert.ok(nodes.some(name => /holder|fixture|bench|mount/i.test(name)), 'focus export includes fixture');
    evidence.glb = { bytes: glb.length, meshes: document.meshes.length, units: extras.units, scope: extras.scope, model: extras.model };
    await page.locator('#view-component').selectOption('all');
  });

  await check('desktop, 720px and mobile workspaces retain large graphs without page overflow', async () => {
    await patch({ componentProfile: null }); await advance(8);
    for (const [name, width, height] of [['desktop', 1440, 1000], ['narrow', 720, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height }); await page.waitForTimeout(200); await cleanCapture();
      await view('bench');
      await page.screenshot({ path: path.join(outputDir, `${name}-full.png`), fullPage: true });
      for (const [workspace, selector, suffix, graphIds] of [
        ['bench', '#viewport', 'scene', []],
        ['experiments', '#experiment-workspace', 'workspace', ['experiment-overlay-chart']],
        ['validation', '#engineering-validation', 'engineering', ['measurement-chart']],
        ['analysis', '.charts-grid', 'analysis', ['motion-chart', 'force-chart', 'acceleration-chart']],
      ]) {
        await view(workspace); await cleanCapture();
        const dims = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(dims.scroll <= dims.width + 1, `${name} ${workspace} page overflow ${dims.scroll - dims.width}px`);
        for (const id of graphIds) {
          const box = await page.locator(`#${id}`).boundingBox();
          assert.ok(box && box.height >= (width === 390 ? 250 : 280), `${name} ${id} height ${box?.height}`);
        }
        await page.locator(selector).screenshot({ path: path.join(outputDir, `${name}-${suffix}.png`), style: suffix === 'scene' ? undefined : '.workspace-nav { visibility: hidden !important; }' });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await cleanCapture();
    await view('validation');
    await page.locator('#component-profile-chart').screenshot({ path: path.join(outputDir, 'profile-cleared.png') });
  });

  await check('all product flows complete with zero JavaScript or browser console errors', async () => {
    assert.deepEqual(errors, []);
  });
  await fs.rm(path.join(outputDir, 'failure.png'), { force: true });
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ status: 'passed', baseURL, entryScripts, checks, errors, evidence }, null, 2));
  console.log(`Verified ${checks.length} product checks. Artifacts: ${outputDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ status: 'failed', baseURL, entryScripts, checks, errors, evidence, failure: error.stack }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  await context.close(); await browser.close();
}
