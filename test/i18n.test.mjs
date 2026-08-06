// Guards the string catalogue against the ways a translation quietly rots: a key added to one
// language and not the other, a placeholder dropped in translation, a t() call naming a key that
// doesn't exist, or a data-i18n attribute pointing at nothing.
//
// The static scans are the valuable part. A missing string doesn't throw -- t() falls back to
// English and then to the key itself -- so without them a typo would ship as a visibly wrong
// label that nobody notices until a user reports it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { CATALOGUE, FALLBACK, LANGUAGES, language, setLanguage, t, tn } from '../extension/src/lib/i18n.js';
import { TOKENS } from '../extension/src/lib/anki-fields.js';
import { actionTitle, menuState, MENU } from '../extension/src/lib/action-state.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const LANGS = Object.keys(LANGUAGES);
const placeholders = (text) => [...String(text).matchAll(/\$(\d)/g)].map((m) => m[1]).sort();

/** Every .js file under extension/src, so a new one can't dodge the key scan. */
function sourceFiles(dir = 'extension/src', found = []) {
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) sourceFiles(path, found);
    else if (name.endsWith('.js')) found.push(path.split('\\').join('/'));
  }
  return found;
}

test('the catalogue offers exactly the languages it claims to', () => {
  assert.deepEqual(Object.keys(CATALOGUE).sort(), LANGS.sort());
  assert.ok(LANGS.includes(FALLBACK), 'the fallback language must itself be in the catalogue');
});

test('every language has every key, and none has extras', () => {
  const expected = Object.keys(CATALOGUE[FALLBACK]).sort();
  for (const lang of LANGS) {
    const actual = Object.keys(CATALOGUE[lang]).sort();
    const missing = expected.filter((k) => !actual.includes(k));
    const extra = actual.filter((k) => !expected.includes(k));
    assert.deepEqual(missing, [], `${lang} is missing: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${lang} has keys ${FALLBACK} doesn't: ${extra.join(', ')}`);
  }
});

test('no string is empty, and none is left as the English original by accident', () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(CATALOGUE[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} is not a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test('translations keep every placeholder the English string has', () => {
  // A dropped $1 is the worst kind of translation bug: the string reads fine but silently
  // loses the word, the deck name or the error it was supposed to be reporting.
  for (const lang of LANGS) {
    if (lang === FALLBACK) continue;
    for (const [key, english] of Object.entries(CATALOGUE[FALLBACK])) {
      assert.deepEqual(
        placeholders(CATALOGUE[lang][key]),
        placeholders(english),
        `${lang}.${key} does not use the same placeholders as ${FALLBACK}.${key}`,
      );
    }
  }
});

test('every key named in a t() or tn() call exists', () => {
  // Deliberately a text scan rather than a runtime check: most of these calls only fire on a
  // code path that needs Anki, a missing voice or a failed fetch.
  const CALL = /(?<![\w.$])tn?\('([A-Za-z0-9_]+)'/g;
  const known = new Set(Object.keys(CATALOGUE[FALLBACK]));

  for (const file of sourceFiles()) {
    for (const [, key] of read(file).matchAll(CALL)) {
      assert.ok(known.has(key), `${file} asks for the string "${key}", which the catalogue lacks`);
    }
  }
});

test('every data-i18n attribute on the options page names a real key', () => {
  const html = read('extension/src/options/options.html');
  const known = new Set(Object.keys(CATALOGUE[FALLBACK]));

  const found = [...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(found.length > 20, 'suspiciously few translated nodes — has the markup been reverted?');
  for (const key of found) {
    assert.ok(known.has(key), `options.html marks a node "${key}", which the catalogue lacks`);
  }
});

test('every Anki field token has a label in the catalogue', () => {
  for (const token of TOKENS) {
    assert.ok(token.labelKey, `token "${token.id}" has no labelKey`);
    assert.ok(
      CATALOGUE[FALLBACK][token.labelKey],
      `token "${token.id}" names "${token.labelKey}", which the catalogue lacks`,
    );
  }
});

test('the manifest only references locale messages that exist', () => {
  const manifest = read('extension/manifest.json');
  const refs = [...manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, 'the manifest should localise at least its name and description');

  const declared = JSON.parse(manifest).default_locale;
  assert.ok(declared, 'default_locale is required once __MSG_ is used');

  for (const lang of LANGS) {
    const messages = JSON.parse(read(`extension/_locales/${lang}/messages.json`));
    for (const ref of refs) {
      assert.ok(messages[ref]?.message, `_locales/${lang} has no message "${ref}"`);
    }
  }
  assert.ok(LANGS.includes(declared), `default_locale "${declared}" has no _locales directory`);
});

test('the store listing summary fits the 132 characters Chrome allows', () => {
  for (const lang of LANGS) {
    const { extDescription } = JSON.parse(read(`extension/_locales/${lang}/messages.json`));
    assert.ok(
      extDescription.message.length <= 132,
      `${lang} description is ${extDescription.message.length} characters`,
    );
  }
});

test('setLanguage narrows a regional tag and rejects an unknown one', () => {
  assert.equal(setLanguage('es'), 'es');
  assert.equal(setLanguage('es-ES'), 'es');
  assert.equal(setLanguage('es_419'), 'es');
  assert.equal(setLanguage('pt-BR'), FALLBACK);
  assert.equal(setLanguage(undefined), FALLBACK);
  // No chrome.i18n in node, so 'auto' can only resolve to the fallback here.
  assert.equal(setLanguage('auto'), FALLBACK);
  assert.equal(language(), FALLBACK);
});

test('t substitutes positionally and leaves an unfilled placeholder visible', () => {
  setLanguage('en');
  assert.equal(t('play', '热门'), 'Play 热门');
  assert.equal(t('ankiAddedCreated', 'Mining', 'a deck'), 'Added to Mining (created a deck)');
  // An argument the caller forgot shows as $1 rather than "undefined".
  assert.equal(t('play'), 'Play $1');
});

test('an unknown key falls back to English, then to the key itself', () => {
  setLanguage('es');
  // Simulating a half-finished translation without editing the catalogue on disk.
  const original = CATALOGUE.es.play;
  delete CATALOGUE.es.play;
  try {
    assert.equal(t('play', '猫'), 'Play 猫', 'should fall back to the English string');
  } finally {
    CATALOGUE.es.play = original;
  }
  assert.equal(t('noSuchKeyAnywhere'), 'noSuchKeyAnywhere');
  setLanguage(FALLBACK);
});

test('tn picks the singular form only at exactly one', () => {
  setLanguage('en');
  assert.equal(tn('ankiConnected', 1, 6, 1), 'Connected — AnkiConnect v6, 1 deck');
  assert.equal(tn('ankiConnected', 3, 6, 3), 'Connected — AnkiConnect v6, 3 decks');
  assert.equal(tn('ankiConnected', 0, 6, 0), 'Connected — AnkiConnect v6, 0 decks');

  setLanguage('es');
  assert.equal(tn('ankiConnected', 1, 6, 1), 'Conectado — AnkiConnect v6, 1 mazo');
  assert.equal(tn('ankiConnected', 3, 6, 3), 'Conectado — AnkiConnect v6, 3 mazos');
  setLanguage(FALLBACK);
});

test('the toolbar tooltip and menu follow the selected language', () => {
  const settings = { enabled: true, triggerKey: 'Shift', lastModifier: 'Shift' };

  setLanguage('en');
  assert.match(actionTitle(settings), /on, hold Shift/);
  assert.equal(menuState(settings)[MENU.modifier].title, 'Require Shift to look up');

  setLanguage('es');
  assert.match(actionTitle(settings), /activado, mantén Shift/);
  assert.match(actionTitle({ ...settings, enabled: false }), /desactivado/);
  assert.equal(menuState(settings)[MENU.modifier].title, 'Requerir Shift para buscar');
  // Key names stay in English on purpose -- they're what's printed on the keyboard.
  assert.match(actionTitle({ ...settings, triggerKey: 'Control' }), /Ctrl/);

  setLanguage(FALLBACK);
});

test('messages.js stays loadable as a content script', () => {
  // The manifest loads it as a classic script, where `import`/`export` is a syntax error that
  // would take the whole content-script bundle down with it.
  const source = read('extension/src/lib/messages.js');
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m, 'messages.js must not use module syntax');
  assert.ok(source.includes('globalThis.zhI18n'), 'messages.js must publish itself on globalThis');

  const manifest = JSON.parse(read('extension/manifest.json'));
  const js = manifest.content_scripts[0].js;
  assert.equal(js[0], 'src/lib/messages.js', 'the catalogue must load before anything reads it');
});

test('every language is offered on the options page', () => {
  const html = read('extension/src/options/options.html');
  for (const lang of LANGS) {
    assert.match(
      html,
      new RegExp(`<option value="${lang}"`),
      `options.html has no <option> for "${lang}"`,
    );
  }
  assert.match(html, /<option value="auto"/, 'the language control needs an "auto" choice');
});

test('the packaged extension carries a locale directory per language', () => {
  for (const lang of LANGS) {
    const path = `extension/_locales/${lang}/messages.json`;
    assert.doesNotThrow(() => read(path), `${path} is missing`);
    assert.equal(relative(root, join(root, path)).split('\\').join('/'), path);
  }
});
