import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const output = path.join(root, 'output', `${process.env.SUSPENSION_DESKTOP_EXE?'desktop-packaged':'desktop'}-v${expectedVersion}`);
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(output, 'profile-'));
const executablePath = process.env.SUSPENSION_DESKTOP_EXE || require('electron');
const packaged = !!process.env.SUSPENSION_DESKTOP_EXE;
const env = { ...process.env, SUSPENSION_LAB_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const checks = [], errors = [], remoteRequests = [];
const CHECK_TIMEOUT = 120000, OPERATION_TIMEOUT = 45000, CLOSE_TIMEOUT = 10000;
const startedAt = new Date().toISOString(), runId = path.basename(profile);
const reportPath = path.join(output, packaged ? 'installed-report.json' : 'report.json');
const progressPath = path.join(output, 'progress.jsonl');
const processLogPath = path.join(output, `desktop-${runId}.log`);
const processRecords = [], checkResults = [], cleanupErrors = [], diagnosticErrors = [];
const expectedProbeErrors = [], expectedProbeRequests = [];
const runFile = promisify(execFile);
let currentCheck = 'launch', lastOperation = 'initialization', primaryError = null;
let suiteAborted = false, expectedProbeActive = false, processTail = '';
function errorRecord(error) { return { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || String(error) }; }
async function progress(event, details = {}) {
  const entry = { runId, time: new Date().toISOString(), event, check: currentCheck, operation: lastOperation, ...details };
  console.log(`${event} ${currentCheck}${details.message ? `: ${details.message}` : ''}`);
  await fs.appendFile(progressPath, JSON.stringify(entry) + '\n');
}
async function bounded(label, action, timeout = OPERATION_TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout} ms`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function operation(label, action, timeout = OPERATION_TIMEOUT) {
  lastOperation = label;
  return bounded(label, action, timeout);
}
async function poll(label, read, accepted, timeout = OPERATION_TIMEOUT) {
  lastOperation = label;
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await bounded(label, read, Math.min(5000, Math.max(1, deadline - Date.now())));
    if (accepted(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label} exceeded ${timeout} ms; last value: ${JSON.stringify(value)}`);
}
async function writeReport(status) {
  const report = { status, runId, startedAt, updatedAt: new Date().toISOString(), executablePath, packaged, profile, checks, checkResults, errors, remoteRequests, expectedProbeErrors, expectedProbeRequests, version: expectedVersion, ciSha: process.env.GITHUB_SHA || null, failedCheck: primaryError?.check || null, lastOperation, primaryError, cleanupErrors, diagnosticErrors, processRecords, processTail, progressPath, processLogPath };
  const text = JSON.stringify(report, null, 2) + '\n';
  await fs.writeFile(reportPath, text);
  await fs.writeFile(path.join(profile, 'run-report.json'), text);
  if (status === 'FAILED') await fs.writeFile(path.join(output, 'failure.json'), text);
}
async function rememberFailure(error) {
  if (!primaryError) primaryError = { ...errorRecord(error), check: currentCheck, operation: lastOperation, time: new Date().toISOString() };
  // Write the original failure before attempting any potentially blocked diagnostics or close.
  await writeReport('FAILED').catch(writeError => { diagnosticErrors.push(errorRecord(writeError)); console.error(`Failure report: ${writeError.stack}`); });
}
async function check(name, action) {
  currentCheck = name;
  lastOperation = 'check body';
  const start = Date.now();
  await progress('START');
  try {
    await bounded(name, action, CHECK_TIMEOUT);
    if (suiteAborted) throw new Error('Desktop suite already exceeded its deadline');
    checks.push(name); checkResults.push({ name, status: 'PASSED', elapsedMs: Date.now() - start });
    await progress('PASS', { elapsedMs: Date.now() - start });
  } catch (error) {
    checkResults.push({ name, status: 'FAILED', elapsedMs: Date.now() - start, error: errorRecord(error), operation: lastOperation });
    await rememberFailure(error);
    await progress('FAIL', { elapsedMs: Date.now() - start, message: error.message });
    throw error;
  }
}
async function launch() {
  await progress('LAUNCH');
  app = await operation('Electron launch', () => electron.launch({ executablePath, args: packaged ? [] : [root], env, timeout: OPERATION_TIMEOUT }));
  const child = app.process();
  const processRecord = { pid: child.pid, startedAt: new Date().toISOString(), exited: false, exitCode: null, signal: null };
  processRecords.push(processRecord);
  child.once('exit', (exitCode, signal) => { Object.assign(processRecord, { exited: true, exitCode, signal, exitedAt: new Date().toISOString() }); });
  for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream?.on('data', bytes => {
    const line = `[${child.pid} ${streamName}] ${bytes.toString()}`;
    processTail = (processTail + line).slice(-65536);
    void fs.appendFile(processLogPath, line).catch(error => diagnosticErrors.push(errorRecord(error)));
  });
  page = await operation('first window', () => app.firstWindow({ timeout: OPERATION_TIMEOUT }));
  app.context().setDefaultTimeout(30000);
  page.on('crash', () => { errors.push('Renderer crashed'); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    if (expectedProbeActive && (msg.text().includes('https://example.com/') || msg.location().url === 'https://example.com/')) expectedProbeErrors.push(msg.text());
    else errors.push(msg.text());
  });
  page.on('request', request => {
    if (!/^https?:/.test(request.url())) return;
    if (expectedProbeActive && request.url() === 'https://example.com/' && !expectedProbeRequests.length) expectedProbeRequests.push(request.url());
    else remoteRequests.push(request.url());
  });
  await operation('renderer API ready', () => page.waitForFunction(() => window.suspensionLab?.getProductState, {}, { timeout: OPERATION_TIMEOUT }));
  await operation('persistent product ready', () => page.evaluate(() => window.suspensionLab.productReady));
  await operation('initial pause', () => page.evaluate(() => window.suspensionLab.setRunning(false)));
}
const config = () => page.evaluate(() => window.suspensionLab.getConfig());
const records = () => page.evaluate(() => window.suspensionLab.getExperiments());
async function view(value) { await page.evaluate(v => window.suspensionLab.setWorkspaceView(v), value); }
async function idle() { await page.waitForFunction(() => !window.suspensionLab.getProductState().busy); }
async function saveDialog(filePath, canceled = false) {
  return app.evaluate(({ dialog }, payload) => { dialog.showSaveDialog = async (_window, options) => { globalThis.saveDialogCalls = (globalThis.saveDialogCalls || 0) + 1; globalThis.saveDialogOptions = options; return { canceled: payload.canceled, filePath: payload.filePath }; }; return globalThis.saveDialogCalls || 0; }, { filePath, canceled });
}
async function openDialog(filePath, canceled = false) {
  return app.evaluate(({ dialog }, payload) => { dialog.showOpenDialog = async (_window, options) => { globalThis.openDialogCalls = (globalThis.openDialogCalls || 0) + 1; globalThis.openDialogOptions = options; return { canceled: payload.canceled, filePaths: payload.canceled ? [] : [payload.filePath] }; }; return globalThis.openDialogCalls || 0; }, { filePath, canceled });
}
async function dialogCalled(kind, before) {
  const count = await poll(`${kind} native dialog call`, () => app.evaluate((_electron, key) => globalThis[key] || 0, `${kind}DialogCalls`), value => value >= before + 1);
  assert.equal(count, before + 1, `${kind} should invoke exactly one native dialog`);
}
async function freshToast(action, source) {
  await operation('clear previous toast', () => page.evaluate(() => { const toast = document.querySelector('#toast'); if (toast) { toast.textContent = ''; toast.hidden = true; } }));
  await action();
  await operation(`new toast: ${source}`, () => page.waitForFunction(pattern => { const toast = document.querySelector('#toast'); return toast && !toast.hidden && new RegExp(pattern).test(toast.textContent || ''); }, source));
  await idle();
}
async function projectWritten(filePath, expectedConfig, expectedRuns) {
  return poll(`project bytes written: ${path.basename(filePath)}`, async () => {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }, value => value && isDeepStrictEqual(value.config, expectedConfig) && isDeepStrictEqual(value.runs, expectedRuns));
}
async function normalClose(label = 'normal application close') {
  const closing = app, record = processRecords.at(-1);
  if (!closing) return;
  await operation(label, async () => {
    await closing.close();
    await poll('owned application process exited', () => record?.exited, Boolean, 3000);
  }, CLOSE_TIMEOUT);
  app = null; page = null;
}
async function forceOwnedProcesses() {
  for (const record of processRecords.filter(value => !value.exited)) {
    assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0 && record.pid !== process.pid, 'Only a captured child PID may be terminated');
    if (process.platform === 'win32') await bounded(`terminate owned PID tree ${record.pid}`, () => runFile('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }), 6000);
    else process.kill(record.pid, 'SIGKILL');
    record.forcedTermination = true;
  }
}
async function failureDiagnostics() {
  if (page && !page.isClosed()) {
    for (const [label, action] of [
      ['failure screenshot', () => page.screenshot({ path: path.join(output, 'failure.png'), timeout: 2000 })],
      ['failure renderer state', async () => { const state = await page.evaluate(() => ({ url: location.href, toast: document.querySelector('#toast')?.textContent, product: window.suspensionLab?.getProductState?.() })); const text = JSON.stringify({ runId, ...state }, null, 2); await fs.writeFile(path.join(profile, 'failure-state.json'), text); await fs.writeFile(path.join(output, 'failure-state.json'), text); }],
    ]) await bounded(label, action, 3000).catch(error => diagnosticErrors.push(errorRecord(error)));
  }
  await fs.copyFile(path.join(profile, 'desktop.log'), path.join(output, `desktop-${runId}-native.log`)).catch(error => { if (error.code !== 'ENOENT') diagnosticErrors.push(errorRecord(error)); });
}
async function exportedFile(selector, name) {
  const target = path.join(output, name);
  await fs.unlink(target).catch(() => {});
  await app.evaluate(({ session }, filePath) => {
    globalThis.lastNativeDownload = null;
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(filePath);
      item.once('done', (_doneEvent, state) => { globalThis.lastNativeDownload = { state, filePath }; });
    });
  }, target);
  await page.locator(selector).click();
  const result = await poll(`native download completed: ${name}`, () => app.evaluate(() => globalThis.lastNativeDownload), Boolean);
  assert.equal(result.state, 'completed');
  return fs.readFile(target);
}
let savedConfig, savedRuns;
const projectPath = path.join(output, '시험 프로젝트.suspension.json');
async function runChecks() {
  await launch();
  await check('bundled first launch renders 3D offline with isolated native API and persistent storage', async () => {
    assert.equal(page.url().split('#')[0], 'app://suspension/');
    const values = await page.evaluate(async () => ({ desktop: window.suspensionDesktop.isDesktop, node: typeof window.require, storage: window.suspensionLab.getProductState(), offline: await window.suspensionLab.offlineReady, canvas: !!document.querySelector('#viewport canvas'), workers: 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistrations().then(items => items.length).catch(() => 0) : 0 }));
    assert.equal(values.desktop, true); assert.equal(values.node, 'undefined'); assert.equal(values.storage.ready, true); assert.equal(values.canvas, true); assert.equal(values.workers, 0);
    assert.match(await page.locator('#project-save-status').textContent(), /이 앱에 자동 저장됨/);
    assert.equal(await page.locator('#install-app-btn').isVisible(), false);
    expectedProbeActive = true;
    try { assert.equal(await operation('intentional denied network probe', () => page.evaluate(() => fetch('https://example.com/').then(() => false).catch(() => true))), true); }
    finally { expectedProbeActive = false; }
  });
  await check('physics and live play/pause work inside the packaged window', async () => {
    await page.evaluate(() => { window.suspensionLab.setConfig({ road: 'flat', holderMode: 'sprung' }); window.suspensionLab.reset(); window.suspensionLab.advance(2); });
    const state = await page.evaluate(() => window.suspensionLab.snapshot());
    for (const key of ['travel', 'bodyY', 'wheelY']) assert.ok(Math.abs(state[key]) < 1e-5);
    const transition = await page.evaluate(() => {
      const app = window.suspensionLab, button = document.querySelector('#run-btn');
      app.setRunning(false);
      const before = app.snapshot().time;
      button.click();
      const playing = button.getAttribute('aria-pressed');
      window.advanceTime(300);
      const running = app.snapshot().time;
      button.click();
      const stopped = button.getAttribute('aria-pressed');
      const paused = app.snapshot().time;
      window.advanceTime(200);
      return { before, playing, running, stopped, paused, after: app.snapshot().time, timeScale: app.getConfig().timeScale };
    });
    assert.equal(transition.playing, 'true');
    assert.ok(Math.abs(transition.running-transition.before-.3*transition.timeScale)<.009, 'Actual play handler advances physical time at the selected replay scale');
    assert.equal(transition.stopped, 'false');
    assert.equal(transition.after, transition.paused);
    const time = transition.paused;
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.suspensionLab.snapshot().time), time);
    await page.evaluate(() => window.suspensionLab.setConfig({ road: 'bump', speed: 45, compressionDamping: 2300 }));
  });
  await check('native menus select every workspace and show help', async () => {
    for (const value of ['bench', 'analysis', 'experiments', 'validation']) {
      await app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('suspension:command', command), 'view-' + value);
      await page.waitForFunction(v => window.suspensionLab.getWorkspaceView() === v, value);
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('suspension:command', 'help'));
    await page.waitForFunction(() => document.querySelector('#help-dialog').open);
    await page.locator('#close-help-btn').click();
  });
  await check('standard test stores full numeric response in IndexedDB', async () => {
    await page.locator('#project-name').fill('Windows 설치본 검증');
    await page.locator('#vehicle-name').fill('단일 휠 테스트');
    await view('experiments');
    await page.locator('#experiment-name').fill('설치 앱 2초 시험');
    await page.locator('#experiment-duration').fill('2');
    await page.locator('#record-experiment-btn').click();
    await idle();
    savedConfig = await config(); savedRuns = await records();
    assert.equal(savedRuns.length, 1); assert.ok(savedRuns[0].history.length >= 240);
    assert.ok(Math.abs(savedRuns[0].history.at(-1).time - 2) < 1e-8);
    for (const row of savedRuns[0].history) for (const value of Object.values(row)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
  });
  await check('native save writes valid project and safely replaces an existing file', async () => {
    const before = await saveDialog(projectPath);
    await freshToast(() => page.locator('#save-project-btn').click(), '설정과 모든 보관 기록');
    await dialogCalled('save', before);
    const file = await projectWritten(projectPath, savedConfig, savedRuns);
    assert.deepEqual(file.config, savedConfig); assert.equal(file.runs[0].id, savedRuns[0].id);
    await fs.writeFile(projectPath, 'old file');
    await freshToast(() => page.locator('#save-project-btn').click(), '설정과 모든 보관 기록');
    await dialogCalled('save', before + 1);
    assert.equal((await projectWritten(projectPath, savedConfig, savedRuns)).runs.length, 1);
  });
  await check('save and open cancellation preserve the project', async () => {
    const canceledPath = path.join(profile, 'canceled.json');
    const saveBefore = await saveDialog(canceledPath, true);
    await page.locator('#save-project-btn').click();
    await dialogCalled('save', saveBefore); await idle();
    await assert.rejects(fs.access(canceledPath), { code: 'ENOENT' });
    const openBefore = await openDialog(projectPath, true);
    await page.locator('#open-project-btn').click();
    await dialogCalled('open', openBefore); await idle();
    assert.deepEqual(await config(), savedConfig); assert.deepEqual(await records(), savedRuns);
  });
  await check('Ctrl+S and Ctrl+O trigger exactly one native dialog each', async () => {
    await saveDialog(projectPath);
    await app.evaluate(() => { globalThis.saveDialogCalls = 0; globalThis.openDialogCalls = 0; });
    await fs.writeFile(projectPath, 'previous file before Ctrl+S');
    await freshToast(() => page.keyboard.press('Control+s'), '설정과 모든 보관 기록');
    await dialogCalled('save', 0);
    assert.equal(await app.evaluate(() => globalThis.saveDialogCalls), 1);
    assert.equal((await projectWritten(projectPath, savedConfig, savedRuns)).runs.length, 1);
    await openDialog(projectPath);
    await freshToast(() => page.keyboard.press('Control+o'), '프로젝트의 설정과 기록을 복원');
    await dialogCalled('open', 0);
    assert.equal(await app.evaluate(() => globalThis.openDialogCalls), 1);
    assert.deepEqual(await config(), savedConfig); assert.deepEqual(await records(), savedRuns);
  });
  await check('native open restores config and records and rejects corrupt projects atomically', async () => {
    const before = await openDialog(projectPath);
    await page.evaluate(() => window.suspensionLab.setConfig({ speed: 80 }));
    assert.equal((await config()).speed, 80);
    await freshToast(() => page.locator('#open-project-btn').click(), '프로젝트의 설정과 기록을 복원');
    await dialogCalled('open', before);
    assert.deepEqual(await config(), savedConfig); assert.deepEqual(await records(), savedRuns);
    const bad = JSON.parse(await fs.readFile(projectPath, 'utf8')); bad.runs[0].history.at(-1).contactForce = -1;
    const badPath = path.join(output, 'corrupt.json'); await fs.writeFile(badPath, JSON.stringify(bad));
    const badBefore = await openDialog(badPath);
    await freshToast(() => page.locator('#open-project-btn').click(), '프로젝트 열기 실패');
    await dialogCalled('open', badBefore);
    assert.deepEqual(await config(), savedConfig); assert.deepEqual(await records(), savedRuns);
  });
  await check('native export creates CSV, report, PNG and GLB files', async () => {
    await view('experiments');
    const csv = await exportedFile('[data-record-action="export"]', 'response.csv'); assert.match(csv.toString('utf8'), /time/);
    const report = await exportedFile('#experiment-report-btn', 'report.html'); assert.match(report.toString('utf8'), /<!doctype html>/i);
    await view('bench');
    const png = await exportedFile('#capture-view-btn', 'viewport.png'); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const glb = await exportedFile('#export-model-btn', 'rig.glb'); assert.equal(glb.readUInt32LE(0), 0x46546c67); assert.equal(glb.readUInt32LE(8), glb.length);
    // Restore dialog queue to its canceled path for subsequent test actions.
  });
  await check('canceled PNG export reports cancellation without a false success', async () => {
    await app.evaluate(({ session }) => { session.defaultSession.once('will-download', (_event, item) => item.cancel()); });
    await freshToast(() => page.locator('#capture-view-btn').click(), '파일 저장을 취소');
  });
  await check('window close is canceled during an actual project restore', async () => {
    await app.evaluate(({ dialog }) => { globalThis.originalMessageBox = dialog.showMessageBox; globalThis.closePromptCalls = 0; dialog.showMessageBox = async () => { globalThis.closePromptCalls++; return { response: 0 }; }; });
    await openDialog(projectPath);
    await page.evaluate(() => {
      const original = Blob.prototype.text;
      let release;
      const held = new Promise(resolve => { release = resolve; });
      const gate = window.restoreReadGate = { entered: false, release, original };
      Blob.prototype.text = async function () { gate.entered = true; await held; return original.call(this); };
      const toast = document.querySelector('#toast'); if (toast) { toast.textContent = ''; toast.hidden = true; }
    });
    let fixtureError;
    try {
      await page.locator('#open-project-btn').click();
      await page.waitForFunction(() => window.restoreReadGate.entered && window.suspensionLab.getProductState().busy);
      assert.deepEqual(await records(), savedRuns, 'The pending read must leave the original records intact');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await poll('busy-close prompt invoked', () => app.evaluate(() => globalThis.closePromptCalls), count => count > 0);
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      assert.equal(await app.evaluate(() => globalThis.closePromptCalls), 1);
      assert.equal(await page.evaluate(() => window.suspensionLab.getProductState().busy), true, 'Read remains held until the test explicitly releases it');
      await page.evaluate(() => window.restoreReadGate.release());
      await operation('released restore completion', () => page.waitForFunction(() => { const toast = document.querySelector('#toast'); return toast && !toast.hidden && /프로젝트의 설정과 기록을 복원/.test(toast.textContent || ''); }));
      await idle();
      assert.deepEqual(await records(), savedRuns);
    } catch (error) { fixtureError = error; await rememberFailure(error); }
    finally {
      for (const [label, action] of [
        ['restore Blob.text fixture', () => page.evaluate(() => { const gate = window.restoreReadGate; if (gate) { gate.release(); Blob.prototype.text = gate.original; delete window.restoreReadGate; } })],
        ['restore native message-box fixture', () => app.evaluate(({ dialog }) => { if (globalThis.originalMessageBox) { dialog.showMessageBox = globalThis.originalMessageBox; delete globalThis.originalMessageBox; } })],
      ]) try { await bounded(label, action, 2000); } catch (error) { if (!fixtureError) fixtureError = error; else diagnosticErrors.push(errorRecord(error)); }
    }
    if (fixtureError) throw fixtureError;
  });
  await check('complete quit and relaunch preserve settings, names and full experiment history', async () => {
    await view('bench'); await page.screenshot({ path: path.join(output, packaged ? 'installed-app.png' : 'desktop-app.png') });
    await normalClose('normal close before persistence relaunch');
    await launch();
    assert.deepEqual(await config(), savedConfig); assert.deepEqual(await records(), savedRuns);
    assert.equal((await page.evaluate(() => window.suspensionLab.getProductState())).projectName, 'Windows 설치본 검증');
    assert.equal(await page.locator('#vehicle-name').inputValue(), '단일 휠 테스트');
  });
  await check('guided A/B experiment preserves working conditions and survives native save and relaunch', async () => {
    const beforeConfig=await config(),beforeRecords=await records();
    await view('bench');await page.locator('#run-consumer-guide-btn').click();await idle();
    assert.deepEqual(await config(),beforeConfig);
    const complete=await records();assert.equal(complete.length,beforeRecords.length+2);
    for(const record of beforeRecords)assert.deepEqual(complete.find(value=>value.id===record.id),record);
    const selected=await page.evaluate(()=>window.suspensionLab.getProductState().selected);
    const pair=selected.map(id=>complete.find(record=>record.id===id));
    assert.deepEqual(pair.map(record=>record.config.reboundDamping),[900,4200]);
    assert.equal(await page.locator('#consumer-guide-results').isVisible(),true);
    const guidePath=path.join(output,'첫 비교 실험.suspension.json'),before=await saveDialog(guidePath);
    await freshToast(() => page.locator('[data-guide-action="save"]').click(), '설정과 모든 보관 기록');
    await dialogCalled('save', before);
    const exported=await projectWritten(guidePath,beforeConfig,complete);assert.deepEqual(exported.config,beforeConfig);assert.deepEqual(exported.runs,complete);
    await normalClose('normal close before guided experiment relaunch');await launch();
    assert.deepEqual(await config(),beforeConfig);assert.deepEqual(await records(),complete);
    await view('experiments');assert.equal(await page.locator('#consumer-guide-results').isVisible(),true);
  });
  await check('final application runs with no JavaScript errors or remote content', async () => { assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []); });
}
try {
  await writeReport('RUNNING');
  await bounded('complete desktop suite', runChecks, 8 * 60 * 1000);
} catch (error) {
  suiteAborted = true;
  await rememberFailure(error);
  console.error(`FAIL ${primaryError.check}: ${primaryError.stack}`);
  await failureDiagnostics();
} finally {
  if (app) {
    try { await normalClose('final graceful cleanup'); }
    catch (error) {
      cleanupErrors.push(errorRecord(error));
      await rememberFailure(error);
      await progress('CLEANUP_FAIL', { message: error.message });
      try { await forceOwnedProcesses(); } catch (killError) { cleanupErrors.push(errorRecord(killError)); console.error(`Owned process cleanup: ${killError.stack}`); }
    }
  }
  const failed = !!primaryError || cleanupErrors.length > 0;
  await writeReport(failed ? 'FAILED' : 'PASSED');
  if (failed) process.exitCode = 1;
  else console.log(`Verified ${checks.length} desktop checks.`);
}
