// The snip result: the captured image, and what was read out of it underneath.
//
// Deliberately the same object the hover popup is -- a shadow root holding a `.card`, drawn by
// the shared EntryView and styled by popup.css. It loads that stylesheet first and its own
// second, so an entry here is not merely similar to a hovered one, it is the same markup under
// the same rules. Only the chrome differs: an image on top, and a close button, because unlike
// the popup there is no pointer leaving the word to dismiss it.
//
// Three states, and the window exists in all of them: the capture alone while recognition is
// still running, the capture with an explanation when nothing was read, and the capture with a
// lookup underneath when something was. Showing the image in every case is the point -- when the
// text comes back wrong, seeing what was actually captured is what tells the user to zoom in and
// snip again.

(() => {
  const zh = (globalThis.zhDic ??= {});
  // messages.js is loaded ahead of this file by the manifest, so the catalogue is already there.
  const { t } = globalThis.zhI18n;

  const MARGIN = 12; // gap between the snipped region and the window
  const EDGE = 8; // keep this far from the viewport edge

  // Inline SVG rather than glyphs, for the reason the speaker and Anki icons are: a font
  // character inherits the page's own emoji and symbol rendering, and "⟲" in particular lands
  // somewhere different in every fallback font.
  const RETRY_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.85"/>' +
    '<path d="M13.4 2.2v3h-3"/>' +
    '</svg>';

  const CLOSE_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/>' +
    '</svg>';

  class ResultWindow {
    #host;
    #root;
    #card;
    #view;
    #shot;
    #image;
    #caption;
    #status;
    #settings;

    /** Assigned by content.js, like the popup's. */
    onClose;
    /** Close and go straight back to framing -- the usual answer to a capture that read badly. */
    onRetry;

    constructor(settings) {
      this.#settings = settings;

      this.#host = document.createElement('div');
      // Marks the window so hover resolution ignores its own text -- the same flag the popup
      // and the snip overlay carry.
      this.#host.dataset.zhDicHost = '';
      this.#host.dataset.zhDicResult = '';
      this.#root = this.#host.attachShadow({ mode: 'open' });

      // popup.css first: it carries the card, the tabs and every entry rule, and result.css
      // then adds only what is particular to this window. Loading them the other way round
      // would let the popup's rules win.
      const shared = document.createElement('link');
      shared.rel = 'stylesheet';
      shared.href = chrome.runtime.getURL('src/content/popup.css');

      const own = document.createElement('link');
      own.rel = 'stylesheet';
      own.href = chrome.runtime.getURL('src/content/result.css');

      this.#card = document.createElement('div');
      this.#card.className = 'card';

      this.#shot = document.createElement('div');
      this.#shot.className = 'shot';

      this.#image = document.createElement('img');
      this.#image.className = 'shot-image';
      this.#image.alt = t('shotAlt');

      this.#caption = document.createElement('div');
      this.#caption.className = 'shot-size';

      // Retry sits before close, in the order the user reaches for them: a capture that read
      // badly is far more often reframed than abandoned.
      const actions = document.createElement('div');
      actions.className = 'shot-actions';
      actions.append(
        this.#actionButton('shot-retry', t('snipAgain'), RETRY_ICON, () => {
          this.hide();
          this.onRetry?.();
        }),
        this.#actionButton('shot-close', t('close'), CLOSE_ICON, () => {
          this.hide();
          this.onClose?.();
        }),
      );

      this.#shot.append(this.#image, this.#caption, actions);

      this.#status = document.createElement('div');
      this.#status.className = 'status';

      this.#view = new zh.EntryView(settings);

      this.#card.append(this.#shot, this.#status, this.#view.tabs, this.#view.panel);
      this.#root.append(shared, own, this.#card);

      this.#applyTheme();
      this.hide();
      (document.body ?? document.documentElement).append(this.#host);
    }

    // Forwarded onto the view rather than wrapped, for the same reason the popup does it: the
    // view reads an unset onPlay/onAdd as "this surface has no audio / no Anki".
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

    contains(node) {
      return this.#host.contains(node) || node === this.#host;
    }

    /** One of the two buttons over the capture. */
    #actionButton(className, label, icon, action) {
      const button = document.createElement('button');
      button.className = `shot-button ${className}`;
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = icon;
      button.addEventListener('click', (event) => {
        // Keep the click off the page underneath, which on a manhua reader is usually a
        // next-page link.
        event.preventDefault();
        event.stopPropagation();
        action();
      });
      return button;
    }

    updateSettings(settings) {
      this.#settings = settings;
      this.#view.updateSettings(settings);
      this.#applyTheme();
    }

    #applyTheme() {
      this.#card.dataset.theme = this.#settings.theme;
      this.#card.style.setProperty('--zh-font-size', `${this.#settings.fontSize}px`);
    }

    /**
     * Put the capture on screen. Called as soon as the crop exists, before recognition has
     * finished, so the user sees what they framed rather than an empty wait.
     *
     * @param {{dataUrl: string, width: number, height: number}} shot
     * @param {{x: number, y: number, width: number, height: number}} region Where it was taken from.
     */
    show(shot, region) {
      this.#image.src = shot.dataUrl;
      // Device pixels, matching the readout on the overlay: this is what OCR will actually get.
      this.#caption.textContent = `${shot.width} × ${shot.height}`;
      this.#view.clear();
      this.#applyTheme();
      this.setStatus(t('shotReading'));
      this.#host.setAttribute('data-visible', '');
      this.#position(region);
    }

    /** The line under the image, for "reading…", "nothing legible", or a failure. */
    setStatus(message) {
      this.#status.textContent = message ?? '';
      this.#status.hidden = !message;
    }

    /**
     * Show what was read. Clearing the status is what turns the window from a capture preview
     * into a lookup.
     */
    showCandidates(candidates) {
      if (!candidates?.length) {
        this.#view.clear();
        this.setStatus(t('shotNoMatch'));
        return;
      }
      this.setStatus('');
      this.#view.render(candidates);
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

    hide() {
      this.#host.removeAttribute('data-visible');
      this.#view.clear();
      // Release the capture rather than leaving a few megabytes of base64 attached to a hidden
      // node until the next snip replaces it.
      this.#image.removeAttribute('src');
    }

    /**
     * Sit below the snipped region, flipping above it when the viewport is tight -- the same
     * rule the popup follows, for the same reason: the window has to not cover what it describes.
     */
    #position(region) {
      this.#card.style.maxHeight = '';
      const { width, height } = this.#card.getBoundingClientRect();

      const spaceBelow = window.innerHeight - (region.y + region.height) - MARGIN - EDGE;
      const spaceAbove = region.y - MARGIN - EDGE;
      const flip = height > spaceBelow && spaceAbove > spaceBelow;

      const available = Math.max(200, flip ? spaceAbove : spaceBelow);
      const shown = Math.min(height, available);
      const top = flip ? region.y - MARGIN - shown : region.y + region.height + MARGIN;
      const left = Math.max(EDGE, Math.min(region.x, window.innerWidth - width - EDGE));

      this.#card.style.maxHeight = `${available}px`;
      this.#host.style.top = `${Math.max(EDGE, top)}px`;
      this.#host.style.left = `${left}px`;
    }

    destroy() {
      this.#host.remove();
    }
  }

  zh.ResultWindow = ResultWindow;
})();
