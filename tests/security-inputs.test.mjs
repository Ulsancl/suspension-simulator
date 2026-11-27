import { createRequire } from 'node:module';
const nativeBudget = createRequire(import.meta.url)('../desktop/project-input.cjs');
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeasurementCSV } from '../src/engineering.js';
import { runExperiment, runExperimentAsync, ExperimentLibrary } from '../src/experiments.js';
import { SuspensionSimulation } from '../src/physics.js';
import { advancePlayback } from '../src/playback-clock.js';
import { checkProjectJSON, parseBoundedJSON } from '../src/project-input.js';

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
  const playback = advancePlayback(simulation, 1);
  assert.equal(playback.stalled, true);
  assert.ok(playback.advanced > 0 && playback.advanced < .2);
  assert.ok(simulation.state.time > 0);
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
  assert.deepEqual(parseBoundedJSON('{"sample":"한글"}', { maxBytes: 30 }), { sample: '한글' });
  assert.throws(() => parseBoundedJSON('{"sample":"한글"}', { maxBytes: 16 }), /크기|최대/);
  await library.ready();
  const project = library.exportProject({}, { name: 'Validated project' });
  project.vehicleName = '<b>Vehicle</b>';
  const result = await library.importProject(JSON.stringify(project));
  assert.equal(result.name, 'Validated project');
  assert.equal(result.vehicleName, 'Vehicle');
  await assert.rejects(library.importProject(JSON.stringify({ ...project, extra: [] })), /지원하지 않는 항목/);
});

test('native project reads stop at the byte limit and saves only clean up owned files', async t => {
  const { readBounded, saveProjectFile } = createRequire(import.meta.url)('../desktop/project-files.cjs');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'suspension-file-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const target = path.join(directory, 'project.json'), temporary = path.join(directory, 'temporary');
  await fs.writeFile(target, 'previous');
  await fs.writeFile(temporary, 'someone else');
  await assert.rejects(saveProjectFile(target, 'new', fs.stat, temporary), { code: 'EEXIST' });
  assert.equal(await fs.readFile(temporary, 'utf8'), 'someone else');
  assert.equal(await fs.readFile(target, 'utf8'), 'previous');
  await fs.unlink(temporary);
  let checks = 0;
  await assert.rejects(saveProjectFile(target, 'new', async () => {
    if (++checks === 2) throw new Error('changed destination');
  }, temporary), /changed destination/);
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  await saveProjectFile(target, 'new', async file => fs.stat(file), temporary);
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
  let bytes = 0;
  await assert.rejects(readBounded({ async read(_buffer, _offset, size) {
    bytes += size; return { bytesRead: size };
  } }, 16), /이하여야/);
  assert.equal(bytes, 17);
  const handle = await fs.open(target, 'r');
  try { assert.equal((await readBounded(handle, 3)).toString(), 'new'); } finally { await handle.close(); }
});
