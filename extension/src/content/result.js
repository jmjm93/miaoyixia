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
  const MIN_HEIGHT = 200; // never squash the window below this, even against an edge
  // Bounds for the capture, which is the only part of the window that can give up height without
  // losing information -- everything else is text. Must match .shot-image in result.css, which
  // holds until the first placement sets an explicit cap.
  const SHOT_MAX = 240;
  const SHOT_MIN = 72;
  /** Gap between the buttons and the window's edge, before any scrollbar is allowed for. */
  const ACTIONS_INSET = 5;
  /** Below this the definitions panel is not worth pinning a header above. */
  const PANEL_MIN = 96;

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

  // Filled rather than stroked, unlike its neighbours, and deliberately so. Drawn as a small
  // disc with eight long thin rays it is a sun, not a gear -- what makes it read as a cog at
  // 14px is the solid ring, the hole punched through the middle, and teeth that are stubby and
  // wider than the gaps between them. The hole is a second subpath, cut out by evenodd.
  const GEAR_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path class="solid" fill-rule="evenodd" d="' +
    'M12.59 6.42 L14.85 6.54 L14.85 9.46 L12.59 9.58 L12.36 10.13 L13.87 11.81 L11.81 13.87 ' +
    'L10.13 12.36 L9.58 12.59 L9.46 14.85 L6.54 14.85 L6.42 12.59 L5.87 12.36 L4.19 13.87 ' +
    'L2.13 11.81 L3.64 10.13 L3.41 9.58 L1.15 9.46 L1.15 6.54 L3.41 6.42 L3.64 5.87 ' +
    'L2.13 4.19 L4.19 2.13 L5.87 3.64 L6.42 3.41 L6.54 1.15 L9.46 1.15 L9.58 3.41 ' +
    'L10.13 3.64 L11.81 2.13 L13.87 4.19 L12.36 5.87 Z ' +
    'M5.65 8 a2.35 2.35 0 1 0 4.7 0 a2.35 2.35 0 1 0 -4.7 0 Z"/>' +
    '</svg>';

  const COPY_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>' +
    '<path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>' +
    '</svg>';

  /** The two things about a capture the user can be wrong about, and fix without re-snipping. */
  const CHOICES = [
    { key: 'ocrScript', label: 'ocrScript', options: [['simplified', 'scriptSimplified'], ['traditional', 'scriptTraditional']] },
    { key: 'ocrOrientation', label: 'ocrOrientation', options: [['horizontal', 'ocrHorizontal'], ['vertical', 'ocrVertical']] },
  ];

  class ResultWindow {
    #host;
    #root;
    #card;
    #view;
    #shot;
    #image;
    #caption;
    #status;
    #tokens;
    #line;
    #lineRow;
    #translation;
    #copy;
    #tuner;
    #actions;
    /** Whether anything was actually changed while the tuner was open. */
    #tuned = false;
    #copiedTimer = 0;
    /**
     * The page's zoom factor, which the window cancels out rather than following.
     *
     * People zoom in to capture text at a higher resolution -- it is the standard fix for a poor
     * reading -- but nobody zooms in to read the definitions. Following the page would make the
     * window balloon exactly when the viewport has least room for it.
     */
    #zoom = 1;
    /** Where the capture was taken from. Kept so the window can be placed again as it grows. */
    #region = null;
    #reading = [];
    #activeToken = 0;
    #settings;

    /** Assigned by content.js, like the popup's. */
    onClose;
    /** Close and go straight back to framing -- the usual answer to a capture that read badly. */
    onRetry;
    /** A settings patch to persist, from the tuner. */
    onSetting;
    /** Read the same capture again, because what it should be read as has changed. */
    onReread;
    /** The user corrected the recognised line; look the corrected text up instead. */
    onEdit;

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
      this.#image.dataset.label = 'shotAlt';

      this.#caption = document.createElement('div');
      this.#caption.className = 'shot-size';

      // Retry sits before close, in the order the user reaches for them: a capture that read
      // badly is far more often reframed than abandoned.
      const actions = document.createElement('div');
      actions.className = 'shot-actions';
      actions.append(
        this.#actionButton('shot-tune', 'ocrSettings', GEAR_ICON, () => this.#toggleTuner()),
        this.#actionButton('shot-retry', 'snipAgain', RETRY_ICON, () => {
          this.hide();
          this.onRetry?.();
        }),
        this.#actionButton('shot-close', 'close', CLOSE_ICON, () => {
          this.hide();
          this.onClose?.();
        }),
      );

      this.#shot.append(this.#image, this.#caption);
      // Deliberately NOT inside the card. The card scrolls, and an absolutely positioned element
      // inside a scroll container scrolls with its content -- so these went off the top the
      // moment the window had more in it than would fit. As a sibling of the card they are
      // positioned against the host, which does not scroll.
      this.#actions = actions;

      // What the recogniser was told to expect. Sits between the capture and the reading, where
      // it reads as "this is how that became this" -- and, being part of the card rather than
      // floating over it, it cannot fall off the screen or need positioning of its own.
      this.#tuner = document.createElement('div');
      this.#tuner.className = 'tuner';
      this.#tuner.hidden = true;
      for (const choice of CHOICES) {
        const row = document.createElement('label');
        row.className = 'tuner-row';

        // Every translated string carries the key that produced it, so #applyLabels can redo
        // them all when the language changes -- see the note there.
        const name = document.createElement('span');
        name.dataset.label = choice.label;

        const select = document.createElement('select');
        select.dataset.setting = choice.key;
        for (const [value, labelKey] of choice.options) {
          const option = document.createElement('option');
          option.value = value;
          option.dataset.label = labelKey;
          select.append(option);
        }
        select.addEventListener('change', () => {
          this.#tuned = true;
          this.onSetting?.({ [choice.key]: select.value });
        });

        row.append(name, select);
        this.#tuner.append(row);
      }

      // The recognised line, as text rather than as chips.
      //
      // Editable on purpose, and it is the most valuable thing in this window. Recognition is
      // imperfect on stylised lettering -- seven characters in ten on a hard panel -- and the
      // capture is sitting right above this box, so correcting a glyph by eye takes a moment and
      // turns a partial reading into an exact one. No engine change buys as much.
      //
      // It is also what you copy out to paste somewhere else, which the chips cannot be: they are
      // buttons, and selecting across them yields nothing useful.
      this.#line = document.createElement('textarea');
      this.#line.className = 'line';
      this.#line.rows = 1;
      this.#line.spellcheck = false;
      this.#line.dataset.label = 'recognisedLine';

      // Enter commits rather than inserting a newline: this is one line of text, and the reading
      // below it is what the user is actually after.
      this.#line.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        this.#line.blur();
      });
      // `change` rather than `input`: re-reading on every keystroke would fire a lookup per
      // character and fight the caret.
      this.#line.addEventListener('change', () => this.onEdit?.(this.#line.value));

      this.#copy = this.#actionButton('line-copy', 'copyLine', COPY_ICON, () => this.#copyLine());

      const lineRow = document.createElement('div');
      lineRow.className = 'line-row';
      lineRow.append(this.#line, this.#copy);
      this.#lineRow = lineRow;

      // Machine translation of the line, when that is switched on. Kept visually distinct from
      // the dictionary below it: those definitions are local and human-edited, this came off the
      // network and is a machine's guess.
      this.#translation = document.createElement('div');
      this.#translation.className = 'translation';
      this.#translation.hidden = true;

      this.#status = document.createElement('div');
      this.#status.className = 'status';

      // The recognised line, split into words. Selecting one shows its entry below; the tabs
      // under it still offer the other lengths at that position, so a bad split is recoverable
      // without re-snipping.
      this.#tokens = document.createElement('div');
      this.#tokens.className = 'tokens';
      this.#tokens.setAttribute('role', 'tablist');
      this.#tokens.addEventListener('click', (event) => {
        const index = event.target.closest('[data-token]')?.dataset.token;
        if (index !== undefined) this.selectToken(Number(index));
      });

      this.#view = new zh.EntryView(settings);

      this.#card.append(
        this.#shot,
        this.#tuner,
        this.#lineRow,
        this.#translation,
        this.#status,
        this.#tokens,
        this.#view.tabs,
        this.#view.panel,
      );
      this.#root.append(shared, own, this.#card, this.#actions);

      this.#applyLabels();
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
    #actionButton(className, labelKey, icon, action) {
      const button = document.createElement('button');
      button.className = `shot-button ${className}`;
      button.type = 'button';
      button.dataset.label = labelKey;
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
      this.#applyLabels();
      this.#applyTheme();
    }

    #applyTheme() {
      this.#card.dataset.theme = this.#settings.theme;
      this.#card.style.setProperty('--zh-font-size', `${this.#settings.fontSize}px`);
      // The tuner shows settings, so it has to follow them -- including when they are changed
      // from the options page while this window is open.
      for (const select of this.#tuner.querySelectorAll('[data-setting]')) {
        select.value = this.#settings[select.dataset.setting] ?? select.options[0].value;
      }
    }

    /**
     * Re-run every translated string in the window.
     *
     * The popup gets this for free: its one piece of fixed text is the hint bar, which
     * #applyHint rewrites on every settings change. This window has a dozen -- three button
     * tooltips, two tuner rows, four option names, the image's alt text -- all built once in the
     * constructor. They stayed in whatever language was active at construction, so switching to
     * Spanish with a tab already open left the drawer in English until the page was reloaded.
     */
    #applyLabels() {
      for (const el of this.#root.querySelectorAll('[data-label]')) {
        const text = t(el.dataset.label);
        if (el.tagName === 'IMG') el.alt = text;
        else if (el.tagName === 'OPTION' || el.tagName === 'SPAN') el.textContent = text;
        else {
          el.title = text;
          el.setAttribute('aria-label', text);
        }
      }
    }

    /**
     * Open or close the recogniser settings.
     *
     * Closing is what triggers a re-read, and only when something actually changed -- switching
     * to traditional and straight back should cost nothing. The capture is reused, so this is a
     * second or two rather than another snip.
     */
    #toggleTuner(open = this.#tuner.hidden) {
      if (open === !this.#tuner.hidden) return;
      this.#tuner.hidden = !open;
      this.#root.querySelector('.shot-tune')?.classList.toggle('is-active', open);

      if (open) {
        this.#tuned = false;
      } else if (this.#tuned) {
        this.#tuned = false;
        this.onReread?.();
      }
      this.#position();
    }

    /** True while the recogniser settings are showing, so Escape knows what it is closing. */
    get tuning() {
      return !this.#tuner.hidden;
    }

    closeTuner() {
      this.#toggleTuner(false);
    }

    /**
     * Put the capture on screen. Called as soon as the crop exists, before recognition has
     * finished, so the user sees what they framed rather than an empty wait.
     *
     * @param {{dataUrl: string, width: number, height: number}} shot
     * @param {{x: number, y: number, width: number, height: number}} region Where it was taken from.
     */
    show(shot, region) {
      this.#region = region;
      this.#image.src = shot.dataUrl;
      // Device pixels, matching the readout on the overlay: this is what OCR will actually get.
      this.#caption.textContent = `${shot.width} × ${shot.height}`;
      this.#clearReading();
      this.#applyTheme();
      this.setStatus(t('shotReading'));
      this.#host.setAttribute('data-visible', '');
      this.#position();

      // Place it again once the capture is really there. A data URL decodes asynchronously, so
      // the measurement above saw a card with a zero-height gap where the image goes -- and then
      // up to 240px of it arrives. Positioning only once put a window near the bottom of the
      // screen on the strength of a height it was about to outgrow, and off the edge it went.
      this.#image.decode?.().then(
        () => this.#position(),
        () => {}, // a capture that cannot decode has bigger problems than its placement
      );
    }

    /**
     * Put the recognised text in the editable line.
     *
     * Only called when a *capture* produces text. Re-reading after an edit deliberately leaves it
     * alone -- rewriting the box the user is typing in would move their caret.
     */
    setLine(text) {
      this.#line.value = text ?? '';
      this.#lineRow.hidden = !text;
      this.#fitLine();
      this.#position();
    }

    get line() {
      return this.#line.value;
    }

    /** Grow the box to its content, so a long sentence is not hidden behind a scrollbar. */
    #fitLine() {
      this.#line.style.height = 'auto';
      this.#line.style.height = `${Math.min(this.#line.scrollHeight, 96)}px`;
    }

    async #copyLine() {
      const text = this.#line.value;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Some pages' permissions policy blocks the async clipboard. Selecting the text and
        // asking the document to copy it still works, and the textarea is right here.
        this.#line.select();
        document.execCommand('copy');
      }
      this.#copy.classList.add('is-done');
      clearTimeout(this.#copiedTimer);
      this.#copiedTimer = setTimeout(() => this.#copy.classList.remove('is-done'), 1200);
    }

    /**
     * Cancel the page's zoom, so the window renders at the same size whatever the page is doing.
     *
     * Scaling the host rather than restyling the card: every length inside is then left alone,
     * and getBoundingClientRect reports the *rendered* size, which is what the placement maths
     * wants anyway. The one thing that needs care is that max-height is applied before the
     * transform, so it is written in card pixels while everything measured is viewport pixels.
     */
    setZoom(factor) {
      const zoom = Number(factor) > 0 ? Number(factor) : 1;
      if (zoom === this.#zoom) return;
      this.#zoom = zoom;
      // Left empty at 1:1 rather than set to scale(1), which would make a compositing layer of
      // the whole window for nothing.
      this.#host.style.transform = zoom === 1 ? '' : `scale(${1 / zoom})`;
      this.reposition();
    }

    /**
     * Place the window again for the viewport as it is now.
     *
     * Zooming a page changes the viewport measured in CSS pixels -- at 200% there is half the
     * height there was -- and the window is otherwise only placed when its *contents* change. It
     * would keep a max-height computed for a viewport that no longer exists, which on the way
     * back down to normal zoom leaves the definitions panel crushed to a few pixels inside a card
     * that thinks it is still tiny.
     */
    reposition() {
      if (this.visible) this.#position();
    }

    /** Show a machine translation of the line, or clear it with a falsy value. */
    setTranslation(text) {
      this.#translation.textContent = text ?? '';
      this.#translation.hidden = !text;
      this.#position();
    }

    /** The line under the image, for "reading…", "nothing legible", or a failure. */
    setStatus(message) {
      this.#status.textContent = message ?? '';
      this.#status.hidden = !message;
    }

    /**
     * Show what was read, split into words. Clearing the status is what turns the window from a
     * capture preview into a lookup.
     *
     * @param {Array<{text: string, start: number, length: number, candidates: object[]}>} tokens
     */
    showReading(tokens) {
      this.#reading = tokens ?? [];
      this.#tokens.replaceChildren();

      if (!this.#reading.length) {
        this.#view.clear();
        this.#tokens.hidden = true;
        this.setStatus(t('shotNoMatch'));
        this.#position();
        return;
      }

      this.setStatus('');
      // A single word needs no chips -- it would be a row of one, restating the entry below it.
      this.#tokens.hidden = this.#reading.length < 2;

      this.#reading.forEach((token, index) => {
        const chip = document.createElement('button');
        chip.className = 'token';
        chip.type = 'button';
        chip.dataset.token = String(index);
        chip.setAttribute('role', 'tab');
        chip.textContent = token.text;
        // A character the dictionary has nothing for -- punctuation, or something OCR invented.
        // Shown so the line reads whole, but there is nothing to select.
        if (!token.candidates?.length) chip.disabled = true;
        this.#tokens.append(chip);
      });

      // Open on the first word there is anything to say about.
      const first = this.#reading.findIndex((token) => token.candidates?.length);
      this.selectToken(first < 0 ? 0 : first);

      // The chips and the entry are both new height. Placing again here rather than on every
      // chip click: the maxHeight set now bounds the card, so switching words scrolls the panel
      // instead of resizing the window, and a window that jumped on each click would be worse
      // than one that is briefly a little short.
      this.#position();
    }

    /** Show one word of the reading. */
    selectToken(index) {
      const token = this.#reading[index];
      if (!token) return;
      this.#activeToken = index;

      for (const chip of this.#tokens.children) {
        const on = Number(chip.dataset.token) === index;
        chip.setAttribute('aria-selected', String(on));
        chip.classList.toggle('is-active', on);
      }

      if (token.candidates?.length) {
        this.#view.render(token.candidates);
        this.setStatus('');
      } else {
        this.#view.clear();
        this.setStatus(t('shotNoMatch'));
      }
    }

    get activeToken() {
      return this.#reading[this.#activeToken];
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

    #clearReading() {
      this.#translation.textContent = '';
      this.#translation.hidden = true;
      this.#line.value = '';
      this.#lineRow.hidden = true;
      this.#reading = [];
      this.#activeToken = 0;
      this.#tokens.replaceChildren();
      this.#tokens.hidden = true;
      this.#view.clear();
    }

    hide() {
      this.#host.removeAttribute('data-visible');
      // Straight shut, without the re-read a normal close would trigger: there is nothing left
      // on screen to re-read into.
      this.#tuned = false;
      this.#tuner.hidden = true;
      this.#root.querySelector('.shot-tune')?.classList.remove('is-active');
      this.#clearReading();
      // Release the capture rather than leaving a few megabytes of base64 attached to a hidden
      // node until the next snip replaces it.
      this.#image.removeAttribute('src');
    }

    /**
     * Sit below the snipped region, flipping above it when the viewport is tight -- the same
     * rule the popup follows, for the same reason: the window has to not cover what it describes.
     */
    #position() {
      const region = this.#region;
      if (!region) return;

      this.#card.style.maxHeight = '';
      // Cleared before measuring, or each placement would inherit the last one's cap and the
      // capture would ratchet smaller every time the window grew.
      this.#image.style.maxHeight = '';
      const { width, height } = this.#card.getBoundingClientRect();

      const below = window.innerHeight - (region.y + region.height) - MARGIN - EDGE;
      const above = region.y - MARGIN - EDGE;
      // Prefer below the snip, flipping up only when that side is genuinely roomier.
      const flip = height > below && above > below;

      // A floor, so a window wedged against an edge is usable rather than a sliver. It is also
      // exactly why the clamp below is needed: honouring it can make the card taller than the
      // side it was placed on.
      const available = Math.max(MIN_HEIGHT, flip ? above : below);

      // Every section but the panel is flex:none, so when their total outgrows `available` the
      // panel is squeezed to nothing and the entries are clipped rather than scrolled -- silently,
      // because the card hides its overflow. Shrinking the capture buys that room back from the
      // one section that can spare it.
      //
      // `overflow` is measured on screen while the cap is written inside the card, so it crosses
      // the zoom boundary and has to be converted.
      const overflow = height - available;
      if (overflow > 0) {
        this.#image.style.maxHeight = `${Math.max(SHOT_MIN, SHOT_MAX - overflow * this.#zoom)}px`;
      }

      // Re-measured: the cap above may have changed how tall the card wants to be.
      const shown = Math.min(this.#card.getBoundingClientRect().height, available);

      const top = flip ? region.y - MARGIN - shown : region.y + region.height + MARGIN;
      const left = Math.max(EDGE, Math.min(region.x, window.innerWidth - width - EDGE));

      // Card pixels, not screen pixels: this is applied before the transform shrinks it.
      this.#card.style.maxHeight = `${available * this.#zoom}px`;
      // Clamped against the bottom of the viewport as well as the top. Which side of the snip it
      // sits on is a preference; staying on screen is not -- so when the floor above wins, the
      // window overlaps the capture rather than hanging off the edge.
      this.#host.style.top = `${Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - shown))}px`;
      this.#host.style.left = `${left}px`;

      this.#applyCompact();
      this.#applyGutter();
    }

    /**
     * Keep the buttons clear of the card's scrollbar.
     *
     * They are anchored to the host, which spans the card including its scrollbar, so once the
     * card starts scrolling the rightmost button sits on top of it. The scrollbar's width is not
     * knowable in advance -- it differs by platform and by whether the card scrolls at all -- so
     * it is measured: offsetWidth counts it, clientWidth does not, and the borders have to come
     * out of the difference because offsetWidth counts those too.
     */
    #applyGutter() {
      const style = getComputedStyle(this.#card);
      const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      const scrollbar = Math.max(0, this.#card.offsetWidth - this.#card.clientWidth - borders);
      this.#actions.style.right = `${ACTIONS_INSET + scrollbar}px`;
    }

    /**
     * Decide whether the capture can still be pinned above a usable panel.
     *
     * Zooming the page is the case this exists for. Zoom shrinks the viewport measured in CSS
     * pixels -- at 200% there is half the height there was -- so the sections that never shrink
     * stop fitting however small the capture is made. The panel then collapses to a few pixels
     * and ends up with a scrollbar of its own *inside* the card's, neither of which reaches the
     * definitions.
     *
     * When that happens the window gives up on a fixed header and becomes one scroll area. A
     * single scrollbar that reaches everything is worth more than a capture that stays put.
     */
    #applyCompact() {
      this.#card.classList.remove('is-compact');

      const panel = this.#view.panel;
      const visible = panel.getBoundingClientRect().height;
      // Only when it is both too small *and* actually holding something; an empty panel is
      // allowed to be short.
      if (visible < PANEL_MIN && panel.scrollHeight > visible + 1) {
        this.#card.classList.add('is-compact');
      }
    }

    destroy() {
      this.#host.remove();
    }
  }

  zh.ResultWindow = ResultWindow;
})();
