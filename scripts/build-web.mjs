import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { checkTree, copyInput, publishDirectory, stagingDirectory } from './safe-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'dist');
if (fs.lstatSync(destination, { throwIfNoEntry: false })) checkTree(root, destination);
checkTree(root, path.join(root, 'node_modules', 'three'));

const stage = stagingDirectory(root);
const output = path.join(stage, 'dist');
try {
  for (const input of ['index.html', 'package.json', 'vite.config.js', 'src', 'public']) {
    copyInput(root, path.join(root, input), path.join(stage, input));
  }
  await build({
    root: stage,
    configFile: path.join(stage, 'vite.config.js'),
    envDir: false,
    css: { postcss: { plugins: [] } },
    build: { outDir: output, emptyOutDir: false },
  });
  checkTree(root, output);
  publishDirectory(root, output, destination);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
