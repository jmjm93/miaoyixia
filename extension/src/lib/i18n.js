// ES module face of the string catalogue.
//
// `messages.js` has to stay free of module syntax so the manifest can load it as a content
// script, which means it publishes itself on globalThis instead of exporting. This file imports
// it for that side effect and re-exports it properly, so the service worker, the options page
// and the lib modules can just `import { t } from '../lib/i18n.js'` like normal.
//
// The wrappers delegate on every call rather than capturing the functions once, because
// setLanguage() mutates state inside messages.js -- binding early would freeze the language.

import './messages.js';

/** @type {{t: Function, tn: Function, setLanguage: Function, language: Function, LANGUAGES: object, FALLBACK: string, CATALOGUE: object}} */
const i18n = globalThis.zhI18n;

export const { LANGUAGES, FALLBACK, CATALOGUE } = i18n;

export const t = (key, ...subs) => i18n.t(key, ...subs);
export const tn = (key, n, ...subs) => i18n.tn(key, n, ...subs);
export const setLanguage = (setting) => i18n.setLanguage(setting);
export const language = () => i18n.language();
