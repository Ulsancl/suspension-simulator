import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readPort(name, fallback) {
  const port = Number(process.env[name] || fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${name} must be 1024–65535`);
  return port;
}
const devPort = readPort('SUSPENSION_CI_DEV_PORT', 5173);
const releasePort = readPort('SUSPENSION_CI_RELEASE_PORT', 5175);
if (devPort === releasePort) throw new Error('Development and release servers need different ports');
const devURL = `http://127.0.0.1:${devPort}`;
const releaseURL = `http://127.0.0.1:${releasePort}`;
const suites = [
  ['browser interaction', 'tests/browser.test.mjs', devURL],
  ['experiment preservation and recovery', 'tests/experiment-migration-browser.test.mjs', devURL],
  ['first guided A/B experiment', 'tests/consumer-guide-browser.test.mjs', devURL],
  ['product workflows', 'tests/product.test.mjs', devURL],
  ['dashboard', 'tests/dashboard.test.mjs', devURL],
  ['layout', 'tests/design.test.mjs', devURL],
  ['offline web release', 'tests/offline-release.test.mjs', releaseURL],
];

function startNode(script, env) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true,
  });
  const running = { child, outcome: null };
  running.completion = new Promise(resolve => {
    child.once('error', error => { running.outcome = { error }; resolve(running.outcome); });
    child.once('close', (code, signal) => {
      running.outcome ??= { code, signal };
      resolve(running.outcome);
    });
  });
  return running;
}
function assertRunning(running, label) {
  if (running.outcome) throw running.outcome.error || new Error(`${label} exited with code ${running.outcome.code} (signal ${running.outcome.signal || 'none'})`);
}
async function waitForRelease(running) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    assertRunning(running, 'Release server');
    try {
      const response = await fetch(releaseURL, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.ok) { assertRunning(running, 'Release server'); return; }
    } catch { /* The child may still be binding its port. */ }
    await delay(250);
  }
  assertRunning(running, 'Release server');
  throw new Error(`Release server unavailable after 45 seconds: ${releaseURL}`);
}
async function stopNode(running) {
  if (!running || running.outcome) return;
  running.child.kill();
  let timer;
  try {
    await Promise.race([
      running.completion,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Release server did not stop')), 5_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

let devServer, releaseServer;
try {
  devServer = await createServer({ root, server: { host: '127.0.0.1', port: devPort, strictPort: true } });
  await devServer.listen();
  releaseServer = startNode('scripts/serve-release.mjs', { SUSPENSION_PORT: String(releasePort) });
  await waitForRelease(releaseServer);
  for (const [label, script, url] of suites) {
    assertRunning(releaseServer, 'Release server');
    console.log(`\nVerify ${label}: ${url}`);
    const result = await startNode(script, { SUSPENSION_TEST_URL: url }).completion;
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`${script} exited with code ${result.code} (signal ${result.signal || 'none'})`);
  }
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([devServer?.close(), stopNode(releaseServer)]);
  for (const result of cleanup) if (result.status === 'rejected') {
    console.error(result.reason);
    process.exitCode = 1;
  }
}
