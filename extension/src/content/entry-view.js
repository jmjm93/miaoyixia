// One lookup, rendered: a row of tabs (one per candidate length) over a panel of entries.
//
// This was carved out of popup.js when the snip result window needed the same thing. Both
// surfaces show identical cards -- headword, readings, senses, a speaker and an Anki button --
// and the only real difference between them is the chrome around it: the popup floats next to a
// word and follows the pointer, the result window sits under a captured image. So the rendering
// lives here and owns nothing else. It has no host, no shadow root and no position; it builds
// two elements and hands them to whoever is framing them.
//
// The class styles nothing itself. Every class name it emits is styled by popup.css, which both
// surfaces load into their shadow root -- which is what actually keeps the two identical rather
// than merely similar.

(() => {
  const zh = (globalThis.zhDic ??= {});
  // messages.js is loaded ahead of this file by the manifest, so the catalogue is already there.
  const { t } = globalThis.zhI18n;

  /** Turns a playback failure into something a learner can act on. */
  function describePlaybackError(error) {
    const reason = String(error?.message ?? error);
    if (reason === 'no-voice') return t('noVoice');
    if (reason === 'no-recording') return t('noRecording');
    if (reason === 'no-audio') return t('noAudio');
    return t('playbackFailed', reason);
  }

  class EntryView {
    #tabs;
    #panel;
    #settings;
    #candidates = [];
    #active = 0;

    /**
     * Assigned by the surface after construction, so they are read at call time rather than
     * captured. `onPlay` and `onAdd` being unset is meaningful: it's what hides the speaker and
     * Anki buttons for a surface that can't service them.
     */
    onSelect;
    onPlay;
    onAdd;
    onInspect;

    constructor(settings) {
      this.#settings = settings;

      this.#tabs = document.createElement('div');
      this.#tabs.className = 'tabs';
      this.#tabs.setAttribute('role', 'tablist');

      this.#panel = document.createElement('div');
      this.#panel.className = 'panel';
      this.#panel.setAttribute('role', 'tabpanel');

      this.#tabs.addEventListener('click', (event) => {
        const index = event.target.closest('[data-index]')?.dataset.index;
        if (index !== undefined) this.select(Number(index));
      });
    }

    /** The two elements the surface has to place. */
    get tabs() {
      return this.#tabs;
    }

    get panel() {
      return this.#panel;
    }

    get candidates() {
      return this.#candidates;
    }

    get activeCandidate() {
      return this.#candidates[this.#active];
    }

    updateSettings(settings) {
      this.#settings = settings;
    }

    /** Show a lookup, selecting the longest match. */
    render(candidates) {
      this.#candidates = candidates;
      this.#active = 0; // longest match wins by default
      this.#renderTabs();
      this.select(0);
    }

    clear() {
      this.#candidates = [];
      this.#tabs.replaceChildren();
      this.#panel.replaceChildren();
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
      candidate.cards.forEach((card, index) => {
        this.#panel.append(this.#renderCard(card, index));
      });
      // Whether these words are already in Anki is answered asynchronously; the buttons start
      // enabled and are disabled if the answer says so.
      this.onInspect?.(candidate);
    }

    /**
     * Apply Anki availability to the add buttons of the candidate currently on screen.
     * @param {{ready: boolean, states: Array<{canAdd: boolean, duplicate: boolean, error: string}>}} result
     */
    applyAnkiStates(result) {
      for (const button of this.#panel.querySelectorAll('button.anki-add')) {
        const state = result.states?.[Number(button.dataset.entry)];
        if (!state) continue;

        if (state.duplicate) {
          button.dataset.state = 'duplicate';
          button.disabled = true;
          button.title = t('alreadyInAnki');
        } else if (!state.canAdd) {
          button.dataset.state = 'error';
          button.disabled = true;
          button.title = t('ankiRejected', state.error);
        }
      }
    }

    /** Mark every add button unavailable, e.g. because Anki isn't running. */
    disableAnki(reason) {
      for (const button of this.#panel.querySelectorAll('button.anki-add')) {
        button.dataset.state = 'unavailable';
        button.disabled = true;
        button.title = reason;
      }
    }

    /**
     * The play button for one reading. Sits at the top-right of its entry, so a word with
     * several readings gets one button per reading rather than one for the whole word.
     *
     * The view doesn't know or care where audio comes from -- it calls onPlay and reflects
     * whatever happens, so the source policy stays in content.js.
     */
    #renderSpeaker(card) {
      if (this.#settings.audio === 'off' || !this.onPlay) return null;

      const button = document.createElement('button');
      button.className = 'speak';
      button.type = 'button';
      button.dataset.state = 'idle';
      button.setAttribute('aria-label', t('playPronunciation', card.headword));
      button.title = t('play', card.headword);
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

    /**
     * The "add to Anki" button for one reading, beside its speaker.
     *
     * Starts enabled and is disabled by applyAnkiStates once Anki has been asked whether the
     * word is already there. Doing it that way round keeps the popup instant -- the duplicate
     * check is a round trip, and blocking the render on it would undo the latency work.
     */
    #renderAddButton(card, index) {
      if (!this.#settings.ankiEnabled || !this.onAdd) return null;

      const button = document.createElement('button');
      button.className = 'anki-add';
      button.type = 'button';
      button.dataset.state = 'idle';
      button.dataset.entry = String(index);
      button.setAttribute('aria-label', t('addToAnki', card.headword));
      button.title = t('addToAnki', card.headword);
      button.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
        '<path class="plus" d="M8 3.4v9.2M3.4 8h9.2"/>' +
        '<path class="tick" d="M3.6 8.6l3 3 5.8-6.4"/>' +
        '</svg>';

      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled || button.dataset.state === 'adding') return;

        button.dataset.state = 'adding';
        try {
          const result = await this.onAdd(card);
          button.dataset.state = 'added';
          button.disabled = true;
          button.title = result?.created?.length
            ? t('ankiAddedCreated', result.deck, result.created.join(t('and')))
            : t('ankiAdded', result?.deck ?? 'Anki');
        } catch (error) {
          const reason = String(error?.message ?? error);
          const duplicate = /duplicate/i.test(reason);
          button.dataset.state = duplicate ? 'duplicate' : 'error';
          button.disabled = duplicate;
          button.title = duplicate ? t('alreadyInAnki') : t('ankiAddFailed', reason);
        }
      });

      return button;
    }

    #renderCard(card, index = 0) {
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
        variant.title = t(script === 'traditional' ? 'tokenSimplified' : 'tokenTraditional');
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

      const add = this.#renderAddButton(card, index);
      if (add) head.append(add);

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
        more.textContent = t('moreSenses', hidden);
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
  }

  zh.EntryView = EntryView;
})();
