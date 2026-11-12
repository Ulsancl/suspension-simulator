import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('release launcher fails on an occupied origin before announcing or opening it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'index.html'), '<h1>App</h1>');
  fs.copyFileSync(new URL('../scripts/serve-release.mjs', import.meta.url), path.join(root, 'serve.mjs'));
  const attacker = http.createServer((_request, response) => response.end('Suspension Lab'));
  await new Promise(resolve => attacker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => attacker.close(resolve)));
  const child = spawn(process.execPath, [path.join(root, 'serve.mjs'), '--open'], {
    env: { ...process.env, SUSPENSION_PORT: String(attacker.address().port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1); assert.match(stderr, /busy/); assert.equal(stdout.includes('http://'), false);
});
