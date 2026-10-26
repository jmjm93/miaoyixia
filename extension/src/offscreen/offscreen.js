// The text recogniser, kept alive off to one side.
//
// Everything here is arranged around two MV3 facts. The service worker is killed after about
// thirty seconds idle, so it cannot hold a 6 MB engine between snips; and remote code is
// forbidden, so tesseract.js must be pointed at vendored copies of its worker, its core and its
// model rather than the CDN it reaches for by default. See tools/fetch-ocr.mjs for what those
// files are and why there is exactly one core build.
//
// The engine is created lazily on the first snip and then reused. Creating it costs a second or
// two -- almost all of it parsing the WASM -- and doing that per snip would be most of the wait.

// Default import, not `{ createWorker }`. The ESM bundle exports one default object and no named
// bindings, so destructuring it throws at module-evaluation time -- which meant this file never
// ran, never registered its listener, and every snip failed with the singularly unhelpful
// "Could not establish connection. Receiving end does not exist."
import Tesseract from '../../data/ocr/tesseract.esm.min.js';
import { OCR_MODELS, JAPANESE_OCR_MODELS, findColumnCuts, inkProfile, isVertical, recogniserScale } from '../lib/ocr.js';
import { withJapaneseModelCache } from '../lib/japanese-store.js';

/** LSTM only. The legacy engine is not in the core build we vendor, and we never want it. */
const LSTM_ONLY = 1;

/**
 * Page segmentation mode 5, "a single uniform block of vertically aligned text".
 *
 * Not optional, and not obvious: loading a `_vert` model is on its own not enough. Measured on a
 * vertical sample, chi_sim_vert at the default mode scored 21% and returned nonsense, and the
 * same model at mode 5 scored 87% and read it exactly. The model knows the glyphs; the mode is
 * what tells the layout analyser to look for columns.
 */
const PSM_VERTICAL_BLOCK = '5';

/**
 * One engine per model, built on demand and kept.
 *
 * Keyed rather than single because the script and direction settings can change between snips --
 * the result window can change them without a re-snip -- and rebuilding six megabytes of WASM on
 * every toggle would make that unusable. Four resident engines is the worst case.
 */
const engines = new Map();

async function startEngine(model) {
  const japanese = JAPANESE_OCR_MODELS.includes(model);
  const start = () => Tesseract.createWorker(model, LSTM_ONLY, {
    // Every path is an extension URL: nothing may be fetched from the network.
    workerPath: chrome.runtime.getURL('data/ocr/worker.min.js'),
    corePath: chrome.runtime.getURL('data/ocr/tesseract-core-simd-lstm.wasm.js'),
    langPath: chrome.runtime.getURL('data/ocr'),
    // The model ships uncompressed, so tesseract.js must not append ".gz" to the name.
    gzip: false,
    // Load the worker from its extension URL rather than wrapping it in a blob: URL. The blob
    // route is what tesseract.js does by default and what MV3 is most likely to object to.
    workerBlobURL: false,
    // The model is already on disk beside us; caching a copy of it in IndexedDB buys nothing.
    cacheMethod: japanese ? 'readOnly' : 'none',
  });
  const worker = japanese ? await withJapaneseModelCache(model, start) : await start();

  if (isVertical(model)) await worker.setParameters({ tessedit_pageseg_mode: PSM_VERTICAL_BLOCK });
  return worker;
}

function recogniser(model) {
  if (!engines.has(model)) {
    engines.set(
      model,
      startEngine(model).catch((error) => {
        // Don't leave a rejected promise cached, or every later snip fails with the first error.
        engines.delete(model);
        throw error;
      }),
    );
  }
  return engines.get(model);
}

/**
 * Chinese has no inter-word spaces, but Tesseract emits them between characters anyway -- along
 * with the line breaks it uses for layout. Both are artefacts of recognition rather than content,
 * and a lookup of "中 国 菜" matches nothing, so all whitespace goes.
 */
function tidy(text) {
  return (text ?? '').replace(/\s+/gu, '');
}

/**
 * Enlarge a capture to the size the recogniser reads best at.
 *
 * How much is decided by recogniserScale, which targets an absolute size rather than multiplying
 * blindly -- see the note there for why a fixed factor was wrong.
 */
async function enlarge(dataUrl) {
  const image = new Image();
  await new Promise((ok, fail) => {
    image.onload = ok;
    image.onerror = () => fail(new Error('the capture could not be decoded'));
    image.src = dataUrl;
  });

  const scale = recogniserScale(image.naturalWidth, image.naturalHeight);
  if (scale === 1) return image; // already big enough; tesseract.js takes an image directly

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);

  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Split a vertical capture into its columns, if it has more than one.
 *
 * Only for vertical text. Mode 5 is the weak one -- horizontal line finding is what Tesseract's
 * default mode is built around and it does that well, so there is nothing to fix there and no
 * measurement saying otherwise.
 *
 * @returns {HTMLCanvasElement[]} One canvas per column, right to left, or [] when there is only
 *   one column and the capture should be read whole.
 */
function splitColumns(source) {
  const width = source.width ?? source.naturalWidth;
  const height = source.height ?? source.naturalHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  // Flattened onto white first: a transparent capture would read as black everywhere.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0);

  const pixels = context.getImageData(0, 0, width, height).data;
  const cuts = findColumnCuts(inkProfile(pixels, width, height), height);
  if (!cuts.length) return [];

  const edges = [0, ...cuts, width];
  const columns = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const from = Math.round(edges[i]);
    const slice = document.createElement('canvas');
    slice.width = Math.max(1, Math.round(edges[i + 1]) - from);
    slice.height = height;
    const ctx = slice.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, from, 0, slice.width, height, 0, 0, slice.width, height);
    columns.push(slice);
  }
  // Vertical Chinese reads the rightmost column first.
  return columns.reverse();
}

async function recognise(dataUrl, model) {
  const chosen = [...OCR_MODELS, ...JAPANESE_OCR_MODELS].includes(model) ? model : OCR_MODELS[0];
  const worker = await recogniser(chosen);
  // The canvas goes straight in; tesseract.js takes one, so there is no second base64 round trip.
  const image = await enlarge(dataUrl);

  const columns = isVertical(chosen) ? splitColumns(image) : [];
  if (columns.length < 2) {
    const { data } = await worker.recognize(image);
    const text = tidy(data?.text);
    return { text: text || null, confidence: data?.confidence ?? null };
  }

  let text = '';
  let confidence = 0;
  for (const column of columns) {
    const { data } = await worker.recognize(column);
    text += tidy(data?.text);
    confidence += (data?.confidence ?? 0) / columns.length;
  }
  // Confidence travels with the text so the window can eventually say "this reading is a guess"
  // rather than presenting a bad OCR result with the same certainty as a hovered word.
  return { text: text || null, confidence };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ocr:clearJapanese') {
    const pending = JAPANESE_OCR_MODELS.map((model) => {
      const engine = engines.get(model);
      engines.delete(model);
      return engine?.then((worker) => worker.terminate());
    });
    Promise.allSettled(pending).then(() => sendResponse({ ok: true }));
    return true;
  }
  // Answering this is the whole point: createDocument resolves as soon as the document exists,
  // which is before a deferred module script has run. The worker pings until this replies, so it
  // never hands work to a document that cannot yet receive it.
  if (message?.type === 'ocr:ping') {
    sendResponse({ ok: true });
    return false;
  }

  // Addressed messages only: the service worker broadcasts to every extension page, and this
  // document must not answer for anything but its own job.
  if (message?.type !== 'ocr:run') return false;

  recognise(message.dataUrl, message.model).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => {
      console.error('[zh-dic] recognition failed', error);
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    },
  );
  return true; // response is async
});
