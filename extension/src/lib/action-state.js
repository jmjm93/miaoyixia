// Everything the toolbar button and its context menu display, derived from settings.
//
// Kept pure and separate from the service worker so the labelling rules -- which are fiddly,
// because the modifier menu item has to name a key that isn't currently in use -- can be
// tested without a browser.

import { HOVER_ONLY } from './settings.js';

export const NAME = '瞄一下';

/** Menu item ids, also used as the contextMenus ids. */
export const MENU = {
  enabled: 'toggle-enabled',
  modifier: 'toggle-modifier',
  options: 'open-options',
};

/** What each modifier is called on the user's keyboard. */
export function modifierLabel(key, isMac = false) {
  if (key === 'Control') return 'Ctrl';
  if (key === 'Meta') return isMac ? 'Cmd' : 'Win';
  return key;
}

export function requiresModifier(settings) {
  return settings.triggerKey !== HOVER_ONLY;
}

/**
 * The modifier the menu item should name.
 *
 * While in hover mode there is no current modifier, so the item names the one that ticking it
 * would restore -- otherwise it would read "Require none to look up".
 */
export function namedModifier(settings) {
  return requiresModifier(settings) ? settings.triggerKey : settings.lastModifier || 'Shift';
}

/** Tooltip: says what the state is and what a click will do, since click toggles. */
export function actionTitle(settings, isMac = false) {
  if (!settings.enabled) return `${NAME} — off\nClick to turn on`;
  const how = requiresModifier(settings)
    ? `hold ${modifierLabel(settings.triggerKey, isMac)}`
    : 'hover, no key needed';
  return `${NAME} — on, ${how}\nClick to turn off`;
}

/** Icon paths per size, for chrome.action.setIcon. */
export function iconPaths(enabled) {
  const suffix = enabled ? '' : '-off';
  return {
    16: `icons/icon${suffix}-16.png`,
    32: `icons/icon${suffix}-32.png`,
    48: `icons/icon${suffix}-48.png`,
    128: `icons/icon${suffix}-128.png`,
  };
}

/** A badge only while off: the grey icon says it too, but this is unmissable. */
export function badge(settings) {
  return settings.enabled ? { text: '', color: '#6b7280' } : { text: 'off', color: '#6b7280' };
}

/** Titles and checkbox states for the action's context menu. */
export function menuState(settings, isMac = false) {
  return {
    [MENU.enabled]: { title: 'Enabled', checked: Boolean(settings.enabled) },
    [MENU.modifier]: {
      title: `Require ${modifierLabel(namedModifier(settings), isMac)} to look up`,
      checked: requiresModifier(settings),
      // Meaningless while the extension is off.
      enabled: Boolean(settings.enabled),
    },
  };
}

/**
 * The settings patch for ticking or unticking the modifier item.
 *
 * Unticking drops to hover mode. Ticking restores the remembered modifier -- which is why
 * `lastModifier` exists: `triggerKey` alone cannot remember what it was before 'none'.
 */
export function trigger(settings, requireIt) {
  if (!requireIt) return { triggerKey: HOVER_ONLY };
  return { triggerKey: settings.lastModifier || 'Shift' };
}

/**
 * Keeps `lastModifier` tracking whichever modifier was chosen most recently, wherever it was
 * changed from. Returns a patch, or null when nothing needs writing.
 */
export function rememberModifier(settings) {
  const key = settings.triggerKey;
  if (key === HOVER_ONLY || key === settings.lastModifier) return null;
  return { lastModifier: key };
}
