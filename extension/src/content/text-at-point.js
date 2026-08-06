// Works out which character sits under the pointer, and reads the text forward from it.
//
// Two things make this less trivial than it looks on a real page:
//
//   1. caretRangeFromPoint() returns an *insertion point*, not a character. The glyph
//      under the pointer is on one side of it or the other, so we measure both.
//   2. Chinese words routinely straddle inline markup -- 中<a>国</a>菜 or text broken up
//      by <span>s for styling. Reading only the hovered text node would truncate the
//      word, so we walk the whole inline run of the containing block.

(() => {
  const zh = (globalThis.zhDic ??= {});

  /** How far forward to read. The dictionary's longest headword is 19 characters. */
  const FORWARD_CHARS = 24;
  /** Sentence context captured for study cards, and the widest block we'll scan. */
  const SENTENCE_LIMIT = 240;
  /** Safety valve on traversal, for blocks made of thousands of tiny text nodes. */
  const NODE_SCAN_LIMIT = 400;

  const HAN = /\p{Script=Han}/u;
  const SENTENCE_END = /[。！？；.!?;\n]/;
  // Elements whose text is never part of a word: ruby annotations carry pinyin above
  // the characters, and the rest simply aren't rendered prose.
  const SKIP_TAGS = new Set(['RT', 'RP', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'SELECT']);
  // Displays that keep text in the same visual run as its neighbours.
  const INLINE_DISPLAYS = new Set([
    'inline',
    'inline-block',
    'inline-flex',
    'inline-grid',
    'contents',
    'ruby',
    'ruby-base',
    'ruby-text',
    'ruby-base-container',
    'ruby-text-container',
  ]);

  const isHan = (ch) => HAN.test(ch);

  /**
   * The nearest ancestor that ends the inline text run -- i.e. the enclosing block.
   *
   * `cache` is passed in by readBlock so one walk resolves each element once. Without it
   * this runs getComputedStyle for every text node in the block, and forcing style
   * resolution that many times per pointer move is visible as jank while sweeping.
   */
  function blockRoot(node, cache) {
    const from = node.parentElement;
    if (!from) return document.body;
    if (cache?.has(from)) return cache.get(from);

    let el = from;
    while (el.parentElement && INLINE_DISPLAYS.has(getComputedStyle(el).display)) {
      el = el.parentElement;
    }
    cache?.set(from, el);
    return el;
  }

  function isSkipped(textNode) {
    for (let el = textNode.parentElement; el; el = el.parentElement) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.dataset?.zhDicHost !== undefined) return true; // our own popup
    }
    return false;
  }

  function charRect(node, offset) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    return range.getBoundingClientRect();
  }

  function rectHolds(rect, x, y) {
    return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /**
   * Resolve the pointer to a concrete (text node, offset). caretRangeFromPoint snaps to
   * the nearest caret position, so the glyph the user means is at `offset` or `offset - 1`;
   * hit-testing both rects tells us which, and rules out pointers sitting in padding or
   * line gaps rather than on a character.
   */
  function characterAtPoint(x, y) {
    const range = document.caretRangeFromPoint?.(x, y);
    if (!range) return null;

    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || isSkipped(node)) return null;

    for (const offset of [range.startOffset, range.startOffset - 1]) {
      if (offset < 0 || offset >= node.data.length) continue;
      const rect = charRect(node, offset);
      if (rectHolds(rect, x, y)) return { node, offset, rect };
    }
    return null;
  }

  /**
   * Read text outward from the cursor, and remember which DOM position each of the
   * following characters came from. Yields everything downstream needs: the candidate text
   * to look up, the sentence for a study card, and the positions used to highlight
   * whichever match the user selects.
   *
   * Both directions walk out from the cursor and stop once they have enough, rather than
   * scanning the block from its start. That keeps the cost flat instead of proportional to
   * block size -- which matters because hover mode resolves the pointer every frame, and
   * pages happily put an entire article in one <p>.
   */
  function readBlock({ node, offset }) {
    const cache = new Map();
    const root = blockRoot(node, cache);
    // A nested block starts a new visual run, so its text can't continue the word.
    const sameRun = (n) => n === node || blockRoot(n, cache) === root;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (isSkipped(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });

    // --- forward from the cursor ---
    let after = '';
    /** @type {Array<{node: Text, offset: number}>} */
    const positions = [];
    walker.currentNode = node;
    let visited = 0;
    for (let current = node; current; current = walker.nextNode()) {
      if (visited++ > NODE_SCAN_LIMIT) break;
      if (sameRun(current)) {
        // Take only what's still needed from this node. Reading it whole and checking
        // afterwards is what made this scale with block size -- a single text node can hold
        // the entire article.
        const start = current === node ? offset : 0;
        const wanted = Math.max(SENTENCE_LIMIT - after.length, FORWARD_CHARS - positions.length);
        const end = Math.min(current.data.length, start + wanted);
        for (let i = start; i < end && positions.length < FORWARD_CHARS; i++) {
          positions.push({ node: current, offset: i });
        }
        after += current.data.slice(start, end);
      }
      if (after.length >= SENTENCE_LIMIT && positions.length >= FORWARD_CHARS) break;
    }

    // --- backward, for sentence context only ---
    // Slice only as far back as the sentence limit: a single text node can hold an entire
    // article, and copying all of it to keep the last 240 characters is pure waste.
    let before = node.data.slice(Math.max(0, offset - SENTENCE_LIMIT), offset);
    walker.currentNode = node;
    visited = 0;
    for (let prev = walker.previousNode(); prev && before.length < SENTENCE_LIMIT; prev = walker.previousNode()) {
      if (visited++ > NODE_SCAN_LIMIT) break;
      if (sameRun(prev)) before = prev.data + before;
    }

    return { before: before.slice(-SENTENCE_LIMIT), after, positions };
  }

  /** The run of Han characters starting at the cursor -- what we actually look up. */
  function forwardWord(after) {
    let word = '';
    for (const ch of after) {
      if (!isHan(ch) || word.length >= FORWARD_CHARS) break;
      word += ch;
    }
    return word;
  }

  /** Trim the surrounding block text down to the sentence the word appears in. */
  function sentenceAround(before, after) {
    let left = before;
    for (let i = before.length - 1; i >= 0; i--) {
      if (SENTENCE_END.test(before[i])) {
        left = before.slice(i + 1);
        break;
      }
    }
    let right = after;
    for (let i = 0; i < after.length; i++) {
      if (SENTENCE_END.test(after[i])) {
        right = after.slice(0, i + 1);
        break;
      }
    }
    return (left + right).trim().slice(0, SENTENCE_LIMIT);
  }

  /**
   * @returns {null | {word: string, sentence: string, rect: DOMRect,
   *                   positions: Array<{node: Text, offset: number}>, key: string}}
   */
  zh.resolveAtPoint = function resolveAtPoint(x, y) {
    const hit = characterAtPoint(x, y);
    if (!hit || !isHan(hit.node.data[hit.offset])) return null;

    const { before, after, positions } = readBlock(hit);
    const word = forwardWord(after);
    if (!word) return null;

    return {
      word,
      sentence: sentenceAround(before, after),
      rect: hit.rect,
      positions,
      // Identifies the hovered character so a mousemove within the same glyph is a no-op.
      key: `${word}@${hit.offset}`,
    };
  };

  /** A Range spanning `length` characters from the cursor, for highlighting the match. */
  zh.rangeForMatch = function rangeForMatch(positions, length) {
    const first = positions[0];
    const last = positions[Math.min(length, positions.length) - 1];
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    return range;
  };
})();
