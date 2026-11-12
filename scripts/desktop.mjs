import { checkedPath, readInput, copyInput, stagingDirectory, publishDirectory, writeArtifact, checkTree } from './safe-files.mjs';
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
for (const input of ['src', 'public', 'desktop', 'docs', 'node_modules/electron']) checkTree(root, path.join(root, input));
// Recent Electron npm packages download the runtime explicitly.
await run(process.execPath, [path.join(path.dirname(require.resolve('electron/package.json')), 'install.js')]);
await run(process.execPath, [path.join(root, 'scripts', 'clean-dist.mjs')]);
await run(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'), 'build']);
if (mode === 'start') await run(require('electron'), [root]);
else {
  const stage = stagingDirectory(root), app = path.join(stage, 'app'), output = path.join(stage, 'windows');
  const configuration = JSON.parse(readInput(root, path.join(root, 'electron-builder.json')));
  const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
  try {
    const inputs = [...new Set(['desktop', 'dist', 'package.json', ...configuration.extraResources.map(item => item.from)])];
    for (const input of inputs.filter(file => !inputs.some(parent => file !== parent && file.startsWith(parent + '/')))) {
      copyInput(root, path.join(root, input), path.join(app, input));
    }
    for (const dependency of Object.keys(packageInfo.dependencies || {})) {
      copyInput(root, path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency));
    }
    const electronDist = checkedPath(root, path.join(root, 'node_modules', 'electron', 'dist'));
    checkTree(root, electronDist);
    await run(process.execPath, [path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'), '--win', 'nsis', '--x64', '--config', path.join(root, 'electron-builder.json'), '--projectDir', app, `--config.electronDist=${electronDist}`, `--config.directories.output=${output}`, '--config.npmRebuild=false', '--publish', 'never']);
    publishDirectory(root, output, path.join(root, 'release', 'windows'));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  const { version } = packageInfo;
  const file = path.join(root, 'release', 'windows', `Suspension-Lab-Setup-${version}.exe`);
  writeArtifact(root, file + '.sha256', `${createHash('sha256').update(readInput(root, file)).digest('hex')}  ${path.basename(file)}\n`);
  console.log(`Installer: ${file}`);
}
