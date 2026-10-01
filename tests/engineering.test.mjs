import test from 'node:test';
import assert from 'node:assert/strict';
import { SuspensionSimulation } from '../src/physics.js';
import { runExperiment } from '../src/experiments.js';
import { linearQuarterCarProperties, runBenchmarkSuite, parseMeasurementCSV, compareMeasurement } from '../src/engineering.js';

const near = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) < epsilon, `${a} vs ${b}`);
const linearRun = () => {
  const run = runExperiment({ road: 'flat' }, { duration: 2 });
  run.history = run.history.map(sample => ({ ...sample, travel: 2 * sample.time + 0.01 }));
  return run;
};

test('static tangent and fixed-holder mode agree with the actual simulation', () => {
  for (const springType of ['coil', 'progressive', 'air']) {
    const properties = linearQuarterCarProperties({ springType });
    const state = new SuspensionSimulation({ springType }).snapshot();
    near(properties.wheelRate, state.effectiveWheelRate);
    near(properties.effectiveMotionRatio, state.effectiveMotionRatio);
    near(properties.fixedHolderFrequencyHz, Math.sqrt((state.effectiveWheelRate + 220000) / 45) / (2 * Math.PI));
    assert.equal(properties.activeFrequenciesHz.length, 1);
    assert.ok(properties.naturalFrequenciesHz[1] > properties.naturalFrequenciesHz[0]);
  }
});

test('two-mass modes satisfy the generalized eigen equation and matrices have mechanical signs', () => {
  const p = linearQuarterCarProperties({ holderMode: 'sprung', sprungMass: 300, unsprungMass: 60, springRate: 16000, tireRate: 190000, motionRatio: 1, autoMotionRatio: false });
  assert.deepEqual(p.massMatrix, [[300, 0], [0, 60]]);
  assert.deepEqual(p.stiffnessMatrix, [[16000, -16000], [-16000, 206000]]);
  assert.equal(p.activeFrequenciesHz.length, 2);
  for (const eigenvalue of p.eigenvaluesRadSquared) {
    const determinant = (16000 - eigenvalue * 300) * (206000 - eigenvalue * 60) - 16000 ** 2;
    assert.ok(Math.abs(determinant) < 0.01);
  }
  near(p.eigenvaluesRadSquared[0] * p.eigenvaluesRadSquared[1], 16000 * 190000 / (300 * 60), 1e-6);
});

test('public verification checks equilibrium and an independent damped closed-form response', () => {
  const result = runBenchmarkSuite();
  assert.equal(result.passed, true);
  assert.equal(result.checks.length, 3);
  assert.ok(result.checks.every(check => check.error < check.tolerance));
  assert.match(result.method, /인증을 의미하지/);
});

test('modal properties use the measured spring tangent rather than the coil control', () => {
  const componentProfile = { format: 'suspension-components/v1', units: 'SI', name: '측정 곡선', source: '벤치', spring: [[0, 0], [0.2, 12000]] };
  const properties = linearQuarterCarProperties({ componentProfile, springRate: 32000, autoMotionRatio: false, motionRatio: 1 });
  near(properties.wheelRate, 60000);
  near(properties.stiffnessMatrix[0][0], 60000);
});

test('CSV handles BOM, CRLF, quoted fields and semicolon, with explicit mm conversion', () => {
  const data = parseMeasurementCSV('\uFEFF"time_s";"travel_mm"\r\n"0";"12.5"\r\n"0.1";"-8"\r\n', { channel: 'travel', sourceName: '<b>bench.csv</b>' });
  near(data.samples[0].value, 0.0125);
  near(data.samples[1].value, -0.008);
  assert.equal(data.units.value, 'm');
  assert.equal(data.sourceUnits.value, 'mm');
  assert.equal(data.delimiter, ';');
  assert.equal(data.sourceName, 'bench.csv');
});

test('canonical headers explicitly mean SI without magnitude-based unit guessing', () => {
  const data = parseMeasurementCSV('time,wheelAcceleration\n0,25\n1,-20', { channel: 'wheelAcceleration' });
  assert.equal(data.samples[0].value, 25);
  assert.equal(data.unit, 'm/s²');
  assert.throws(() => parseMeasurementCSV('time,wheelAcceleration_g\n0,1\n1,2', { channel: 'wheelAcceleration' }), /단위/);
  assert.throws(() => parseMeasurementCSV('time_ms,travel_mm\n0,1\n100,2', { channel: 'travel' }), /시간 헤더/);
});

test('CSV rejects truncated rows/quotes, duplicate or nonmonotonic time and formula injection', () => {
  for (const text of [
    'time,travel\n0,1\n1', 'time,travel\n0,"1\n1,2',
    'time,travel\n0,1\n0,2', 'time,travel\n1,1\n0,2',
    'time,travel\n0,=1+1\n1,2', 'time,travel\n0,NaN\n1,2',
    'time,travel\n0,\n1,2', 'time,travel\n0,0x10\n1,2',
    'time,travel\n0,"1"bad\n1,2', 'time,travel\n0,1\n301,2',
    'time,travel,travel_mm\n0,1,1\n1,2,2',
  ]) assert.throws(() => parseMeasurementCSV(text, { channel: 'travel' }));
});

test('CSV sample count is bounded to 100,000', () => {
  const text = 'time,travel\n' + Array.from({ length: 100001 }, (_, index) => `${index * 0.001},0`).join('\n');
  assert.throws(() => parseMeasurementCSV(text, { channel: 'travel' }), /100,000/);
});

test('linear interpolation and explicit time offset reproduce an independent linear signal', () => {
  const run = linearRun();
  const data = parseMeasurementCSV('time,travel\n0,0.51\n0.123,0.756\n0.5,1.51\n1,2.51', { channel: 'travel' });
  const comparison = compareMeasurement(run, data, { timeOffset: 0.25 });
  near(comparison.rmse, 0, 1e-12);
  near(comparison.mae, 0, 1e-12);
  near(comparison.r2, 1, 1e-12);
  near(comparison.window.start, 0.25);
  assert.equal(comparison.sampleCount, 4);
});

test('known constant residual yields expected RMSE/MAE/peak error without fitting', () => {
  const run = linearRun();
  const data = parseMeasurementCSV('time,travel\n0,-0.49\n0.5,0.51\n1,1.51\n1.5,2.51', { channel: 'travel' });
  const result = compareMeasurement(run, data);
  near(result.rmse, 0.5, 1e-12);
  near(result.mae, 0.5, 1e-12);
  near(result.peakError, 0.5, 1e-12);
  assert.ok(result.residuals.every(sample => Math.abs(sample.residual - 0.5) < 1e-12));
});

test('sinusoidal channel compares at original samples and finite R² is reported', () => {
  const run = runExperiment({ road: 'flat' }, { duration: 1 });
  run.history = run.history.map(sample => ({ ...sample, wheelAcceleration: Math.sin(2 * Math.PI * sample.time) }));
  const csv = 'time,wheelAcceleration\n' + run.history.map(sample => `${sample.time},${sample.wheelAcceleration}`).join('\n');
  const measured = parseMeasurementCSV(csv, { channel: 'wheelAcceleration' });
  const result = compareMeasurement(run, measured);
  near(result.rmse, 0, 1e-12);
  near(result.r2, 1, 1e-12);
});

test('constant measured signal has undefined R² and comparisons never extrapolate', () => {
  const run = runExperiment({ road: 'flat' }, { duration: 1 });
  const measured = parseMeasurementCSV('time,bodyAcceleration\n-1,0\n0,0\n0.5,0\n2,0', { channel: 'bodyAcceleration' });
  const result = compareMeasurement(run, measured);
  assert.equal(result.r2, null);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.residuals.some(sample => sample.time < 0 || sample.time > 1), false);
  assert.throws(() => compareMeasurement(run, measured, { channel: 'travel' }), /채널/);
  assert.throws(() => compareMeasurement(run, measured, { timeOffset: 100 }), /겹치는/);
  assert.throws(() => compareMeasurement(run, measured, { timeOffset: '0' }), /오프셋/);
});
