// Drives the real service worker with a mocked chrome API.
//
// The packaged extension can't be loaded automatically (current Chrome stable refuses
// --load-extension), so this is the only way to exercise the worker's own wiring: that clicking
// the toolbar button flips the setting, and that the resulting storage change actually repaints
// the icon with the off artwork.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installDictStub } from './dict-stub.mjs';
import { DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

/** Records every chrome.* call the worker makes, and captures its event listeners. */
function mockChrome(stored = {}) {
  const calls = [];
  const listeners = {};
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve();
  };
  const capture = (key) => ({ addListener: (fn) => { listeners[key] = fn; } });

  const chrome = {
    action: {
      setIcon: record('setIcon'),
      setTitle: record('setTitle'),
      setBadgeText: record('setBadgeText'),
      setBadgeBackgroundColor: record('setBadgeBackgroundColor'),
      onClicked: capture('actionClicked'),
    },
    contextMenus: {
      create: record('menuCreate'),
      update: record('menuUpdate'),
      removeAll: (cb) => { calls.push({ name: 'menuRemoveAll', args: [] }); cb?.(); },
      onClicked: capture('menuClicked'),
    },
    runtime: {
      getURL: (p) => `stub:${p}`,
      openOptionsPage: record('openOptions'),
      onMessage: capture('message'),
      onInstalled: capture('installed'),
      onStartup: capture('startup'),
    },
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...stored }),
        set: async (patch) => {
          calls.push({ name: 'storageSet', args: [patch] });
          Object.assign(stored, patch);
          // Mirror the browser: a write notifies listeners.
          const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }]));
          await listeners.storageChanged?.(changes, 'sync');
        },
      },
      onChanged: capture('storageChanged'),
    },
  };

  return { chrome, calls, listeners, stored, last: (name) => calls.filter((c) => c.name === name).at(-1) };
}

let mock;

before(async () => {
  installDictStub();
  mock = mockChrome();
  globalThis.chrome = mock.chrome;
  // The worker reads navigator.userAgent to name the Meta key.
  globalThis.navigator ??= { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' };

  await import('../extension/src/background/service-worker.js');
  await new Promise((r) => setTimeout(r, 20)); // let the top-level refreshAction settle
});

test('the worker registers the toolbar listeners it needs', () => {
  for (const key of ['actionClicked', 'menuClicked', 'storageChanged', 'installed', 'startup']) {
    assert.ok(mock.listeners[key], `no listener registered for ${key}`);
  }
});

test('it paints the awake icon on startup', () => {
  const icon = mock.last('setIcon');
  assert.ok(icon, 'setIcon was never called');
  assert.equal(icon.args[0].path[16], '/icons/icon-16.png');
});

test('every icon path the worker asks for exists on disk', () => {
  // A path Chrome cannot load makes setIcon fail and the icon silently stay as it was, which is
  // exactly how the leading-slash bug presented.
  for (const call of mock.calls.filter((c) => c.name === 'setIcon')) {
    for (const [size, path] of Object.entries(call.args[0].path)) {
      assert.ok(path.startsWith('/'), `${path} is not anchored to the extension root`);
      // Paths are root-relative, so resolve them the way the browser would.
      assert.ok(existsSync(join(extensionDir, path.slice(1))), `${path} (size ${size}) does not exist`);
    }
  }
});

test('clicking the button flips enabled and repaints with the off artwork', async () => {
  assert.equal(mock.stored.enabled ?? DEFAULT_SETTINGS.enabled, true);

  await mock.listeners.actionClicked();

  assert.deepEqual(mock.last('storageSet').args[0], { enabled: false });

  const icon = mock.last('setIcon');
  assert.equal(icon.args[0].path[16], '/icons/icon-off-16.png', 'off icon not applied');
  assert.equal(icon.args[0].path[32], '/icons/icon-off-32.png');
  assert.match(mock.last('setTitle').args[0].title, /— off/);
  // The artwork carries the state; a badge would sit on top of it.
  assert.equal(mock.last('setBadgeText').args[0].text, '');
});

test('clicking again restores the awake icon', async () => {
  await mock.listeners.actionClicked();
  assert.deepEqual(mock.last('storageSet').args[0], { enabled: true });
  assert.equal(mock.last('setIcon').args[0].path[16], '/icons/icon-16.png');
});

test('the badge is always cleared, never drawn over the artwork', async () => {
  // Also clears anything a previous version of the extension may have left showing.
  const badges = mock.calls.filter((c) => c.name === 'setBadgeText');
  assert.ok(badges.length > 0, 'the badge is never cleared');
  for (const call of badges) assert.equal(call.args[0].text, '');
  assert.equal(mock.calls.filter((c) => c.name === 'setBadgeBackgroundColor').length, 0);
});

test('the menu checkbox toggles the same setting', async () => {
  await mock.listeners.menuClicked({ menuItemId: 'toggle-enabled', checked: false });
  assert.deepEqual(mock.last('storageSet').args[0], { enabled: false });
  assert.equal(mock.last('setIcon').args[0].path[16], '/icons/icon-off-16.png');

  await mock.listeners.menuClicked({ menuItemId: 'toggle-enabled', checked: true });
  assert.equal(mock.last('setIcon').args[0].path[16], '/icons/icon-16.png');
});

test('unticking the modifier item drops to hover mode without disabling', async () => {
  await mock.listeners.menuClicked({ menuItemId: 'toggle-modifier', checked: false });
  assert.equal(mock.stored.triggerKey, 'none');
  assert.equal(mock.stored.enabled, true, 'the trigger change must not disable the extension');
});

test('the options item opens the options page', async () => {
  await mock.listeners.menuClicked({ menuItemId: 'open-options' });
  assert.ok(mock.last('openOptions'), 'openOptionsPage was not called');
});
