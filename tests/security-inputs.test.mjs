import { createRequire } from 'node:module';
const nativeBudget = createRequire(import.meta.url)('../desktop/project-input.cjs');
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeasurementCSV } from '../src/engineering.js';
import { runExperiment, runExperimentAsync, ExperimentLibrary } from '../src/experiments.js';
import { SuspensionSimulation } from '../src/physics.js';
import { checkProjectJSON } from '../src/project-input.js';

test('CSV rejects delimiter floods, excess record width and oversized cells while tokenizing', () => {
  assert.throws(() => parseMeasurementCSV(','.repeat(1000000)), /헤더|열/);
  assert.throws(() => parseMeasurementCSV('time,travel\n0,0,' + ','.repeat(1000000)), /열/);
  assert.throws(() => parseMeasurementCSV('time,travel\n0,"' + 'x'.repeat(20000) + '"'), /길이/);
  assert.equal(parseMeasurementCSV('time,travel\n0,0\n1,0.1', { channel: 'travel' }).sampleCount, 2);
});

test('stiff but schema-valid curves cannot schedule an unbounded synchronous or async run', async () => {
  const config = { unsprungMass: 15, autoMotionRatio: false, motionRatio: 1.3,
    componentProfile: { format: 'suspension-components/v1', units: 'SI',
      spring: [[0, 0], [.01, 80000], [.02, 160000]],
      damper: [[-1, -200000], [0, 0], [1, 200000]] } };
  const simulation = new SuspensionSimulation(config);
  assert.throws(() => simulation.advance(6), /계산량/);
  assert.equal(simulation.state.time, 0);
  assert.throws(() => runExperiment(config, { duration: 30 }), /계산량/);
  await assert.rejects(runExperimentAsync(config, { duration: 30 }), /계산량/);
  const signal = AbortSignal.abort();
  assert.throws(() => simulation.step(.01, { signal }), { name: 'AbortError' });
});

test('project graphs are budgeted before parsing and UI metadata comes from validated import', async () => {
  const reject = message => { throw new Error(message); };
  assert.throws(() => checkProjectJSON('['.repeat(17), reject), /복잡도/);
  assert.throws(() => nativeBudget.checkProjectJSON('['.repeat(17), reject), /복잡도/);
  assert.throws(() => checkProjectJSON('[' + '{},'.repeat(100001) + '{}]', reject), /복잡도/);
  assert.throws(() => checkProjectJSON('{"extra":"' + 'x'.repeat(9000) + '"}', reject), /길이/);
  const library = new ExperimentLibrary({ indexedDB: null, storage: null });
  await library.ready;
  const project = library.exportProject({}, { name: 'Validated project' });
  project.vehicleName = '<b>Vehicle</b>';
  const result = await library.importProject(JSON.stringify(project));
  assert.equal(result.name, 'Validated project');
  assert.equal(result.vehicleName, 'Vehicle');
  await assert.rejects(library.importProject(JSON.stringify({ ...project, extra: [] })), /지원하지 않는 항목/);
});
