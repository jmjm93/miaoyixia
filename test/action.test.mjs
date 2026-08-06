// Tests the toolbar button's derived state. The labelling rules are the fiddly part: the
// modifier menu item has to name a key that, in hover mode, isn't currently in use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MENU,
  NAME,
  actionTitle,
  badge,
  iconPaths,
  menuState,
  modifierLabel,
  namedModifier,
  rememberModifier,
  requiresModifier,
  trigger,
} from '../extension/src/lib/action-state.js';
import { DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';

const on = (patch = {}) => ({ ...DEFAULT_SETTINGS, ...patch });

test('modifier names follow the keyboard, not the spec', () => {
  assert.equal(modifierLabel('Shift'), 'Shift');
  assert.equal(modifierLabel('Control'), 'Ctrl');
  assert.equal(modifierLabel('Alt'), 'Alt');
  assert.equal(modifierLabel('Meta', false), 'Win');
  assert.equal(modifierLabel('Meta', true), 'Cmd');
});

test('hover mode is the absence of a required modifier', () => {
  assert.equal(requiresModifier(on({ triggerKey: 'Shift' })), true);
  assert.equal(requiresModifier(on({ triggerKey: 'none' })), false);
});

test('the icon greys out when switched off', () => {
  assert.match(iconPaths(true)[16], /icon-16\.png$/);
  assert.match(iconPaths(false)[16], /icon-off-16\.png$/);
  assert.deepEqual(Object.keys(iconPaths(true)), ['16', '32', '48', '128']);
});

test('the badge appears only while off', () => {
  assert.equal(badge(on({ enabled: true })).text, '');
  assert.equal(badge(on({ enabled: false })).text, 'off');
});

test('the tooltip says both the state and what a click will do', () => {
  const off = actionTitle(on({ enabled: false }));
  assert.match(off, /— off/);
  assert.match(off, /Click to turn on/);

  const shift = actionTitle(on({ enabled: true, triggerKey: 'Control' }));
  assert.match(shift, /hold Ctrl/);
  assert.match(shift, /Click to turn off/);

  assert.match(actionTitle(on({ triggerKey: 'none' })), /hover, no key needed/);
  assert.ok(actionTitle(on()).startsWith(NAME));
});

test('in hover mode the menu names the key it would restore, not "none"', () => {
  const settings = on({ triggerKey: 'none', lastModifier: 'Alt' });
  assert.equal(namedModifier(settings), 'Alt');

  const menu = menuState(settings);
  assert.equal(menu[MENU.modifier].title, 'Require Alt to look up');
  assert.equal(menu[MENU.modifier].checked, false);
});

test('with a modifier active the menu names that one', () => {
  const menu = menuState(on({ triggerKey: 'Control', lastModifier: 'Shift' }));
  assert.equal(menu[MENU.modifier].title, 'Require Ctrl to look up');
  assert.equal(menu[MENU.modifier].checked, true);
});

test('falls back to Shift when nothing has been remembered', () => {
  assert.equal(namedModifier({ triggerKey: 'none', lastModifier: '' }), 'Shift');
});

test('the modifier item is disabled while the extension is off', () => {
  assert.equal(menuState(on({ enabled: false }))[MENU.modifier].enabled, false);
  assert.equal(menuState(on({ enabled: true }))[MENU.modifier].enabled, true);
});

test('the enabled checkbox mirrors the setting', () => {
  assert.equal(menuState(on({ enabled: true }))[MENU.enabled].checked, true);
  assert.equal(menuState(on({ enabled: false }))[MENU.enabled].checked, false);
});

test('unticking the modifier drops straight to hover mode', () => {
  assert.deepEqual(trigger(on({ triggerKey: 'Alt' }), false), { triggerKey: 'none' });
});

test('ticking it restores the remembered modifier rather than a fixed default', () => {
  assert.deepEqual(trigger(on({ triggerKey: 'none', lastModifier: 'Meta' }), true), { triggerKey: 'Meta' });
  assert.deepEqual(trigger({ triggerKey: 'none', lastModifier: '' }, true), { triggerKey: 'Shift' });
});

test('a round trip through hover mode preserves the modifier', () => {
  // The whole point of lastModifier: triggerKey alone forgets once it has been set to 'none'.
  let settings = on({ triggerKey: 'Control', lastModifier: 'Control' });
  settings = { ...settings, ...trigger(settings, false) };
  assert.equal(settings.triggerKey, 'none');
  settings = { ...settings, ...trigger(settings, true) };
  assert.equal(settings.triggerKey, 'Control');
});

test('choosing a modifier anywhere updates what will be remembered', () => {
  assert.deepEqual(rememberModifier(on({ triggerKey: 'Alt', lastModifier: 'Shift' })), { lastModifier: 'Alt' });
});

test('nothing is written when there is nothing to remember', () => {
  // Hover mode must not overwrite the memory, or ticking back would have nothing to restore.
  assert.equal(rememberModifier(on({ triggerKey: 'none', lastModifier: 'Alt' })), null);
  // Nor should an unchanged value cause a redundant write, which would loop via onChanged.
  assert.equal(rememberModifier(on({ triggerKey: 'Alt', lastModifier: 'Alt' })), null);
});
