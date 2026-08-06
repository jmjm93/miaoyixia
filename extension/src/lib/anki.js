// AnkiConnect client. Runs in the service worker: extension fetches with a host permission
// bypass CORS, and it keeps one point of contact rather than one per tab.
//
// AnkiConnect answers with 200 and {result, error} even for failures, so `error` has to be
// checked rather than the status code.

import { primaryField } from './anki-fields.js';
import { t } from './i18n.js';

export const ANKI_ORIGIN = 'http://127.0.0.1:8765';
const API_VERSION = 6;

/** AnkiConnect's wording when Anki itself refuses a note for being a duplicate. */
const DUPLICATE = /duplicate/i;

export class AnkiUnreachableError extends Error {}

/**
 * @param {(action: string, params?: object) => Promise<any>} [transport] injected for tests
 */
export function createClient(transport) {
  const invoke =
    transport ??
    (async (action, params = {}) => {
      let response;
      try {
        response = await fetch(ANKI_ORIGIN, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, version: API_VERSION, params }),
        });
      } catch (cause) {
        // Anki closed, AnkiConnect not installed, or the permission not granted.
        throw new AnkiUnreachableError(`Cannot reach Anki at ${ANKI_ORIGIN}`, { cause });
      }
      if (!response.ok) throw new Error(`AnkiConnect returned ${response.status} for ${action}`);

      const body = await response.json();
      if (body.error) throw new Error(body.error);
      return body.result;
    });

  return {
    invoke,

    version: () => invoke('version'),
    deckNames: () => invoke('deckNames'),
    modelNames: () => invoke('modelNames'),
    modelFieldNames: (modelName) => invoke('modelFieldNames', { modelName }),

    /**
     * Ask Anki whether each note could be added, and say why not.
     * This is the authoritative duplicate check: it uses Anki's own logic on the note type's
     * first field, so a greyed-out button matches exactly what Anki would refuse.
     */
    async inspect(notes) {
      const results = await invoke('canAddNotesWithErrorDetail', { notes });
      return results.map((result) => ({
        canAdd: Boolean(result.canAdd),
        duplicate: !result.canAdd && DUPLICATE.test(result.error ?? ''),
        error: result.canAdd ? '' : (result.error ?? 'unknown'),
      }));
    },

    addNote: (note) => invoke('addNote', { note }),

    /** @returns {Promise<string>} the filename Anki actually stored it under */
    storeMedia: (filename, base64) => invoke('storeMediaFile', { filename, data: base64 }),

    createDeck: (deck) => invoke('createDeck', { deck }),

    /**
     * Create a note type with the given field names, plus a card template and the tone CSS
     * that the coloured tokens rely on. Generated from the mapping so it works whatever the
     * user named their fields.
     */
    async createModel(modelName, mapping) {
      const fields = Object.keys(mapping);
      const front = primaryField(mapping);
      const rest = fields.filter((field) => field !== front && mapping[field] !== 'none');

      return invoke('createModel', {
        modelName,
        inOrderFields: fields,
        isCloze: false,
        css: MODEL_CSS,
        cardTemplates: [
          {
            Name: 'Recognition',
            Front: `<div class="zh-word">{{${front}}}</div>`,
            Back: ['{{FrontSide}}', '<hr id=answer>', ...rest.map((f) => `<div class="zh-${slug(f)}">{{${f}}}</div>`)].join(
              '\n',
            ),
          },
        ],
      });
    },
  };
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'field';

/**
 * Styling for an auto-created note type. The .tone1-.tone5 rules are the important part --
 * without them the tone-coloured tokens render as plain text. These are the conventional
 * colours, matching what existing Chinese note types use.
 */
const MODEL_CSS = `.card {
  font-family: system-ui, "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 20px;
  text-align: center;
  color: #1a1a1a;
  background-color: #ffffff;
  word-wrap: break-word;
}

.zh-word { font-size: 64px; margin: 12px 0; }
.zh-pinyin, .zh-reading { font-size: 28px; }
.zh-english, .zh-meaning { font-size: 20px; margin-top: 10px; }

.tone1 { color: #c0392b; }
.tone2 { color: #b7791f; }
.tone3 { color: #2f7d32; }
.tone4 { color: #2b5fd9; }
.tone5 { color: #6b7280; }

@media (prefers-color-scheme: dark) {
  .card { color: #e8eaed; background-color: #1f2227; }
  .tone1 { color: #f2777a; }
  .tone2 { color: #e0b060; }
  .tone3 { color: #8fc98f; }
  .tone4 { color: #7aa2f7; }
  .tone5 { color: #9aa0a6; }
}
`;

/**
 * Make sure the configured deck and note type exist, creating either if it doesn't.
 *
 * Deliberately called on the first *add*, not while merely inspecting: hovering a word should
 * never mutate the collection. Returns what had to be created, so the UI can say so.
 */
export async function ensureTarget(client, { deck, model, fields }) {
  const created = [];

  const decks = await client.deckNames();
  if (!decks.includes(deck)) {
    await client.createDeck(deck);
    created.push(t('createdDeck', deck));
  }

  const models = await client.modelNames();
  if (!models.includes(model)) {
    await client.createModel(model, fields);
    created.push(t('createdNoteType', model));
  }

  return created;
}

/**
 * Field names the collection actually has, reconciled with the configured mapping.
 * Fields the note type doesn't have are dropped -- sending them makes AnkiConnect reject the
 * whole note -- and fields it has but the mapping doesn't mention are added as empty.
 */
export function reconcileMapping(mapping, actualFields) {
  const reconciled = {};
  for (const field of actualFields) reconciled[field] = mapping[field] ?? 'none';
  return reconciled;
}
