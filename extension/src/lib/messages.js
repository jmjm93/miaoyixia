// Every string the extension puts on screen, in every language it speaks.
//
// This file is deliberately written as a *classic* script -- no `import`, no `export` -- because
// it has to be readable from both of the extension's two worlds:
//
//   - the content scripts, which the manifest loads as classic scripts and which therefore
//     cannot use ES module syntax at all;
//   - the service worker and the options page, which are ES modules.
//
// So it publishes itself on globalThis, and `i18n.js` next door re-exports that for the module
// side. One catalogue, no duplication, and no async loading anywhere: `t()` is a plain function
// call, which matters because the popup renders on the hover path where a round trip would show.
//
// chrome.i18n is used only to *read* the browser's language. The strings are not in _locales/
// because chrome.i18n.getMessage() always answers in the browser's UI language and cannot be
// overridden -- and a Spanish speaker on an English-language browser is exactly the user this
// extension is for. _locales/ still holds the two strings Chrome itself renders (the extension
// name and description), which are the only ones we don't control the rendering of.

(() => {
  /** Languages offered in the options page, keyed by the code stored in settings. */
  const LANGUAGES = {
    en: 'English',
    es: 'Español',
  };

  const FALLBACK = 'en';

  const CATALOGUE = {
    en: {
      // --- options page: chrome ---
      optionsTitle: '瞄一下 settings',
      tagline: 'Chinese popup dictionary.',
      saved: 'Saved',

      // --- options page: lookups ---
      enabled: 'Enabled',
      uiLanguage: 'Language',
      uiLanguageHint: 'Language of this page, the popup and the toolbar menu',
      langAuto: 'Match browser',
      glossLanguage: 'Definitions',
      glossLanguageHint: 'Language of the definitions themselves. Spanish is downloaded once, then works offline',
      glossAvailable: 'Definition languages',
      glossBundled: 'Included with the extension',
      glossNotDownloaded: 'Not downloaded',
      glossDownload: 'Download',
      glossDownloading: 'Downloading… $1%',
      glossPreparing: 'Preparing…',
      glossDownloaded: '$1 definitions · $2',
      glossFailed: 'Download failed: $1',
      glossRemove: 'Remove',
      glossRemoveActive: 'These definitions are in use. Switch Definitions to another language first.',
      glossNeedsPermission: 'Needs permission to reach github.com',
      glossUpdate: 'A newer version is available',
      trigger: 'Trigger',
      holdShift: 'Hold Shift',
      holdCtrl: 'Hold Ctrl',
      holdAlt: 'Hold Alt',
      holdWin: 'Hold Win',
      holdCmd: 'Hold Cmd',
      noKey: 'No key — show on hover',
      hoverDelay: 'Hover delay',
      hoverDelayHint: 'How long to rest on a word before it opens',
      showScript: 'Show script',
      simplifiedFirst: 'Simplified first',
      traditionalFirst: 'Traditional first',

      // --- options page: pronunciation ---
      pronunciation: 'Pronunciation',
      audioSource: 'Audio source',
      audioAuto: 'Voice, then recording',
      audioVoice: 'Computer voice only',
      audioRecording: 'Wikimedia recordings only',
      audioOff: 'No audio button',
      audioHintAuto: 'Uses an installed Chinese voice; falls back to a Wikimedia recording when there is none.',
      audioHintVoice: 'Offline and instant, covers every entry — but needs a Chinese voice installed.',
      audioHintRecording: 'Real speakers from Wikimedia Commons. Only common words have one.',
      audioHintOff: 'Hides the play button entirely.',
      playbackSpeed: 'Playback speed',
      playbackSpeedHint: 'Recordings are only ever slowed, never sped up',
      voiceChecking: 'Checking for Chinese voices…',
      voiceFound: 'Chinese voice found: $1',
      voiceMissing:
        'No Chinese voice is installed, so the computer-voice options are unavailable and ' +
        'Wikimedia recordings are being used instead. Installing a voice is worth it: it is ' +
        'the better option of the two — instant, fully offline, and it covers every entry in ' +
        'the dictionary, whereas Commons only has recordings for common words.',
      voiceHelpSummary: 'How to add a Chinese voice to Windows',
      voiceHelpStep1: 'Open <b>Settings → Time &amp; language → Language &amp; region</b>.',
      voiceHelpStep2:
        '<b>Add a language</b> → search for <b>Chinese (Simplified, China)</b> → Next.',
      voiceHelpStep3:
        'Tick <b>Speech</b> (and <b>Text-to-speech</b> if listed). You can untick “Set as my ' +
        'Windows display language” — you only need the voice.',
      voiceHelpStep4: 'Install, then <b>restart the browser</b> so it picks the new voice up.',
      voiceHelpNote:
        'This installs the Microsoft zh-CN voices. Afterwards audio works offline, instantly, ' +
        'and for all $1 entries — no network request at all. On macOS the equivalent is ' +
        '<b>System Settings → Accessibility → Spoken Content → System voice → Manage Voices</b>.',

      // --- options page: Anki ---
      ankiEnabled: 'Show an “add to Anki” button',
      ankiEnabledHint: 'Needs Anki running with the AnkiConnect add-on',
      localAccess: 'Local access',
      granted: 'Granted',
      notGranted: 'Not granted',
      grant: 'Grant',
      connection: 'Connection',
      notChecked: 'Not checked',
      check: 'Check',
      checking: 'Checking…',
      grantFirst: 'Grant local access first',
      ankiConnected: 'Connected — AnkiConnect v$1, $2 decks',
      ankiConnected_one: 'Connected — AnkiConnect v$1, $2 deck',
      ankiWillCreate: ' · “$1” will be created on first use',
      ankiUnreachable: 'Not reachable — is Anki running? ($1)',
      deck: 'Deck',
      deckHint: 'Created automatically if it doesn’t exist yet',
      noteType: 'Note type',
      noteTypeHint: 'Also created automatically, with tone colouring',
      tags: 'Tags',
      fields: 'Fields',
      fieldsNote:
        'Choose what goes in each field of your note type. Read from your collection, so any ' +
        'naming works.',

      // --- Anki field bindings (anki-fields.js TOKENS) ---
      tokenNone: '— leave empty —',
      tokenHeadword: 'Word (as hovered)',
      tokenSimplified: 'Simplified',
      tokenTraditional: 'Traditional',
      tokenColourHanzi: 'Word, tone-coloured',
      tokenPinyin: 'Pinyin (nǐ hǎo)',
      tokenColourPinyin: 'Pinyin, tone-coloured',
      tokenPinyinNumbered: 'Pinyin, numbered (ni3 hao3)',
      tokenSenses: 'All definitions',
      tokenSensesNumbered: 'All definitions, numbered',
      tokenFirstSense: 'First definition only',
      tokenSentence: 'Example sentence (from the page)',
      tokenSentenceBold: 'Example sentence, word in bold',
      tokenAudio: 'Pronunciation audio',
      tokenSource: 'Source page (link)',
      tokenSourceUrl: 'Source page (plain URL)',

      // --- options page: appearance ---
      appearance: 'Appearance',
      theme: 'Theme',
      themeAuto: 'Match system',
      themeLight: 'Light',
      themeDark: 'Dark',
      fontSize: 'Font size',
      maxSenses: 'Senses shown before collapsing',

      // --- options page: shortcuts ---
      shortcuts: 'Shortcuts',
      keySwitch: 'Switch between candidate words',
      keyJump: 'Jump straight to a candidate — the digit shown on its tab',
      keyClose: 'Close the popup',

      // --- options page: dictionary ---
      dictionary: 'Dictionary',
      loading: 'Loading…',
      dictMeta: '$1 entries · $2 headwords · CC-CEDICT release $3',
      dictMissing:
        'Dictionary data not found — run `npm run build` in the project root, then reload the extension.',
      creditPre: 'Definitions from',
      creditMid: ', used under',
      creditPost: '.',

      // --- the popup ---
      popupHint: '$1 to look up · ←/→ switch · Esc to close',
      popupHintHover: 'Hover',
      popupHintKey: '$1-hover',
      moreSenses: '+$1 more',
      glossPending:
        'Showing English. The Spanish definitions have not been downloaded yet — open the ' +
        'extension options to get them.',
      glossMissingEntry: 'Showing English: this entry has no Spanish definition yet.',
      playPronunciation: 'Play pronunciation of $1',
      play: 'Play $1',
      addToAnki: 'Add $1 to Anki',
      alreadyInAnki: 'Already in your Anki collection',
      ankiRejected: 'Anki won’t accept this note: $1',
      ankiAddFailed: 'Could not add: $1',
      ankiAdded: 'Added to $1',
      ankiAddedCreated: 'Added to $1 (created $2)',
      ankiAbsent: 'Anki is not running, or AnkiConnect is unavailable',
      createdDeck: 'deck “$1”',
      createdNoteType: 'note type “$1”',
      and: ' and ',
      noVoice: 'No Chinese voice installed — see the extension options',
      noRecording: 'No recording on Wikimedia Commons for this word',
      noAudio: 'No Chinese voice installed and no recording found',
      playbackFailed: 'Could not play audio: $1',

      // --- toolbar button and its menu ---
      actionOff: '$1 — off\nClick to turn on',
      actionOn: '$1 — on, $2\nClick to turn off',
      actionHoldKey: 'hold $1',
      actionHover: 'hover, no key needed',
      menuRequireKey: 'Require $1 to look up',
      menuRequireAKey: 'Require a key',
      menuOptions: 'Options…',
    },

    es: {
      // --- options page: chrome ---
      optionsTitle: 'Ajustes de 瞄一下',
      tagline: 'Diccionario popup de chino.',
      saved: 'Guardado',

      // --- options page: lookups ---
      enabled: 'Activado',
      uiLanguage: 'Idioma',
      uiLanguageHint: 'Idioma de esta página, del popup y del menú de control (no de las traducciones en sí)',
      langAuto: 'Como el navegador',
      glossLanguage: 'Definiciones',
      glossLanguageHint: 'Idioma de las definiciones. El español se descarga una vez y luego funciona sin conexión',
      glossAvailable: 'Idiomas de las definiciones',
      glossBundled: 'Incluido con la extensión',
      glossNotDownloaded: 'Sin descargar',
      glossDownload: 'Descargar',
      glossDownloading: 'Descargando… $1 %',
      glossPreparing: 'Preparando…',
      glossDownloaded: '$1 definiciones · $2',
      glossFailed: 'Error en la descarga: $1',
      glossRemove: 'Eliminar',
      glossRemoveActive: 'Estas definiciones están en uso. Cambia Definiciones a otro idioma primero.',
      glossNeedsPermission: 'Necesita permiso para acceder a github.com',
      glossUpdate: 'Hay una versión más reciente',
      trigger: 'Activación',
      holdShift: 'Mantener Shift',
      holdCtrl: 'Mantener Ctrl',
      holdAlt: 'Mantener Alt',
      holdWin: 'Mantener Win',
      holdCmd: 'Mantener Cmd',
      noKey: 'Sin tecla — mostrar al pasar el ratón',
      hoverDelay: 'Retardo del ratón',
      hoverDelayHint: 'Cuánto hay que parar el cursor sobre una palabra antes de que se abra el popup',
      showScript: 'Escritura',
      simplifiedFirst: 'Simplificado primero',
      traditionalFirst: 'Tradicional primero',

      // --- options page: pronunciation ---
      pronunciation: 'Pronunciación',
      audioSource: 'Fuente del audio',
      audioAuto: 'Voz y, si no, grabación',
      audioVoice: 'Solo voz del ordenador',
      audioRecording: 'Solo grabaciones de Wikimedia',
      audioOff: 'Sin botón de audio',
      audioHintAuto:
        'Usa una voz china instalada en el ordenador; si no hay, recurre a grabación de Wikimedia.',
      audioHintVoice:
        'Sin conexión e instantáneo, cubre todas las entradas — pero necesita una voz china instalada.',
      audioHintRecording:
        'Grabaciones de personas reales de Wikimedia Commons. Pero no todas las palabras tienen audio.',
      audioHintOff: 'Oculta por completo el botón de reproducción.',
      playbackSpeed: 'Velocidad de reproducción',
      playbackSpeedHint: 'Las grabaciones solo se ralentizan, nunca se aceleran',
      voiceChecking: 'Buscando voces en chino…',
      voiceFound: 'Voz en chino encontrada: $1',
      voiceMissing:
        'No hay ninguna voz en chino instalada, así que las opciones de voz del ordenador no ' +
        'están disponibles y se usan grabaciones de Wikimedia en su lugar. Recomiendo instalar ' +
        'una voz: es la mejor de las dos opciones — instantánea, totalmente sin conexión, y cubre ' +
        'todas las entradas del diccionario, mientras que Commons solo tiene grabaciones de ' +
        'palabras comunes.',
      voiceHelpSummary: 'Cómo añadir una voz en chino a Windows',
      voiceHelpStep1: 'Abre <b>Configuración → Hora e idioma → Idioma y región</b>.',
      voiceHelpStep2:
        '<b>Agregar un idioma</b> → busca <b>Chino (simplificado, China)</b> → Siguiente.',
      voiceHelpStep3:
        'Marca <b>Voz</b> (y <b>Texto a voz</b> si aparece). Puedes desmarcar «Establecer como ' +
        'idioma de presentación de Windows» — solo necesitas la voz.',
      voiceHelpStep4: 'Instálalo y <b>reinicia el navegador</b> para que detecte la nueva voz.',
      voiceHelpNote:
        'Esto instala las voces zh-CN de Microsoft. Después el audio funciona sin conexión, al ' +
        'instante y para las $1 entradas — sin ninguna petición de red. En macOS el equivalente es ' +
        '<b>Ajustes del Sistema → Accesibilidad → Contenido hablado → Voz del sistema → ' +
        'Gestionar voces</b>.',

      // --- options page: Anki ---
      ankiEnabled: 'Mostrar un botón «añadir a Anki»',
      ankiEnabledHint: 'Requiere Anki abierto con el addon AnkiConnect',
      localAccess: 'Acceso local',
      granted: 'Concedido',
      notGranted: 'No concedido',
      grant: 'Conceder',
      connection: 'Conexión',
      notChecked: 'Sin comprobar',
      check: 'Comprobar',
      checking: 'Comprobando…',
      grantFirst: 'Concede primero el acceso local',
      ankiConnected: 'Conectado — AnkiConnect v$1, $2 mazos',
      ankiConnected_one: 'Conectado — AnkiConnect v$1, $2 mazo',
      ankiWillCreate: ' · «$1» se creará al usarlo por primera vez',
      ankiUnreachable: 'Sin conexión — ¿está Anki abierto? ($1)',
      deck: 'Mazo',
      deckHint: 'Se crea automáticamente si aún no existe',
      noteType: 'Tipo de nota',
      noteTypeHint: 'También se crea automáticamente, con colores de tono',
      tags: 'Etiquetas',
      fields: 'Campos',
      fieldsNote:
        'Elige qué va en cada campo de tu tipo de nota. Se leen de tu colección, así que ' +
        'cualquier nombre funciona.',

      // --- Anki field bindings (anki-fields.js TOKENS) ---
      tokenNone: '— dejar vacío —',
      tokenHeadword: 'Palabra (tal como se señaló)',
      tokenSimplified: 'Simplificado',
      tokenTraditional: 'Tradicional',
      tokenColourHanzi: 'Palabra, con colores de tono',
      tokenPinyin: 'Pinyin (nǐ hǎo)',
      tokenColourPinyin: 'Pinyin, con colores de tono',
      tokenPinyinNumbered: 'Pinyin, con números (ni3 hao3)',
      tokenSenses: 'Todas las definiciones',
      tokenSensesNumbered: 'Todas las definiciones, numeradas',
      tokenFirstSense: 'Solo la primera definición',
      tokenSentence: 'Frase de ejemplo (de la página)',
      tokenSentenceBold: 'Frase de ejemplo, palabra en negrita',
      tokenAudio: 'Audio de pronunciación',
      tokenSource: 'Página de origen (enlace)',
      tokenSourceUrl: 'Página de origen (URL simple)',

      // --- options page: appearance ---
      appearance: 'Apariencia',
      theme: 'Tema',
      themeAuto: 'Como el sistema',
      themeLight: 'Claro',
      themeDark: 'Oscuro',
      fontSize: 'Tamaño de letra',
      maxSenses: 'Definiciones visibles antes de plegar',

      // --- options page: shortcuts ---
      shortcuts: 'Atajos',
      keySwitch: 'Cambiar entre palabras candidatas',
      keyJump: 'Ir directamente a una candidata — el dígito que aparece en su pestaña',
      keyClose: 'Cerrar la ventana emergente',

      // --- options page: dictionary ---
      dictionary: 'Diccionario',
      loading: 'Cargando…',
      dictMeta: '$1 entradas · $2 palabras · versión de CC-CEDICT $3',
      dictMissing:
        'No se encontraron los datos del diccionario — ejecuta `npm run build` en la raíz del ' +
        'proyecto y vuelve a cargar la extensión.',
      creditPre: 'Definiciones de',
      creditMid: ', usadas bajo',
      creditPost: '.',

      // --- the popup ---
      popupHint: '$1 para buscar · ←/→ cambiar · Esc para cerrar',
      popupHintHover: 'Pasar el ratón',
      popupHintKey: '$1 + ratón',
      moreSenses: '+$1 más',
      glossPending:
        'Mostrando inglés. Las definiciones en español aún no se han descargado — abre las ' +
        'opciones de la extensión para obtenerlas.',
      glossMissingEntry: 'Mostrando inglés: esta entrada aún no tiene definición en español.',
      playPronunciation: 'Reproducir la pronunciación de $1',
      play: 'Reproducir $1',
      addToAnki: 'Añadir $1 a Anki',
      alreadyInAnki: 'Ya está en tu colección de Anki',
      ankiRejected: 'Anki no acepta esta nota: $1',
      ankiAddFailed: 'No se pudo añadir: $1',
      ankiAdded: 'Añadido a $1',
      ankiAddedCreated: 'Añadido a $1 (se creó $2)',
      ankiAbsent: 'Anki no está abierto, o AnkiConnect no está disponible',
      createdDeck: 'el mazo «$1»',
      createdNoteType: 'el tipo de nota «$1»',
      and: ' y ',
      noVoice: 'No hay ninguna voz en chino instalada — consulta las opciones de la extensión',
      noRecording: 'No hay grabación de esta palabra en Wikimedia Commons',
      noAudio: 'No hay ninguna voz en chino instalada ni se encontró grabación',
      playbackFailed: 'No se pudo reproducir el audio: $1',

      // --- toolbar button and its menu ---
      actionOff: '$1 — desactivado\nClic para activar',
      actionOn: '$1 — activado, $2\nClic para desactivar',
      actionHoldKey: 'mantén $1',
      actionHover: 'pasando el ratón, sin tecla',
      menuRequireKey: 'Requerir $1 para buscar',
      menuRequireAKey: 'Requerir una tecla',
      menuOptions: 'Opciones…',
    },
  };

  /** The language `t()` is currently answering in. Never 'auto' -- always a real code. */
  let current = FALLBACK;

  /**
   * Narrow whatever the browser reports to a language we actually have strings for.
   * 'es-ES' and 'es-419' both become 'es'; anything unknown becomes English.
   */
  function normalise(tag) {
    const base = String(tag ?? '').toLowerCase().split(/[-_]/)[0];
    return base in LANGUAGES ? base : FALLBACK;
  }

  /** What 'auto' means here: the browser's own UI language. */
  function browserLanguage() {
    try {
      return normalise(chrome?.i18n?.getUILanguage?.());
    } catch {
      // No chrome at all -- unit tests, or a context without the API.
      return FALLBACK;
    }
  }

  /**
   * Point `t()` at a language. Accepts 'auto', which resolves against the browser, so callers
   * can hand the stored setting straight through without special-casing it.
   */
  function setLanguage(setting) {
    current = !setting || setting === 'auto' ? browserLanguage() : normalise(setting);
    return current;
  }

  function language() {
    return current;
  }

  function substitute(template, subs) {
    if (!subs.length) return template;
    return template.replace(/\$(\d)/g, (whole, digit) => {
      const value = subs[Number(digit) - 1];
      return value === undefined ? whole : String(value);
    });
  }

  /**
   * Look a string up, substituting $1, $2… positionally.
   *
   * A key missing from the active language falls back to English rather than to blank, so a
   * half-finished translation degrades to a readable page. A key missing from English too
   * returns the key itself, which is ugly on purpose -- an obviously wrong string in the UI is
   * far easier to notice than an empty one.
   */
  function t(key, ...subs) {
    const template = CATALOGUE[current]?.[key] ?? CATALOGUE[FALLBACK][key] ?? key;
    return substitute(template, subs);
  }

  /**
   * Plural-aware lookup: `n === 1` prefers `<key>_one`.
   *
   * Deliberately minimal. English and Spanish share the same one/other split, so this covers
   * both; a language with more forms would need CLDR rules rather than an extra key.
   */
  function tn(key, n, ...subs) {
    const singular = `${key}_one`;
    const useSingular = n === 1 && (CATALOGUE[current]?.[singular] ?? CATALOGUE[FALLBACK][singular]);
    return t(useSingular ? singular : key, ...subs);
  }

  globalThis.zhI18n = { t, tn, setLanguage, language, LANGUAGES, FALLBACK, CATALOGUE };

  // Sensible default before any settings have been read, so a string fetched during startup is
  // never the literal key.
  setLanguage('auto');
})();
