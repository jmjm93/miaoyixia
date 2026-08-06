// Pronunciation playback: an OS Chinese voice, or the bytes of a Commons recording.
//
// Recordings are played through Web Audio rather than an <audio> element on purpose. A media
// element loads a resource, so the host page's CSP `media-src` can block it -- and plenty of
// sites restrict that. Web Audio is handed raw bytes, so there is nothing for a page policy
// to refuse.

(() => {
  const zh = (globalThis.zhDic ??= {});

  /** Ranked language tags: mainland Mandarin first, then anything Chinese. */
  const PREFERRED = ['zh-cn', 'zh-hans', 'zh-sg', 'zh'];

  let context = null;
  let playing = null; // the live BufferSource, so a second click can interrupt the first

  /**
   * Choose a voice for Mandarin. Exposed for testing, and kept a pure function of the list
   * so it can be exercised without a speech engine present.
   */
  function pickVoice(voices) {
    const chinese = voices.filter((voice) => /^zh\b|^zh-/i.test(voice.lang ?? ''));
    if (!chinese.length) return null;

    for (const tag of PREFERRED) {
      const match = chinese.find((voice) => voice.lang.toLowerCase().replace('_', '-').startsWith(tag));
      if (match) return match;
    }
    return chinese[0];
  }

  /** getVoices() populates asynchronously, so this is read fresh each time rather than cached. */
  function availableVoices() {
    try {
      return globalThis.speechSynthesis?.getVoices?.() ?? [];
    } catch {
      return [];
    }
  }

  function stop() {
    try {
      globalThis.speechSynthesis?.cancel?.();
    } catch {
      /* no engine; nothing to cancel */
    }
    if (playing) {
      try {
        playing.stop();
      } catch {
        /* already finished */
      }
      playing = null;
    }
  }

  zh.speech = {
    pickVoice,

    /** Is there an OS voice that can read Chinese at all? */
    voiceAvailable() {
      return Boolean(pickVoice(availableVoices()));
    },

    /** Names of the Chinese voices found, for the options page to report. */
    chineseVoiceNames() {
      return availableVoices()
        .filter((voice) => /^zh\b|^zh-/i.test(voice.lang ?? ''))
        .map((voice) => `${voice.name} [${voice.lang}]`);
    },

    /** Speak `text` with the best Chinese voice. Resolves when the utterance ends. */
    speakWithVoice(text, rate = 1) {
      const voice = pickVoice(availableVoices());
      if (!voice) return Promise.reject(new Error('no-voice'));

      stop();
      return new Promise((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.rate = rate;
        utterance.onend = () => resolve();
        utterance.onerror = (event) => reject(new Error(event.error ?? 'speech-failed'));
        globalThis.speechSynthesis.speak(utterance);
      });
    },

    /** Play a recording delivered as base64. Resolves when it finishes. */
    async playBytes(base64, rate = 1) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      stop();
      context ??= new (globalThis.AudioContext ?? globalThis.webkitAudioContext)();
      // Created inside a click handler, so autoplay policy lets this resume.
      if (context.state === 'suspended') await context.resume();

      const buffer = await context.decodeAudioData(bytes.buffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      // A human recording is already correctly paced; only slow it, never speed it up.
      source.playbackRate.value = Math.min(rate, 1);
      source.connect(context.destination);

      return new Promise((resolve) => {
        source.onended = () => {
          if (playing === source) playing = null;
          resolve();
        };
        playing = source;
        source.start();
      });
    },

    stop,
  };
})();
