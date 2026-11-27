import test from 'node:test';
import assert from 'node:assert/strict';
import { findConsumerGuideTrials, runConsumerGuide } from '../src/consumer-guide.js';
import { ExperimentLibrary, MODEL_VERSION, EXPERIMENT_SCHEMA_VERSION, runExperiment, validateExperiment } from '../src/experiments.js';
import { normalizeConfig, roadEventEndDistance, roadHeight, SuspensionSimulation } from '../src/physics.js';

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${expected}, received ${actual}`);
}

test('the lead-in delays the road profile, tyre contact and suspension response by the same distance', () => {
  const base = new SuspensionSimulation({ road: 'step', roadWidth: 0.1, speed: 36, holderMode: 'sprung' });
  const delayed = new SuspensionSimulation({ ...base.config, roadLeadIn: 4 });
  const early = delayed.advance(0.32);
  assert.equal(early.rawRoadY, 0);
  assert.equal(early.roadY, 0);
  near(early.travel, 0);

  // The wheel centre is still before the narrow step but its envelope has touched the edge.
  const baseline = base.advance(0.31);
  const shifted = delayed.advance(0.39);
  assert.equal(baseline.rawRoadY, 0);
  assert.ok(baseline.roadY > 0);
  assert.ok(baseline.wheelY > 0);
  for (const field of ['rawRoadY', 'roadY', 'wheelY', 'bodyY', 'contactForce']) {
    near(shifted[field], baseline[field], 1e-6);
  }
  near(shifted.distance - baseline.distance, 4);
});

test('finite mixed and corrugated inputs return to flat at the correct positions', () => {
  const mixed = normalizeConfig({ road: 'mixed', roadLeadIn: 4, roadRepeatCount: 3, speed: 36 });
  const firstPeak = mixed.roadLeadIn + 0.55 * mixed.roadSpacing;
  near(roadHeight(firstPeak, mixed), 0.06);
  near(roadHeight(firstPeak + mixed.roadSpacing, mixed), 0.06);
  near(roadHeight(firstPeak + 2 * mixed.roadSpacing, mixed), -0.06);
  assert.equal(roadHeight(firstPeak + 3 * mixed.roadSpacing, mixed), 0);
  const mixedEnd = firstPeak + 2 * mixed.roadSpacing + mixed.roadWidth / 2 + mixed.tireRadius;
  near(roadEventEndDistance(mixed), mixedEnd);
  const run = runExperiment(mixed, { duration: 3 });
  near(run.kpis.settling.eventEndTime, mixedEnd / 10);
  assert.ok(run.history.some(sample => sample.rawRoadY < 0));
  assert.ok(run.history.filter(sample => sample.distance > mixedEnd).every(sample => sample.roadY === 0));

  const waves = normalizeConfig({ road: 'washboard', roadWidth: 0.8, roadLeadIn: 2, roadRepeatCount: 2 });
  const start = 2 + 0.35 * waves.roadSpacing;
  const end = start + 2 * waves.roadWidth;
  for (const cycle of [0.5, 1.5]) near(roadHeight(start + cycle * waves.roadWidth, waves), 0.06);
  near(roadHeight(end, waves), 0);
  assert.equal(roadHeight(end + 0.4, waves), 0);
  near(roadHeight(end + 0.4, { ...waves, roadRepeatCount: 0 }), 0.06);
  near(roadEventEndDistance(waves), end + waves.tireRadius);
  near(roadEventEndDistance({ ...waves, singleEvent: true }), end + waves.roadWidth + waves.tireRadius);
  assert.equal(roadEventEndDistance({ ...waves, roadRepeatCount: 0 }), null);
  assert.equal(roadEventEndDistance({ ...waves, road: 'flat' }), null);
});

test('finite and continuous runs produce different responses while legacy defaults retain the original cadence', () => {
  const trial = { speed: 36, holderMode: 'sprung' };
  const options = { duration: 2 };
  const continuous = runExperiment(trial, options);
  const explicit = runExperiment({ ...trial, roadLeadIn: 0, roadRepeatCount: 0 }, options);
  const twice = runExperiment({ ...trial, roadRepeatCount: 2 }, options);
  assert.deepEqual(continuous.history, explicit.history);
  assert.deepEqual(continuous.metrics, explicit.metrics);
  assert.notEqual(twice.metrics.rmsBodyAcceleration, continuous.metrics.rmsBodyAcceleration);
  assert.ok(continuous.history.some(sample => sample.distance > 11 && sample.rawRoadY > 0));
  assert.ok(twice.history.every(sample => sample.distance <= 11 || sample.roadY === 0));
  assert.equal(continuous.kpis.settling.status, 'not-applicable');
  near(twice.kpis.settling.eventEndTime, 1.014);
  assert.equal(normalizeConfig({ roadLeadIn: 25, roadRepeatCount: 30 }).roadLeadIn, 20);
  assert.equal(normalizeConfig({ roadLeadIn: -1, roadRepeatCount: 30 }).roadRepeatCount, 12);
  assert.equal(normalizeConfig({ roadLeadIn: 3.14, roadRepeatCount: 2.2 }).roadLeadIn, 3.1);
  assert.equal(normalizeConfig({ roadLeadIn: 3.14, roadRepeatCount: 2.2 }).roadRepeatCount, 2);
});

function memoryStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

function withoutRoadSequence(config) {
  const old = { ...config };
  delete old.roadLeadIn;
  delete old.roadRepeatCount;
  return old;
}

test('saved runs and projects preserve new conditions and reject invalid supplied values', async () => {
  const storage = memoryStorage();
  const library = new ExperimentLibrary({ storage });
  await library.ready();
  const run = runExperiment({ road: 'washboard', roadLeadIn: 4.2, roadRepeatCount: 4 }, { duration: 2 });
  await library.save(run);

  const reopened = new ExperimentLibrary({ storage });
  await reopened.ready();
  assert.deepEqual(reopened.get(run.id), run);
  const target = new ExperimentLibrary({ storage: null });
  await target.ready();
  const project = library.exportProject(run.config);
  const imported = await target.importProject(JSON.stringify(project));
  assert.deepEqual(imported.config, run.config);
  assert.deepEqual(target.get(run.id), run);

  assert.throws(() => validateExperiment({ ...run, config: { ...run.config, roadRepeatCount: 1.5 } }), /roadRepeatCount/);
  await assert.rejects(target.importProject({ ...project, config: { ...project.config, roadLeadIn: 21 } }), /roadLeadIn/);
  assert.deepEqual(target.get(run.id), run);
});

test('an existing guide pair reloads from storage and a historical project resets the new controls', async () => {
  const key = 'test-old-road-config';
  const storage = memoryStorage();
  const guideLibrary = new ExperimentLibrary({ storage: null });
  await guideLibrary.ready();
  const { guide, trials: runs } = await runConsumerGuide(guideLibrary, { scheduler: async () => {} });
  const oldRuns = runs.map(run => ({ ...run, config: withoutRoadSequence(run.config) }));
  storage.setItem(key, JSON.stringify({ schemaVersion: EXPERIMENT_SCHEMA_VERSION, modelVersion: MODEL_VERSION, runs: oldRuns }));
  const library = new ExperimentLibrary({ storage, key });
  await library.ready();
  assert.deepEqual(findConsumerGuideTrials(library.list()), runs);
  assert.equal(library.getRecoveries().length, 0);

  const oldProject = {
    ...library.exportProject(guide.config),
    config: withoutRoadSequence(guide.config),
    modelVersion: 'quarter-car-1.2',
    runs: oldRuns.map(run => ({ ...run, modelVersion: 'quarter-car-1.2' })),
  };
  const restored = await library.importProject(JSON.stringify(oldProject));
  assert.equal(restored.config.roadLeadIn, 0);
  assert.equal(restored.config.roadRepeatCount, 0);
  assert.ok(library.list().every(run => !Object.hasOwn(run.config, 'roadLeadIn')));
  assert.deepEqual(validateExperiment({ ...oldProject.runs[0], kpis: undefined }).kpis.settling, runs[0].kpis.settling);
});
