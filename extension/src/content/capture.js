// Turning a snipped rectangle into pixels.
//
// The screenshot itself is taken by the service worker -- captureVisibleTab is not available to
// a content script -- and comes back as a PNG of the whole visible tab. Cropping it happens
// here, in the page, because this is where the coordinate system the user dragged in actually
// lives.

(() => {
  const zh = (globalThis.zhDic ??= {});

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('the capture could not be decoded'));
      image.src = src;
    });
  }

  /**
   * Cut the snipped region out of a full-viewport capture.
   *
   * @param {string} dataUrl A PNG of the whole visible tab.
   * @param {{x: number, y: number, width: number, height: number}} region In viewport CSS pixels.
   * @param {{width: number, height: number}} viewport The CSS-pixel area the capture covers, i.e.
   *   the viewport *including* its scrollbars. Passed in rather than read off `window` here so
   *   this stays a pure function of its inputs -- which is the only way the mapping can be tested
   *   at sizes a headless browser refuses to produce. See the caller for which globals to use.
   * @returns {Promise<{dataUrl: string, width: number, height: number}>} The crop, in device pixels.
   */
  zh.cropRegion = async function cropRegion(dataUrl, region, viewport) {
    const image = await loadImage(dataUrl);

    // Derive the scale from the capture itself rather than trusting devicePixelRatio. Browser
    // zoom folds into that ratio, and Chrome caps the capture on very large viewports -- either
    // way an assumed ratio silently crops the wrong part of the page, which looks like OCR
    // reading the wrong text rather than like a bug here.
    //
    // Per axis, because a horizontal scrollbar shortens the height the same way a vertical one
    // narrows the width.
    const scaleX = image.naturalWidth / viewport.width;
    const scaleY = image.naturalHeight / viewport.height;

    const width = Math.max(1, Math.round(region.width * scaleX));
    const height = Math.max(1, Math.round(region.height * scaleY));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    context.drawImage(
      image,
      Math.round(region.x * scaleX),
      Math.round(region.y * scaleY),
      width,
      height,
      0,
      0,
      width,
      height,
    );

    return { dataUrl: canvas.toDataURL('image/png'), width, height };
  };

  /**
   * Read Chinese out of a captured crop.
   *
   * The recogniser itself is nowhere near here -- it runs in an offscreen document, because it
   * is several megabytes of WASM that has to outlive the service worker. This just asks for it.
   *
   * Answers null when nothing legible was found, which the result window reports as such. That
   * is a normal outcome on a textured panel, not a failure, so it does not throw.
   *
   * @param {{dataUrl: string}} shot
   * @returns {Promise<string|null>}
   */
  zh.recognise = async function recognise(shot) {
    const response = await chrome.runtime.sendMessage({ type: 'recognise', dataUrl: shot.dataUrl });
    if (!response?.ok) throw new Error(response?.error ?? 'no response');
    return response.result?.text ?? null;
  };
})();
