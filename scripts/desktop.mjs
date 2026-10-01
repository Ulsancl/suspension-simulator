import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['start', 'package'].includes(mode)) throw new Error('Use start or package');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)));
  });
}
// Recent Electron npm packages download the runtime explicitly.
await run(process.execPath, [path.join(path.dirname(require.resolve('electron/package.json')), 'install.js')]);
await run(process.execPath, [path.join(root, 'scripts', 'clean-dist.mjs')]);
await run(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'), 'build']);
if (mode === 'start') await run(require('electron'), [root]);
else {
  await run(process.execPath, [path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'), '--win', 'nsis', '--x64', '--config', 'electron-builder.json']);
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const file = path.join(root, 'release', 'windows', `Suspension-Lab-Setup-${version}.exe`);
  fs.writeFileSync(file + '.sha256', `${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}\n`);
  console.log(`Installer: ${file}`);
}
