import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const output = path.join(root, 'output', 'playwright', `storage-migration-v${version}`);
const baseURL = process.env.SUSPENSION_TEST_URL || 'http://127.0.0.1:5186';
await fs.mkdir(output, { recursive: true });
const ownedServer = process.env.SUSPENSION_TEST_URL ? null : await createServer({ root, server: { host: '127.0.0.1', port: 5186, strictPort: true, watch: { ignored: ['**/output/**', '**/release/**', '**/dist/**'] } } });
await ownedServer?.listen();
const browser = await chromium.launch({ headless: true });
const contexts = [], checks = [], errors = [];
const hash = raw => createHash('sha256').update(raw).digest('hex');
const key = 'suspension-lab:experiments:v1';
async function ready(page) {
  await page.waitForFunction(() => window.suspensionLab?.productReady);
  await page.evaluate(() => window.suspensionLab.productReady);
  await page.evaluate(() => window.suspensionLab.setRunning(false));
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL); await ready(page);
  return page;
}
async function source(page) {
  return page.evaluate(async key => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('suspension-lab-experiments', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const raw = await new Promise((resolve, reject) => { const request = db.transaction('libraries', 'readonly').objectStore('libraries').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return typeof raw === 'string' ? raw : JSON.stringify(raw);
  }, key);
}
async function seed(page, raw) {
  await page.evaluate(async ({ key, raw }) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('suspension-lab-experiments', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const transaction = db.transaction('libraries', 'readwrite'); transaction.objectStore('libraries').put(raw, key); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close();
  }, { key, raw });
  await page.reload(); await ready(page);
  await page.locator('.workspace-nav a[href="#experiment-workspace"]').click();
}
async function record(page, name) {
  await page.locator('#experiment-name').fill(name); await page.locator('#experiment-duration').fill('1');
  await page.locator('#record-experiment-btn').click();
  await page.waitForFunction(() => !window.suspensionLab.getProductState().busy);
}
try {
  const page = await newPage();
  const past = await page.evaluate(async () => {
    const { runExperiment } = await import('/src/experiments.js');
    const run = runExperiment({ singleEvent: true }, { duration: 1, name: '이전 1.2 기록' });
    run.modelVersion = 'quarter-car-1.2'; run.history[8].wheelY = 0.0123456789;
    run.kpis.bodyRMS = 0.432123456789; run.kpis.settling.method = '이전 정착 판정';
    delete run.config.componentProfile; delete run.metrics.curveExtrapolationPct; delete run.kpis.curveExtrapolationPct;
    for (const row of run.history) { delete row.springCurveOutOfRange; delete row.damperCurveOutOfRange; }
    return run;
  });
  const payload = { schemaVersion: 1, modelVersion: past.modelVersion, runs: [past] };
  await seed(page, payload); const originalHash = hash(await source(page));
  assert.deepEqual(await page.evaluate(() => window.suspensionLab.getExperiments()), [past]);
  const card = page.locator(`[data-record-id="${past.id}"]`).first();
  assert.match(await card.innerText(), /quarter-car-1\.2.*읽기 전용/);
  assert.equal(await card.locator('[data-record-action="load"]').isDisabled(), true);
  assert.equal(await card.locator('[data-record-action="delete"]').isDisabled(), true);
  const csvEvent = page.waitForEvent('download'); await card.locator('[data-record-action="export"]').click();
  const csv = await csvEvent; const csvPath = path.join(output, 'legacy-original.csv'); await csv.saveAs(csvPath);
  assert.match(await fs.readFile(csvPath, 'utf8'), /0\.0123456789/);
  checks.push('IndexedDB prior-model samples/KPIs remain original; read-only UI and original CSV work');
  await record(page, '현재 모델 새 시험');
  const both = await page.evaluate(() => window.suspensionLab.getExperiments());
  assert.equal(both.length, 2); assert.deepEqual(both.find(run => run.id === past.id), past);
  assert.equal(hash(await source(page)), originalHash);
  assert.match(await page.locator('#experiment-recovery-panel').innerText(), /백업 확인됨/);
  await page.reload(); await ready(page);
  assert.deepEqual(await page.evaluate(() => window.suspensionLab.getExperiments()), both);
  await page.locator('.workspace-nav a[href="#experiment-workspace"]').click();
  const rawEvent = page.waitForEvent('download'); await page.locator('[data-recovery-action="export"]').click();
  const rawDownload = await rawEvent; const rawPath = path.join(output, 'legacy-original.json'); await rawDownload.saveAs(rawPath);
  assert.equal(hash(await fs.readFile(rawPath, 'utf8')), originalHash);
  const reportEvent = page.waitForEvent('download'); await page.locator('#experiment-report-btn').click();
  const report = await reportEvent; const reportPath = path.join(output, 'legacy-comparison-report.html'); await report.saveAs(reportPath);
  assert.match(await fs.readFile(reportPath, 'utf8'), /quarter-car-1\.2/);
  checks.push('new-model save/reload keeps the source hash and provides original download plus mixed-version report');
  await page.screenshot({ path: path.join(output, 'legacy-recovery.png'), fullPage: true });
  page.once('dialog', dialog => dialog.accept()); await page.locator('[data-recovery-action="restore"]').click();
  await page.waitForFunction(() => !window.suspensionLab.getProductState().busy);
  assert.deepEqual(await page.evaluate(() => window.suspensionLab.getExperiments()), [past]);
  assert.equal(hash(await source(page)), originalHash);
  await page.reload(); await ready(page);
  assert.deepEqual(await page.evaluate(() => window.suspensionLab.getExperiments()), [past]);
  checks.push('explicit recovery/relaunch restores prior records while retaining the original slot for rollback');

  const futurePage = await newPage();
  const futureRaw = ' \n{"schemaVersion": 99, "modelVersion": "quarter-car-9.0", "runs": []}\n  ';
  await seed(futurePage, futureRaw);
  assert.match(await futurePage.locator('#experiment-recovery-panel').innerText(), /지원하지 않는 저장 형식/);
  assert.equal(await futurePage.locator('[data-recovery-action="restore"]').count(), 0);
  await record(futurePage, '미래 저장과 별도 새 시험');
  assert.equal(await source(futurePage), futureRaw);
  await futurePage.reload(); await ready(futurePage);
  assert.equal((await futurePage.evaluate(() => window.suspensionLab.getExperiments())).length, 1);
  assert.equal(await source(futurePage), futureRaw);
  await futurePage.locator('.workspace-nav a[href="#experiment-workspace"]').click();
  const futureDownloadEvent = futurePage.waitForEvent('download'); await futurePage.locator('[data-recovery-action="export"]').click();
  const futureDownload = await futureDownloadEvent; const futurePath = path.join(output, 'future-original.json'); await futureDownload.saveAs(futurePath);
  assert.equal(await fs.readFile(futurePath, 'utf8'), futureRaw);
  checks.push('unsupported schema stays distinguishable, cannot be falsely restored and survives durable new work byte-for-byte');
  const fallback = await futurePage.evaluate(async () => {
    const { ExperimentLibrary, runExperiment } = await import('/src/experiments.js');
    const key = 'suspension-lab:migration-test-fallback';
    const previous = runExperiment({}, { duration: 1 }); previous.modelVersion = 'quarter-car-1.2';
    const raw = ' \n' + JSON.stringify({ schemaVersion: 1, modelVersion: previous.modelVersion, runs: [previous] }) + '\n';
    localStorage.setItem(key, raw);
    const options = { key, indexedDB: { open() { throw new Error('IndexedDB blocked for fallback test'); } } };
    const library = new ExperimentLibrary(options), initial = await library.ready();
    const current = runExperiment({}, { duration: 1 }); const saved = await library.save(current);
    const restarted = new ExperimentLibrary(options); await restarted.ready();
    return { initial, saved, original: localStorage.getItem(key), raw, count: restarted.list().length, oldVersion: restarted.get(previous.id).modelVersion, recovery: restarted.exportRecovery(restarted.getRecoveries()[0].id) };
  });
  assert.equal(fallback.initial.persistence, 'localStorage'); assert.equal(fallback.initial.fallbackReason, 'storage-unavailable');
  assert.equal(fallback.saved.persisted, true); assert.equal(fallback.count, 2);
  assert.equal(fallback.oldVersion, 'quarter-car-1.2'); assert.equal(fallback.original, fallback.raw); assert.equal(fallback.recovery, fallback.raw);
  checks.push('IndexedDB open failure falls back to real localStorage without overwriting legacy raw; relaunch keeps both versions');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, originalSHA256: originalHash, pageErrors: errors, realAppDataTouched: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, originalSHA256: originalHash, output }));
} finally { for (const context of contexts) await context.close(); await browser.close(); await ownedServer?.close(); }
