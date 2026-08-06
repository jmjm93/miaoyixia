// The lookup popup: one tab per candidate length, longest first.
//
// Lives in a shadow root, so page CSS can't restyle it and its own CSS can't leak out. The
// root is `open` rather than `closed`: closing it would only stop page JS from reading the
// contents, which is weak protection given the page can hook attachShadow or simply watch the
// host element -- and it costs real inspectability in DevTools and in tests.
//
// A single instance is created up front and reused, so the stylesheet is already loaded by the
// time the user first triggers a lookup.

(() => {
  const zh = (globalThis.zhDic ??= {});

  const MARGIN = 12; // gap between the hovered word and the popup
  const EDGE = 8; // keep this far from the viewport edge

  /** Turns a playback failure into something a learner can act on. */
  function describePlaybackError(error) {
    const reason = String(error?.message ?? error);
    if (reason === 'no-voice') return 'No Chinese voice installed — see the extension options';
    if (reason === 'no-recording') return 'No recording on Wikimedia Commons for this word';
    if (reason === 'no-audio') return 'No Chinese voice installed and no recording found';
    return `Could not play audio: ${reason}`;
  }

  class Popup {
    #host;
    #root;
    #card;
    #tabs;
    #panel;
    #hint;
    #candidates = [];
    #active = 0;
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
      this.#tabs = document.createElement('div');
      this.#tabs.className = 'tabs';
      this.#tabs.setAttribute('role', 'tablist');
      this.#panel = document.createElement('div');
      this.#panel.className = 'panel';
      this.#panel.setAttribute('role', 'tabpanel');

      this.#hint = document.createElement('div');
      this.#hint.className = 'hint';

      this.#card.append(this.#tabs, this.#panel, this.#hint);
      this.#root.append(style, this.#card);

      this.#tabs.addEventListener('click', (event) => {
        const index = event.target.closest('[data-index]')?.dataset.index;
        if (index !== undefined) this.select(Number(index));
      });

      this.#applyTheme();
      this.hide();
      (document.body ?? document.documentElement).append(this.#host);
    }

    get visible() {
      return this.#host.hasAttribute('data-visible');
    }

    get activeCandidate() {
      return this.#candidates[this.#active];
    }

    /** Viewport box of the popup, or null when hidden. Used to tell if the pointer is heading here. */
    get rect() {
      return this.visible ? this.#host.getBoundingClientRect() : null;
    }

    updateSettings(settings) {
      this.#settings = settings;
      this.#applyTheme();
    }

    #applyHint() {
      // Describes the trigger currently configured, so changing it doesn't leave stale advice.
      const { triggerKey } = this.#settings;
      const LABELS = { Control: 'Ctrl', Meta: navigator.platform.startsWith('Mac') ? 'Cmd' : 'Win' };
      const how = triggerKey === 'none' ? 'Hover' : `${LABELS[triggerKey] ?? triggerKey}-hover`;
      this.#hint.textContent = `${how} to look up · ←/→ switch · Esc to close`;
    }

    contains(node) {
      return this.#host.contains(node) || node === this.#host;
    }

    #applyTheme() {
      this.#card.dataset.theme = this.#settings.theme;
      this.#card.style.setProperty('--zh-font-size', `${this.#settings.fontSize}px`);
      this.#applyHint();
    }

    /** @param {Array<{headword: string, length: number, cards: object[]}>} candidates */
    show(candidates, anchorRect) {
      this.#candidates = candidates;
      this.#active = 0; // longest match wins by default
      this.#applyTheme();
      this.#renderTabs();
      this.select(0);
      this.#host.setAttribute('data-visible', '');
      this.#position(anchorRect);
    }

    hide() {
      this.#host.removeAttribute('data-visible');
      this.#candidates = [];
    }

    #renderTabs() {
      this.#tabs.replaceChildren();
      // Only rendered when there's a real choice to make.
      this.#tabs.hidden = this.#candidates.length < 2;

      this.#candidates.forEach((candidate, index) => {
        const tab = document.createElement('button');
        tab.className = 'tab';
        tab.type = 'button';
        tab.dataset.index = String(index);
        tab.setAttribute('role', 'tab');
        tab.textContent = candidate.headword;

        // The badge is the digit that selects this tab, not the word's length -- the length
        // is already obvious from the characters, and showing it here read as an index that
        // disagreed with the hotkeys (热门 is 2 characters but is selected by 1).
        if (index < 9) {
          const key = document.createElement('span');
          key.className = 'key';
          key.textContent = String(index + 1);
          tab.append(key);
          tab.setAttribute('aria-keyshortcuts', String(index + 1));
        }
        this.#tabs.append(tab);
      });
    }

    select(index) {
      if (!this.#candidates.length) return;
      this.#active = Math.max(0, Math.min(index, this.#candidates.length - 1));

      for (const tab of this.#tabs.children) {
        const on = Number(tab.dataset.index) === this.#active;
        tab.setAttribute('aria-selected', String(on));
        tab.classList.toggle('is-active', on);
      }

      this.#renderPanel(this.#candidates[this.#active]);
      this.onSelect?.(this.#candidates[this.#active]);
    }

    step(delta) {
      this.select(this.#active + delta);
    }

    #renderPanel(candidate) {
      this.#panel.replaceChildren();
      for (const card of candidate.cards) {
        this.#panel.append(this.#renderCard(card));
      }
    }

    /**
     * The play button for one reading. Sits at the top-right of its entry, so a word with
     * several readings gets one button per reading rather than one for the whole word.
     *
     * The popup doesn't know or care where audio comes from -- it calls onPlay and reflects
     * whatever happens, so the source policy stays in content.js.
     */
    #renderSpeaker(card) {
      if (this.#settings.audio === 'off' || !this.onPlay) return null;

      const button = document.createElement('button');
      button.className = 'speak';
      button.type = 'button';
      button.dataset.state = 'idle';
      button.setAttribute('aria-label', `Play pronunciation of ${card.headword}`);
      button.title = `Play ${card.headword}`;
      // Inline SVG: a font glyph would inherit the page's emoji rendering and shift the row.
      button.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        '<path d="M8.5 2.2v11.6a.6.6 0 0 1-1 .43L4.3 11H2.6A1.1 1.1 0 0 1 1.5 9.9V6.1A1.1 1.1 0 0 1 2.6 5h1.7l3.2-3.23a.6.6 0 0 1 1 .43Z"/>' +
        '<path class="wave wave-1" d="M10.8 5.6a3.4 3.4 0 0 1 0 4.8"/>' +
        '<path class="wave wave-2" d="M12.7 3.7a6 6 0 0 1 0 8.6"/>' +
        '</svg>';

      button.addEventListener('click', async (event) => {
        // Keep the click from reaching the page, and from dismissing the popup.
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.state === 'loading') return;

        button.dataset.state = 'loading';
        try {
          await this.onPlay(card);
          button.dataset.state = 'idle';
        } catch (error) {
          button.dataset.state = 'error';
          button.title = describePlaybackError(error);
        }
      });

      return button;
    }

    #renderCard(card) {
      const wrap = document.createElement('article');
      wrap.className = 'entry';

      const head = document.createElement('div');
      head.className = 'head';

      const { script } = this.#settings;
      const primary = script === 'traditional' ? card.traditional : card.simplified;
      const secondary = script === 'traditional' ? card.simplified : card.traditional;

      const word = document.createElement('span');
      word.className = 'word';
      word.textContent = primary;
      head.append(word);

      // Only worth the space when the two scripts actually differ.
      if (card.hasVariants) {
        const variant = document.createElement('span');
        variant.className = 'variant';
        variant.textContent = secondary;
        variant.title = script === 'traditional' ? 'Simplified' : 'Traditional';
        head.append(variant);
      }

      const pinyin = document.createElement('span');
      pinyin.className = 'pinyin';
      for (const syllable of card.syllables) {
        const span = document.createElement('span');
        span.className = `tone tone-${syllable.tone}`;
        span.textContent = syllable.text;
        pinyin.append(span, document.createTextNode(' '));
      }
      head.append(pinyin);

      const speaker = this.#renderSpeaker(card);
      if (speaker) head.append(speaker);

      const senses = document.createElement('ol');
      senses.className = 'senses';
      const { maxSenses } = this.#settings;
      const shown = card.senses.slice(0, maxSenses);
      for (const sense of shown) {
        const li = document.createElement('li');
        li.textContent = sense;
        senses.append(li);
      }

      wrap.append(head, senses);

      const hidden = card.senses.length - shown.length;
      if (hidden > 0) {
        const more = document.createElement('button');
        more.className = 'more';
        more.type = 'button';
        more.textContent = `+${hidden} more`;
        more.addEventListener('click', () => {
          for (const sense of card.senses.slice(maxSenses)) {
            const li = document.createElement('li');
            li.textContent = sense;
            senses.append(li);
          }
          more.remove();
        });
        wrap.append(more);
      }

      return wrap;
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
