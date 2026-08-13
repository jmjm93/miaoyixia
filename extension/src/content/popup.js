// The lookup popup: one tab per candidate length, longest first.
//
// Lives in a shadow root, so page CSS can't restyle it and its own CSS can't leak out. The
// root is `open` rather than `closed`: closing it would only stop page JS from reading the
// contents, which is weak protection given the page can hook attachShadow or simply watch the
// host element -- and it costs real inspectability in DevTools and in tests.
//
// A single instance is created up front and reused, so the stylesheet is already loaded by the
// time the user first triggers a lookup.
//
// The cards themselves are drawn by EntryView, which the snip result window shares -- so what's
// left here is only what makes this a *popup*: the shadow root, the hint bar, the gloss warning,
// and anchoring the whole thing to a word without falling off the screen.

(() => {
  const zh = (globalThis.zhDic ??= {});
  // messages.js is loaded ahead of this file by the manifest, so the catalogue is already there.
  const { t } = globalThis.zhI18n;

  const MARGIN = 12; // gap between the hovered word and the popup
  const EDGE = 8; // keep this far from the viewport edge

  class Popup {
    #host;
    #root;
    #card;
    #view;
    #hint;
    #warn;
    /** Set when a gloss language is chosen but its data hasn't been downloaded yet. */
    #glossPending = false;
    #settings;

    constructor(settings) {
      this.#settings = settings;

      this.#host = document.createElement('div');
      // Marks the popup so hover resolution ignores its own text.
      this.#host.dataset.zhDicHost = '';
      this.#root = this.#host.attachShadow({ mode: 'open' });

      const style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = chrome.runtime.getURL('src/content/popup.css');

      this.#card = document.createElement('div');
      this.#card.className = 'card';

      this.#view = new zh.EntryView(settings);
      // The warning depends on which candidate is showing, so it is refreshed on the way past
      // rather than left to the surface to remember.
      this.#view.onSelect = (candidate) => {
        this.#applyWarning();
        this.onSelect?.(candidate);
      };

      this.#hint = document.createElement('div');
      this.#hint.className = 'hint';

      // Sibling of the hint rather than part of it: the hint's text is asserted verbatim in
      // tests and read aloud as one string, and a stray "!" in the middle of it helps nobody.
      this.#warn = document.createElement('span');
      this.#warn.className = 'warn';
      this.#warn.textContent = '!';
      this.#warn.setAttribute('role', 'img');
      this.#warn.hidden = true;

      const foot = document.createElement('div');
      foot.className = 'foot';
      foot.append(this.#hint, this.#warn);

      this.#card.append(this.#view.tabs, this.#view.panel, foot);
      this.#root.append(style, this.#card);

      this.#applyTheme();
      this.hide();
      (document.body ?? document.documentElement).append(this.#host);
    }

    // Assigned by content.js after construction. They are forwarded straight onto the view
    // rather than wrapped, because the view treats an unset onPlay/onAdd as "this surface has no
    // audio / no Anki" and hides those buttons -- a wrapper would always look set.
    set onPlay(fn) {
      this.#view.onPlay = fn;
    }

    get onPlay() {
      return this.#view.onPlay;
    }

    set onAdd(fn) {
      this.#view.onAdd = fn;
    }

    get onAdd() {
      return this.#view.onAdd;
    }

    set onInspect(fn) {
      this.#view.onInspect = fn;
    }

    get onInspect() {
      return this.#view.onInspect;
    }

    get visible() {
      return this.#host.hasAttribute('data-visible');
    }

    get activeCandidate() {
      return this.#view.activeCandidate;
    }

    /** Viewport box of the popup, or null when hidden. Used to tell if the pointer is heading here. */
    get rect() {
      return this.visible ? this.#host.getBoundingClientRect() : null;
    }

    updateSettings(settings) {
      this.#settings = settings;
      this.#view.updateSettings(settings);
      this.#applyTheme();
    }

    #applyHint() {
      // Describes the trigger currently configured, so changing it doesn't leave stale advice.
      const { triggerKey } = this.#settings;
      const LABELS = { Control: 'Ctrl', Meta: navigator.platform.startsWith('Mac') ? 'Cmd' : 'Win' };
      const how =
        triggerKey === 'none'
          ? t('popupHintHover')
          : t('popupHintKey', LABELS[triggerKey] ?? triggerKey);
      this.#hint.textContent = t('popupHint', how);
    }

    /**
     * Explain, quietly, why these definitions are in English when another language was chosen.
     *
     * Two different situations look identical to a reader and are worth telling apart, because
     * only one of them is actionable: the whole gloss layer is missing and can be downloaded,
     * or it is present but has nothing for this particular entry. The second is normal -- the
     * translation trails CC-CEDICT by a few hundred entries -- and there is nothing to do
     * about it, so saying "download it" there would send someone looking for a button that
     * would not help.
     */
    #applyWarning() {
      // English is what CC-CEDICT ships, so a card being "untranslated" is the normal state
      // rather than a shortfall -- there is nothing to fall back *from*. Without this the badge
      // appears for every lookup the moment definitions are set to English.
      if ((this.#settings?.glossLanguage ?? 'en') === 'en') {
        this.#warn.hidden = true;
        return;
      }

      const untranslated = this.#view.activeCandidate?.cards.some((card) => !card.translated);
      const reason = this.#glossPending ? 'glossPending' : untranslated ? 'glossMissingEntry' : '';

      this.#warn.hidden = !reason;
      if (!reason) return;
      // title drives the native tooltip; aria-label is what a screen reader gets, since the
      // visible text is a bare "!".
      this.#warn.title = t(reason);
      this.#warn.setAttribute('aria-label', t(reason));
    }

    contains(node) {
      return this.#host.contains(node) || node === this.#host;
    }

    #applyTheme() {
      this.#card.dataset.theme = this.#settings.theme;
      this.#card.style.setProperty('--zh-font-size', `${this.#settings.fontSize}px`);
      this.#applyHint();
    }

    /**
     * @param {Array<{headword: string, length: number, cards: object[]}>} candidates
     * @param {DOMRect} anchorRect
     * @param {{glossPending?: boolean}} [state]
     */
    show(candidates, anchorRect, state = {}) {
      this.#glossPending = Boolean(state.glossPending);
      this.#applyTheme();
      this.#view.render(candidates);
      this.#host.setAttribute('data-visible', '');
      this.#position(anchorRect);
    }

    hide() {
      this.#host.removeAttribute('data-visible');
      this.#view.clear();
    }

    select(index) {
      this.#view.select(index);
    }

    step(delta) {
      this.#view.step(delta);
    }

    applyAnkiStates(result) {
      this.#view.applyAnkiStates(result);
    }

    disableAnki(reason) {
      this.#view.disableAnki(reason);
    }

    /**
     * Anchor below the word, flipping above it when the viewport is tight, and clamp
     * horizontally so the popup never hangs off screen.
     */
    #position(rect) {
      // Measure at natural size before deciding which side to sit on.
      this.#card.style.maxHeight = '';
      const { width, height } = this.#card.getBoundingClientRect();

      const spaceBelow = window.innerHeight - rect.bottom - MARGIN - EDGE;
      const spaceAbove = rect.top - MARGIN - EDGE;
      // Prefer below the word, flipping up only when that side is genuinely roomier.
      const flip = height > spaceBelow && spaceAbove > spaceBelow;

      // Cap the height to the chosen side, then place using the *capped* height -- placing
      // by the natural height would push a scrolling popup away from the word it describes.
      const available = Math.max(160, flip ? spaceAbove : spaceBelow);
      const shown = Math.min(height, available);
      const top = flip ? rect.top - MARGIN - shown : rect.bottom + MARGIN;
      const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE));

      this.#card.style.maxHeight = `${available}px`;
      this.#host.style.top = `${Math.max(EDGE, top)}px`;
      this.#host.style.left = `${left}px`;
    }

    destroy() {
      this.#host.remove();
    }
  }

  zh.Popup = Popup;
})();
