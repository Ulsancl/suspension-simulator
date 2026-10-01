import { defineConfig } from 'vite';

export default defineConfig({
  // Keep the independent simulator's HTML and dependency copies out of this app's optimizer.
  optimizeDeps: { entries: ['index.html'] },
  resolve: { dedupe: ['three'] },
  server:{watch:{ignored:['**/output/**','**/release/**','**/dist/**','**/transmission-lab/**','**/.codex/**']}},
  plugins: [{
    name: 'offline-asset-manifest',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(name => name.startsWith('assets/')).map(name => '/' + name);
      this.emitFile({ type: 'asset', fileName: 'asset-manifest.json', source: JSON.stringify(assets) });
    },
  }],
  build: {
    // Node 24.12 on Windows can abort in recursive rmSync with Korean paths.
    // prebuild clears only this project's dist with individual unlink/rmdir calls.
    // Fixed upstream in Node 24.13.1: https://github.com/nodejs/node/pull/61108
    emptyOutDir: false,
  },
});
