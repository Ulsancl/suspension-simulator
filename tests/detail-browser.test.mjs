import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { DEFAULT_CONFIG } from '../src/physics.js';
import { COMPONENT_PROFILE_TEMPLATE } from '../src/component-curves.js';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output', 'detail-browser');
const address = process.env.SUSPENSION_TEST_URL || 'http://127.0.0.1:5257';
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const checks = [], errors = [], externalRequests = [], evidence = [];
let server, browser, context, page;
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`);
const cameraNear = (actual, expected) => { for (const key of ['position', 'target']) actual[key].forEach((value, index) => near(value, expected[key][index], 1e-8)); near(actual.zoom, expected.zoom); assert.equal(actual.view, expected.view); };
const hashData = value => JSON.stringify(value);
const paint = (target = page) => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const state = () => page.evaluate(() => ({ config: window.suspensionLab.getConfig(), snapshot: window.suspensionLab.snapshot(), detail: window.suspensionLab.getDetail(), metrics: window.suspensionLab.sim.metrics() }));
const records = () => page.evaluate(() => window.suspensionLab.getExperiments());
const debug = () => page.evaluate(() => window.suspensionLab.getSceneDiagnostics());
const view = name => page.evaluate(name => window.suspensionLab.setWorkspaceView(name), name);
const patch = config => page.evaluate(config => { window.suspensionLab.setRunning(false); window.suspensionLab.setConfig(config); }, { ...DEFAULT_CONFIG, ...config });
const advance = seconds => page.evaluate(seconds => window.suspensionLab.advance(seconds), seconds);
const get = (value, key) => key.split('.').reduce((node, key) => node?.[key], value);
const rendering = (target = page) => target.evaluate(() => {
  const canvas = document.querySelector('#viewport canvas'), gl = canvas?.getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info'), d = window.suspensionLab?.getSceneDiagnostics();
  return { documentId: window.__detailDocumentId, readyState: document.readyState, contextLost: gl?.isContextLost() ?? true,
    renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER), draws: d?.draws, triangles: d?.triangles };
});
async function ready(previousDocumentId = null) {
  await page.waitForFunction(previous => {
    const app = window.suspensionLab;
    if (document.readyState !== 'complete' || !window.__detailDocumentId || window.__detailDocumentId === previous || !app?.getDetail || !app.getProductState().ready) return false;
    const canvas = document.querySelector('#viewport canvas'), gl = canvas?.getContext('webgl2'), d = app.getSceneDiagnostics();
    return !!gl && !gl.isContextLost() && canvas.width > 0 && canvas.height > 0 && d.draws > 0 && d.triangles > 0;
  }, previousDocumentId, { polling: 100, timeout: 60000 });
  await page.evaluate(() => window.suspensionLab.setRunning(false));
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); evidence.push({ failureRendering: await rendering().catch(() => null) }); await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {}); throw error; }
}
async function factsMatch() {
  await paint();
  const result = await page.evaluate(() => ({ detail: window.suspensionLab.getDetail(), rows: [...document.querySelectorAll('.detail-fact[data-detail-key]')].map(node => ({ key: node.dataset.detailKey, value: node.dataset.value, unit: node.dataset.unit, displayUnit: node.dataset.displayUnit, text: node.textContent })) }));
  assert.ok(result.rows.length >= 10, 'current detail includes meaningful force, motion and power quantities');
  for (const row of result.rows) {
    const expected = get(result.detail, row.key);
    if (row.key.startsWith('air.') && result.detail.air === null) { assert.equal(row.value, undefined); assert.equal(row.text, '—'); continue; }
    assert.notEqual(expected, undefined, `known quantity ${row.key}`);
    if (typeof expected === 'number') near(Number(row.value), expected, Math.max(1e-9, Math.abs(expected) * 1e-10));
    else assert.equal(row.value, String(expected));
    const unit = row.key.endsWith('N') ? 'N' : row.key.endsWith('W') ? 'W' : row.key.endsWith('Mps') ? 'm/s' : row.key.endsWith('Pa') ? 'Pa' : row.key.endsWith('M3') ? 'm3' : row.key.endsWith('M') ? 'm' : '';
    assert.equal(row.unit, unit, `raw SI unit of ${row.key}`);
    assert.equal(row.displayUnit, ({ m: 'mm', Pa: 'bar', m3: 'L' })[unit] ?? unit);
    assert.doesNotMatch(row.text, /NaN|Infinity|undefined|(?:^|\s)[−-]0(?:\.0+)?(?=\s|$)/);
  }
  const bars = await page.locator('[data-force-key]').evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.forceKey, direction: node.dataset.direction, width: parseFloat(node.querySelector('i').style.width), left: parseFloat(node.querySelector('i').style.left) })));
  const maximum = Math.max(1, ...bars.map(bar => Math.abs(get(result.detail, bar.key))));
  for (const bar of bars) { const value = get(result.detail, bar.key), width = Math.abs(value) / maximum * 50; near(bar.width, width, 1e-4); near(bar.left, value >= 0 ? 50 : 50 - width, 1e-4); assert.equal(bar.direction, value < 0 ? 'down' : 'up'); }
  return result;
}
function forceClosure({ config: c, snapshot: s, detail: d }) {
  const G = 9.80665, total = s.springForce + s.damperForce + s.bumpStopForce, relative = s.wheelVelocity - s.bodyVelocity;
  near(d.timeS, s.time); near(d.forces.suspensionN, total); near(d.forces.springN, s.springForce); near(d.forces.damperN, s.damperForce); near(d.forces.stopN, s.bumpStopForce);
  near(d.forces.body.gravityN, -c.sprungMass * G); near(d.forces.wheel.gravityN, -c.unsprungMass * G);
  near(d.forces.body.constraintN, c.holderMode === 'fixed' ? c.sprungMass * G - total : 0);
  near(d.forces.body.netN, c.sprungMass * s.bodyAcceleration); near(d.forces.wheel.netN, c.unsprungMass * s.wheelAcceleration);
  near(d.forces.wheel.netN, s.contactForce - total - c.unsprungMass * G);
  near(d.forces.body.residualN, 0); near(d.forces.wheel.residualN, 0);
  near(d.motion.axialTravelM, s.effectiveMotionRatio * s.travel); near(d.motion.axialVelocityMps, s.effectiveMotionRatio * relative);
  near(d.motion.springAxialForceN * s.effectiveMotionRatio, s.springForce); near(d.motion.damperAxialForceN * s.effectiveMotionRatio, s.damperForce);
  near(d.power.damperLossW, s.damperForce * relative); assert.ok(d.power.damperLossW >= -1e-8); assert.ok(d.power.stopLossW >= -1e-8);
  near(d.power.kineticRateW, c.sprungMass * s.bodyVelocity * s.bodyAcceleration + c.unsprungMass * s.wheelVelocity * s.wheelAcceleration, 1e-7);
  near(d.power.residualW, 0, 1e-7);
}
async function download(selector, filename) {
  const pending = page.waitForEvent('download', { timeout: 60000 });
  await page.locator(selector).click(); const result = await pending;
  assert.equal(await result.failure(), null);
  const file = path.join(output, filename); await result.saveAs(file); return readFile(file);
}
async function record(name, duration = 1) {
  await view('experiments'); const before = await records();
  await page.locator('#experiment-name').fill(name); await page.locator('#experiment-duration').fill(String(duration));
  await page.locator('#record-experiment-btn').click();
  await page.waitForFunction(count => !window.suspensionLab.getProductState().busy && window.suspensionLab.getExperiments().length === count + 1, before.length, { timeout: 60000 });
  const added = (await records()).filter(run => !before.some(previous => previous.id === run.id)); assert.equal(added.length, 1); return added[0];
}
async function importProject(project) {
  await page.locator('#project-import-file').setInputFiles({ name: 'detail-project.suspension.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await page.waitForFunction(expected => {
    const app = window.suspensionLab;
    return !app.getProductState().busy && JSON.stringify(app.getConfig()) === JSON.stringify(expected.config) && app.getExperiments().length === expected.runs.length;
  }, project, { timeout: 60000 });
  await paint();
}
function parseGLB(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x46546c67); assert.equal(buffer.readUInt32LE(4), 2); assert.equal(buffer.readUInt32LE(8), buffer.length);
  const jsonLength = buffer.readUInt32LE(12); assert.equal(buffer.readUInt32LE(16), 0x4e4f534a);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trim());
}
async function capture(name, selector = '#viewport') {
  assert.equal(JSON.parse(await page.evaluate(() => window.render_game_to_text())).mode, 'paused');
  const before = await state(), locator = page.locator(selector);
  await locator.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' })); await paint();
  const box = await locator.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0 && Object.values(box).every(Number.isFinite));
  const bytes = await page.screenshot({ path: path.join(output, name + '.png'), clip: box, timeout: 30000 }); assert.ok(bytes.byteLength > 12000);
  assert.deepEqual(await state(), before, 'actual render capture does not advance paused physical state');
  evidence.push({ screenshot: name + '.png', bytes: bytes.byteLength });
}
async function capturePage(name) {
  const before = await state(); assert.equal(JSON.parse(await page.evaluate(() => window.render_game_to_text())).mode, 'paused');
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 7000 });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' })); await paint();
  const bytes = await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, timeout: 30000 }); assert.ok(bytes.byteLength > 12000);
  assert.deepEqual(await state(), before); evidence.push({ screenshot: name + '.png', bytes: bytes.byteLength });
}

try {
  await mkdir(output, { recursive: true }); await rm(path.join(output, 'failure.png'), { force: true });
  if (!process.env.SUSPENSION_TEST_URL) { server = await createServer({ root, server: { host: '127.0.0.1', port: 5257, strictPort: true, hmr: false, watch: null } }); await server.listen(); }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  await context.exposeBinding('__detailContextLost', (_source, message) => errors.push({ kind: 'webgl', message }));
  await context.addInitScript(() => { window.__detailDocumentId = crypto.randomUUID(); document.addEventListener('webglcontextlost', event => window.__detailContextLost(event.statusMessage || 'WebGL context lost'), true); });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push({ kind: 'page', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ kind: 'console', message: message.text() }); });
  page.on('requestfailed', request => errors.push({ kind: 'request', message: request.url() + ': ' + request.failure()?.errorText }));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
  await page.goto(address, { waitUntil: 'commit', timeout: 60000 }); await ready(); evidence.push({ initialRendering: await rendering() });

  await check('default detail disclosure preserves first-screen telemetry and native summary keyboard behavior', async () => {
    assert.equal(await page.locator('#detail-disclosure').evaluate(node => node.open), false);
    const telemetry = await page.locator('.telemetry-section').boundingBox(); assert.ok(telemetry.y + telemetry.height <= 1000);
    const initial = await state(); await page.locator('#detail-disclosure > summary').focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('#detail-disclosure').evaluate(node => node.open), true); assert.equal(JSON.parse(await page.evaluate(() => window.render_game_to_text())).mode, 'paused');
    await page.keyboard.press('Space'); assert.equal(await page.locator('#detail-disclosure').evaluate(node => node.open), false);
    assert.deepEqual(await state(), initial); await page.locator('#detail-disclosure > summary').click(); await factsMatch();
    await view('analysis'); assert.equal(await page.locator('#detail-panel').isVisible(), false); await view('bench'); assert.equal(await page.locator('#detail-panel').isVisible(), true);
  });

  await check('static equilibrium distinguishes transmitted spring load from the signed fixed-holder constraint', async () => {
    for (const holderMode of ['fixed', 'sprung']) {
      await patch({ holderMode, road: 'flat' }); const current = await state(); forceClosure(current);
      near(current.detail.forces.transmittedHolderN, current.config.sprungMass * 9.80665);
      near(current.detail.forces.body.constraintN, 0); near(current.detail.forces.body.netN, 0); near(current.detail.forces.wheel.netN, 0);
      near(current.detail.power.damperLossW, 0); near(current.detail.power.kineticRateW, 0); await factsMatch();
    }
  });

  await check('compression, rebound and distinct unilateral tire branches display actual solved forces and power', async () => {
    const branches = [];
    for (const time of [.35, .398, .4, .42]) {
      await patch({ holderMode: 'sprung' }); await advance(time); const current = await state(); forceClosure(current); await factsMatch(); branches.push(current.detail.tire.branch);
      if (time === .35) assert.equal(current.detail.damper.branch, 'compression');
      if (time === .42) { assert.equal(current.detail.damper.branch, 'rebound'); assert.ok(current.detail.forces.damperN < 0); }
      if (time === .398) { assert.equal(current.detail.tire.branch, 'clamped'); assert.ok(current.detail.tire.compressionM > 0); assert.ok(current.detail.tire.rawForceN <= 0); }
      if (time === .4) { assert.equal(current.detail.tire.branch, 'detached'); assert.ok(current.detail.tire.compressionM < 0); }
      if (current.detail.tire.branch !== 'loaded') near(current.detail.tire.actualForceN, 0);
    }
    evidence.push({ tireBranches: branches });
  });

  await check('elastic stops report actual overtravel, loading dissipation and both fixed-body reaction signs', async () => {
    const config = { holderMode: 'fixed', roadHeight: .2, roadWidth: .2, speed: 50, travelBump: .02, travelRebound: .02, tireDamping: 2000 }, constraints = [];
    for (const [time, side] of [[.224, 'bump'], [.242, 'bump'], [.274, 'rebound']]) {
      await patch(config); await advance(time); const current = await state(); forceClosure(current); await factsMatch();
      assert.ok(current.detail.stop[side + 'PenetrationM'] > 0); near(current.snapshot.bodyY, 0); near(current.snapshot.bodyAcceleration, 0); near(current.detail.power.constraintW, 0);
      constraints.push(current.detail.forces.body.constraintN);
      if (time === .242) { assert.equal(current.detail.stop.loading, false); near(current.detail.power.stopLossW, 0); }
      else { assert.equal(current.detail.stop.loading, true); assert.ok(current.detail.power.stopLossW > 0); }
    }
    assert.ok(constraints.some(value => value < 0) && constraints.some(value => value > 0)); evidence.push({ fixedHolderConstraints: constraints });
  });

  await check('motion-ratio conversion and air absolute pressure retain the published model and explicit volume limit', async () => {
    await patch({ holderMode: 'sprung', autoMotionRatio: false, motionRatio: .55 }); await advance(.36); let current = await state(); forceClosure(current); near(current.detail.motion.motionRatio, .55); await factsMatch();
    await patch({ springType: 'air', holderMode: 'fixed', airVolume: .5, airArea: .015, airPressure: .5, roadHeight: .25, roadWidth: 1, speed: 40 }); await advance(.272); current = await state(); forceClosure(current);
    const air = current.detail.air; assert.equal(air.volumeLimited, true); near(air.volumeM3, .0005 * .15); assert.ok(air.rawVolumeM3 < air.volumeM3);
    near(air.initialAbsolutePressurePa, .5 * 100000 + 101325); near(air.absolutePressurePa - air.gaugePressurePa, 101325, 1e-7); await factsMatch();
    await patch({ springType: 'air', componentProfile: COMPONENT_PROFILE_TEMPLATE }); await advance(.35); current = await state(); assert.equal(current.detail.spring.source, 'curve'); assert.equal(current.detail.air, null); await factsMatch();
  });

  await check('component-table provenance and out-of-range evaluation survive derived observation without changing source data', async () => {
    const profile = structuredClone(COMPONENT_PROFILE_TEMPLATE); profile.damper = [[-.01, -28], [0, 0], [.01, 18]];
    await patch({ holderMode: 'sprung', componentProfile: profile }); await advance(.36);
    const before = await state(); forceClosure(before); assert.equal(before.detail.spring.source, 'curve'); assert.equal(before.detail.damper.source, 'curve'); assert.equal(before.detail.damper.curveOutOfRange, true);
    await factsMatch(); assert.deepEqual(await state(), before); assert.deepEqual((await state()).config.componentProfile, profile);
  });

  await check('playback scale, scene quality and display controls preserve paused physical detail', async () => {
    await patch({ holderMode: 'sprung' }); await advance(.36); const before = await state(), history = await page.evaluate(() => window.suspensionLab.history());
    for (const scale of ['0.25', '1', '0.5']) { await page.locator('#time-scale').selectOption(scale); assert.deepEqual((await state()).snapshot, before.snapshot); assert.deepEqual((await state()).detail, before.detail); }
    for (const id of ['show-links', 'show-forces', 'show-labels']) { const control = page.locator('#' + id); const initial = await control.isChecked(); await control.setChecked(!initial); await control.setChecked(initial); }
    await page.locator('#render-quality').selectOption('standard'); await page.locator('#render-quality').selectOption('high'); await paint();
    assert.deepEqual((await state()).snapshot, before.snapshot); assert.deepEqual((await state()).detail, before.detail); assert.deepEqual(await page.evaluate(() => window.suspensionLab.history()), history); await factsMatch();
  });

  let referenceRun, savedProject;
  await check('configuration reset changes current trial only while recorded experiments retain their original samples and metrics', async () => {
    await patch({ holderMode: 'sprung' }); await advance(.4); const live = await state(); referenceRun = await record('상세 검증 원본 시험');
    assert.deepEqual(await state(), live, 'independent standard recording does not alter live playback');
    const original = hashData(await records()); await patch({ holderMode: 'fixed', springType: 'progressive', springRate: 41000 });
    const reset = await state(); near(reset.snapshot.time, 0); near(reset.detail.timeS, 0); near(reset.metrics.duration, 0); assert.equal(hashData(await records()), original);
    await view('experiments'); await page.locator(`[data-record-action="load"][data-record-id="${referenceRun.id}"]`).click();
    assert.deepEqual((await state()).config, referenceRun.config); near((await state()).detail.timeS, 0); assert.equal(hashData(await records()), original);
    savedProject = JSON.parse((await download('#save-project-btn', 'detail-records.suspension.json')).toString('utf8'));
    assert.deepEqual(savedProject.runs, await records()); assert.deepEqual(savedProject.config, (await state()).config); assert.equal(savedProject.modelVersion, 'quarter-car-1.3');
  });

  await check('current force detail stays current when chart intervals and recorded comparison cursors change', async () => {
    await view('bench'); await advance(6); const before = await state(), original = hashData(await records()); await view('analysis');
    for (const span of ['4', '8', '30']) { await page.locator('#chart-window').selectOption(span); assert.deepEqual((await state()).detail, before.detail); }
    const chart = page.locator('#motion-chart'); await chart.scrollIntoViewIfNeeded(); const box = await chart.boundingBox(); await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
    assert.deepEqual((await state()).detail, before.detail); assert.equal(hashData(await records()), original); near((await state()).metrics.duration, before.snapshot.time);
    await view('experiments'); assert.match(await page.locator('#context-result-scope').textContent(), /기록별 전체/); near(referenceRun.metrics.duration, 1);
    await view('bench'); await factsMatch(); assert.match(await page.locator('#detail-reference').textContent(), /현재|시점|실시간/);
  });

  await check('actual project import and fresh-document reload preserve records while derived detail restarts at static equilibrium', async () => {
    await patch({ speed: 5, holderMode: 'fixed' }); await advance(.15); await importProject(savedProject); near((await state()).detail.timeS, 0); assert.deepEqual(await records(), savedProject.runs); await factsMatch();
    const previous = await page.evaluate(() => window.__detailDocumentId); await page.reload({ waitUntil: 'commit', timeout: 60000 }); await ready(previous);
    assert.deepEqual((await state()).config, savedProject.config); assert.deepEqual(await records(), savedProject.runs); near((await state()).detail.timeS, 0); forceClosure(await state()); await factsMatch();
  });

  await check('legacy CSV exports retain original prior-model samples while current observations use the current model', async () => {
    const legacy = structuredClone(referenceRun); legacy.id = 'd041dd0e-858f-4bd5-bb9d-ce4d74784399'; legacy.modelVersion = 'quarter-car-1.2'; legacy.name = legacy.title = '이전 모델 원본';
    legacy.history[8].wheelY = .0123456789; legacy.kpis.bodyRMS = .432123456789; legacy.kpis.settling.method = '이전 정착 판정';
    delete legacy.config.componentProfile; delete legacy.metrics.curveExtrapolationPct; delete legacy.kpis.curveExtrapolationPct;
    for (const row of legacy.history) { delete row.springCurveOutOfRange; delete row.damperCurveOutOfRange; }
    await importProject({ ...savedProject, runs: [referenceRun, legacy] }); await view('experiments');
    const card = page.locator(`article[data-record-id="${legacy.id}"]`); assert.match(await card.innerText(), /quarter-car-1\.2.*읽기 전용/);
    assert.equal(await card.locator('[data-record-action="load"]').isDisabled(), true); assert.equal(await card.locator('[data-record-action="delete"]').isDisabled(), true);
    const csv = (await download(`[data-record-action="export"][data-record-id="${legacy.id}"]`, 'legacy-original.csv')).toString('utf8'); assert.match(csv, /0\.0123456789/);
    const original = hashData(await records()); await view('bench'); await patch({ holderMode: 'fixed', springType: 'air' }); await advance(.36); await factsMatch();
    assert.equal(hashData(await records()), original); assert.deepEqual((await records()).find(run => run.id === legacy.id), legacy);
    await importProject(savedProject); assert.deepEqual(await records(), savedProject.runs);
  });

  await check('rendered spring seats and damper clearances follow the actual moving assembly across structure and spring changes', async () => {
    for (const config of [{ structure: 'wishbone', springType: 'coil' }, { structure: 'macpherson', springType: 'progressive' }, { structure: 'multilink', springType: 'air' }]) {
      await patch({ ...config, holderMode: 'sprung' }); await advance(.36); await paint(); const d = await debug(), m = d.mechanical;
      assert.equal(m.springType, config.springType); assert.equal(m.integrated, config.structure === 'macpherson');
      near(Math.hypot(...m.lowerEye.map((value, index) => value - m.upperEye[index])), m.lengthM, 1e-8);
      assert.equal(m.damper.variableEnvelope, true); assert.equal(m.damper.hydraulicCircuitSolved, false);
      assert.ok(m.damper.guideBoreRadiusM > m.damper.rodRadiusM); assert.ok(m.damper.bodyBoreRadiusM > m.damper.pistonRadiusM);
      assert.ok(m.damper.pistonYM > m.damper.bodyBottomYM && m.damper.pistonYM < m.damper.bodyTopYM);
      if (config.springType === 'air') { assert.equal(m.coilBounds, null); assert.ok(m.visibleMeshes.includes('hollow-five-convolution-bellows')); }
      else { near(m.seats.lowerTopYM, m.seats.lowerContactYM, 1e-7); near(m.seats.upperBottomYM, m.seats.upperContactYM, 1e-7); assert.equal(m.displayEnvelopeValid, true); assert.ok(m.usableSpanM >= m.minimumSpanM); assert.ok(m.minSampledTurnClearanceM > 0, 'actual coil turns do not intersect'); assert.ok(m.coilBounds.min.every(Number.isFinite) && m.coilBounds.max.every(Number.isFinite)); }
      evidence.push({ assembly: config, mechanical: m });
    }
  });

  await check('explicit spring and damper inspection preserve paused physics, restore the previous camera and honor current display choices', async () => {
    await patch({ structure: 'wishbone', springType: 'coil', holderMode: 'sprung' }); await advance(.36); await view('bench');
    if (!await page.locator('#detail-disclosure').evaluate(node => node.open)) await page.locator('#detail-disclosure > summary').click();
    await page.locator('[data-camera="side"]').click(); await paint(); const original = await state(), saved = (await debug()).camera;
    await page.locator('#inspect-spring').click(); assert.deepEqual(await page.evaluate(() => window.suspensionLab.getInspection()), { id: 'spring' });
    assert.equal((await debug()).camera.view, 'iso'); assert.equal(await page.locator('[data-camera="iso"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#inspect-spring').getAttribute('aria-pressed'), 'true'); assert.equal((await debug()).actualVisible.wheel, false);
    let d = await debug(); assert.ok(d.mechanical.visibleMeshes.includes('helical-coil')); assert.ok(!d.mechanical.visibleMeshes.includes('sliding-chrome-rod')); assert.notDeepEqual(d.camera.position, saved.position);
    await capture('spring-inspection');
    await page.locator('#render-quality').selectOption('standard'); await page.locator('#render-quality').selectOption('high'); await page.locator('[data-camera="front"]').click();
    await page.locator('#show-links').uncheck(); await page.locator('#show-labels').uncheck(); await page.locator('#show-forces').check(); await page.locator('#studio-mode').selectOption('technical');
    const isolated = (await debug()).actualVisible;
    for (const key of ['wheel', 'road', 'fixture', 'floor', 'grid', 'labels', 'forces', 'otherLinks']) assert.equal(isolated[key], false, `${key} remains hidden in explicit inspection`);
    assert.equal(isolated.spring, true);
    await page.locator('#exit-inspection').click(); assert.equal(await page.evaluate(() => window.suspensionLab.getInspection()), null); cameraNear((await debug()).camera, saved); assert.deepEqual(await state(), original);
    assert.equal(await page.locator('[data-camera="side"]').getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('[data-camera="front"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#show-links').isChecked(), false); assert.equal(await page.locator('#show-forces').isChecked(), true);
    assert.equal((await debug()).actualVisible.links, false); assert.equal((await debug()).actualVisible.forces, true); assert.equal((await debug()).actualVisible.grid, true);
    await page.locator('#show-links').check(); await page.locator('#show-labels').check(); await page.locator('#show-forces').uncheck(); await page.locator('#studio-mode').selectOption('studio');
    await page.locator('#inspect-damper').click(); d = await debug(); assert.deepEqual(d.inspection, { id: 'damper' }); assert.match(d.mechanical.cutaway, /closed half-section/);
    for (const name of ['hollow-damper-envelope-section', 'representative-piston-head', 'sliding-chrome-rod']) assert.ok(d.mechanical.visibleMeshes.includes(name));
    assert.ok(!d.mechanical.visibleMeshes.includes('helical-coil')); await capture('damper-inspection');
    const preAdvance = (await debug()).camera; await advance(.005); d = await debug();
    for (let i = 0; i < 3; i++) near(d.camera.position[i] - d.camera.target[i], preAdvance.position[i] - preAdvance.target[i], 1e-8);
    assert.deepEqual(d.inspection, { id: 'damper' }); await page.locator('#view-component').selectOption('wheel'); assert.equal((await debug()).inspection, null); assert.equal((await debug()).componentFocus, 'wheel');
    await page.locator('#view-component').selectOption('all'); await page.locator('#inspect-spring').click(); await patch({ structure: 'macpherson', springType: 'progressive' }); assert.equal((await debug()).inspection, null); await factsMatch();
  });

  await check('GLB exported during internal inspection contains the full current assembly with uncut spring and damper meshes', async () => {
    await patch({ holderMode: 'sprung' }); await advance(.36); await page.locator('#inspect-damper').click(); const before = await state(), sceneBefore = await debug();
    const bytes = await download('#export-model-btn', 'inspected-full-assembly.glb'), glb = parseGLB(bytes), extras = glb.scenes[glb.scene || 0].extras;
    assert.equal(extras.format, 'suspension-lab/glb-v1'); assert.equal(extras.units, 'm'); assert.equal(extras.quantityUnits.force, 'N'); assert.equal(extras.configUnits.airPressure, 'bar gauge');
    assert.deepEqual(extras.config, before.config); assert.deepEqual(extras.state, before.snapshot); assert.match(extras.scope, /Current static display pose/); assert.match(extras.exportIncludes, /Full selected assembly/);
    const names = glb.nodes.map(node => node.name || ''); for (const name of ['wheel-and-brake', 'helical-coil', 'hollow-damper-envelope', 'representative-piston-head']) assert.ok(names.includes(name), `export includes ${name}`);
    assert.ok(!names.some(name => /(?:damper-envelope|rod-guide|wiper-seal|bellows)-section$/.test(name)), 'presentation-only section meshes do not replace the exported assembly');
    const coil = glb.nodes.find(node => node.name === 'helical-coil'), primitive = glb.meshes[coil.mesh].primitives[0]; assert.equal(glb.accessors[primitive.attributes.POSITION].count, sceneBefore.coilBufferVertices);
    assert.deepEqual(await state(), before); assert.deepEqual((await debug()).inspection, { id: 'damper' }); cameraNear((await debug()).camera, sceneBefore.camera);
    assert.equal((await debug()).geometries, sceneBefore.geometries); assert.equal((await debug()).textures, sceneBefore.textures);
    evidence.push({ glb: { bytes: bytes.length, meshes: glb.meshes.length, coilVertices: glb.accessors[primitive.attributes.POSITION].count, time: extras.state.time } }); await page.locator('#exit-inspection').click();
  });

  await check('narrow workspaces keep detail controls accessible and hide live observations from stored-result workspaces', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await view('bench'); await patch({ holderMode: 'sprung' }); await advance(.36);
    await page.locator('#detail-disclosure').evaluate(node => { node.open = false; }); await page.locator('#detail-disclosure > summary').focus(); const before = await state(); await page.keyboard.press('Space');
    assert.equal(await page.locator('#detail-disclosure').evaluate(node => node.open), true); assert.deepEqual(await state(), before); await factsMatch();
    const telemetry = await page.locator('.telemetry-section').boundingBox(), detail = await page.locator('#detail-panel').boundingBox(); assert.ok(telemetry.y + telemetry.height <= detail.y + 1, 'narrow detail follows current telemetry');
    const camera = (await debug()).camera; await page.locator('#inspect-damper').click(); assert.deepEqual((await debug()).inspection, { id: 'damper' });
    await capture('mobile-damper-inspection'); await page.locator('#inspection-banner-exit').click(); cameraNear((await debug()).camera, camera); assert.deepEqual(await state(), before);
    for (const workspace of ['bench', 'analysis', 'experiments', 'validation']) {
      await view(workspace); await paint(); const width = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth })); assert.ok(width.page <= width.viewport + 1, `${workspace} horizontal overflow`);
      assert.equal(await page.locator('#detail-panel').isVisible(), workspace === 'bench');
    }
    await view('bench'); await capturePage('mobile-detail');
    await page.setViewportSize({ width: 1440, height: 1000 }); await view('bench'); await paint();
  });

  await check('actual rendered overview and expanded force observations remain finite and paused', async () => {
    await patch({ holderMode: 'sprung' }); await advance(.36); await capture('detail-overview'); await page.locator('#detail-disclosure').evaluate(node => { node.open = true; });
    await capturePage('force-detail');
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); evidence.push({ finalRendering: await rendering() });
  });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', version, address, checks, errors, externalRequests, evidence }, null, 2));
} catch (error) {
  console.error(error.stack || error); process.exitCode = 1;
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', version, address, checks, errors, externalRequests, evidence, failure: error.stack || String(error) }, null, 2));
} finally { await context?.close(); await browser?.close(); await server?.close(); }
