import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = process.env.SUSPENSION_TEST_OUTPUT_SUFFIX || '';
if (suffix && !/^[a-z0-9-]+$/.test(suffix)) throw new Error('Invalid test output suffix');
const outputDir = path.join(root, 'output', 'browser' + (suffix ? '-' + suffix : ''));
const baseURL = process.env.SUSPENSION_TEST_URL || 'http://127.0.0.1:5173';
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
const checks = [];
let entryScripts = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

async function check(name, fn) {
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
}
const config = () => page.evaluate(() => window.suspensionLab.getConfig());
const snapshot = () => page.evaluate(() => window.suspensionLab.snapshot());
const pause = () => page.evaluate(() => window.suspensionLab.setRunning(false));
const advance = seconds => page.evaluate(value => window.suspensionLab.advance(value), seconds);
const reset = () => page.evaluate(() => window.suspensionLab.reset());
const patch = value => page.evaluate(p => window.suspensionLab.setConfig(p), value);
const configKey = (value, pattern) => {
  const key = Object.keys(value).find(k => pattern.test(k));
  assert.ok(key, `Configuration key matching ${pattern} exists`);
  return key;
};
const time = value => {
  assert.equal(typeof value.time, 'number', 'snapshot.time is numeric');
  return value.time;
};
function assertFinite(value, location = 'snapshot') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${location} must be finite`);
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertFinite(entry, `${location}.${key}`);
  }
}
async function setRange(key, value) {
  const input = page.locator(`[data-config="${key}"]`);
  await input.evaluate((element, next) => {
    element.value = String(next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  const expected = await input.inputValue();
  const current = await config();
  assert.equal(Number(current[key]), Number(expected), `Slider ${key} applies its actual value`);
}
async function choose(id, key, values) {
  const options = await page.locator(id).locator('option').evaluateAll(items => items.map(item => item.value));
  assert.ok(options.length >= values, `${id} offers at least ${values} choices`);
  for (const value of options) {
    await page.locator(id).selectOption(value);
    assert.equal((await config())[key], value, `${id} updates configuration`);
    await advance(0.25);
    assertFinite(await snapshot());
  }
  return options;
}
async function download(button, name) {
  await page.evaluate(() => window.suspensionLab.setWorkspaceView?.('analysis'));
  const pending = page.waitForEvent('download');
  await page.locator(button).click();
  const artifact = await pending;
  const target = path.join(outputDir, name);
  await artifact.saveAs(target);
  assert.equal(await artifact.failure(), null);
  return { target, text: await fs.readFile(target, 'utf8') };
}

try {
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  entryScripts = await page.locator('script[type="module"][src]').evaluateAll(elements => elements.map(element => element.src));
  await page.waitForFunction(() => window.suspensionLab && window.render_game_to_text && window.advanceTime);
  await pause();
  let initial = await config();
  const roadKey = configKey(initial, /^road(Type)?$/i);
  const springKey = configKey(initial, /^springType$/i);
  const holderKey = configKey(initial, /^holderMode$/i);
  const speedKey = configKey(initial, /^speed$/i);
  const dampingKey = configKey(initial, /(compression.*damp|damp.*compression|compressionDamping)/i);

  await check('3D canvas renders and API returns finite state', async () => {
    const canvas = page.locator('#viewport canvas, #scene canvas, canvas').first();
    await canvas.waitFor({ state: 'visible' });
    const bounds = await canvas.boundingBox();
    assert.ok(bounds.width > 400 && bounds.height > 250);
    const pixels = await canvas.screenshot();
    assert.ok(pixels.byteLength > 6000, 'Rendered scene has nontrivial image content');
    assertFinite(await snapshot());
    const text = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    assert.ok(text && typeof text === 'object');
  });

  await check('flat road reset starts and stays at static equilibrium', async () => {
    await patch({ [roadKey]: 'flat' });
    await page.locator('#reset-btn').click();
    const before = await snapshot();
    await advance(2);
    const after = await snapshot();
    assert.ok(Math.abs(after.travel) < 1e-5, 'Static equilibrium travel stays zero');
    assert.ok(Math.abs(after.bodyY) < 1e-5 && Math.abs(after.wheelY) < 1e-5);
    assert.ok(time(after) > time(before));
  });

  await check('play advances and pause freezes simulation time', async () => {
    await pause();
    // Exercise the real button handlers in one event task. A slow software
    // renderer may intentionally pause between separate wall-clock clicks.
    const transition = await page.evaluate(() => {
      const button = document.querySelector('#run-btn');
      const before = window.suspensionLab.snapshot().time;
      button.click();
      const playing = button.getAttribute('aria-pressed');
      window.advanceTime(300);
      const running = window.suspensionLab.snapshot().time;
      button.click();
      const stopped = button.getAttribute('aria-pressed');
      const paused = window.suspensionLab.snapshot().time;
      window.advanceTime(200);
      return { before, playing, running, stopped, paused, after: window.suspensionLab.snapshot().time };
    });
    assert.equal(transition.playing, 'true');
    assert.ok(transition.running > transition.before, 'Play button advances physical time');
    assert.equal(transition.stopped, 'false');
    assert.equal(transition.after, transition.paused);
    const paused = transition.paused;
    await page.waitForTimeout(200);
    assert.equal(time(await snapshot()), paused);
  });

  await check('all six road presets apply and generate finite responses', async () => {
    await page.locator('#tab-road').click();
    for (const road of ['bump', 'step', 'pothole', 'washboard', 'flat', 'mixed']) {
      await page.locator(`[data-road="${road}"]`).click();
      assert.equal((await config())[roadKey], road);
      await reset();
      await advance(2);
      assertFinite(await snapshot());
    }
  });

  let holderOptions;
  await check('structure, spring and holder selectors update actual model', async () => {
    await page.locator('#tab-setup').click();
    await choose('#structure', 'structure', 3);
    const springOptions = await choose('#spring-type', springKey, 3);
    assert.ok(springOptions.includes('air'));
    await page.locator('#spring-type').selectOption('air');
    await page.locator('#air-controls').waitFor({ state: 'visible' });
    const coil = springOptions.find(value => value !== 'air');
    await page.locator('#spring-type').selectOption(coil);
    assert.equal(await page.locator('#air-controls').isVisible(), false);
    holderOptions = await choose('#holder-mode', holderKey, 2);
  });

  await check('damping and belt speed sliders update physics settings', async () => {
    await page.locator('#tab-setup').click();
    const dampingInput = page.locator(`[data-config="${dampingKey}"]`);
    const dmin = Number(await dampingInput.getAttribute('min'));
    const dmax = Number(await dampingInput.getAttribute('max'));
    await setRange(dampingKey, dmin + (dmax - dmin) * 0.7);
    await page.locator('#tab-road').click();
    const speedInput = page.locator(`[data-config="${speedKey}"]`);
    const smin = Number(await speedInput.getAttribute('min'));
    const smax = Number(await speedInput.getAttribute('max'));
    await setRange(speedKey, smin + (smax - smin) * 0.35);
    await setRange(speedKey, 0);
    await advance(1);
    assert.equal((await snapshot()).distance, 0, 'Zero belt speed keeps road distance stationary');
    assert.ok(time(await snapshot()) > 0.9, 'Zero belt speed still integrates suspension time');
  });

  await check('fixed holder and sprung body produce different vertical responses', async () => {
    const fixed = holderOptions.find(value => /fixed/i.test(value));
    const sprung = holderOptions.find(value => /sprung|body|floating/i.test(value));
    assert.ok(fixed && sprung, 'Both fixed and sprung holder modes exist');
    await patch({ [roadKey]: 'bump', [speedKey]: 6, [holderKey]: fixed });
    await reset();
    await advance(4);
    const fixedState = await snapshot();
    assert.equal(fixedState.bodyY, 0);
    assert.equal(fixedState.bodyAcceleration, 0);
    assert.match(await page.locator('#acceleration-label').innerText(), /휠/);
    await patch({ [holderKey]: sprung });
    await reset();
    await advance(4);
    const samples = await page.evaluate(() => window.suspensionLab.history());
    assert.ok(samples.some(value => Math.abs(value.bodyAcceleration) > 0.01), 'Sprung body responds to the road');
    assert.match(await page.locator('#acceleration-label').innerText(), /차체/);
    for (const id of ['travel-value', 'acceleration-value', 'contact-value', 'camber-value']) {
      assert.ok(Number.isFinite(Number((await page.locator(`#${id}`).innerText()).replaceAll(',', ''))), `${id} displays a finite metric`);
    }
  });

  await check('automatic geometry ratio and manual override apply to dynamics', async () => {
    await page.locator('#tab-setup').click();
    const details = page.locator('details').filter({ has: page.locator('#auto-motion-ratio') });
    await details.evaluate(element => { element.open = true; });
    await page.locator('#auto-motion-ratio').check();
    const ratios = [];
    for (const structure of ['wishbone', 'multilink', 'macpherson']) {
      await page.locator('#structure').selectOption(structure);
      const state = await snapshot();
      assert.ok(Number.isFinite(state.effectiveMotionRatio));
      ratios.push(state.effectiveMotionRatio);
    }
    assert.ok(Math.max(...ratios) - Math.min(...ratios) > 0.01, 'Different representative structures have different static leverage');
    await page.locator('#auto-motion-ratio').uncheck();
    await setRange('motionRatio', 0.72);
    assert.equal((await config()).autoMotionRatio, false);
    assert.ok(Math.abs((await snapshot()).effectiveMotionRatio - 0.72) < 1e-8);
    await page.locator('#auto-motion-ratio').check();
    assert.equal((await config()).autoMotionRatio, true);
  });

  await check('display switches, camera presets and keyboard shortcuts work', async () => {
    for (const id of ['show-links', 'show-forces', 'show-labels']) {
      const control = page.locator(`#${id}`);
      const wasChecked = await control.isChecked();
      await control.setChecked(!wasChecked);
      assert.equal(await control.isChecked(), !wasChecked);
      await control.setChecked(wasChecked);
    }
    for (const camera of ['iso', 'side', 'front']) {
      await page.locator(`[data-camera="${camera}"]`).click();
      assert.equal(await page.locator(`[data-camera="${camera}"]`).getAttribute('aria-pressed'), 'true');
    }
    const normalSpeed = time(await snapshot());
    await page.locator('#time-scale').selectOption('0.25');
    await page.locator('#time-scale').selectOption('1');
    assert.equal(await page.locator('#time-scale').inputValue(), '1');
    assert.equal(time(await snapshot()), normalSpeed, 'Changing replay scale while paused preserves simulation time');
    await page.locator('[data-camera="iso"]').click();
    await page.locator('canvas').first().click({ position: { x: 12, y: 12 } });
    await pause();
    // Keep both shortcut transitions in one event task, as for the play button
    // above. Slow rendering can intentionally auto-pause between wall-clock
    // key presses; a second Space would then resume instead of testing pause.
    const shortcut = await page.evaluate(() => {
      const pressSpace = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
      const button = document.querySelector('#run-btn');
      const before = window.suspensionLab.snapshot().time;
      pressSpace();
      const playing = button.getAttribute('aria-pressed');
      window.advanceTime(200);
      const advanced = window.suspensionLab.snapshot().time;
      pressSpace();
      const paused = button.getAttribute('aria-pressed');
      const stopped = window.suspensionLab.snapshot().time;
      window.advanceTime(100);
      return { before, playing, advanced, paused, stopped, after: window.suspensionLab.snapshot().time };
    });
    assert.equal(shortcut.playing, 'true', 'Space starts replay through the actual key handler');
    assert.ok(shortcut.advanced > shortcut.before);
    assert.equal(shortcut.paused, 'false', 'Space pauses replay through the actual key handler');
    assert.equal(shortcut.after, shortcut.stopped, 'Paused keyboard state ignores deterministic time advancement');
    const stopped = shortcut.stopped;
    await page.waitForTimeout(100);
    assert.equal(time(await snapshot()), stopped);
    await page.keyboard.press('r');
    assert.ok(time(await snapshot()) < 0.1);
    await page.keyboard.press('f');
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), true, 'F opens fullscreen viewport');
    await page.keyboard.press('f');
    await page.waitForFunction(() => !document.fullscreenElement);
    assertFinite(await snapshot());
  });

  await check('A/B comparison captures separate experiment results', async () => {
    await page.evaluate(() => window.suspensionLab.setWorkspaceView?.('analysis'));
    await patch({ [roadKey]: 'bump', [speedKey]: 8, [dampingKey]: 500 });
    await reset();
    await advance(5);
    await page.locator('#save-a-btn').click();
    await patch({ [dampingKey]: 4000 });
    await reset();
    await advance(5);
    await page.locator('#save-b-btn').click();
    const result = await page.locator('#compare-summary').innerText();
    assert.ok(result.length > 30 && /A/.test(result) && /B/.test(result), 'Comparison includes A and B results');
    assert.ok(/\d/.test(result), 'Comparison contains numeric metrics');
    assert.ok(!/저장한 후|저장하세요|아직/.test(result), 'Comparison placeholder is replaced');
    const { A, B } = await page.evaluate(() => window.suspensionLab.getComparisons());
    assert.equal(A.config[dampingKey], 500);
    assert.equal(B.config[dampingKey], 4000);
    assert.ok(Math.abs(A.metrics.duration - 6) < 1e-6 && Math.abs(B.metrics.duration - 6) < 1e-6, 'Both captured trials cover 6 seconds');
    const metric = A.config[holderKey] === 'fixed' ? 'rmsWheelAcceleration' : 'rmsBodyAcceleration';
    assert.ok(Math.abs(A.metrics[metric] - B.metrics[metric]) > 1e-5, 'Distinct damper settings produce distinct captured responses');
  });

  await check('CSV and JSON exports contain data and config import restores settings', async () => {
    const csv = await download('#export-csv-btn', 'samples.csv');
    const rows = csv.text.trim().split(/\r?\n/);
    assert.ok(rows.length > 10);
    assert.ok(/time/i.test(rows[0]) && /travel/i.test(rows[0]));
    const width = rows[0].split(',').length;
    assert.ok(width >= 5);
    for (const row of rows.slice(1, 10)) assert.equal(row.split(',').length, width);
    const exported = await download('#export-config-btn', 'settings.json');
    const parsed = JSON.parse(exported.text);
    const payload = parsed.config ?? parsed.configuration ?? parsed;
    const original = await config();
    assert.equal(payload[speedKey], original[speedKey]);
    assert.equal(payload[dampingKey], original[dampingKey]);
    await patch({ [speedKey]: 1 });
    await page.locator('#import-file').setInputFiles(exported.target);
    await page.waitForFunction(({ key, expected }) => window.suspensionLab.getConfig()[key] === expected,
      { key: speedKey, expected: original[speedKey] });
    assert.equal((await config())[dampingKey], original[dampingKey]);
  });

  await check('single obstacle trial starts and stops automatically', async () => {
    // Run real RAF callbacks with controlled timestamps. A slow renderer must
    // not turn the frame-delay safety pause into a false obstacle completion.
    const trialContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    const trial = await trialContext.newPage();
    trial.on('pageerror', error => errors.push(error.message));
    trial.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await trial.clock.install();
      await trial.goto(baseURL, { waitUntil: 'networkidle' });
      await trial.waitForFunction(() => window.suspensionLab?.productReady && window.render_game_to_text);
      await trial.evaluate(async settings => {
        const app = window.suspensionLab;
        await app.productReady;
        app.setRunning(false);
        app.setConfig(settings);
        app.setWorkspaceView('bench');
      }, { ...(await config()), [roadKey]: 'bump', [speedKey]: 100, timeScale: 1 });
      await trial.clock.pauseAt(await trial.evaluate(() => Date.now() + 60_000));
      await trial.locator('#single-event-btn').click({ force: true });
      assert.equal(await trial.locator('#run-btn').getAttribute('aria-pressed'), 'true');
      await trial.clock.runFor(1000);
      const completed = await trial.evaluate(() => ({
        ...JSON.parse(window.render_game_to_text()),
        toast: document.querySelector('#toast').textContent,
      }));
      assert.equal(completed.config.singleEvent, true);
      assert.ok(completed.state.distance >= completed.config.roadSpacing + completed.config.roadWidth,
        'Automatic stop happens after the whole obstacle has passed');
      assert.equal(completed.mode, 'paused');
      assert.match(completed.toast, /장애물 1회 통과 시험을 완료/);
      assertFinite(completed.state);
      await fs.writeFile(path.join(outputDir, 'single-event-clock.json'), JSON.stringify({ virtualMilliseconds: 1000, completed }, null, 2));
    } finally { await trialContext.close(); }
  });

  await check('stress settings stay finite across all roads and spring types', async () => {
    await page.evaluate(() => window.suspensionLab.setWorkspaceView('bench'));
    await page.locator('#tab-setup').click();
    const rangeLimits = await page.locator('[data-config]').evaluateAll(elements =>
      Object.fromEntries(elements.filter(element => element.type === 'range').map(element =>
        [element.dataset.config, { min: Number(element.min), max: Number(element.max) }])));
    const stress = {};
    for (const [key, range] of Object.entries(rangeLimits)) {
      if (/mass/i.test(key)) stress[key] = range.min;
      else if (/rate|damp|speed|height|pressure/i.test(key)) stress[key] = range.max;
    }
    for (const road of ['bump', 'step', 'pothole', 'washboard', 'mixed']) {
      for (const spring of ['coil', 'progressive', 'air']) {
        await patch({ ...stress, [roadKey]: road, [springKey]: spring, singleEvent: false });
        await reset();
        for (let interval = 0; interval < 6; interval++) {
          await advance(0.5);
          assertFinite(await snapshot());
        }
      }
    }
  });

  await patch(initial);
  await reset();
  await pause();
  await check('help dialog opens, has accessible name, and closes', async () => {
    await page.locator('#help-btn').click();
    const dialog = page.locator('#help-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.ok(await dialog.getAttribute('aria-label') || await dialog.getAttribute('aria-labelledby'), 'Help has an accessible name');
    await page.locator('#close-help-btn').click();
    assert.equal(await dialog.isVisible(), false);
  });
  await page.locator('#tab-setup').click();
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(element => { element.open = false; });
    document.querySelector('.control-scroll').scrollTop = 0;
    scrollTo(0, 0);
  });
  await page.screenshot({ path: path.join(outputDir, 'desktop.png'), fullPage: true });

  await check('mobile layout has visible canvas and no horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width + 1, `Mobile overflow ${dimensions.scroll - dimensions.width}px`);
    const canvas = await page.locator('canvas').first().boundingBox();
    assert.ok(canvas && canvas.width >= 300 && canvas.height >= 200);
    await page.locator('#run-btn').click();
    await page.waitForTimeout(100);
    await page.locator('#run-btn').click();
    await page.evaluate(() => { document.querySelector('.control-scroll').scrollTop = 0; scrollTo(0, 0); });
    await page.screenshot({ path: path.join(outputDir, 'mobile.png'), fullPage: true });
  });

  await check('no browser runtime or console errors', async () => {
    assert.deepEqual(errors, []);
  });
  await fs.rm(path.join(outputDir, 'failure.png'), { force: true });
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ status: 'passed', baseURL, entryScripts, checks, errors }, null, 2));
  console.log(`Verified ${checks.length} browser checks. Artifacts: ${outputDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify({ status: 'failed', baseURL, entryScripts, checks, errors, failure: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
