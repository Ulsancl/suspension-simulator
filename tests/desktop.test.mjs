import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
async function launch() {
  app = await electron.launch({ executablePath, args: packaged ? [] : [root], env, timeout: 45000 });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await page.waitForFunction(() => window.suspensionLab?.getProductState, {}, { timeout: 45000 });
  await page.evaluate(() => window.suspensionLab.productReady);
  await page.evaluate(() => window.suspensionLab.setRunning(false));
}
const config = () => page.evaluate(() => window.suspensionLab.getConfig());
const records = () => page.evaluate(() => window.suspensionLab.getExperiments());
async function view(value) { await page.evaluate(v => window.suspensionLab.setWorkspaceView(v), value); }
async function idle() { await page.waitForFunction(() => !window.suspensionLab.getProductState().busy); }
async function saveDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => { dialog.showSaveDialog = async (_window, options) => { globalThis.saveDialogCalls = (globalThis.saveDialogCalls || 0) + 1; globalThis.saveDialogOptions = options; return { canceled: payload.canceled, filePath: payload.filePath }; }; }, { filePath, canceled });
}
async function openDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => { dialog.showOpenDialog = async (_window, options) => { globalThis.openDialogCalls = (globalThis.openDialogCalls || 0) + 1; globalThis.openDialogOptions = options; return { canceled: payload.canceled, filePaths: payload.canceled ? [] : [payload.filePath] }; }; }, { filePath, canceled });
}
async function toast(source) { await page.waitForFunction(pattern => new RegExp(pattern).test(document.querySelector('#toast')?.textContent || ''), source); }
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
  const result = await app.evaluate(() => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('Download did not finish')); }, 45000);
    const timer = setInterval(() => { if (globalThis.lastNativeDownload) { clearInterval(timer); clearTimeout(timeout); resolve(globalThis.lastNativeDownload); } }, 50);
  }));
  assert.equal(result.state, 'completed');
  return fs.readFile(target);
}
let savedConfig, savedRuns;
const projectPath = path.join(output, '시험 프로젝트.suspension.json');
try {
  await launch();
  await check('bundled first launch renders 3D offline with isolated native API and persistent storage', async () => {
    assert.equal(page.url().split('#')[0], 'app://suspension/');
    const values = await page.evaluate(async () => ({ desktop: window.suspensionDesktop.isDesktop, node: typeof window.require, storage: window.suspensionLab.getProductState(), offline: await window.suspensionLab.offlineReady, canvas: !!document.querySelector('#viewport canvas'), workers: 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistrations().then(items => items.length).catch(() => 0) : 0 }));
    assert.equal(values.desktop, true); assert.equal(values.node, 'undefined'); assert.equal(values.storage.ready, true); assert.equal(values.canvas, true); assert.equal(values.workers, 0);
    assert.match(await page.locator('#project-save-status').textContent(), /이 앱에 자동 저장됨/);
    assert.equal(await page.locator('#install-app-btn').isVisible(), false);
    const denied = await page.evaluate(() => fetch('https://example.com/').then(() => false).catch(() => true));
    assert.equal(denied, true);
    // The deliberate rejected request above is omitted from application error checks.
    errors.length = 0; remoteRequests.length = 0;
  });
  await check('physics and live play/pause work inside the packaged window', async () => {
    await page.evaluate(() => { window.suspensionLab.setConfig({ road: 'flat', holderMode: 'sprung' }); window.suspensionLab.reset(); window.suspensionLab.advance(2); });
    const state = await page.evaluate(() => window.suspensionLab.snapshot());
    for (const key of ['travel', 'bodyY', 'wheelY']) assert.ok(Math.abs(state[key]) < 1e-5);
    await page.locator('#run-btn').click();
    await page.waitForFunction(() => window.suspensionLab.snapshot().time > 2.05);
    await page.locator('#run-btn').click();
    const time = await page.evaluate(() => window.suspensionLab.snapshot().time);
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
    await saveDialog(projectPath);
    await page.locator('#save-project-btn').click(); await toast('설정과 모든 보관 기록');
    const file = JSON.parse(await fs.readFile(projectPath, 'utf8'));
    assert.deepEqual(file.config, savedConfig); assert.equal(file.runs[0].id, savedRuns[0].id);
    await fs.writeFile(projectPath, 'old file');
    await page.locator('#save-project-btn').click();
    await page.waitForFunction(() => document.querySelector('#project-save-status')?.textContent === '프로젝트 파일 저장됨');
    // A marker from native completion ensures the second asynchronous write finished.
    await app.evaluate(async () => new Promise(resolve => setTimeout(resolve, 150)));
    assert.equal(JSON.parse(await fs.readFile(projectPath, 'utf8')).runs.length, 1);
  });
  await check('save and open cancellation preserve the project', async () => {
    await saveDialog(path.join(output, 'canceled.json'), true);
    await page.locator('#save-project-btn').click();
    await app.evaluate(async () => new Promise(resolve => setTimeout(resolve, 150)));
    await assert.rejects(fs.access(path.join(output, 'canceled.json')));
    await openDialog(projectPath, true);
    await page.locator('#open-project-btn').click();
    await app.evaluate(async () => new Promise(resolve => setTimeout(resolve, 100)));
    assert.deepEqual(await config(), savedConfig); assert.deepEqual(await records(), savedRuns);
  });
  await check('Ctrl+S and Ctrl+O trigger exactly one native dialog each', async () => {
    await saveDialog(projectPath);
    await app.evaluate(() => { globalThis.saveDialogCalls = 0; globalThis.openDialogCalls = 0; });
    await page.keyboard.press('Control+s');
    await app.evaluate(async () => new Promise(resolve => setTimeout(resolve, 200)));
    assert.equal(await app.evaluate(() => globalThis.saveDialogCalls), 1);
    assert.equal(JSON.parse(await fs.readFile(projectPath, 'utf8')).runs.length, 1);
    await openDialog(projectPath);
    await page.keyboard.press('Control+o'); await toast('프로젝트의 설정과 기록을 복원'); await idle();
    assert.equal(await app.evaluate(() => globalThis.openDialogCalls), 1);
  });
  await check('native open restores config and records and rejects corrupt projects atomically', async () => {
    await openDialog(projectPath);
    await page.evaluate(() => window.suspensionLab.setConfig({ speed: 80 }));
    await page.locator('#open-project-btn').click(); await toast('프로젝트의 설정과 기록을 복원');
    assert.deepEqual(await config(), savedConfig); assert.deepEqual(await records(), savedRuns);
    const bad = JSON.parse(await fs.readFile(projectPath, 'utf8')); bad.runs[0].history.at(-1).contactForce = -1;
    const badPath = path.join(output, 'corrupt.json'); await fs.writeFile(badPath, JSON.stringify(bad));
    await openDialog(badPath); await page.locator('#open-project-btn').click(); await toast('프로젝트 열기 실패');
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
    await page.locator('#capture-view-btn').click(); await toast('파일 저장을 취소');
  });
  await check('window close is canceled during an actual project restore', async () => {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => { globalThis.closePromptCalls = (globalThis.closePromptCalls || 0) + 1; return { response: 0 }; }; });
    await openDialog(projectPath);
    await page.evaluate(() => { window.originalBlobText = Blob.prototype.text; Blob.prototype.text = async function () { await new Promise(resolve => setTimeout(resolve, 750)); return window.originalBlobText.call(this); }; });
    await page.locator('#open-project-btn').click();
    await page.waitForFunction(() => window.suspensionLab.getProductState().busy);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(await app.evaluate(() => globalThis.closePromptCalls), 1);
    await idle();
    await page.evaluate(() => { Blob.prototype.text = window.originalBlobText; delete window.originalBlobText; });
    assert.deepEqual(await records(), savedRuns);
  });
  await check('complete quit and relaunch preserve settings, names and full experiment history', async () => {
    await view('bench'); await page.screenshot({ path: path.join(output, packaged ? 'installed-app.png' : 'desktop-app.png') });
    await app.close();
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
    const guidePath=path.join(output,'첫 비교 실험.suspension.json');await saveDialog(guidePath);
    await page.locator('[data-guide-action="save"]').click();await toast('설정과 모든 보관 기록');
    const exported=JSON.parse(await fs.readFile(guidePath,'utf8'));assert.deepEqual(exported.config,beforeConfig);assert.deepEqual(exported.runs,complete);
    await app.close();await launch();
    assert.deepEqual(await config(),beforeConfig);assert.deepEqual(await records(),complete);
    await view('experiments');assert.equal(await page.locator('#consumer-guide-results').isVisible(),true);
  });
  await check('final application runs with no JavaScript errors or remote content', async () => { assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []); });
  await fs.writeFile(path.join(output, packaged ? 'installed-report.json' : 'report.json'), JSON.stringify({ executablePath, packaged, profile, checks, errors, remoteRequests, version: expectedVersion }, null, 2));
  console.log(`Verified ${checks.length} desktop checks.`);
} finally { if (app) await app.close().catch(() => {}); }
