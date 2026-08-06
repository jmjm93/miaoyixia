// Guards against a setting being added without a control to change it or a line documenting
// it, and against the README quoting a range that the input doesn't actually allow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const html = read('extension/src/options/options.html');
const readme = read('README.md');

/**
 * Settings with no control and no README entry by design: internal state rather than a
 * preference. `lastModifier` only remembers which modifier to restore when the toolbar menu's
 * "require a key" item is ticked again — it is never set directly by the user.
 */
const INTERNAL = new Set(['lastModifier']);

/** The README phrase that documents each user-facing setting. */
const DOCUMENTED_AS = {
  enabled: 'Enabled',
  uiLanguage: 'Language',
  triggerKey: 'Trigger',
  hoverDelay: 'Hover delay',
  script: 'Show script',
  audio: 'Audio source',
  speechRate: 'Playback speed',
  ankiEnabled: 'add to Anki',
  ankiDeck: 'Deck',
  ankiModel: 'Note type',
  ankiFields: 'Fields',
  ankiTags: 'Tags',
  theme: 'Theme',
  fontSize: 'Font size',
  maxSenses: 'Senses shown before collapsing',
};

/** ankiFields is a table generated from the collection, not a single element. */
const GENERATED = new Set(['ankiFields']);

test('every user-facing setting has a control on the options page', () => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (INTERNAL.has(key) || GENERATED.has(key)) continue;
    assert.ok(html.includes(`id="${key}"`), `no control with id="${key}" in options.html`);
  }
});

test('every user-facing setting is documented in the README', () => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (INTERNAL.has(key)) continue;
    const phrase = DOCUMENTED_AS[key];
    assert.ok(phrase, `no expected README phrase registered for "${key}"`);
    assert.ok(readme.includes(phrase), `README does not mention "${phrase}" for setting "${key}"`);
  }
});

test('no control exists for a setting that does not exist', () => {
  // Catches a control left behind after a setting is renamed or removed.
  for (const id of html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"/g)) {
    const key = id[1];
    if (!(key in DEFAULT_SETTINGS)) {
      // Buttons and helper inputs are fine; only flag ids that look like settings.
      assert.ok(
        !Object.keys(DEFAULT_SETTINGS).some((k) => k.toLowerCase() === key.toLowerCase()),
        `control id="${key}" differs only by case from a setting`,
      );
    }
  }
});

test('ranges quoted in the README match the inputs', () => {
  const ranges = {
    hoverDelay: { min: '0', max: '1200', quoted: /0.{0,4}1200\s*ms|Hover delay/ },
    speechRate: { min: '0.5', max: '1.2', quoted: /0\.5.{0,4}1\.2×/ },
    fontSize: { min: '11', max: '22', quoted: /11.{0,4}22\s*px/ },
    maxSenses: { min: '1', max: '20', quoted: /1.{0,4}20/ },
  };

  for (const [key, { min, max, quoted }] of Object.entries(ranges)) {
    assert.ok(
      html.includes(`id="${key}" min="${min}" max="${max}"`),
      `${key} input is not min="${min}" max="${max}"`,
    );
    assert.match(readme, quoted, `README does not quote ${key}'s range`);
  }
});

test('the manifest declares an icon for both toolbar states', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  for (const size of [16, 32, 48, 128]) {
    assert.ok(manifest.action.default_icon[size], `manifest has no ${size}px action icon`);
    // The off variant is set at runtime, so it must exist even though the manifest omits it.
    assert.doesNotThrow(() => readFileSync(join(root, 'extension', `icons/icon-off-${size}.png`)));
  }
});

test('the manifest permissions cover what the code uses', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.ok(manifest.permissions.includes('storage'), 'settings need storage');
  assert.ok(manifest.permissions.includes('contextMenus'), 'the toolbar menu needs contextMenus');
  // Anki is opt-in, so localhost must be optional rather than granted up front.
  assert.ok(
    manifest.optional_host_permissions?.some((p) => p.includes('127.0.0.1:8765')),
    'AnkiConnect access should be an optional permission',
  );
  assert.ok(
    !manifest.host_permissions?.some((p) => p.includes('127.0.0.1')),
    'localhost must not be a required permission',
  );
});
