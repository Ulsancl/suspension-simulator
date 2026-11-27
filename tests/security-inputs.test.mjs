import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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
  const { readBounded, saveSiblingProjectFile } = createRequire(import.meta.url)('../desktop/project-files.cjs');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'suspension-file-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const target = path.join(directory, 'project.json'), temporary = path.join(directory, 'temporary');
  await fs.writeFile(target, 'previous');
  await fs.writeFile(temporary, 'someone else');
  await assert.rejects(saveSiblingProjectFile(target, 'new', fs.stat, temporary), { code: 'EEXIST' });
  assert.equal(await fs.readFile(temporary, 'utf8'), 'someone else');
  assert.equal(await fs.readFile(target, 'utf8'), 'previous');
  await fs.unlink(temporary);
  let checks = 0;
  await assert.rejects(saveSiblingProjectFile(target, 'new', async () => {
    if (++checks === 2) throw new Error('changed destination');
  }, temporary), /changed destination/);
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  await saveSiblingProjectFile(target, 'new', async file => fs.stat(file), temporary);
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
  let bytes = 0;
  await assert.rejects(readBounded({ async read(_buffer, _offset, size) {
    bytes += size; return { bytesRead: size };
  } }, 16), /이하여야/);
  assert.equal(bytes, 17);
  const handle = await fs.open(target, 'r');
  try { assert.equal((await readBounded(handle, 3)).toString(), 'new'); } finally { await handle.close(); }
});

test('native saves protect new files and preserve the Windows destination DACL', async t => {
  const require = createRequire(import.meta.url);
  const { saveProjectFile } = require('../desktop/project-files.cjs');
  const { windowsPowerShell, windowsPowerShellEnv } = require('../desktop/windows-save.cjs');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'suspension-permissions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, '기존 프로젝트.json');
  const newTarget = path.join(directory, '새 프로젝트.json');
  const previous = '{"name":"기존"}', replacement = '{"name":"교체"}';
  await fs.writeFile(target, previous, { mode: 0o600 });
  async function validate(file, allowMissing) {
    try {
      const stat = await fs.lstat(file);
      assert.ok(stat.isFile());
      return stat;
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  function powerShell(script) {
    const executable = windowsPowerShell();
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    const result = spawnSync(executable, args, {
      cwd: path.dirname(executable), encoding: 'utf8',
      env: windowsPowerShellEnv({ SUSPENSION_ACL_FIXTURE: target, SUSPENSION_ACL_NEW: newTarget }),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  let before;
  if (process.platform === 'win32') {
    before = powerShell(`
$ErrorActionPreference = 'Stop'
$target = $env:SUSPENSION_ACL_FIXTURE
$acl = [IO.File]::GetAccessControl($target)
$acl.SetAccessRuleProtection($true, $false)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, 'Read', 'Allow'))
[IO.File]::SetAccessControl($target, $acl)
[IO.File]::GetAccessControl($target).GetSecurityDescriptorSddlForm('Access')
`);
    assert.match(before, /^D:P/);
    await assert.rejects(saveProjectFile(target, replacement, async () => null), /저장하지 못했습니다/);
    assert.equal(await fs.readFile(target, 'utf8'), previous);
    assert.deepEqual(await fs.readdir(directory), [path.basename(target)]);
  }
  await saveProjectFile(newTarget, replacement, validate);
  await saveProjectFile(target, replacement, validate);
  assert.equal(await fs.readFile(newTarget, 'utf8'), replacement);
  assert.equal(await fs.readFile(target, 'utf8'), replacement);
  assert.deepEqual((await fs.readdir(directory)).sort(), [path.basename(target), path.basename(newTarget)].sort());
  if (process.platform === 'win32') {
    assert.equal(powerShell("[IO.File]::GetAccessControl($env:SUSPENSION_ACL_FIXTURE).GetSecurityDescriptorSddlForm('Access')"), before);
    assert.equal(powerShell(`
$acl = [IO.File]::GetAccessControl($env:SUSPENSION_ACL_NEW)
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rules.Count -eq 1 -and $rules[0].IdentityReference -eq $user -and $rules[0].FileSystemRights -eq 'FullControl'
`), 'True');
  } else {
    for (const filename of [target, newTarget]) assert.equal((await fs.stat(filename)).mode & 0o077, 0);
  }
});
