import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG } from '../src/physics.js';
import { runExperiment, runExperimentAsync, runDampingSweep, validateDuration, validateExperiment, normalizeExperimentName, ExperimentLibrary, MODEL_VERSION, experimentCSV, getReportData, isLegacyExperiment } from '../src/experiments.js';

const immediate = async () => {};
const makeStorage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
};
const fixture = () => runExperiment({ singleEvent: true }, { duration: 1, name: '범프 시험' });

test('numeric experiment results are deterministic and sync/async use identical integration chunks', async () => {
  const config = { holderMode: 'sprung', road: 'mixed', speed: 70 };
  const first = runExperiment(config, { duration: 2 });
  const second = runExperiment(config, { duration: 2 });
  const asynchronous = await runExperimentAsync(config, { duration: 2, scheduler: immediate });
  assert.deepEqual(first.history, second.history);
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.history, asynchronous.history);
  assert.notEqual(first.id, second.id);
});

test('duration rejects invalid types, NaN, and values outside 1–30 seconds', () => {
  for (const duration of [0, 0.99, 30.01, Infinity, NaN, '8', null]) assert.throws(() => validateDuration(duration), /1~30/);
  assert.equal(validateDuration(1), 1);
  assert.equal(validateDuration(30), 30);
  assert.throws(() => runExperiment({}, { duration: '8' }), /1~30/);
  assert.throws(() => runExperiment({}, { duration: null }), /1~30/);
});

test('record metadata, 120 Hz samples, model version and KPIs round-trip through strict validation', () => {
  const record = fixture();
  assert.match(record.id, /^[0-9a-f-]{36}$/);
  assert.equal(record.modelVersion, MODEL_VERSION);
  assert.equal(record.title, '범프 시험');
  assert.ok(record.history.length >= 120 && record.history.length <= 122);
  assert.ok(record.history.every(sample => Object.values(sample).every(value => typeof value !== 'number' || Number.isFinite(value))));
  assert.deepEqual(validateExperiment(JSON.stringify(record)), record);
  assert.ok(record.kpis.maxContactForce >= record.kpis.minContactForce);
  assert.ok(record.effectiveMotionRatio > 0);
});

test('names strip HTML and controls, limit length, and leave no HTML report output', () => {
  assert.equal(normalizeExperimentName(' <b>실험</b>\u0000\n 이름 '), '실험 이름');
  assert.equal(normalizeExperimentName('<img src=x onerror=alert(1)>'), '서스펜션 실험');
  assert.equal(normalizeExperimentName('a'.repeat(100)).length, 80);
  const run = fixture();
  run.name = '<script>실험</script>';
  const validated = validateExperiment(run);
  assert.equal(validated.name, '실험');
  assert.equal(getReportData(validated).title, '실험');
});

test('import validates finite samples, bounded history, schema and configuration while dropping unknown fields', () => {
  const baseline = fixture();
  for (const alter of [
    run => { run.history[5].wheelY = Infinity; },
    run => { run.history[5].time = -1; },
    run => { run.history = Array(3602).fill(run.history[0]); },
    run => { run.config.tireRate = -1; },
    run => { run.schemaVersion = 99; },
    run => { run.metrics.contactLossPct = 101; },
    run => { run.id = 'unsafe'; },
  ]) {
    const record = structuredClone(baseline); alter(record);
    assert.throws(() => validateExperiment(record));
  }
  const enriched = structuredClone(baseline);
  enriched.html = '<script>unsafe</script>';
  enriched.history[0].html = '<img>';
  enriched.config.html = '<img>';
  const safe = validateExperiment(enriched);
  assert.equal(safe.html, undefined);
  assert.equal(safe.history[0].html, undefined);
  assert.equal(safe.config.html, undefined);
});

test('settling is estimated only for a completed single event and uses an explicit threshold method', () => {
  const continuous = runExperiment({}, { duration: 3 });
  assert.equal(continuous.kpis.settling.status, 'not-applicable');
  assert.equal(continuous.kpis.settlingTime, null);
  const short = runExperiment({ singleEvent: true, speed: 1 }, { duration: 1 });
  assert.equal(short.kpis.settling.status, 'not-observed');
  const event = runExperiment({ singleEvent: true, compressionDamping: 2500, reboundDamping: 4000 }, { duration: 5 });
  assert.equal(event.kpis.settling.status, 'settled');
  assert.ok(event.kpis.settlingTime >= 0);
  assert.match(event.kpis.settling.method, /0.5초/);
});

test('damping sweep changes the actual selected coefficient, keeps other conditions, and yields progress', async () => {
  let yields = 0, progressEvents = 0;
  const sweep = await runDampingSweep({ holderMode: 'sprung', reboundDamping: 3210, singleEvent: true }, {
    coefficient: 'compressionDamping', candidates: [500, 1500, 3500], duration: 2,
    scheduler: async () => { yields++; }, onProgress: () => { progressEvents++; },
  });
  assert.equal(sweep.trials.length, 3);
  assert.deepEqual(sweep.trials.map(trial => trial.config.compressionDamping), [500, 1500, 3500]);
  assert.ok(sweep.trials.every(trial => trial.config.reboundDamping === 3210 && trial.config.singleEvent && trial.config.holderMode === 'sprung'));
  assert.ok(yields > 30 && progressEvents > 30);
  assert.equal(sweep.method.scoreMetric, 'bodyRMS');
  assert.equal(sweep.method.contactLossGuardPct, 1);
  assert.ok(sweep.ranking.every(row => row.score === sweep.trials.find(trial => trial.id === row.trialId).kpis.bodyRMS));
  assert.notEqual(sweep.trials[0].metrics.rmsBodyAcceleration, sweep.trials[2].metrics.rmsBodyAcceleration);
});

test('fixed-holder ranking uses wheel RMS and no unsafe automatic recommendation passes the guard', async () => {
  const sweep = await runDampingSweep({ holderMode: 'fixed', road: 'step', roadHeight: 0.25, speed: 100 }, { coefficient: 'rebound', candidates: [0, 500, 1000], duration: 2, scheduler: immediate });
  assert.equal(sweep.method.scoreMetric, 'wheelRMS');
  assert.ok(sweep.ranking.every(row => row.score === sweep.trials.find(trial => trial.id === row.trialId).kpis.wheelRMS));
  if (sweep.recommendation) assert.ok(sweep.recommendation.contactLossPct <= 1);
  else assert.ok(sweep.ranking.every(row => !row.passesGuard));
  for (const candidates of [[1, 2], [1, 1, 2], [0, 1, Infinity], [0, 1, 17000]]) await assert.rejects(() => runDampingSweep({}, { candidates, duration: 1, scheduler: immediate }));
});

test('async trial and sweep support cancellation at yield boundaries', async () => {
  const controller = new AbortController();
  let yields = 0;
  await assert.rejects(() => runExperimentAsync({}, { duration: 2, signal: controller.signal, scheduler: async () => { if (++yields === 3) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(yields, 3);
  const batchController = new AbortController();
  await assert.rejects(() => runDampingSweep({}, { duration: 1, candidates: [500, 1500, 2500], signal: batchController.signal, scheduler: immediate, onTrial: () => batchController.abort() }), error => error.name === 'AbortError' && error.completedTrials.length === 1);
});

test('library CRUD persists records, exposes copies, and enforces capacity without deleting old work', async () => {
  const storage = makeStorage();
  const library = new ExperimentLibrary({ storage, maxRuns: 2 });
  await library.ready();
  const first = fixture(), second = fixture();
  assert.equal((await library.save(first)).persisted, true);
  await library.save(second);
  const thirdStatus = await library.save(fixture());
  assert.equal(thirdStatus.reason, 'capacity');
  assert.equal(library.list().length, 2);
  const copy = library.get(first.id); copy.name = 'changed';
  assert.equal(library.get(first.id).name, first.name);
  await library.rename(first.id, '<b>새 이름</b>');
  assert.equal(library.get(first.id).name, '새 이름');
  const reloaded = new ExperimentLibrary({ storage, maxRuns: 2 });
  await reloaded.ready();
  assert.equal(reloaded.list().length, 2);
  await library.remove(first.id);
  assert.equal(library.get(first.id), null);
  assert.equal((await library.remove(first.id)).reason, 'not-found');
});

test('quota failure preserves in-memory work and reports lack of durable persistence', async () => {
  const storage = { getItem: () => null, setItem: () => { const error = new Error('storage quota reached'); error.name = 'QuotaExceededError'; throw error; } };
  const library = new ExperimentLibrary({ storage });
  await library.ready();
  const run = fixture();
  const status = await library.save(run);
  assert.equal(status.ok, true);
  assert.equal(status.persisted, false);
  assert.equal(status.reason, 'quota');
  assert.equal(library.get(run.id).name, run.name);
  assert.equal(library.exportProject(DEFAULT_CONFIG).runs.length, 1);
});

test('corrupted persistence surfaces a load error and never overwrites storage on initialization', async () => {
  let writes = 0;
  const library = new ExperimentLibrary({ storage: { getItem: () => '{bad json', setItem: () => { writes++; } } });
  const status = await library.ready();
  assert.equal(status.ok, false);
  assert.equal(status.reason, 'corrupt-storage');
  assert.equal(library.list().length, 0);
  assert.equal(writes, 0);
});

test('project export/import preserves configuration and records; invalid imports are atomic', async () => {
  const source = new ExperimentLibrary({ storage: null });
  await source.ready();
  await source.save(fixture());
  const project = source.exportProject({ road: 'pothole', airPressure: 7 }, { name: '하체 프로젝트' });
  const target = new ExperimentLibrary({ storage: null });
  await target.ready();
  const status = await target.importProject(JSON.stringify(project));
  assert.equal(status.ok, true);
  assert.equal(status.config.road, 'pothole');
  assert.equal(status.config.airPressure, 7);
  assert.equal(status.name, '하체 프로젝트');
  assert.deepEqual(target.list(), source.list());
  const malformed = structuredClone(project); malformed.runs[0].history[3].time = NaN;
  await assert.rejects(() => target.importProject(malformed));
  assert.deepEqual(target.list(), source.list());
});

test('queued saves avoid lost updates and report/CSV data has consistent sample columns', async () => {
  const library = new ExperimentLibrary({ storage: makeStorage() });
  const first = fixture(), second = fixture();
  await Promise.all([library.save(first), library.save(second)]);
  assert.equal(library.list().length, 2);
  const csv = experimentCSV(first).trim().split('\n');
  assert.equal(csv.length, first.history.length + 1);
  assert.equal(csv[0].split(',').length, csv[1].split(',').length);
  const report = getReportData(first);
  assert.equal(report.kpiRows.find(row => row.label === '접지 이탈').value, first.metrics.contactLossPct);
});

test('measured component profiles and extrapolation provenance round-trip through records and projects', async () => {
  const componentProfile = { format: 'suspension-components/v1', units: 'SI', name: '시험 스프링', source: '벤치 측정', spring: [[0, 0], [0.2, 12000]], damper: [[-1, -3000], [0, 0], [1, 2000]] };
  const run = runExperiment({ componentProfile, autoMotionRatio: false, motionRatio: 1 }, { duration: 1 });
  assert.equal(run.effectiveWheelRate, 60000);
  assert.ok(run.history.every(sample => typeof sample.springCurveOutOfRange === 'boolean' && typeof sample.damperCurveOutOfRange === 'boolean'));
  assert.ok(Number.isFinite(run.metrics.curveExtrapolationPct));
  assert.deepEqual(validateExperiment(JSON.stringify(run)), run);
  const library = new ExperimentLibrary({ storage: null });
  await library.ready(); await library.save(run);
  const project = library.exportProject(run.config);
  const target = new ExperimentLibrary({ storage: null });
  await target.ready(); await target.importProject(JSON.stringify(project));
  assert.deepEqual(target.get(run.id).config.componentProfile, run.config.componentProfile);
  const invalid = structuredClone(run);
  invalid.config.componentProfile.spring[1][1] = -1;
  assert.throws(() => validateExperiment(invalid));
});

test('coefficient sweeps reject measured damper curves because those curves override the coefficients', async () => {
  const componentProfile = { format: 'suspension-components/v1', units: 'SI', name: '댐퍼', source: '실측', damper: [[-1, -3000], [0, 0], [1, 2000]] };
  await assert.rejects(() => runDampingSweep({ componentProfile }, { duration: 1, candidates: [500, 1500, 2500], scheduler: immediate }), /측정 댐퍼 곡선/);
});

const libraryKey = 'suspension-lab:experiments:v1';
const branchKey = `${libraryKey}:model:${MODEL_VERSION}:schema:1`;
const sha256 = raw => createHash('sha256').update(raw).digest('hex');
function historicalFixture() {
  const record = fixture(); record.modelVersion = 'quarter-car-1.2';
  // Distinct stored results make a hidden recalculation or KPI substitution fail.
  record.history[8].wheelY = 0.0123456789;
  record.kpis.bodyRMS = 0.432123456789;
  record.kpis.settling.method = '이전 버전에서 기록한 정착 판정법';
  delete record.config.componentProfile;
  delete record.metrics.curveExtrapolationPct; delete record.kpis.curveExtrapolationPct;
  for (const row of record.history) { delete row.springCurveOutOfRange; delete row.damperCurveOutOfRange; }
  return record;
}

test('past model opens read-only with original samples and KPIs; new save/relaunch/rollback preserve original bytes', async () => {
  const storage = makeStorage(), past = historicalFixture();
  const raw = ' \n' + JSON.stringify({ schemaVersion: 1, modelVersion: past.modelVersion, runs: [past] }, null, 2) + '\n  ';
  const originalHash = sha256(raw); storage.values.set(libraryKey, raw);
  const library = new ExperimentLibrary({ storage });
  const status = await library.ready();
  assert.equal(status.ok, true); assert.equal(status.reason, 'legacy-model');
  assert.equal(isLegacyExperiment(library.get(past.id)), true);
  assert.deepEqual(library.get(past.id), past);
  assert.equal(storage.values.size, 1, 'read-only initialization must not write migration data');
  assert.match(experimentCSV(library.get(past.id)), /0\.0123457/);
  assert.equal(getReportData(library.get(past.id)).kpiRows.find(row => row.label === '차체 가속도 RMS').value, past.kpis.bodyRMS);
  for (const operation of [() => library.rename(past.id, 'changed'), () => library.remove(past.id), () => library.save({ ...fixture(), id: past.id }), () => library.saveBatch([{ ...fixture(), id: past.id }])]) assert.equal((await operation()).reason, 'read-only');
  const current = fixture(); assert.equal((await library.save(current)).persisted, true);
  assert.equal(sha256(storage.getItem(libraryKey)), originalHash);
  assert.equal(JSON.parse(storage.getItem(branchKey)).runs.length, 2);
  assert.deepEqual(library.get(past.id), past);
  const recovery = library.getRecoveries()[0]; assert.equal(recovery.persisted, true);
  assert.equal(recovery.restorable, true); assert.equal(sha256(library.exportRecovery(recovery.id)), originalHash);
  const restarted = new ExperimentLibrary({ storage }); await restarted.ready();
  assert.deepEqual(restarted.get(past.id), past); assert.deepEqual(restarted.get(current.id), current);
  assert.equal(restarted.getRecoveries().length, 1);
  assert.equal((await restarted.restoreRecovery(recovery.id)).persisted, true);
  assert.deepEqual(restarted.list(), [past]);
  assert.equal(sha256(storage.getItem(libraryKey)), originalHash);
  // Restoring the original slot (e.g. using the old application) still finds the old version.
  assert.deepEqual(JSON.parse(storage.getItem(libraryKey)).runs, [past]);
  await restarted.clear();
  const afterClear = new ExperimentLibrary({ storage }); await afterClear.ready();
  assert.deepEqual(afterClear.list(), []);
  assert.equal(sha256(afterClear.exportRecovery(recovery.id)), originalHash);
  assert.deepEqual(validateExperiment(JSON.parse(afterClear.exportRecovery(recovery.id)).runs[0]), past);
});

test('future schema, future model, unknown model and corrupt raw get distinct reasons and survive new saved work', async () => {
  for (const [raw, reason] of [
    [JSON.stringify({ schemaVersion: 2, modelVersion: MODEL_VERSION, runs: [] }, null, 2), 'unsupported-schema'],
    [JSON.stringify({ schemaVersion: 1, modelVersion: 'quarter-car-9.0', runs: [] }), 'unsupported-model'],
    [JSON.stringify({ schemaVersion: 1, modelVersion: 'foreign-model', runs: [] }), 'unknown-model'],
    ['  {broken, json\r\n', 'corrupt-storage'],
  ]) {
    const storage = makeStorage(); storage.values.set(libraryKey, raw);
    const library = new ExperimentLibrary({ storage });
    assert.equal((await library.ready()).reason, reason);
    assert.equal(library.getRecoveries()[0].restorable, false);
    assert.equal((await library.save(fixture())).persisted, true);
    assert.equal(storage.getItem(libraryKey), raw);
    const recovery = library.getRecoveries()[0];
    assert.equal(library.exportRecovery(recovery.id), raw);
    const restarted = new ExperimentLibrary({ storage }); await restarted.ready();
    assert.equal(restarted.list().length, 1); assert.equal(restarted.exportRecovery(recovery.id), raw);
    const before = restarted.list(); await assert.rejects(() => restarted.restoreRecovery(recovery.id));
    assert.deepEqual(restarted.list(), before);
  }
});

test('backup write and read verification failures never replace source or write the active branch', async () => {
  for (const failure of ['quota', 'wrong-copy', 'index-write']) {
    const raw = JSON.stringify({ schemaVersion: 1, modelVersion: 'quarter-car-1.2', runs: [historicalFixture()] });
    const storage = makeStorage(); storage.values.set(libraryKey, raw);
    let fail = true;
    const adapter = {
      getItem(key) { const value = storage.getItem(key); return fail && failure === 'wrong-copy' && key.startsWith(`${libraryKey}:recovery:`) && value != null ? JSON.stringify({ format: 'suspension-lab-recovery/v1', raw: 'altered' }) : value; },
      setItem(key, value) {
        if (fail && (failure === 'quota' || (failure === 'index-write' && key.endsWith(':recovery-index:v1')))) { const error = new Error('Quota exceeded'); error.name = 'QuotaExceededError'; throw error; }
        storage.setItem(key, value);
      },
    };
    const library = new ExperimentLibrary({ storage: adapter }); await library.ready();
    const current = fixture(); const status = await library.save(current);
    assert.equal(status.persisted, false); assert.equal(status.reason, 'backup-failed');
    assert.equal(storage.getItem(libraryKey), raw); assert.equal(storage.getItem(branchKey), null);
    assert.deepEqual(library.get(current.id), current);
    assert.equal(library.exportProject(DEFAULT_CONFIG).runs.length, 2);
    assert.equal(library.exportRecovery(library.getRecoveries()[0].id), raw);
    fail = false;
    assert.equal((await library.save(current)).persisted, true);
    assert.equal(storage.getItem(libraryKey), raw);
  }
});

test('unsupported working branch and storage read failures stay memory-only without overwriting either source', async () => {
  const storage = makeStorage();
  const original = JSON.stringify({ schemaVersion: 1, modelVersion: 'quarter-car-1.2', runs: [historicalFixture()] });
  const damaged = 'unreadable current branch'; storage.values.set(libraryKey, original); storage.values.set(branchKey, damaged);
  const library = new ExperimentLibrary({ storage }); await library.ready();
  assert.equal((await library.save(fixture())).reason, 'recovery-required');
  assert.equal(storage.getItem(libraryKey), original); assert.equal(storage.getItem(branchKey), damaged);
  assert.ok(library.getRecoveries().some(entry => library.exportRecovery(entry.id) === damaged));
  let writes = 0;
  const failedRead = new ExperimentLibrary({ storage: { getItem: () => { throw new Error('Read unavailable'); }, setItem: () => { writes++; } } });
  assert.equal((await failedRead.ready()).ok, false);
  assert.equal((await failedRead.save(fixture())).persisted, false); assert.equal(writes, 0);
});

test('legacy project imports retain exact raw separately and reject future projects without changing the library', async () => {
  const storage = makeStorage(), library = new ExperimentLibrary({ storage }); await library.ready();
  const current = fixture(); await library.save(current);
  const past = historicalFixture();
  const raw = JSON.stringify({ type: 'suspension-lab-project', schemaVersion: 1, modelVersion: past.modelVersion, name: '이전 프로젝트', exportedAt: past.createdAt, config: past.config, runs: [past] }, null, 2) + '\n';
  assert.equal((await library.importProject(raw)).persisted, true);
  assert.deepEqual(library.get(past.id), past);
  assert.ok(library.getRecoveries().some(entry => library.exportRecovery(entry.id) === raw && entry.persisted));
  const future = '{"type":"suspension-lab-project", "schemaVersion":99, "modelVersion":"quarter-car-10.0"}\n';
  await assert.rejects(() => library.importProject(future), error => error.reason === 'unsupported-schema');
  assert.deepEqual(library.list(), [past]);
  assert.ok(library.getRecoveries().some(entry => library.exportRecovery(entry.id) === future));
  await library.save(current);
  const reloaded = new ExperimentLibrary({ storage }); await reloaded.ready();
  assert.deepEqual(reloaded.get(past.id), past); assert.deepEqual(reloaded.get(current.id), current);
  assert.ok(reloaded.getRecoveries().some(entry => reloaded.exportRecovery(entry.id) === future));
});
