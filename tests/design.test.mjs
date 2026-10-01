import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = process.env.SUSPENSION_TEST_OUTPUT_SUFFIX || '';
if (suffix && !/^[a-z0-9-]+$/.test(suffix)) throw new Error('Invalid test output suffix');
const outputDir = path.join(root, 'output', 'design' + (suffix ? '-' + suffix : ''));
const baseURL = process.env.SUSPENSION_TEST_URL || 'http://127.0.0.1:5173';
await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const checks = [];
const errors = [];
const sceneEvidence = {};
let entryScripts = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const chartIds = ['motion-chart', 'force-chart', 'acceleration-chart'];
const seriesKeys = ['wheelY', 'bodyY', 'rawRoadY', 'contactForce', 'springForce', 'bodyAcceleration', 'wheelAcceleration'];
const state = () => page.evaluate(() => window.suspensionLab.getChartState());
const snapshot = () => page.evaluate(() => window.suspensionLab.snapshot());
const history = () => page.evaluate(() => window.suspensionLab.history());
const config = () => page.evaluate(() => window.suspensionLab.getConfig());
const patch = value => page.evaluate(value => window.suspensionLab.setConfig(value), value);
const advance = value => page.evaluate(value => window.suspensionLab.advance(value), value);
const setRunning = value => page.evaluate(value => window.suspensionLab.setRunning(value), value);
const diagnostics = () => page.evaluate(() => window.suspensionLab.getSceneDiagnostics());
async function workspaceView(view) {
  await page.evaluate(view => window.suspensionLab.setWorkspaceView?.(view), view);
}

async function check(name, action) {
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}
function finite(value, description = 'value') {
  assert.ok(Number.isFinite(value), `${description} must be finite`);
}
function trace(key) {
  return page.locator(`svg path[data-series="${key}"], svg polyline[data-series="${key}"]`);
}
async function traceVisible(key) {
  const target = trace(key);
  if (!(await target.count())) return false;
  return target.first().evaluate(element => {
    const css = getComputedStyle(element);
    return css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) !== 0 && !element.hasAttribute('hidden');
  });
}
async function chartDimensions(minimumHeight) {
  await workspaceView('analysis');
  for (const id of chartIds) {
    const chart = page.locator(`#${id}`);
    const box = await chart.boundingBox();
    assert.ok(box && box.height >= minimumHeight, `${id} actual height ${box?.height}px is at least ${minimumHeight}px`);
    const axes = await chart.locator('text').evaluateAll(elements => elements.filter(element => /[-+−]?\d/.test(element.textContent)).map(element => ({
      text: element.textContent,
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      actualHeight: element.getBoundingClientRect().height,
    })));
    assert.ok(axes.length >= 4, `${id} has numeric scale labels`);
    for (const axis of axes) {
      assert.ok(axis.fontSize >= 12, `${id} axis font ${axis.fontSize}px`);
      assert.ok(axis.actualHeight >= 10.5, `${id} rendered axis glyph height ${axis.actualHeight}px`);
    }
  }
}
async function download(id, filename) {
  await workspaceView('analysis');
  const pending = page.waitForEvent('download');
  await page.locator(id).click();
  const result = await pending;
  const target = path.join(outputDir, filename);
  await result.saveAs(target);
  assert.equal(await result.failure(), null);
  return { target, text: await fs.readFile(target, 'utf8') };
}
async function cleanCaptureLayout() {
  await page.waitForFunction(() => {
    const toast = document.querySelector('#toast');
    return !toast || toast.hidden || getComputedStyle(toast).display === 'none';
  }, null, { timeout: 7000 });
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(element => { element.open = false; });
    const panel = document.querySelector('.control-scroll');
    if (panel) panel.scrollTop = 0;
    scrollTo(0, 0);
  });
}

try {
  await page.clock.install();
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.suspensionLab?.getChartState && window.suspensionLab?.getSceneDiagnostics);
  entryScripts = await page.locator('script[type="module"][src]').evaluateAll(elements => elements.map(element => element.src));
  await setRunning(false);
  await patch({ holderMode: 'sprung', structure: 'wishbone', springType: 'coil', road: 'bump', speed: 30, singleEvent: false, autoMotionRatio: true });
  await advance(2);
  await workspaceView('analysis');

  await check('two-second trial plots actual nonzero wheel, body, force and acceleration samples', async () => {
    const samples = await history();
    assert.ok(samples.length >= 200);
    for (const key of seriesKeys) {
      const values = samples.map(sample => sample[key]);
      values.forEach(value => finite(value, key));
      assert.ok(Math.max(...values) - Math.min(...values) > 1e-6, `${key} changes during the road input`);
      const target = trace(key);
      assert.equal(await target.count(), 1, `One chart trace for ${key}`);
      const geometry = await target.getAttribute('d') || await target.getAttribute('points');
      assert.ok(geometry?.length > 100, `${key} has sampled path data`);
    }
  });

  await advance(6);
  await check('desktop charts have large plotting areas and readable numeric axes', async () => {
    await chartDimensions(300);
  });

  await check('hover readout is synchronized to the nearest real simulation sample', async () => {
    const chart = page.locator('#motion-chart');
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5);
    await page.waitForFunction(() => document.querySelector('#chart-cursor-readout')?.getAttribute('data-value'));
    const raw = JSON.parse(await page.locator('#chart-cursor-readout').getAttribute('data-value'));
    const cursor = raw.time ?? raw.cursorTime;
    finite(cursor, 'readout time');
    const chartState = await state();
    finite(chartState.cursorTime, 'shared cursor time');
    assert.ok(Math.abs(chartState.cursorTime - cursor) <= 0.01);
    const samples = await history();
    const nearest = samples.reduce((selected, sample) => Math.abs(sample.time - cursor) < Math.abs(selected.time - cursor) ? sample : selected);
    assert.ok(Math.abs(nearest.time - cursor) < 0.01);
    const values = raw.values ?? raw;
    for (const key of seriesKeys) {
      finite(values[key], `readout ${key}`);
      assert.ok(Math.abs(values[key] - nearest[key]) <= Math.max(1e-6, Math.abs(nearest[key]) * 1e-6), `${key} readout matches the recorded SI sample`);
    }
    for (const id of chartIds) {
      const cursorPosition = await page.locator(`#${id}`).evaluate(element => {
        const line = element.querySelector('[data-chart-layer="cursor"] line');
        const clip = element.querySelector('clipPath rect');
        return line ? (Number(line.getAttribute('x1')) - Number(clip.getAttribute('x'))) / Number(clip.getAttribute('width')) : null;
      });
      finite(cursorPosition, `${id} synchronized cursor`);
      assert.ok(Math.abs(cursorPosition - (cursor - chartState.start) / chartState.windowSeconds) < 0.001, `${id} cursor uses the same sample time`);
    }
    assert.ok((await page.locator('#chart-cursor-readout').innerText()).length > 30);
  });

  await check('legend controls hide the corresponding actual chart trace', async () => {
    for (const key of ['wheelY', 'springForce', 'bodyAcceleration']) {
      const button = page.locator(`button[data-series="${key}"]`);
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      assert.ok(await traceVisible(key));
      await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'false');
      assert.equal(await traceVisible(key), false);
      await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      assert.ok(await traceVisible(key));
    }
  });

  await check('window selection and pointer wheel zoom change time span without scrolling the page', async () => {
    for (const seconds of ['4', '8', '15', '30']) {
      await page.locator('#chart-window').selectOption(seconds);
      assert.ok(Math.abs((await state()).windowSeconds - Number(seconds)) < 1e-8);
    }
    await page.locator('#chart-window').selectOption('8');
    await page.locator('#motion-chart').scrollIntoViewIfNeeded();
    const box = await page.locator('#motion-chart').boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    const before = await state();
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, -180);
    await page.waitForTimeout(150);
    const after = await state();
    assert.ok(after.windowSeconds < before.windowSeconds, 'Wheel zoom narrows the time window');
    assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - scrollY) <= 1, 'Chart wheel interaction does not scroll the page');
  });

  await check('dragging pans the chart without pausing simulation and view offset survives new samples', async () => {
    await page.locator('#chart-window').selectOption('4');
    await page.locator('#chart-follow').check();
    const chart = page.locator('#motion-chart');
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    await setRunning(false);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
    try {
      await setRunning(true);
      const before = await state(), beforeTime = (await snapshot()).time;
      const y = box.y + box.height * 0.55;
      await page.mouse.move(box.x + box.width * 0.45, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.73, y, { steps: 8 });
      await page.mouse.up();
      const panned = await state();
      assert.equal(panned.follow, false);
      assert.equal(await page.locator('#chart-follow').isChecked(), false);
      assert.ok(panned.end < before.end - 0.1, 'Drag reveals older samples');
      assert.equal(JSON.parse(await page.evaluate(() => window.render_game_to_text())).mode, 'running', 'Real pointer drag preserves simulation playback');
      await page.clock.runFor(300);
      const playing = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
      assert.equal(playing.mode, 'running');
      assert.ok(playing.state.time > beforeTime + .3*playing.config.timeScale-.03, 'RAF playback advances at the selected replay scale after the drag');
      assert.ok(Math.abs((await state()).end - panned.end) < 0.02, 'RAF samples preserve the panned view');
      await setRunning(false);
      await advance(1.5);
      assert.ok(Math.abs((await state()).end - panned.end) < 0.02, 'New samples preserve the panned view');
      // Force skips locator RAF stability checks while the test clock is paused.
      await page.locator('#chart-reset-view').click({ force: true });
      const restored = await state();
      assert.equal(restored.follow, true);
      assert.equal(await page.locator('#chart-follow').isChecked(), true);
      assert.ok(Math.abs(restored.end - (await snapshot()).time) < 0.025, 'Reset view catches up to current samples');
      sceneEvidence.chartPanClock = { virtualMilliseconds: 300, beforeTime, afterTime: playing.state.time, before, panned, restored };
    } finally {
      await setRunning(false);
      await page.clock.resume();
    }
  });

  await check('all analysis summaries compute correct RMS, extrema and contact loss for the visible interval', async () => {
    const interval = await state();
    const rows = (await history()).filter(row => row.time >= interval.start && row.time <= interval.end);
    assert.ok(rows.length > 100);
    const statistics = (key, scale = 1) => {
      const values = rows.map(row => row[key] * scale);
      const min = Math.min(...values), max = Math.max(...values);
      return { min, max, peak: Math.max(Math.abs(min), Math.abs(max)), rms: Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length) };
    };
    const wheel = statistics('wheelY', 1000), body = statistics('bodyY', 1000), travel = statistics('travel', 1000);
    const force = statistics('contactForce', 0.001), spring = statistics('springForce', 0.001);
    const bodyAcceleration = statistics('bodyAcceleration'), wheelAcceleration = statistics('wheelAcceleration');
    const expected = {
      wheelPeak: wheel.peak, compressionPeak: Math.max(0, travel.max), reboundPeak: Math.max(0, -travel.min), bodyDisplacementRMS: body.rms,
      contactMin: force.min, contactMax: force.max, springPeak: spring.peak, contactLoss: rows.filter(row => !row.contact).length / rows.length * 100,
      bodyAccelerationRMS: bodyAcceleration.rms, bodyAccelerationPeak: bodyAcceleration.peak,
      wheelAccelerationRMS: wheelAcceleration.rms, wheelAccelerationPeak: wheelAcceleration.peak,
    };
    for (const [key, value] of Object.entries(expected)) {
      const metric = page.locator(`[data-metric="${key}"]`);
      assert.equal(await metric.count(), 1);
      const actual = Number(await metric.getAttribute('data-value'));
      finite(actual, key);
      assert.ok(Math.abs(actual - value) < Math.max(1e-7, Math.abs(value) * 1e-7), `${key} matches samples in the current time window`);
    }
    for (const id of ['motion-analysis', 'force-analysis', 'acceleration-analysis']) assert.doesNotMatch(await page.locator(`#${id}`).innerText(), /NaN|Infinity|undefined/);
  });

  await check('scene quality controls change actual renderer settings and preserve detailed components', async () => {
    await workspaceView('bench');
    await page.locator('#render-quality').selectOption('standard');
    const standard = await diagnostics();
    await page.locator('#render-quality').selectOption('high');
    const high = await diagnostics();
    assert.equal(standard.quality ?? standard.renderer?.quality, 'standard');
    assert.equal(high.quality ?? high.renderer?.quality, 'high');
    const standardCanvas = standard.canvas ?? standard.renderer ?? standard;
    const highCanvas = high.canvas ?? high.renderer ?? high;
    const actualFields = ['width', 'height', 'pixelRatio', 'shadowMapSize', 'shadowResolution', 'shadowEnabled', 'shadowMapEnabled', 'environmentIntensity', 'exposure', 'samples'];
    assert.ok(actualFields.some(key => JSON.stringify(standardCanvas[key] ?? standard[key]) !== JSON.stringify(highCanvas[key] ?? high[key])), 'Quality selection changes canvas resolution or rendering settings');
    const description = JSON.stringify(high).toLowerCase();
    for (const feature of ['rim', 'brake', 'caliper']) assert.ok(description.includes(feature), `Diagnostics identify the ${feature} component`);
    assert.match(description, /holder|fixture/, 'Diagnostics identify the holder fixture');
    const triangles = high.triangles ?? high.renderer?.triangles;
    assert.ok(triangles > 5000, 'Detailed rig has substantial rendered mesh geometry');
  });

  await check('refined structure and air-spring screenshots show distinct rendered geometry', async () => {
    await workspaceView('bench');
    await page.locator('#tab-setup').click();
    const hashes = [];
    for (const structure of ['wishbone', 'multilink', 'macpherson']) {
      await page.locator('#structure').selectOption(structure);
      await patch({ holderMode: 'sprung', springType: 'coil', road: 'bump', speed: 30, singleEvent: false });
      await advance(8);
      const value = await diagnostics();
      assert.equal(value.structure, structure);
      const topology = {
        wishbone: 'two-triangular-forged-a-arms',
        multilink: 'five-independent-adjustable-rods',
        macpherson: 'lower-a-arm-and-telescopic-strut',
      };
      assert.ok(value.components.includes(topology[structure]), `${structure} renders its distinct suspension topology`);
      assert.equal(value.topology.aArms, structure === 'wishbone' ? 2 : structure === 'macpherson' ? 1 : 0);
      assert.equal(value.topology.rods, structure === 'multilink' ? 5 : 1);
      assert.equal(value.topology.struts, structure === 'macpherson' ? 1 : 0);
      sceneEvidence[structure] = value;
      await cleanCaptureLayout();
      await page.screenshot({ path: path.join(outputDir, `${structure}-desktop.png`), fullPage: true });
      const picture = await page.locator('#viewport').screenshot({ path: path.join(outputDir, `${structure}-scene.png`) });
      assert.ok(picture.byteLength > 18000);
      hashes.push(crypto.createHash('sha256').update(picture).digest('hex'));
    }
    assert.equal(new Set(hashes).size, 3, 'All structures produce distinct scene images');
    await page.locator('#structure').selectOption('wishbone');
    await page.locator('#spring-type').selectOption('air');
    await advance(8);
    sceneEvidence.air = await diagnostics();
    assert.equal(sceneEvidence.air.springType, 'air');
    assert.ok(sceneEvidence.air.components.includes('five-convolution-air-bellows'), 'Air mode renders its bellows component');
    await cleanCaptureLayout();
    await page.screenshot({ path: path.join(outputDir, 'air-desktop.png'), fullPage: true });
    await page.locator('#viewport').screenshot({ path: path.join(outputDir, 'air-scene.png') });
    await workspaceView('analysis');
    await page.locator('.charts-grid').screenshot({ path: path.join(outputDir, 'charts-desktop.png'), style: '.workspace-nav { visibility: hidden !important; }' });
    await workspaceView('bench');
    await page.locator('#spring-type').selectOption('progressive');
    await advance(8);
    sceneEvidence.progressive = await diagnostics();
    assert.ok(sceneEvidence.progressive.components.includes('variable-pitch-helical-coil'), 'Progressive mode renders its variable-pitch coil');
    await workspaceView('bench');
    await cleanCaptureLayout();
    await page.screenshot({ path: path.join(outputDir, 'progressive-desktop.png'), fullPage: true });
    await page.locator('#viewport').screenshot({ path: path.join(outputDir, 'progressive-scene.png') });
    await page.locator('#spring-type').selectOption('air');
    await advance(8);
  });

  await check('CSV and settings download/import still work after the graph redesign', async () => {
    const csv = await download('#export-csv-btn', 'design-samples.csv');
    const rows = csv.text.trim().split(/\r?\n/);
    assert.ok(rows.length > 900);
    assert.match(rows[0], /time.*bodyY.*wheelY.*bodyAcceleration.*wheelAcceleration/);
    const json = await download('#export-config-btn', 'design-settings.json');
    const saved = JSON.parse(json.text).config;
    const original = await config();
    assert.equal(saved.springType, 'air');
    assert.equal(saved.speed, original.speed);
    await patch({ speed: 5 });
    await page.locator('#import-file').setInputFiles(json.target);
    await page.waitForFunction(value => window.suspensionLab.getConfig().speed === value, original.speed);
    assert.equal((await config()).springType, 'air');
    await advance(8);
  });

  await check('720px and mobile layouts retain large charts without horizontal overflow', async () => {
    for (const [name, width, height] of [['narrow', 720, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(200);
      await chartDimensions(width === 390 ? 240 : 280);
      const dims = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(dims.scroll <= dims.width + 1, `${name} horizontal overflow ${dims.scroll - dims.width}px`);
      await cleanCaptureLayout();
      await workspaceView('bench');
      await page.screenshot({ path: path.join(outputDir, `${name}-full.png`), fullPage: true });
      await page.locator('#viewport').screenshot({ path: path.join(outputDir, `${name}-scene.png`) });
      await workspaceView('analysis');
      await page.locator('.charts-grid').screenshot({ path: path.join(outputDir, `${name}-charts.png`), style: '.workspace-nav { visibility: hidden !important; }' });
    }
  });

  await check('refined design has no browser runtime or console errors', async () => {
    assert.deepEqual(errors, []);
  });
  await fs.rm(path.join(outputDir, 'failure.png'), { force: true });
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ status: 'passed', baseURL, entryScripts, checks, errors, sceneEvidence }, null, 2));
  console.log(`Verified ${checks.length} design checks. Artifacts: ${outputDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ status: 'failed', baseURL, entryScripts, checks, errors, sceneEvidence, failure: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
