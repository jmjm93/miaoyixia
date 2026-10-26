// Synthesised pronunciation, used when Commons has no human recording of a word.
//
// Why this exists: Commons coverage measured against the matcher in audio-source.js is ~80%
// for the 25 most frequent words but ~12% by rank 2000, and mining vocabulary lives well past
// that. Without a fallback, most exported notes get an empty audio field -- and a synthetic
// voice on the card beats silence. Neither service is reachable for a *traditional-only*
// headword either (於 has no recording in either script), so this is the only thing that
// covers those at all.
//
// Both providers are plain GETs returning MP3 bytes, which is the whole reason they were
// picked over Amazon Polly (needs credentials) or gTTS's current RPC endpoint (a POST with a
// nested-JSON `f.req` payload). Chinese Support 3 uses the same two hosts, so a collection
// mixing notes from that addon and this extension stays consistent.
//
// Both are undocumented endpoints belonging to consumer web apps rather than public APIs.
// They can change without notice, so every failure here is non-fatal: the caller adds the note
// without audio rather than losing it.

/** Google Translate's speech endpoint. `client=tw-ob` needs no signing token. */
const GOOGLE = 'https://translate.google.com/translate_tts';
/** Baidu Translate's, as used by Chinese Support 3. */
const BAIDU = 'https://fanyi.baidu.com/gettts';

/**
 * Longest text either endpoint will read. Both truncate rather than erroring beyond roughly
 * this, which would silently give a half-spoken card, so it is checked up front instead.
 */
const MAX_CHARS = 100;

export const TTS_SERVICES = ['google', 'baidu'];

/**
 * Baidu's speed scale is 1-9 around a default of 5, not a multiplier. Chinese Support 3 sends
 * a flat 2, which is slow enough to sound laboured on single words; this maps the extension's
 * own 0.5x-1.2x range onto the same scale so the setting means one thing everywhere.
 */
export function baiduSpeed(rate = 1) {
  // Math.min/max propagate NaN rather than clamping it, so a corrupt stored setting would
  // otherwise reach the endpoint as `spd=NaN`.
  const wanted = Number.isFinite(rate) ? rate : 1;
  const scaled = Math.round(5 * Math.max(0.5, Math.min(1.2, wanted)));
  return Math.max(1, Math.min(9, scaled));
}

/** The request headers a service will answer. Exported so a test can assert the pairing. */
export function refererFor(service) {
  if (service === 'google') return { Referer: 'https://translate.google.com/' };
  if (service === 'baidu') return { Referer: 'https://fanyi.baidu.com/' };
  return {};
}

/** The URL that returns MP3 bytes for `text`, or '' if the service name isn't known. */
export function ttsUrl(service, text, rate = 1, language = 'zh') {
  if (service === 'google') {
    const params = new URLSearchParams({
      ie: 'UTF-8',
      q: text,
      tl: language === 'ja' ? 'ja' : 'zh-CN',
      client: 'tw-ob',
      // Google's own slow mode is a hard 0.3x, far below anything useful for a learner, so
      // playback speed is left to the player and only the neutral rendering is requested.
      ttsspeed: '1',
      total: '1',
      idx: '0',
      textlen: String([...text].length),
    });
    return `${GOOGLE}?${params}`;
  }

  if (service === 'baidu' && language !== 'ja') {
    const params = new URLSearchParams({
      lan: 'zh',
      ie: 'UTF-8',
      text,
      spd: String(baiduSpeed(rate)),
      source: 'web',
    });
    return `${BAIDU}?${params}`;
  }

  return '';
}

/**
 * Synthesise `text`, or return null if it can't be had.
 *
 * @param {string} text the word to speak
 * @param {object} options
 * @param {string} options.service one of TTS_SERVICES
 * @param {number} [options.rate] playback speed, only used by Baidu (see baiduSpeed)
 * @param {(url: string) => Promise<Response>} [options.fetchImpl] injected for testing
 * @returns {Promise<{data: ArrayBuffer, mime: string, extension: string, service: string}|null>}
 */
export async function synthesise(text, { service, rate = 1, language = 'zh', fetchImpl = fetch } = {}) {
  const word = String(text ?? '').trim();
  if (!word || [...word].length > MAX_CHARS) return null;

  const url = ttsUrl(service, word, rate, language);
  if (!url) return null;

  // Each host wants to see its own page as the referrer -- sending Google's to Baidu gets a
  // 200 with an empty body, which is how this went wrong the first time. gTTS sends the
  // Google one for the same reason.
  const response = await fetchImpl(url, { headers: refererFor(service) });
  if (!response.ok) throw new Error(`tts ${service} failed: ${response.status}`);

  const data = await response.arrayBuffer();
  // Both hosts answer a rejected request with a 200 and an HTML error page, so a body that is
  // too small to be speech is treated as a failure rather than written to the collection as a
  // silent, unplayable file.
  if (data.byteLength < 512) throw new Error(`tts ${service} returned ${data.byteLength} bytes`);

  return {
    data,
    mime: response.headers.get('content-type') ?? 'audio/mpeg',
    extension: '.mp3',
    service,
  };
}
