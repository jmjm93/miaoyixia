// Region selection, in the style of the OS screenshot tools: drag a box over some text and
// what's inside it becomes the input to OCR.
//
// This deliberately does *not* go looking for the text itself. Reading a manhua page otherwise
// means guessing which element holds the art -- an <img>, a <canvas>, a CSS background -- and
// then whether the browser will even let us read its pixels, since anything cross-origin taints
// the canvas. The user settles all of that in one drag. When the result comes back wrong they
// zoom the page in and drag again, which is a better answer than any heuristic we could write.
//
// The overlay only ever reports a rectangle. Capturing it and recognising the text happen
// elsewhere, so this file needs no permissions and can be driven from a test with nothing but
// pointer events.

(() => {
  const zh = (globalThis.zhDic ??= {});
  // messages.js is loaded ahead of this file by the manifest, so the catalogue is already there.
  const { t } = globalThis.zhI18n;

  /** Drags shorter than this in either direction are a mis-click, not a selection. */
  const MIN_SIZE = 8;

  /** The live session, so a second trigger replaces the first rather than stacking overlays. */
  let active = null;

  const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

  /** Pointer position in viewport coordinates, kept inside the viewport. */
  function pointAt(event) {
    return {
      x: clamp(event.clientX, 0, document.documentElement.clientWidth),
      y: clamp(event.clientY, 0, document.documentElement.clientHeight),
    };
  }

  function boxBetween(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  function build() {
    const host = document.createElement('div');
    // Marks the overlay so hover resolution ignores it -- the same flag the popup uses.
    host.dataset.zhDicHost = '';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = chrome.runtime.getURL('src/content/snip.css');

    const sheet = document.createElement('div');
    sheet.className = 'sheet';

    // One element covers both states. Its shadow spreads a viewport's worth in every direction,
    // so at zero size it simply dims the whole page; once the drag grows it, the same shadow
    // becomes the dimming *outside* the selection. No second element, and no hole to punch.
    const rect = document.createElement('div');
    rect.className = 'rect';

    const size = document.createElement('div');
    size.className = 'size';

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = t('snipHint');

    rect.append(size);
    sheet.append(rect, hint);
    root.append(style, sheet);
    return { host, sheet, rect, size, hint };
  }

  /**
   * Put the user in region-select mode.
   *
   * @returns {Promise<null | {x: number, y: number, width: number, height: number, dpr: number}>}
   *   The selection in viewport CSS pixels, or null if it was cancelled or too small to mean
   *   anything. `dpr` comes back with it because the capture this feeds is in device pixels, and
   *   the ratio has to be the one in force at selection time.
   */
  zh.startSnip = function startSnip() {
    // Every frame runs its own copy of the content script, but the overlay is viewport-wide and
    // the capture that follows is of the whole tab, so only the top frame may own one.
    if (window.top !== window) return Promise.resolve(null);

    // Whatever was mid-drag belongs to a trigger the user has already replaced.
    active?.();

    const ui = build();
    (document.body ?? document.documentElement).append(ui.host);

    return new Promise((resolve) => {
      let origin = null;
      let box = null;

      function paint() {
        const { x, y, width, height } = box;
        ui.rect.style.left = `${x}px`;
        ui.rect.style.top = `${y}px`;
        ui.rect.style.width = `${width}px`;
        ui.rect.style.height = `${height}px`;

        // Device pixels, not CSS ones: this is what the capture will actually contain, and it's
        // the number that decides whether the text is big enough to recognise. Showing 400 x 90
        // for a selection that reaches OCR as 200 x 45 would be actively misleading.
        const dpr = window.devicePixelRatio || 1;
        ui.size.textContent = `${Math.round(width * dpr)} × ${Math.round(height * dpr)}`;
      }

      function finish(result) {
        if (active !== cancel) return;
        active = null;
        detach();
        ui.host.remove();
        resolve(result);
      }

      const cancel = () => finish(null);

      function onPointerDown(event) {
        if (event.button !== 0) return cancel(); // right or middle click backs out
        event.preventDefault();
        origin = pointAt(event);
        box = boxBetween(origin, origin);
        ui.sheet.setPointerCapture(event.pointerId);
        ui.rect.classList.add('drawing');
        ui.hint.hidden = true;
        paint();
      }

      function onPointerMove(event) {
        if (!origin) return;
        event.preventDefault();
        box = boxBetween(origin, pointAt(event));
        paint();
      }

      function onPointerUp(event) {
        if (!origin) return;
        event.preventDefault();
        box = boxBetween(origin, pointAt(event));
        // A stray click while aiming shouldn't hand OCR a two-pixel sliver of nothing.
        if (box.width < MIN_SIZE || box.height < MIN_SIZE) return cancel();
        finish({ ...box, dpr: window.devicePixelRatio || 1 });
      }

      function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        // Capture phase and stopped here: pages bind Escape for their own lightboxes and
        // galleries, which is exactly the sort of page this gets used on.
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }

      // The capture that follows is of the viewport as it stands, so the page must not move
      // underneath a selection that's already been drawn. Swallowing the scroll keeps the
      // rectangle meaning what it looked like it meant; changing overflow instead would reflow
      // the page and shift the very text the user was aiming at.
      const swallow = (event) => event.preventDefault();

      function detach() {
        ui.sheet.removeEventListener('pointerdown', onPointerDown);
        ui.sheet.removeEventListener('pointermove', onPointerMove);
        ui.sheet.removeEventListener('pointerup', onPointerUp);
        ui.sheet.removeEventListener('contextmenu', swallow);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('wheel', swallow, { capture: true });
        window.removeEventListener('touchmove', swallow, { capture: true });
        window.removeEventListener('blur', cancel);
        window.removeEventListener('resize', cancel);
      }

      ui.sheet.addEventListener('pointerdown', onPointerDown);
      ui.sheet.addEventListener('pointermove', onPointerMove);
      ui.sheet.addEventListener('pointerup', onPointerUp);
      ui.sheet.addEventListener('contextmenu', swallow);
      window.addEventListener('keydown', onKeyDown, true);
      // passive: false, or preventDefault is ignored and the page scrolls anyway.
      window.addEventListener('wheel', swallow, { capture: true, passive: false });
      window.addEventListener('touchmove', swallow, { capture: true, passive: false });
      // Switching tab or window mid-drag abandons the selection: whatever comes back into view
      // is no longer what was framed.
      window.addEventListener('blur', cancel);
      window.addEventListener('resize', cancel);

      active = cancel;
    });
  };

  /** True while a selection is in progress, so lookups can stand down. */
  zh.snipping = () => active !== null;
})();
