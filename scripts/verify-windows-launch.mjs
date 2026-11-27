import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const executable = path.resolve('release/windows/win-unpacked/Suspension Lab.exe');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'suspension-launch-'));
const child = spawn(executable, [], {
  env: { ...process.env, SUSPENSION_LAB_DATA_DIR: profile },
  windowsHide: true,
  stdio: 'ignore',
});
const closed = once(child, 'close');
closed.catch(() => {});
try {
  const deadline = Date.now() + 45000;
  let loaded = false;
  while (Date.now() < deadline) {
    assert.ok(child.pid && child.exitCode === null, 'Hardened desktop application exited at launch');
    const log = await fs.readFile(path.join(profile, 'desktop.log'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    assert.doesNotMatch(log, /Startup failed:|Load failed:/);
    if (log.includes('Application loaded')) {
      console.log('Hardened desktop executable loaded its application bundle');
      loaded = true;
      break;
    }
    await setTimeout(100);
  }
  assert.ok(loaded, 'Hardened desktop application did not load within 45 seconds');
} finally {
  if (child.pid && child.exitCode === null) child.kill();
  await closed.catch(() => {});
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
