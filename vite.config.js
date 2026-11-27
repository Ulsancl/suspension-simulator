import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

let publicDir;
const shellFiles = ['sw.js', 'manifest.webmanifest', 'app-icon.svg', 'app-icon-192.png', 'app-icon-512.png', 'THREE-LICENSE.txt'];

export default defineConfig({
  // Keep the independent simulator's HTML and dependency copies out of this app's optimizer.
  optimizeDeps: { entries: ['index.html'] },
  resolve: { dedupe: ['three'] },
  server:{watch:{ignored:['**/.security-stage-*', '**/.security-stage-*/**', '**/output/**','**/release/**','**/dist/**','**/transmission-lab/**','**/.codex/**']}},
  plugins: [{
    name: 'offline-asset-manifest',
    apply: 'build',
    configResolved(config) { publicDir = config.publicDir; },
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle).sort();
      const assets = names.filter(name => name.startsWith('assets/')).map(name => '/' + name);
      const hash = createHash('sha256');
      for (const name of names) {
        const file = bundle[name];
        hash.update(name).update(file.type === 'chunk' ? file.code : file.source);
      }
      for (const name of shellFiles) hash.update(name).update(fs.readFileSync(path.join(publicDir, name)));
      const worker = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker.replace('__BUILD_ID__', hash.digest('hex').slice(0, 24)) });
      this.emitFile({ type: 'asset', fileName: 'asset-manifest.json', source: JSON.stringify(assets) });
    },
  }],
  build: { emptyOutDir: false },
});
