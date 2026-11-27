import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

test('non-shell navigations cannot replace the offline application', async () => {
  const listeners = {}, writes = [], origin = 'https://app.invalid';
  let response, pending, background = [];
  const cache = { put: async (...args) => writes.push(args), match: async request => request === '/' ? 'offline shell' : undefined };
  const context = {
    self: { location: { origin }, addEventListener: (name, listener) => { listeners[name] = listener; } },
    URL, Response, console,
    caches: { open: async () => cache, match: async () => 'offline shell' },
    fetch: async () => { if (response instanceof Error) throw response; return response; }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  async function request(path, type = 'text/html', overrides = {}, mode = 'navigate') {
    response = { ok: true, type: 'basic', url: origin + path, redirected: false,
      headers: new Headers({ 'content-type': type }), clone() { return this; }, ...overrides };
    listeners.fetch({ request: { method: 'GET', mode, url: origin + path },
      respondWith(value) { pending = value; }, waitUntil(value) { background.push(value); } });
    await pending; await Promise.all(background); background = [];
  }
  await request('/'); assert.equal(writes.length, 1);
  await request('/sw.js', 'text/javascript');
  await request('/manifest.webmanifest', 'application/manifest+json');
  await request('/', 'application/json');
  await request('/?resource=other');
  await request('/', 'text/html', { redirected: true, url: origin + '/other' });
  await request('/', 'text/html', { url: 'https://other.invalid/' });
  assert.equal(writes.length, 1);
  await request('/assets/shell.js', 'text/javascript', {}, 'cors');
  await request('/assets/shell.js?version=other', 'text/javascript', {}, 'cors');
  await request('/assets/other.js', 'text/javascript', { redirected: true }, 'cors');
  await request('/assets/other.js', 'text/javascript', { type: 'opaque' }, 'cors');
  assert.equal(writes.length, 2);
  response = new Error('offline');
  listeners.fetch({ request: { method: 'GET', mode: 'navigate', url: origin + '/' }, respondWith(value) { pending = value; } });
  assert.equal(await pending, 'offline shell');
});
