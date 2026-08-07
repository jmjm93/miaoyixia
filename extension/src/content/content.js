// Wires pointer/keyboard events to dictionary lookups.
//
// There are two interaction modes, chosen by the triggerKey setting:
//
//   A modifier (default Shift). Press it to look up whatever the pointer is over. Keep it
//   held and the popup follows the pointer, so you can sweep a line of text. Releasing it
//   leaves the popup up rather than dismissing it -- you need a free hand to click through
//   the candidate tabs.
//
//   'none'. Any Chinese the pointer rests on is looked up, after a dwell delay. Without
//   that delay the popup would flash open on every word the pointer crosses on its way
//   somewhere else. The popup then tracks the pointer and closes as soon as it leaves
//   Chinese text, since there is no key release to signal "done".
//
// Either way it also closes on Escape, on a click elsewhere, and on scroll.

(() => {
  const zh = globalThis.zhDic;
  if (!zh?.resolveAtPoint || window.__zhDicLoaded) return;
  window.__zhDicLoaded = true;

  const { t, setLanguage } = globalThis.zhI18n;

  const HIGHLIGHT = 'zh-dic-match';
  /** Pointer distance from the looked-up word that dismisses an unheld popup. */
  const LEAVE_DISTANCE = 120;
  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
  const HOVER_ONLY = 'none';

  /** How long the pointer must hold still on a word before it's worth a lookup. */
  const PREFETCH_SETTLE = 50;
  /** Grace before closing once the pointer leaves the text, heading nowhere in particular. */
  const LEAVE_GRACE = 150;
  /** Grace when the pointer is heading for the popup -- long enough to actually get there. */
  const APPROACH_GRACE = 800;
  /** cos of the angle between pointer movement and the popup that counts as "heading for it". */
  const APPROACH_COS = 0.45;
  /** How far past the popup's near edge the approach corridor reaches. */
  const CORRIDOR_PAD = 4;
  /** How far either side of the word/popup the corridor reaches. */
  const CORRIDOR_SIDE_PAD = 16;

  let settings = null;
  let popup = null;
  let pointer = { x: 0, y: 0 };
  let previous = { x: 0, y: 0 }; // one sample back, for the direction test
  let anchor = null; // { x, y } of the word we last looked up
  let triggerHeld = false;
  let mouseDown = false;
  let lastKey = null; // the word currently on display
  let pendingKey = null; // the word currently being fetched
  let requestId = 0;
  let current = null; // { positions } for the resolved hover
  let pendingFrame = 0;
  let prefetchTimer = 0;
  let showTimer = 0;
  let closeTimer = 0;
  let closeDeadline = 0;
  // In hover mode Escape would otherwise be futile: the pointer hasn't moved, so the next
  // mousemove reopens the same word. Remember what was dismissed and stay quiet until the
  // pointer reaches something else.
  let suppressedKey = null;

  /** True when lookups are driven by the pointer alone, with no modifier held. */
  const hoverMode = () => settings.triggerKey === HOVER_ONLY;

  /** True when pointer movement should drive lookups right now. */
  const sweeping = () => hoverMode() || triggerHeld;

  // --- setup -------------------------------------------------------------------

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error ?? 'no response');
    return response.result;
  }

  async function init() {
    settings = await send({ type: 'getSettings' });
    // Settings arrive over a message here rather than from getSettings(), so the language has
    // to be pinned by hand -- see the note in settings.js.
    setLanguage(settings.uiLanguage);
    installHighlightStyle();
    popup = new zh.Popup(settings);
    popup.onSelect = (candidate) => paintHighlight(candidate?.length ?? 0);
    popup.onPlay = playPronunciation;
    popup.onAdd = addToAnki;
    popup.onInspect = inspectAnki;
    addListeners();
  }

  /** ::highlight() styles page text, so this rule has to live in the page, not the shadow root. */
  function installHighlightStyle() {
    if (!('highlights' in CSS)) return;
    const style = document.createElement('style');
    style.textContent = `::highlight(${HIGHLIGHT}) { background: rgba(37, 99, 235, 0.22); }`;
    (document.head ?? document.documentElement).append(style);
  }

  function addListeners() {
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', () => { mouseDown = false; }, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    // Scroll events aren't composed, so one from inside the popup's own overflow never
    // reaches here -- but be explicit, since dismissing on it would be maddening.
    document.addEventListener(
      'scroll',
      (event) => {
        if (!popup.contains(event.target)) dismiss();
      },
      { capture: true, passive: true },
    );
    window.addEventListener('blur', dismiss);
    // In hover mode nothing else signals that the user has left; without this the popup
    // would sit there after the pointer exits the window.
    document.addEventListener('mouseleave', dismiss);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
      // Before updateSettings, which re-renders the hint bar in whatever language is active.
      if (changes.uiLanguage) setLanguage(settings.uiLanguage);
      popup.updateSettings(settings);

      // Switching trigger mid-session leaves a popup that belongs to the old mode, and a
      // held-key flag for a key we're no longer watching.
      if (changes.triggerKey || !settings.enabled) {
        triggerHeld = false;
        dismiss();
      }
    });
  }

  // --- events ------------------------------------------------------------------

  function isEditable() {
    const el = document.activeElement;
    if (!el) return false;
    return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  }

  function onMouseDown(event) {
    mouseDown = true;
    // A click anywhere but the popup dismisses it.
    if (popup.visible && !popup.contains(event.target)) dismiss();
  }

  function onMouseMove(event) {
    previous = pointer;
    pointer = { x: event.clientX, y: event.clientY };

    // The popup is part of the page's DOM, so the pointer crossing it must not be read as
    // a hover over the page. In hover mode this is what makes the tabs reachable at all --
    // resolving a point inside the popup finds no Chinese and would close it.
    if (popup.contains(event.target)) {
      cancelClose();
      return;
    }

    if (sweeping() && !mouseDown) {
      scheduleLookup();
      return;
    }

    // Modifier mode with the popup left pinned: close it once the pointer wanders off, but
    // not while it's on its way to the popup.
    if (!popup.visible || !anchor) return;
    if (Math.hypot(pointer.x - anchor.x, pointer.y - anchor.y) > LEAVE_DISTANCE && !approachingPopup()) {
      dismiss();
    }
  }

  /**
   * Resolving the pointer is cheap and synchronous, so it runs every frame in both modes.
   * What the dwell delay gates is *showing* the popup, not looking the word up -- see
   * beginLookup.
   */
  function scheduleLookup() {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      if (sweeping()) lookupAtPointer();
    });
  }

  /**
   * The pointer is no longer on Chinese text.
   *
   * Closing immediately is what made the popup unreachable in hover mode: it sits ~12px
   * below the word, and the pointer jumps that gap between two mousemove samples, so the
   * sample in between lands on nothing and killed it. Instead the close is deferred, and the
   * grace is generous when the pointer is heading for the popup and short when it isn't.
   */
  function leaveText() {
    if (!hoverMode()) {
      // While the modifier is held the user is actively scanning, so clear straight away.
      // Once released the popup is pinned and only the distance rule closes it.
      if (triggerHeld) dismiss();
      return;
    }
    if (!popup.visible) {
      cancelPending();
      return;
    }

    const now = performance.now();
    const approaching = approachingPopup();
    const proposed = now + (approaching ? APPROACH_GRACE : LEAVE_GRACE);
    // Heading for the popup extends the deadline; heading away never shortens one already
    // set, so a single stray sample can't cut short a deliberate reach.
    const deadline = !closeDeadline ? proposed : approaching ? Math.max(closeDeadline, proposed) : closeDeadline;
    if (deadline === closeDeadline && closeTimer) return;

    closeDeadline = deadline;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(dismiss, Math.max(0, deadline - now));
  }

  /**
   * Is the pointer in the gap between the word on display and the popup?
   *
   * Hover mode re-anchors the moment a different word is under the pointer, which is what makes
   * sweeping a line work. But the popup opens only ~12px from the word, and at ordinary line
   * spacing the *next line's characters fall inside that gap* -- so reaching for the popup
   * crossed another word, the popup re-anchored to it and slid out from under the pointer.
   * Inside this band the pointer is on its way to the popup, not reading, so re-anchoring is
   * suppressed.
   *
   * The band starts exactly at the word's edge with no padding on that side: extending it back
   * over the word would cover the lower few pixels of the glyphs and stop sweeping from working
   * there. It's measured from whichever side the popup ended up on, so a flipped popup works too.
   */
  function inApproachCorridor() {
    const rect = popup.rect;
    const word = current?.rect;
    if (!rect || !word) return false;

    const below = rect.top >= word.bottom;
    const top = below ? word.bottom : rect.bottom - CORRIDOR_PAD;
    const bottom = below ? rect.top + CORRIDOR_PAD : word.top;
    if (bottom <= top) return false; // popup overlaps the word; no gap to cross

    return (
      pointer.y >= top &&
      pointer.y <= bottom &&
      pointer.x >= Math.min(word.left, rect.left) - CORRIDOR_SIDE_PAD &&
      pointer.x <= Math.max(word.right, rect.right) + CORRIDOR_SIDE_PAD
    );
  }

  /**
   * Is the pointer moving towards the popup? Measured against the nearest point on its box,
   * so this works whether it sits below the word, above it after a flip, or off to one side.
   */
  function approachingPopup() {
    const rect = popup.rect;
    if (!rect) return false;

    const mx = pointer.x - previous.x;
    const my = pointer.y - previous.y;
    const moved = Math.hypot(mx, my);
    if (moved < 0.5) return true; // hesitating over a word is not leaving it

    const tx = Math.min(Math.max(pointer.x, rect.left), rect.right);
    const ty = Math.min(Math.max(pointer.y, rect.top), rect.bottom);
    const dx = tx - pointer.x;
    const dy = ty - pointer.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return true; // already on it

    return (mx * dx + my * dy) / (moved * distance) >= APPROACH_COS;
  }

  function cancelClose() {
    clearTimeout(closeTimer);
    closeTimer = 0;
    closeDeadline = 0;
  }

  /** Drops any lookup that hasn't been shown yet, and invalidates in-flight replies. */
  function cancelPending() {
    clearTimeout(prefetchTimer);
    clearTimeout(showTimer);
    prefetchTimer = 0;
    showTimer = 0;
    pendingKey = null;
    requestId++;
  }

  function onKeyDown(event) {
    if (popup.visible && event.key === 'Escape') {
      suppressedKey = lastKey;
      dismiss();
      return;
    }

    // Arrows and digits only belong to us when the user isn't typing -- swallowing them in
    // a search box would be far worse than losing the shortcut.
    if (popup.visible && !isEditable()) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        popup.step(1);
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        popup.step(-1);
        event.preventDefault();
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        popup.select(Number(event.key) - 1);
        event.preventDefault();
        return;
      }
    }

    if (hoverMode() || event.key !== settings.triggerKey || event.repeat) return;
    triggerHeld = true;
    // Modifiers are also how you type capitals and extend selections; stay out of the way.
    if (mouseDown || isEditable()) return;
    lookupAtPointer();
  }

  function onKeyUp(event) {
    // Popup stays visible after release so the tabs remain clickable.
    if (MODIFIERS.has(event.key)) triggerHeld = false;
  }

  // --- lookup ------------------------------------------------------------------

  function lookupAtPointer() {
    if (!settings.enabled) return;

    const hit = zh.resolveAtPoint(pointer.x, pointer.y);
    if (!hit) {
      leaveText();
      return;
    }

    // Landing on Chinese cancels any pending close, and reaching *different* text clears an
    // earlier Escape so the popup may open again.
    cancelClose();
    if (hit.key === suppressedKey) return;
    suppressedKey = null;

    if (hit.key === lastKey) return; // already on display
    if (hit.key === pendingKey) return; // already being fetched
    // A word crossed on the way to the popup isn't a word the user asked about.
    if (popup.visible && inApproachCorridor()) return;
    beginLookup(hit);
  }

  /**
   * Starts the lookup and, separately, decides when the result may be shown.
   *
   * Hover mode has to wait before opening, or the popup flashes on every word the pointer
   * crosses. But waiting and *then* fetching made that delay additive with the round trip to
   * the service worker -- which is why hover mode felt slower than the modifier, even though
   * both do identical work. The fetch now happens during the wait, so the cost is
   * max(delay, fetch) rather than delay + fetch.
   */
  function beginLookup(hit) {
    cancelPending();
    pendingKey = hit.key;

    // Modifier mode needs no dwell: pressing the key is already the signal.
    const delay = hoverMode() && !popup.visible ? settings.hoverDelay : 0;
    const showAt = performance.now() + delay;
    // Words merely passed over shouldn't cost a lookup at all, so let the pointer settle
    // briefly first. Kept well under the dwell so it stays hidden inside it.
    const settle = Math.min(PREFETCH_SETTLE, delay);

    prefetchTimer = setTimeout(() => {
      prefetchTimer = 0;
      fetchThenShow(hit, showAt);
    }, settle);
  }

  async function fetchThenShow(hit, showAt) {
    const id = ++requestId;
    let result;
    try {
      result = await send({
        type: 'lookup',
        text: hit.word,
        sentence: hit.sentence,
        url: location.href,
        title: document.title,
      });
    } catch (error) {
      // Most often the extension was reloaded and this context is orphaned.
      console.debug('[zh-dic] lookup failed', error);
      return;
    }
    if (id !== requestId) return; // a newer hover superseded this one

    if (!result.candidates.length) {
      pendingKey = null;
      leaveText();
      return;
    }

    const remaining = showAt - performance.now();
    if (remaining > 1) {
      showTimer = setTimeout(() => present(hit, result.candidates, result.glossPending), remaining);
    } else {
      present(hit, result.candidates, result.glossPending);
    }
  }

  function present(hit, candidates, glossPending) {
    showTimer = 0;
    pendingKey = null;
    lastKey = hit.key;
    current = hit;
    anchor = { x: pointer.x, y: pointer.y };
    popup.show(candidates, hit.rect, { glossPending });
  }

  // --- pronunciation -----------------------------------------------------------

  /**
   * Play one reading, honouring the configured source.
   *
   * 'auto' tries the OS voice first because it is instant and offline, and only reaches for
   * Commons when no Chinese voice is installed. Recordings are real speakers and so nicer to
   * learn from, but cost a network round trip and only exist for a fraction of the
   * dictionary -- choose 'recording' to prefer them anyway.
   *
   * Throws a tagged Error the popup turns into a tooltip; see describePlaybackError.
   */
  async function playPronunciation(card) {
    const source = settings.audio;
    const rate = settings.speechRate;

    // 'voice' and 'auto' both start with the OS voice: instant, offline, every entry covered.
    if (source !== 'recording' && zh.speech.voiceAvailable()) {
      return zh.speech.speakWithVoice(card.headword, rate);
    }
    if (source === 'voice') throw new Error('no-voice');

    // The reading is passed too: many Commons files are named in pinyin, and matching it
    // picks the recording for *this* reading rather than another of the same characters.
    const result = await send({ type: 'audio', word: card.headword, pinyin: card.pinyin });
    if (result.found) return zh.speech.playBytes(result.data, rate);
    if (result.error) throw new Error(`network: ${result.error}`);

    // 'recording' means recordings only, so it does not fall back to the voice here.
    throw new Error(source === 'recording' ? 'no-recording' : 'no-audio');
  }

  // --- Anki --------------------------------------------------------------------

  /**
   * Ask Anki which of this candidate's readings are already in the collection, and grey those
   * buttons out. Fire-and-forget: the popup has already rendered, so a slow or absent Anki
   * costs nothing but a button that stays enabled until the answer lands.
   */
  async function inspectAnki(candidate) {
    if (!settings.ankiEnabled) return;

    const shownFor = lastKey;
    try {
      const result = await send({ type: 'ankiInspect', cards: candidate.cards });
      // A newer lookup may have replaced the panel these buttons belong to.
      if (lastKey === shownFor) popup.applyAnkiStates(result);
    } catch (error) {
      if (lastKey === shownFor) popup.disableAnki(t('ankiAbsent'));
      console.debug('[zh-dic] anki inspect failed', error);
    }
  }

  /** Add one reading as a note. Errors propagate so the button can explain itself. */
  function addToAnki(card) {
    return send({ type: 'ankiAdd', card });
  }

  /** Underline the characters the selected tab actually covers. */
  function paintHighlight(length) {
    if (!('highlights' in CSS) || !current) return;
    CSS.highlights.delete(HIGHLIGHT);
    const range = zh.rangeForMatch(current.positions, length);
    if (range) CSS.highlights.set(HIGHLIGHT, new Highlight(range));
  }

  function dismiss() {
    cancelClose();
    cancelPending();
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }
    popup?.hide();
    if ('highlights' in CSS) CSS.highlights.delete(HIGHLIGHT);
    lastKey = null;
    anchor = null;
    current = null;
  }

  init().catch((error) => console.error('[zh-dic] failed to start', error));
})();
