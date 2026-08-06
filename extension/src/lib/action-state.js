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

/**
 * Icon paths for chrome.action.setIcon.
 *
 * The leading slash is load-bearing. setIcon resolves a relative path against the URL of
 * whatever called it, and the caller is the service worker at src/background/ -- so
 * "icons/icon-16.png" is fetched as "src/background/icons/icon-16.png" and fails with
 * "Failed to fetch", leaving the icon silently unchanged. Manifest paths resolve from the
 * extension root instead, so the identical-looking string works there, which makes this
 * especially easy to get wrong. A leading slash anchors to the root from any caller.
 *
 * Only the toolbar sizes are offered: 16, and 32 for 2x displays. Chrome scales between them
 * for other densities, and the 48/128 files exist for the manifest's `icons` block (extensions
 * page, store listing) rather than for the button.
 */
export function iconPaths(enabled) {
  const suffix = enabled ? '' : '-off';
  return {
    16: `/icons/icon${suffix}-16.png`,
    32: `/icons/icon${suffix}-32.png`,
  };
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
