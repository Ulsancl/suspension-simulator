import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWindowState } from '../desktop/window-state.cjs';

const area = { width: 1920, height: 1080 };
test('corrupt JSON values do not prevent window creation', () => {
  for (const value of [null, [], true, 42, 'invalid', { width: -2, height: '1000', maximized: 'yes' }]) {
    assert.deepEqual(normalizeWindowState(value, area), {
      width: 1440, height: 1000, minWidth: 960, minHeight: 640, maximized: false,
    });
  }
});
test('valid saved dimensions survive and fit the current monitor', () => {
  assert.deepEqual(normalizeWindowState({ width: 1200, height: 800, maximized: true }, area), {
    width: 1200, height: 800, minWidth: 960, minHeight: 640, maximized: true,
  });
  assert.deepEqual(normalizeWindowState({ width: 1e300, height: 1 }, { width: 800, height: 600 }), {
    width: 800, height: 600, minWidth: 800, minHeight: 600, maximized: false,
  });
});

