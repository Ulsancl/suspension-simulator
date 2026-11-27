import { checkedPath, readInput, copyInput, stagingDirectory, publishDirectory, writeArtifact, checkTree } from './safe-files.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyAuthenticode, verifyFuses } from './windows-package.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['start', 'package', 'package-test', 'package-signed'].includes(mode)) throw new Error('Invalid desktop build mode');
const signed = mode === 'package-signed';
const inspector = mode === 'package-test';
const signerHash = process.env.SUSPENSION_SIGNER_SHA256;
const storeCertificate = process.env.SUSPENSION_CERTIFICATE_SHA1;
if (signed && (process.platform !== 'win32' || !/^[a-f0-9]{64}$/i.test(signerHash || ''))) {
  throw new Error('Signed packaging requires Windows and SUSPENSION_SIGNER_SHA256 for the approved certificate');
}
if (signed && storeCertificate && !/^[a-f0-9]{40}$/i.test(storeCertificate)) throw new Error('Invalid Windows store certificate identifier');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (!signed) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
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
await run(process.execPath, [path.join(root, 'scripts', 'build-web.mjs')]);
if (mode === 'start') await run(require('electron'), [root]);
else {
  const configuration = JSON.parse(readInput(root, path.join(root, 'electron-builder.json')));
  const destination = path.join(root, 'release', signed ? 'windows-signed' : inspector ? 'windows-test' : 'windows');
  const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
  const stage = stagingDirectory(root), app = path.join(stage, 'app'), output = path.join(stage, 'windows');
  const configPath = path.join(stage, 'electron-builder.json');
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
    configuration.forceCodeSigning = signed;
    if (signed && storeCertificate) configuration.win.signtoolOptions = { certificateSha1: storeCertificate };
    if (!signed) configuration.win.signExecutable = false;
    configuration.electronFuses.enableNodeCliInspectArguments = inspector;
    configuration.directories.output = output;
    configuration.electronDist = electronDist;
    configuration.npmRebuild = false;
    fs.writeFileSync(configPath, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
    await run(process.execPath, [
      path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'),
      '--win', 'nsis', '--x64', '--config', configPath, '--projectDir', app, '--publish', 'never',
    ]);
    const executable = path.join(output, 'win-unpacked', 'Suspension Lab.exe');
    const installer = path.join(output, 'Suspension-Lab-Setup-' + packageInfo.version + '.exe');
    await verifyFuses(executable, inspector);
    if (signed) verifyAuthenticode(executable, installer, signerHash);
    const checksum = createHash('sha256').update(readInput(root, installer)).digest('hex');
    writeArtifact(root, installer + '.sha256', checksum + '  ' + path.basename(installer) + '\n');
    publishDirectory(root, output, destination);
    console.log('Installer: ' + path.join(destination, path.basename(installer)));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
