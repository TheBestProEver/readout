/* Readout: paste text or open a file and hear it read aloud, or dictate notes. No build step.
 * Text and speech come from readkit (vendored in readkit/, loaded with import()): extract()
 * turns any file into text, plan() turns text into what a voice says, and its voices and
 * player read it aloud, with the screen off too. */
(() => {
  'use strict';

  const Core = window.ReadoutCore;
  const VERSION = '2.0.0';
  const CONFIG = Object.assign(
    {
      githubApi: 'https://api.github.com',
      netWait: 45000, // ms to wait for a reply to start
      netStall: 30000, // ms a reply may pause before giving up
      fastEndCheck: true,
      readkit: null, // configure() overrides for readkit (tests, self-hosting)
      swOnLocalhost: false,
    },
    window.READOUT_CONFIG || {}
  );

  const UA = navigator.userAgent || '';
  const IS_ANDROID = /Android/i.test(UA);
  const mq = (q) => (window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener() {} });
  const reduceMotion = mq('(prefers-reduced-motion: reduce)');
  const darkScheme = mq('(prefers-color-scheme: dark)');
  const desktop = mq('(min-width: 960px)');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

  const DEFAULTS = {
    rate: 1,
    pitch: 1,
    voiceURI: '', // device voice
    voiceMode: 'natural', // 'natural' (Kokoro) | 'standard' (Piper) | 'device' (speechSynthesis)
    accent: '', // 'en-US' | 'en-GB'; '' = from the device's language
    voices: {}, // chosen speaker per mode and accent: { 'natural-en-US': 'am_michael', ... }
    theme: 'system',
    size: 'm',
    follow: true,
    keepAwake: true,
    autoNext: false,
    skipCitations: true,
    includeNotes: false,
    lexicon: [], // [[word, sayAs], ...]
    lexiconAt: 0,
    dictLang: '',
    spokenPunct: true,
    dictLocal: false,
    cps: 14.5, // learned speaking speed in characters per second at 1x
    lastDocId: null,
    seenWelcome: false,
    ocrOk: false, // agreed to the one-time download for reading scanned pages
    offeredVoice: false, // the one-time "get a natural voice" hint was shown
  };

  const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const MAX_RATE = { device: 4, audio: 3 };

  // The voices offered per mode and accent, default first (readkit's catalog ids).
  const KIT_VOICES = {
    'natural-en-US': ['am_michael', 'am_fenrir', 'am_puck', 'af_heart', 'af_bella'],
    'natural-en-GB': ['bm_george', 'bf_emma'],
    'standard-en-US': ['en_US-ryan-medium'],
    'standard-en-GB': ['en_GB-alba-medium', 'en_GB-cori-medium'],
  };

  const DICT_LANGS = [
    ['', 'Same as this device'],
    ['en-US', 'English (US)'],
    ['en-GB', 'English (UK)'],
    ['en-IN', 'English (India)'],
    ['en-AU', 'English (Australia)'],
    ['es-ES', 'Spanish (Spain)'],
    ['es-MX', 'Spanish (Mexico)'],
    ['fr-FR', 'French'],
    ['de-DE', 'German'],
    ['it-IT', 'Italian'],
    ['pt-BR', 'Portuguese (Brazil)'],
    ['nl-NL', 'Dutch'],
    ['ru-RU', 'Russian'],
    ['tr-TR', 'Turkish'],
    ['ar-SA', 'Arabic'],
    ['hi-IN', 'Hindi'],
    ['ur-PK', 'Urdu'],
    ['bn-IN', 'Bengali'],
    ['ta-IN', 'Tamil'],
    ['te-IN', 'Telugu'],
    ['mr-IN', 'Marathi'],
    ['zh-CN', 'Chinese (Mandarin)'],
    ['ja-JP', 'Japanese'],
    ['ko-KR', 'Korean'],
  ];

  const WELCOME_TEXT = [
    'Welcome to Readout.',
    '',
    'Paste any text and it will be read aloud, one sentence at a time. The sentence you are hearing gets highlighted, so you can follow along or look away.',
    '',
    'Tap any sentence to jump there. The speed button goes from half speed up to four times as fast, and that is also where you pick a voice.',
    '',
    'Everything you add stays on this device, and Readout remembers where you stopped in each text.',
    '',
    'To write a note by voice, start a new text and tap Dictate. Saying "comma" or "new paragraph" adds punctuation.',
    '',
    'You can delete this text once you have tried it.',
  ].join('\n');

  const state = {
    docs: [],
    positions: new Map(),
    current: null,
    segs: [], // readkit plan() segments of the current text
    cum: [0],
    idx: 0,
    dirty: false,
    mode: 'listen',
    settings: Object.assign({}, DEFAULTS),
    query: '',
  };

  const el = {};
  let spans = [];
  let curSpan = -1;
  let lastManualScroll = 0;
  let scrubbing = false;

  /* ================= readkit ================= */

  // The text side (extract, plan) loads at start; voices and the player load when needed.
  const kit = { K: null, system: null, autoName: null, V: null, P: null };

  // Dev override (never on by default): ?local=<http://127.0.0.1:port> points the voice models
  // and their runtime at a local server (the layout of readkit's tests/fixtures/voice/server.mjs).
  // Only honoured when both Readout and that server are on this machine.
  function localModels() {
    const v = new URLSearchParams(location.search).get('local');
    if (!v) return null;
    try {
      const u = new URL(v);
      if (!LOOPBACK.test(u.hostname) || !LOOPBACK.test(location.hostname) || !/^https?:$/.test(u.protocol)) return null;
      const b = u.origin;
      return { ort: b + '/ort/', phonemizer: b + '/phonemizer.js', piperPhonemize: b + '/piperph/', kokoro: { base: b + '/kokoro/' }, piper: b + '/piper/' };
    } catch (e) {
      return null;
    }
  }

  async function loadKit() {
    const [K, system, ex] = await Promise.all([import('./readkit/index.js'), import('./readkit/src/voice/system.js'), import('./readkit/src/extract.js')]);
    if (CONFIG.readkit) K.configure(CONFIG.readkit);
    const local = localModels();
    if (local) K.configure(local);
    kit.K = K;
    kit.system = system;
    kit.autoName = ex.autoName;
  }

  function voiceModule() {
    if (!kit.Vp) kit.Vp = import('./readkit/src/voice/voice.js').then((m) => (kit.V = m)).catch((e) => ((kit.Vp = null), Promise.reject(e)));
    return kit.Vp;
  }

  function playerModule() {
    if (!kit.Pp) kit.Pp = import('./readkit/src/audio/player.js').then((m) => (kit.P = m)).catch((e) => ((kit.Pp = null), Promise.reject(e)));
    return kit.Pp;
  }

  function accent() {
    const a = state.settings.accent;
    if (a === 'en-US' || a === 'en-GB') return a;
    return /^en-(GB|IE|AU|NZ|IN|ZA)/i.test(navigator.language || '') ? 'en-GB' : 'en-US';
  }

  let lexCache = { at: -1, map: null };
  function planOptions() {
    const s = state.settings;
    if (lexCache.at !== s.lexiconAt || !lexCache.map) lexCache = { at: s.lexiconAt, map: Core.lexiconMap(s.lexicon) };
    const opts = { dialect: accent(), skip: { citations: s.skipCitations !== false } };
    if (Object.keys(lexCache.map).length) opts.lexicon = lexCache.map;
    return opts;
  }

  // Text -> segments. plan() never throws on real text; if it ever does (or readkit didn't
  // load), each line is read as it is.
  function planText(text) {
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return [];
    if (kit.K) {
      try {
        return kit.K.plan(text, planOptions());
      } catch (e) {
        console.warn('Readout: plan() failed, reading line by line', e);
      }
    }
    const out = [];
    const re = /[^\n]+/g;
    let m;
    while ((m = re.exec(text))) {
      if (/[\p{L}\p{N}]/u.test(m[0])) out.push({ index: out.length, start: m.index, end: m.index + m[0].length, spoken: m[0].trim(), kind: 'sentence', pauseAfterMs: 0, align: [] });
    }
    return out;
  }

  // Utterance-sized pieces of spoken text: readkit's, or (without readkit) up to 200
  // characters, cut at a space.
  function utterancePieces(text) {
    if (kit.system) return kit.system.chunkText(text);
    const out = [];
    let a = 0;
    while (a < text.length) {
      let b = Math.min(text.length, a + 200);
      if (b < text.length) {
        const sp = text.lastIndexOf(' ', b);
        if (sp > a + 60) b = sp;
      }
      out.push({ start: a, end: b });
      a = b;
    }
    return out;
  }

  /* ================= storage ================= */

  const store = (() => {
    let db = null;
    let mem = null;

    function openDb() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error('IndexedDB unavailable'));
          return;
        }
        let req;
        try {
          req = indexedDB.open('readout', 1);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('pos')) d.createObjectStore('pos', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('open failed'));
        req.onblocked = () => reject(new Error('blocked'));
      });
    }

    function tx(name, mode, fn) {
      return new Promise((resolve, reject) => {
        let t;
        try {
          t = db.transaction(name, mode);
        } catch (e) {
          reject(e);
          return;
        }
        let out;
        const r = fn(t.objectStore(name));
        if (r) r.onsuccess = () => (out = r.result);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('aborted'));
      });
    }

    return {
      get memoryOnly() {
        return !!mem;
      },
      async init() {
        try {
          db = await openDb();
        } catch (e) {
          mem = { docs: new Map(), pos: new Map(), kv: new Map() };
        }
      },
      allDocs: () => (mem ? Promise.resolve([...mem.docs.values()]) : tx('docs', 'readonly', (s) => s.getAll())),
      putDoc: (d) => (mem ? (mem.docs.set(d.id, Object.assign({}, d)), Promise.resolve()) : tx('docs', 'readwrite', (s) => s.put(d))),
      deleteDoc: (id) => (mem ? (mem.docs.delete(id), Promise.resolve()) : tx('docs', 'readwrite', (s) => s.delete(id))),
      allPos: () => (mem ? Promise.resolve([...mem.pos.values()]) : tx('pos', 'readonly', (s) => s.getAll())),
      putPos: (p) => (mem ? (mem.pos.set(p.id, Object.assign({}, p)), Promise.resolve()) : tx('pos', 'readwrite', (s) => s.put(p))),
      deletePos: (id) => (mem ? (mem.pos.delete(id), Promise.resolve()) : tx('pos', 'readwrite', (s) => s.delete(id))),
      get: (k) => (mem ? Promise.resolve(mem.kv.get(k)) : tx('kv', 'readonly', (s) => s.get(k))),
      set: (k, v) => (mem ? (mem.kv.set(k, v), Promise.resolve()) : tx('kv', 'readwrite', (s) => s.put(v, k))),
    };
  })();

  let storeErrorShown = false;
  function onStoreError(e) {
    console.warn('Readout storage error', e);
    if (!storeErrorShown) {
      storeErrorShown = true;
      toast('Couldn’t save to this browser’s storage. Export a backup from Settings to be safe.');
    }
  }

  const pendingDocs = new Map();
  let docSaveTimer = null;
  function scheduleSave(doc) {
    pendingDocs.set(doc.id, doc);
    clearTimeout(docSaveTimer);
    docSaveTimer = setTimeout(flushDocs, 400);
  }
  function flushDocs() {
    clearTimeout(docSaveTimer);
    for (const d of pendingDocs.values()) store.putDoc(d).catch(onStoreError);
    pendingDocs.clear();
  }

  let settingsTimer = null;
  function saveSettings() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => store.set('settings', state.settings).catch(onStoreError), 300);
  }

  // Throttled, not debounced: during playback a save still lands every ~1.5 s.
  let posTimer = null;
  function queuePositionSave() {
    if (posTimer) return;
    posTimer = setTimeout(() => {
      posTimer = null;
      savePositionNow();
    }, 1500);
  }
  // IndexedDB writes can be cut off when the page closes, so positions are also
  // mirrored to localStorage, which writes synchronously.
  const POS_KEY = 'readout-pos-';
  function mirrorPosition(p) {
    try {
      localStorage.setItem(POS_KEY + p.id, JSON.stringify(p));
    } catch (e) {
      /* storage unavailable */
    }
  }
  function forgetMirroredPosition(id) {
    try {
      localStorage.removeItem(POS_KEY + id);
    } catch (e) {
      /* ignore */
    }
  }
  function mergeMirroredPositions() {
    try {
      for (const d of state.docs) {
        const raw = localStorage.getItem(POS_KEY + d.id);
        if (!raw) continue;
        const p = JSON.parse(raw);
        const cur = state.positions.get(d.id);
        if (p && p.id === d.id && (!cur || (p.at || 0) > (cur.at || 0))) {
          state.positions.set(d.id, p);
          store.putPos(p).catch(() => {});
        }
      }
    } catch (e) {
      /* ignore */
    }
  }
  // A place is saved per segment ({ id, offset, progress, done, at }, the 1.x format sync
  // uses): the segment's first character, or the word where the device voice was paused.
  function savePositionNow(finishedNow) {
    clearTimeout(posTimer);
    posTimer = null;
    const doc = state.current;
    if (!doc) return;
    const n = state.segs.length;
    const finished = finishedNow === true || (n > 0 && state.idx >= n);
    const i = Math.min(state.idx, Math.max(0, n - 1));
    const sg = state.segs[i];
    const offset = finished ? doc.text.length : sg ? sg.start + (tts.playing ? 0 : tts.wordOffset || 0) : 0;
    const progress = n ? (finished ? 1 : state.cum[i] / state.cum[n]) : 0;
    const old = state.positions.get(doc.id);
    if (old && old.offset === offset && !!old.done === finished) {
      // Same place as before: keep its time, so it can't override newer progress from another device.
      if (old.progress !== progress) {
        const q = Object.assign({}, old, { progress });
        state.positions.set(doc.id, q);
        mirrorPosition(q);
        store.putPos(q).catch(onStoreError);
      }
      renderLibrarySoon();
      return;
    }
    const p = { id: doc.id, offset, progress, done: finished, at: Date.now() };
    state.positions.set(doc.id, p);
    mirrorPosition(p);
    store.putPos(p).catch(onStoreError);
    sync.dirty = true;
    renderLibrarySoon();
  }

  let persistAsked = false;
  function requestPersist() {
    if (persistAsked) return;
    persistAsked = true;
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage
          .persisted()
          .then((p) => (p ? null : navigator.storage.persist()))
          .catch(() => {});
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* ================= documents ================= */

  function lastActive(d) {
    const p = state.positions.get(d.id);
    return Math.max(d.updatedAt || 0, p ? p.at || 0 : 0);
  }

  function sortedDocs() {
    return state.docs.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || lastActive(b) - lastActive(a));
  }

  // Records a change for sync: when it happened, and one more change from this device.
  function touch(doc, textChanged) {
    doc.changedAt = Date.now();
    doc.vv = Core.bumpVV(doc.vv, sync.device);
    if (textChanged) doc.tv = Core.bumpVV(doc.tv, sync.device);
    syncSoon();
  }

  function createDoc(text, title) {
    const now = Date.now();
    const t = typeof title === 'string' ? title.trim().slice(0, 120) : '';
    const doc = {
      id: Core.uid(),
      title: t || Core.deriveTitle(text),
      titleLocked: !!t,
      text: text || '',
      createdAt: now,
      updatedAt: now,
      changedAt: now,
      titleAt: t ? now : 0,
      pinned: false,
      vv: {},
      tv: {},
    };
    if (doc.text) touch(doc, true);
    state.docs.push(doc);
    store.putDoc(doc).catch(onStoreError);
    requestPersist();
    renderLibrarySoon();
    return doc;
  }

  // The built-in welcome text has the same id and an "untouched" stamp on every
  // device, so sync treats the copies as one, and deleting it anywhere deletes it everywhere.
  function createWelcomeDoc() {
    const now = Date.now();
    const doc = { id: 'welcome', title: 'Welcome to Readout', titleLocked: true, text: WELCOME_TEXT, createdAt: now, updatedAt: now, changedAt: 1, pinned: false, vv: {}, tv: {} };
    state.docs.push(doc);
    store.putDoc(doc).catch(onStoreError);
    return doc;
  }

  // Removes a doc from this device only. Sync uses this for deletions made elsewhere.
  function removeDocLocally(doc) {
    const i = state.docs.indexOf(doc);
    if (i >= 0) state.docs.splice(i, 1);
    pendingDocs.delete(doc.id);
    state.positions.delete(doc.id);
    forgetMirroredPosition(doc.id);
    store.deleteDoc(doc.id).catch(() => {});
    store.deletePos(doc.id).catch(() => {});
  }

  function dropDocQuietly(doc) {
    removeDocLocally(doc);
    if (doc.text.trim() || Object.keys(doc.vv || {}).length) {
      sync.tombs[doc.id] = { at: Date.now(), vv: Object.assign({}, doc.vv) };
      saveTombs();
      syncSoon();
    }
  }

  function openDoc(id, opts) {
    const o = opts || {};
    const doc = state.docs.find((d) => d.id === id);
    if (!doc) return;
    if (!o.keepPlaying) pausePlayback();
    stopDictation();
    flushDocs();
    const prev = state.current;
    if (prev && prev !== doc && !prev.text.trim()) dropDocQuietly(prev);
    state.current = doc;
    state.settings.lastDocId = doc.id;
    saveSettings();
    rebuildSegments();
    placeAtSaved(doc);
    state.mode = o.mode || (doc.text.trim() ? 'listen' : 'edit');
    if (state.mode === 'edit') el.editor.value = doc.text;
    renderView();
    if (state.mode === 'listen') {
      renderReader();
      el.stage.scrollTop = 0;
      if (spans[curSpan]) scrollToSpan(spans[curSpan], true, 'auto');
    }
    renderLibrary();
    updateMediaSession();
    if (state.mode === 'listen') warmVoiceSoon();
  }

  // Moves the reading place to where this doc was left off.
  function placeAtSaved(doc) {
    const pos = state.positions.get(doc.id);
    tts.wordOffset = 0;
    if (pos && pos.done) {
      state.idx = state.segs.length;
    } else if (pos && state.segs.length) {
      state.idx = Core.findSegment(state.segs, pos.offset);
      const sg = state.segs[state.idx];
      if (sg && pos.offset > sg.start && pos.offset < sg.end) tts.wordOffset = pos.offset - sg.start;
    } else {
      state.idx = 0;
    }
  }

  function showWelcome() {
    pausePlayback();
    stopDictation();
    dropPlayer();
    state.current = null;
    state.segs = [];
    state.cum = [0];
    state.idx = 0;
    state.mode = 'listen';
    spans = [];
    curSpan = -1;
    el.reader.replaceChildren();
    renderView();
    renderLibrary();
  }

  function openNextOrWelcome() {
    const next = sortedDocs()[0];
    if (next) openDoc(next.id);
    else showWelcome();
  }

  function newDoc(opts) {
    const o = opts || {};
    const doc = createDoc('');
    openDoc(doc.id, { mode: 'edit' });
    closeDrawer();
    if (o.dictate) startDictation();
    else if (!o.noFocus) el.editor.focus();
  }

  function deleteDoc(id) {
    const doc = state.docs.find((d) => d.id === id);
    if (!doc) return;
    const pos = state.positions.get(id);
    const wasCurrent = state.current === doc;
    if (wasCurrent) pausePlayback();
    dropDocQuietly(doc);
    if (wasCurrent) {
      state.current = null;
      openNextOrWelcome();
    }
    renderLibrary();
    toast(`Deleted “${doc.title}”.`, {
      action: 'Undo',
      onAction: () => {
        // A sync may have brought back another version meanwhile. It's still in the
        // gist, so drop it here and let the next sync merge it with this one.
        const back = state.docs.find((d) => d !== doc && d.id === id);
        if (back) removeDocLocally(back);
        delete sync.tombs[id];
        saveTombs();
        touch(doc, false);
        state.docs.push(doc);
        store.putDoc(doc).catch(onStoreError);
        if (pos) {
          state.positions.set(id, pos);
          mirrorPosition(pos);
          store.putPos(pos).catch(onStoreError);
        }
        openDoc(id);
      },
    });
  }

  function applyDocText(doc, text) {
    pausePlayback();
    const sg = state.segs[Math.min(state.idx, state.segs.length - 1)];
    const ratio = sg && doc.text.length ? sg.start / doc.text.length : 0;
    doc.text = text;
    doc.updatedAt = Date.now();
    if (!doc.titleLocked) doc.title = Core.deriveTitle(text);
    touch(doc, true);
    scheduleSave(doc);
    if (state.current === doc) {
      rebuildSegments();
      state.idx = Core.findSegment(state.segs, Math.round(ratio * text.length));
      tts.wordOffset = 0;
      if (state.mode === 'edit') el.editor.value = text;
      renderView();
      renderReader();
    }
    renderLibrarySoon();
  }

  // The reading settings changed (accent, pronunciations, citations): plan the text again
  // and carry on from the same place.
  function replanCurrent() {
    const doc = state.current;
    if (!doc) return;
    const wasPlaying = tts.playing;
    pausePlayback();
    const sg = state.segs[Math.min(state.idx, state.segs.length - 1)];
    const at = sg ? sg.start : 0;
    const finished = state.segs.length > 0 && state.idx >= state.segs.length;
    rebuildSegments();
    state.idx = finished ? state.segs.length : Core.findSegment(state.segs, at);
    tts.wordOffset = 0;
    if (state.mode === 'listen') renderReader();
    if (wasPlaying) play();
  }

  /* ================= library ================= */

  const wordCache = new Map();
  function wordsOf(d) {
    const c = wordCache.get(d.id);
    if (c && c.at === d.updatedAt && c.len === d.text.length) return c.n;
    const n = Core.wordCount(d.text);
    wordCache.set(d.id, { at: d.updatedAt, len: d.text.length, n });
    return n;
  }

  function useIcon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function renderLibrary() {
    clearTimeout(libTimer);
    const q = state.query.trim().toLowerCase();
    const docs = sortedDocs().filter((d) => !q || d.title.toLowerCase().includes(q) || d.text.toLowerCase().includes(q));
    const now = Date.now();
    const nf = new Intl.NumberFormat();
    const frag = document.createDocumentFragment();
    for (const d of docs) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'doc-item';
      b.dataset.id = d.id;
      if (state.current === d) {
        b.classList.add('is-active');
        b.setAttribute('aria-current', 'true');
      }
      const title = document.createElement('span');
      title.className = 'doc-item-title';
      if (d.pinned) title.appendChild(useIcon('pin'));
      const tt = document.createElement('span');
      tt.textContent = d.title || 'Untitled';
      title.appendChild(tt);
      const meta = document.createElement('span');
      meta.className = 'doc-item-meta';
      const w = wordsOf(d);
      meta.textContent = `${nf.format(w)} ${w === 1 ? 'word' : 'words'}, ${Core.relativeTime(lastActive(d), now)}`;
      const bar = document.createElement('span');
      bar.className = 'doc-item-progress';
      const p = state.positions.get(d.id);
      bar.style.setProperty('--p', Math.round((p ? p.progress || 0 : 0) * 100) + '%');
      b.append(title, meta, bar);
      li.appendChild(b);
      frag.appendChild(li);
    }
    el.docList.replaceChildren(frag);
    el.docEmpty.hidden = docs.length > 0;
    el.docEmpty.textContent = q ? `No texts match “${state.query.trim()}”.` : 'No texts yet. Tap New to add one.';
  }

  let libTimer = null;
  function renderLibrarySoon() {
    clearTimeout(libTimer);
    libTimer = setTimeout(renderLibrary, 400);
  }

  function openDrawer() {
    if (desktop.matches) {
      el.search.focus();
      return;
    }
    renderLibrary();
    el.library.classList.add('is-open');
    el.scrim.hidden = false;
    el.menuBtn.setAttribute('aria-expanded', 'true');
    el.main.inert = true;
    setTimeout(() => {
      const target = el.library.querySelector('.doc-item.is-active') || el.newBtn;
      target.focus({ preventScroll: true });
    }, 60);
  }

  function closeDrawer() {
    if (!el.library.classList.contains('is-open')) return;
    el.library.classList.remove('is-open');
    el.scrim.hidden = true;
    el.menuBtn.setAttribute('aria-expanded', 'false');
    el.main.inert = false;
  }

  /* ================= views ================= */

  // New segments for the current text. A player made for the old ones can't go on.
  function rebuildSegments() {
    const doc = state.current;
    state.segs = doc ? planText(doc.text) : [];
    state.cum = Core.prefixLengths(state.segs);
    state.dirty = false;
    if (au.player && au.playerSegs !== state.segs) dropPlayer();
  }

  function renderView() {
    const hasDoc = !!state.current;
    const editing = hasDoc && state.mode === 'edit';
    el.welcome.hidden = hasDoc;
    el.reader.hidden = !hasDoc || editing;
    el.editorWrap.hidden = !editing;
    el.dock.hidden = !hasDoc;
    el.player.hidden = editing;
    el.editTools.hidden = !editing;
    el.modeBtn.hidden = !hasDoc;
    el.moreBtn.hidden = !hasDoc;
    el.modeBtn.textContent = editing ? 'Done' : 'Edit';
    el.docTitle.disabled = !hasDoc;
    if (!editing) el.dictation.hidden = true;
    renderTitle();
    renderPlayer();
    requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--dock-h', (el.dock.hidden ? 0 : el.dock.offsetHeight) + 'px');
    });
  }

  function renderTitle() {
    const doc = state.current;
    if (document.activeElement !== el.docTitle) el.docTitle.value = doc ? doc.title : 'Readout';
    document.title = doc ? `${doc.title} | Readout` : 'Readout';
  }

  function setMode(mode) {
    const doc = state.current;
    if (!doc) return;
    if (mode === 'edit') {
      if (state.mode === 'edit') return;
      pausePlayback();
      state.mode = 'edit';
      el.editor.value = doc.text;
      renderView();
      return;
    }
    stopDictation();
    flushDocs();
    if (!doc.text.trim()) {
      dropDocQuietly(doc);
      state.current = null;
      openNextOrWelcome();
      renderLibrary();
      return;
    }
    const wasEditing = state.mode === 'edit';
    if (wasEditing && sync.dirty) syncSoon(800);
    state.mode = 'listen';
    if (state.dirty || !state.segs.length) {
      const n = state.segs.length;
      const sg = state.segs[Math.min(state.idx, n - 1)];
      const finished = n > 0 && state.idx >= n;
      rebuildSegments();
      state.idx = finished ? state.segs.length : sg ? Core.findSegment(state.segs, sg.start) : 0;
    }
    renderView();
    if (wasEditing || !spans.length) renderReader();
    warmVoiceSoon();
  }

  // Each segment is a tappable span over its own characters of the text; what lies between
  // segments (markup, skipped citations, blank lines) is shown as plain text.
  function renderReader() {
    const doc = state.current;
    const frag = document.createDocumentFragment();
    spans = [];
    curSpan = -1;
    if (doc) {
      const text = doc.text;
      let pos = 0;
      for (let i = 0; i < state.segs.length; i++) {
        const sg = state.segs[i];
        const a = Math.max(pos, sg.start);
        const b = Math.max(a, sg.end);
        if (a > pos) frag.appendChild(document.createTextNode(text.slice(pos, a)));
        const s = document.createElement('span');
        s.className = 'chunk';
        s.dataset.i = String(i);
        s.textContent = text.slice(a, b);
        frag.appendChild(s);
        spans.push(s);
        pos = b;
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    }
    el.reader.replaceChildren(frag);
    if (spans.length) highlightChunk(Math.min(state.idx, spans.length), { scroll: false });
    else {
      observeCurrent(null);
      renderPlayer();
    }
  }

  function highlightChunk(i, opts) {
    const o = opts || {};
    const prev = curSpan;
    if (prev >= 0 && spans[prev]) {
      spans[prev].classList.remove('is-current');
      spans[prev].removeAttribute('aria-current');
    }
    if (prev >= 0 && i === prev + 1 && spans[prev]) spans[prev].classList.add('is-read');
    else for (let k = 0; k < spans.length; k++) spans[k].classList.toggle('is-read', k < i);
    curSpan = i;
    clearWord();
    const s = spans[i];
    if (s) {
      s.classList.remove('is-read');
      s.classList.add('is-current');
      s.setAttribute('aria-current', 'true');
      if (o.scroll === 'force') scrollToSpan(s, true);
      else if (o.scroll !== false) followSpan(s);
    }
    observeCurrent(s || null);
    renderPlayer();
  }

  function followSpan(s) {
    if (!state.settings.follow) return;
    if (Date.now() - lastManualScroll < 5000) return;
    if (document.visibilityState === 'hidden') return;
    scrollToSpan(s, false);
  }

  // Keeps the sentence being read about a third of the way down the screen.
  function scrollToSpan(s, force, behavior) {
    if (!s || el.reader.hidden) return;
    const box = el.stage.getBoundingClientRect();
    const r = s.getBoundingClientRect();
    if (!box.height) return;
    if (!force && r.top > box.top + box.height * 0.12 && r.bottom < box.top + box.height * 0.72) return;
    const top = el.stage.scrollTop + (r.top - box.top) - box.height * 0.3;
    el.stage.scrollTo({ top: Math.max(0, top), behavior: behavior || (reduceMotion.matches ? 'auto' : 'smooth') });
  }

  let io = null;
  function observeCurrent(s) {
    if (!('IntersectionObserver' in window)) return;
    if (!io) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) el.locateBtn.hidden = e.isIntersecting || state.mode !== 'listen' || !state.current;
        },
        { root: el.stage, threshold: 0 }
      );
    }
    io.disconnect();
    if (s) io.observe(s);
    else el.locateBtn.hidden = true;
  }

  const canHighlightWords = typeof CSS !== 'undefined' && CSS.highlights && typeof window.Highlight === 'function';
  // Marks characters [ci, ci + len) of the current sentence's span.
  function markWord(ci, len) {
    if (!canHighlightWords) return;
    const s = spans[curSpan];
    const node = s && s.firstChild;
    if (!node || node.nodeType !== 3) return;
    const text = node.data;
    if (ci < 0 || ci >= text.length) return;
    let end;
    if (len > 0) end = ci + len;
    else {
      const m = text.slice(ci).match(/^[\p{L}\p{N}'’-]+/u);
      end = ci + (m ? m[0].length : 1);
    }
    try {
      const r = new Range();
      r.setStart(node, ci);
      r.setEnd(node, Math.min(end, text.length));
      CSS.highlights.set('readout-word', new Highlight(r));
    } catch (e) {
      /* ignore */
    }
  }
  function clearWord() {
    if (canHighlightWords) CSS.highlights.delete('readout-word');
  }

  function renderPlayer() {
    const n = state.segs.length;
    const i = Math.min(state.idx, n);
    const finished = n > 0 && i >= n;
    const max = Math.max(0, n - 1);
    el.scrub.max = String(max);
    if (!scrubbing) el.scrub.value = String(finished ? max : Math.min(i, max));
    el.scrub.disabled = n === 0;
    el.scrub.style.setProperty('--fill', (finished ? 100 : max ? (Number(el.scrub.value) / max) * 100 : 0) + '%');
    const total = state.cum[n] || 0;
    const done = finished ? total : state.cum[i] || 0;
    if (!scrubbing) {
      el.progressPct.textContent = n ? Math.round(total ? (done / total) * 100 : 0) + '%' : '';
      el.timeLeft.textContent = !n
        ? 'Nothing to read yet'
        : finished
          ? 'Finished'
          : Core.formatDuration((total - done) / (state.settings.cps * state.settings.rate)) + ' left';
    }
    el.playerStatus.textContent = playerStatusText();
    const playing = tts.playing;
    el.playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
    el.playBtn.setAttribute('aria-label', playing ? 'Pause' : finished ? 'Play again from the start' : 'Play');
    el.playBtn.classList.toggle('is-paused-ready', !playing);
    el.playBtn.disabled = n === 0;
    el.prevBtn.disabled = n === 0;
    el.nextBtn.disabled = n === 0;
  }

  // The middle of the player line: a voice getting ready, or the sleep timer.
  function playerStatusText() {
    if (tts.playing && au.waiting) return au.waiting;
    if (sleep.mode === 'end') return 'Stops at the end';
    if (sleep.until) {
      const min = Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000));
      return `Stops in ${min} min`;
    }
    return '';
  }

  /* ================= reading aloud ================= */

  // Two engines read the same segments: the device's speech engine (speechSynthesis, works
  // at once, needs the screen on) and readkit's player (Natural = Kokoro, Standard = Piper:
  // audio made on this device and played through one <audio>, so it goes on with the screen off).
  const tts = {
    ok: 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
    voices: [],
    playing: false, // reading aloud, with either engine
    engine: null, // 'device' | 'audio': the engine reading (or last read) the current text
    token: 0,
    utter: null, // kept so Chrome can't garbage-collect the utterance before onend fires
    wordOffset: 0, // where to resume inside the current segment (characters from its start)
    lastBoundary: 0,
    lastCancelAt: 0,
    errors: 0,
    fastEnds: 0,
    voiceBroken: false,
    watchdog: null,
    keepAlive: null,
    restartTimer: null,
    rateTimer: null,
    pieces: [], // the current segment's spoken text in utterance-sized pieces
    piece: 0,
    volume: 1,
  };
  const synth = () => window.speechSynthesis;

  const au = {
    el: null, // the one <audio> the player uses for the whole session
    voice: null, // the loaded readkit voice
    loading: null, // { id, promise } while a voice loads
    player: null,
    playerSegs: null,
    playerDoc: null,
    waiting: '', // shown in the player line while a voice gets ready
    broken: false, // an error this session: the device voice reads until the next start
    naturalBroken: false, // the natural voice failed this session: the standard one reads
    preview: null,
    previewToken: 0,
    installed: new Set(), // voice ids downloaded on this device
    dl: null, // { id, ctrl, done, total }: a download in progress
    gpu: null, // WebGPU adapter present: true | false | null (not checked yet)
    offerShown: false,
  };

  const queue = { order: [] }; // library order when listening started (Play next text automatically)

  function playerSupported() {
    try {
      return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/webm; codecs="opus"') && typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
    } catch (e) {
      return false;
    }
  }

  function kitVoiceId(mode, acc) {
    const key = `${mode}-${acc || accent()}`;
    const list = KIT_VOICES[key] || [];
    const chosen = state.settings.voices && state.settings.voices[key];
    return list.includes(chosen) ? chosen : list[0];
  }

  // The natural voice's check on this device (calibrate()), per Chrome version.
  const NAT_KEY = 'readout-natural-check';
  function chromeMajor() {
    const m = /Chrome\/(\d+)/.exec(UA);
    return m ? m[1] : '';
  }
  function naturalCheck() {
    try {
      const v = JSON.parse(localStorage.getItem(NAT_KEY) || 'null');
      return v && v.chrome === chromeMajor() ? v : null;
    } catch (e) {
      return null;
    }
  }
  function recordNaturalCheck(v) {
    try {
      if (v) localStorage.setItem(NAT_KEY, JSON.stringify(Object.assign({ chrome: chromeMajor(), at: Date.now() }, v)));
      else localStorage.removeItem(NAT_KEY);
    } catch (e) {
      /* ignore */
    }
  }
  function naturalFails() {
    const c = naturalCheck();
    return au.gpu === false || !!(c && c.ok === false);
  }

  // The voice that reads when play is pressed: { kind: 'audio', id, mode } or { kind: 'device' }.
  // Natural, then Standard, then the device voice, as far as they are downloaded and work here.
  function chooseEngine() {
    const mode = state.settings.voiceMode;
    if (mode === 'device' || au.broken || !playerSupported()) return { kind: 'device' };
    const nat = kitVoiceId('natural');
    const std = kitVoiceId('standard');
    if (mode === 'natural' && au.installed.has(nat) && !naturalFails() && !au.naturalBroken) return { kind: 'audio', id: nat, mode: 'natural' };
    if (au.installed.has(std)) return { kind: 'audio', id: std, mode: 'standard' };
    return { kind: 'device' };
  }

  function rateMax() {
    return chooseEngine().kind === 'audio' ? MAX_RATE.audio : MAX_RATE.device;
  }
  function audioRate() {
    return Core.clamp(state.settings.rate, 0.5, MAX_RATE.audio);
  }

  function setWaiting(text) {
    if (au.waiting === text) return;
    au.waiting = text;
    if (el.playerStatus) renderPlayer();
  }

  function togglePlay() {
    if (tts.playing) pausePlayback();
    else play();
  }

  function play(fromIdx, opts) {
    const o = opts || {};
    if (!state.current) return;
    if (state.mode !== 'listen') setMode('listen');
    if (!state.current || !state.segs.length) {
      toast('There’s nothing to read in this text yet.');
      return;
    }
    stopDictation();
    stopPreview();
    if (typeof fromIdx === 'number') {
      state.idx = Core.clamp(fromIdx, 0, state.segs.length - 1);
      tts.wordOffset = 0;
    }
    if (state.idx >= state.segs.length) {
      state.idx = 0;
      tts.wordOffset = 0;
    }
    lastManualScroll = 0;
    if (!tts.playing && !o.queued) queue.order = sortedDocs().map((d) => d.id);
    const eng = chooseEngine();
    if (eng.kind === 'audio') playAudio(eng);
    else playDevice();
  }

  /* ---------- the device voice (speechSynthesis) ---------- */

  function clearSpeechTimers() {
    clearInterval(tts.watchdog);
    clearInterval(tts.keepAlive);
    tts.watchdog = null;
    tts.keepAlive = null;
  }

  function cancelSpeech() {
    try {
      const s = synth();
      if (s && (s.speaking || s.pending || s.paused)) {
        s.cancel();
        tts.lastCancelAt = Date.now();
      }
    } catch (e) {
      /* ignore */
    }
  }

  function loadVoices() {
    if (!tts.ok) {
      renderVoiceOptions();
      return;
    }
    const read = () => {
      let list = [];
      try {
        list = synth().getVoices() || [];
      } catch (e) {
        /* ignore */
      }
      if (list.length !== tts.voices.length) {
        tts.voices = list;
        renderVoiceOptions();
      }
    };
    read();
    if (typeof synth().addEventListener === 'function') synth().addEventListener('voiceschanged', read);
    else synth().onvoiceschanged = read;
    for (const t of [300, 1200, 3000, 6000]) setTimeout(read, t);
  }

  function currentVoice() {
    return tts.voiceBroken ? null : Core.pickVoice(tts.voices, state.settings.voiceURI);
  }

  function isOnlineVoice(v) {
    if (v) return v.localService === false;
    const d = tts.voices.find((x) => x.default);
    return !!d && d.localService === false;
  }

  function playDevice() {
    if (!tts.ok) {
      toast('This browser can’t read aloud. Open Readout in Chrome.');
      return;
    }
    if (tts.engine === 'audio' && au.player) au.player.pause();
    const wasPlaying = tts.playing;
    tts.playing = true;
    tts.engine = 'device';
    tts.errors = 0;
    tts.fastEnds = 0;
    setWaiting('');
    if (!wasPlaying) onPlaybackStart();
    speakCurrent(true);
    offerVoiceOnce();
  }

  // Source offset (from the segment start) of the spoken word at or after spoken index i.
  function sourceAt(sg, i) {
    const a = sg.align || [];
    for (let k = 0; k < a.length; k++) if (a[k][1] > i) return Core.wordRange(sg, k)[0];
    return 0;
  }

  function speakCurrent(interrupt) {
    const my = ++tts.token;
    clearSpeechTimers();
    clearTimeout(tts.restartTimer);

    const run = () => {
      if (my !== tts.token || !tts.playing) return;
      const sg = state.segs[state.idx];
      if (!state.current || !sg) {
        finishPlayback();
        return;
      }
      // Resume at the word where reading stopped, or the segment's start.
      const from = Core.spokenStartFor(sg, tts.wordOffset);
      tts.wordOffset = 0;
      const rest = String(sg.spoken || '').slice(from);
      highlightChunk(state.idx);
      if (!/[\p{L}\p{N}]/u.test(rest)) {
        advance(my);
        return;
      }
      // Android's engine caps an utterance's length and Chrome's online voices stop after
      // ~15 s, so a long segment is spoken in pieces.
      tts.pieces = utterancePieces(rest).map((c) => ({ start: from + c.start, end: from + c.end }));
      tts.piece = 0;
      speakPiece(my);
      queuePositionSave();
      updateMediaSession();
    };

    if (interrupt) {
      cancelSpeech();
      // Chrome on Android silently drops an utterance spoken right after cancel().
      const gap = IS_ANDROID ? 180 : 80;
      const wait = Math.max(0, gap - (Date.now() - tts.lastCancelAt));
      if (wait > 0) tts.restartTimer = setTimeout(run, wait);
      else run();
    } else {
      run();
    }
  }

  function speakPiece(my) {
    if (my !== tts.token || !tts.playing) return;
    const sg = state.segs[state.idx];
    const pc = tts.pieces[tts.piece];
    if (!sg || !pc) {
      advance(my);
      return;
    }
    const spoken = sg.spoken.slice(pc.start, pc.end);
    const u = new SpeechSynthesisUtterance(spoken);
    u.rate = state.settings.rate;
    u.pitch = state.settings.pitch;
    u.volume = tts.volume;
    const voice = currentVoice();
    if (voice) {
      u.voice = voice;
      u.lang = Core.normalizeLang(voice.lang);
    }
    const expectedMs = (spoken.length / (state.settings.cps * state.settings.rate)) * 1000;
    const t0 = performance.now();
    let finished = false;
    let forced = false;
    tts.lastBoundary = sourceAt(sg, pc.start);

    const done = (kind, ev) => {
      if (finished || my !== tts.token) return;
      finished = true;
      clearSpeechTimers();
      if (kind === 'end' || forced) onUtteranceEnd(my, spoken.length, performance.now() - t0, expectedMs, !!voice);
      else onUtteranceError(my, ev, !!voice);
    };
    u.onend = () => done('end');
    u.onerror = (ev) => done('error', ev);
    u.onboundary = (ev) => {
      if (my !== tts.token || finished) return;
      if (ev.name && ev.name !== 'word') return;
      const k = Core.alignAtSpoken(sg, pc.start + (ev.charIndex || 0));
      const r = k >= 0 ? Core.wordRange(sg, k) : null;
      if (!r) return;
      tts.lastBoundary = r[0];
      markWord(r[0], r[1]);
    };
    tts.utter = u;

    try {
      const s = synth();
      if (s.paused) s.resume();
      s.speak(u);
    } catch (e) {
      done('error', { error: 'synthesis-failed' });
      return;
    }

    // Some engines never fire onend. If speech stopped (or is stuck), move on.
    const startedAt = Date.now();
    tts.watchdog = setInterval(() => {
      if (my !== tts.token || finished) {
        clearInterval(tts.watchdog);
        return;
      }
      const s = synth();
      const elapsed = Date.now() - startedAt;
      if (!s.speaking && !s.pending && elapsed > 1500) {
        done('end');
      } else if (elapsed > expectedMs * 3 + 12000) {
        forced = true;
        try {
          s.cancel();
          tts.lastCancelAt = Date.now();
        } catch (e) {
          /* ignore */
        }
        setTimeout(() => done('end'), 250);
      }
    }, 700);

    // Chrome on desktop stops online voices after ~15 s unless nudged.
    if (!IS_ANDROID && isOnlineVoice(voice)) {
      tts.keepAlive = setInterval(() => {
        if (my !== tts.token || finished) return;
        const s = synth();
        if (s.speaking && !s.paused) {
          s.pause();
          s.resume();
        }
      }, 10000);
    }
  }

  function onUtteranceEnd(my, len, ms, expectedMs, usedVoice) {
    if (ms > 700 && len > 24) {
      const measured = len / (ms / 1000) / state.settings.rate;
      if (measured > 4 && measured < 45) state.settings.cps = state.settings.cps * 0.85 + measured * 0.15;
    }
    // A voice whose data isn't installed can "finish" instantly without a sound.
    if (CONFIG.fastEndCheck && expectedMs > 1800 && ms < expectedMs * 0.15) {
      tts.fastEnds++;
      if (tts.fastEnds >= 3) {
        tts.fastEnds = 0;
        if (usedVoice && !tts.voiceBroken) {
          tts.voiceBroken = true;
          toast('That voice isn’t installed on this device, so Readout switched to the default voice.');
          state.idx = Math.max(0, state.idx - 2);
          speakCurrent(false);
          return;
        }
        pausePlayback();
        toast('Speech isn’t coming through. Check your phone’s text-to-speech settings, then press play.');
        return;
      }
    } else {
      tts.fastEnds = 0;
    }
    tts.errors = 0;
    if (tts.piece + 1 < tts.pieces.length) {
      tts.piece++;
      speakPiece(my);
      return;
    }
    advance(my);
  }

  function onUtteranceError(my, ev, usedVoice) {
    const code = (ev && ev.error) || 'unknown';
    if (code === 'interrupted' || code === 'canceled') {
      // Something outside Readout cut in (a call, another app). Keep the place.
      if (tts.playing) {
        tts.wordOffset = tts.lastBoundary || 0;
        pausePlayback({ keepOffset: true });
      }
      return;
    }
    if (code === 'not-allowed') {
      pausePlayback();
      toast('Tap play to start reading.');
      return;
    }
    tts.errors++;
    if (usedVoice && !tts.voiceBroken && /voice|language|synthesis|network/.test(code)) {
      tts.voiceBroken = true;
      toast(
        code === 'network'
          ? 'The online voice lost its connection, so Readout switched to the default voice.'
          : 'That voice didn’t work here, so Readout switched to the default voice.'
      );
      tts.wordOffset = tts.lastBoundary || 0;
      speakCurrent(false);
      return;
    }
    if (tts.errors >= 3) {
      pausePlayback();
      toast('Your device’s speech engine isn’t responding. Check its text-to-speech settings, then press play.');
      return;
    }
    advance(my);
  }

  // On to the next segment, after a short break where the text has one (paragraphs, headings).
  function advance(my) {
    if (my !== tts.token || !tts.playing) return;
    if (state.idx + 1 >= state.segs.length) {
      finishPlayback();
      return;
    }
    const sg = state.segs[state.idx];
    const gap = sg && sg.pauseAfterMs ? Math.min(600, Math.round(sg.pauseAfterMs / 2 / state.settings.rate)) : 0;
    const go = () => {
      if (my !== tts.token || !tts.playing) return;
      state.idx++;
      speakCurrent(false);
    };
    if (gap > 40) tts.restartTimer = setTimeout(go, gap);
    else go();
  }

  function restartPlaybackAtWord(delay) {
    if (!tts.playing || tts.engine !== 'device') return;
    clearTimeout(tts.rateTimer);
    tts.rateTimer = setTimeout(() => {
      if (!tts.playing || tts.engine !== 'device') return;
      tts.wordOffset = tts.lastBoundary || 0;
      speakCurrent(true);
    }, delay);
  }

  /* ---------- the natural and standard voices (readkit player) ---------- */

  function icon(s) {
    return { src: new URL(`icons/icon-${s}.png`, location.href).href, sizes: `${s}x${s}`, type: 'image/png' };
  }

  async function playAudio(eng) {
    const my = ++tts.token;
    if (tts.engine === 'device') {
      clearSpeechTimers();
      clearTimeout(tts.restartTimer);
      cancelSpeech();
    }
    const wasPlaying = tts.playing;
    tts.playing = true;
    tts.engine = 'audio';
    tts.wordOffset = 0;
    if (!wasPlaying) onPlaybackStart();
    highlightChunk(state.idx);
    const p = au.player;
    if (p && au.playerDoc === state.current && au.playerSegs === state.segs && au.voice && au.voice.id === eng.id && p.state !== 'ended' && p.state !== 'error') {
      if (p.index !== state.idx) p.seek(state.idx);
      p.setSpeed(audioRate());
      p.play();
      return;
    }
    dropPlayer();
    let voice;
    try {
      [voice] = await Promise.all([ensureVoice(eng.id), playerModule()]);
    } catch (e) {
      if (my !== tts.token || isAbort(e)) return;
      audioFailed(e, eng);
      return;
    }
    if (my !== tts.token || !tts.playing || !state.current) return; // paused while the voice loaded
    try {
      startPlayer(voice);
      au.player.play();
    } catch (e) {
      audioFailed(e, eng);
    }
  }

  function startPlayer(voice) {
    const doc = state.current;
    const segs = state.segs;
    let player = null;
    const mine = () => player && au.player === player;
    player = kit.P.createPlayer({
      audio: au.el,
      voice,
      segments: segs,
      startAt: Math.min(state.idx, segs.length - 1),
      speed: audioRate(),
      metadata: { title: doc.title, artist: 'Readout', artwork: [icon(192), icon(512)] },
      onSegment: (i) => mine() && onAudioSegment(i),
      onWord: (i, k) => mine() && onAudioWord(i, k),
      onState: (s) => mine() && onAudioState(s),
      onError: (e) => mine() && onAudioError(e),
    });
    au.player = player;
    au.playerSegs = segs;
    au.playerDoc = doc;
  }

  function dropPlayer() {
    const p = au.player;
    if (!p) return;
    au.player = null;
    au.playerSegs = null;
    au.playerDoc = null;
    try {
      p.destroy();
    } catch (e) {
      /* ignore */
    }
    if (tts.engine === 'audio' && tts.playing) {
      tts.playing = false;
      onPlaybackStop();
    }
    // The player's lock-screen controls went with it; the device voice's come back.
    setupMediaSession();
    updateMediaSession();
  }

  function onAudioSegment(i) {
    if (i !== state.idx || curSpan !== i) {
      state.idx = i;
      tts.wordOffset = 0;
      highlightChunk(i);
      queuePositionSave();
    }
    sleepCheck();
  }

  function onAudioWord(i, k) {
    if (i !== curSpan) return;
    const r = Core.wordRange(state.segs[i], k);
    if (r) markWord(r[0], r[1]);
  }

  // A player that makes no audio for this long (a voice that hangs) counts as failed.
  const STALL_MS = { loading: 60000, buffering: 30000 };
  let stallTimer = null;
  function watchStall(s) {
    clearTimeout(stallTimer);
    stallTimer = null;
    if (!STALL_MS[s]) return;
    const p = au.player;
    stallTimer = setTimeout(() => {
      if (au.player === p && p && p.state === s && tts.playing && tts.engine === 'audio') audioFailed(Object.assign(new Error('The voice stopped making audio'), { code: 'stalled' }), { id: au.voice && au.voice.id });
    }, STALL_MS[s]);
  }

  function onAudioState(s) {
    watchStall(s);
    if (s === 'playing' || s === 'loading' || s === 'buffering') {
      setWaiting(s === 'loading' ? 'Getting the voice ready…' : s === 'buffering' ? 'Catching up…' : '');
      if (!tts.playing) {
        // Started from the lock screen or the notification.
        tts.playing = true;
        tts.engine = 'audio';
        onPlaybackStart();
      }
    } else if (s === 'paused') {
      setWaiting('');
      if (tts.playing && tts.engine === 'audio') {
        tts.playing = false;
        tts.token++;
        clearWord();
        onPlaybackStop();
        savePositionNow();
      }
    } else if (s === 'ended') {
      setWaiting('');
      if (tts.engine === 'audio' && state.idx < state.segs.length) finishPlayback();
    }
    renderPlayer();
  }

  function onAudioError(e) {
    if (!e) return;
    if (e.code === 'segment') {
      console.warn('Readout: a sentence couldn’t be spoken and was skipped', e);
      return;
    }
    if (e.code === 'not-allowed') {
      pausePlayback();
      toast('Tap play to start reading.');
      return;
    }
    audioFailed(e, { id: au.voice && au.voice.id });
  }

  function voiceName(id) {
    const v = kit.V && id ? kit.V.findVoice(id) : null;
    return v ? v.name : 'The voice';
  }

  // A voice that can't load or stops: say so and go on with the next voice that can read.
  function audioFailed(e, eng) {
    console.warn('Readout voice error', e);
    const id = (eng && eng.id) || '';
    const name = voiceName(id);
    const wasPlaying = tts.playing;
    dropPlayer();
    if (au.voice && (!id || au.voice.id === id)) {
      au.voice.dispose();
      au.voice = null;
    }
    tts.engine = null;
    if (e && e.code === 'calibrate') {
      const std = kitVoiceId('standard');
      const next = chooseEngine();
      toast(
        next.kind === 'audio'
          ? `${name} doesn’t run well on this device, so Readout is using ${voiceName(next.id)}, the standard voice.`
          : `${name} doesn’t run well on this device. The standard voice (63 MB) works on any phone.`,
        next.kind === 'audio' ? {} : { action: 'Get it', onAction: () => askDownload(std) }
      );
      renderVoicePanel();
    } else if (e && e.code === 'quota' && !e.index) {
      au.broken = true;
      toast('This device ran out of room for the audio, so Readout switched to the device voice.');
    } else {
      // The natural voice gave out (a graphics driver, say): the standard voice, if it's here,
      // also reads with the screen off; the device voice doesn't.
      const kokoro = kit.V && id && kit.V.findVoice(id) && kit.V.findVoice(id).engine === 'kokoro';
      if (kokoro) au.naturalBroken = true;
      const next = kokoro ? chooseEngine() : { kind: 'device' };
      if (next.kind === 'audio') toast(`${name} stopped working, so Readout switched to ${voiceName(next.id)}, the standard voice.`);
      else {
        au.broken = true;
        toast(`${name} stopped working, so Readout switched to the device voice.`);
      }
    }
    if (wasPlaying && state.current) {
      tts.playing = false;
      play();
    } else renderPlayer();
  }

  const isAbort = (e) => !!e && (e.name === 'AbortError' || e.code === 'aborted');

  // Loads a downloaded voice (one at a time). The natural voice is checked on this device the
  // first time (speed, and output a broken graphics driver would spoil).
  async function ensureVoice(id) {
    if (au.voice && au.voice.id === id) return au.voice;
    if (au.loading && au.loading.id === id) return au.loading.promise;
    const V = await voiceModule();
    if (au.voice) {
      if (au.player) dropPlayer();
      stopPreview();
      au.voice.dispose();
      au.voice = null;
    }
    const entry = V.findVoice(id);
    const promise = (async () => {
      if (entry.engine === 'kokoro' && !(await hasWebGpu())) throw Object.assign(new Error('No WebGPU'), { code: 'calibrate', reason: 'webgpu' });
      setWaiting(`Loading ${entry.name}…`);
      const voice = await V.createVoice({ id, source: 'store' });
      if (entry.engine === 'kokoro') {
        setWaiting(`Checking ${entry.name} on this device…`);
        let cal;
        try {
          cal = await voice.calibrate({ speed: 1 });
        } catch (e) {
          voice.dispose();
          throw e;
        }
        recordNaturalCheck({ ok: cal.ok, reason: cal.reason || null, rt: cal.rt || 0 });
        if (!cal.ok) {
          voice.dispose();
          throw Object.assign(new Error(cal.message || cal.reason || 'calibration failed'), { code: 'calibrate', reason: cal.reason });
        }
      }
      return voice;
    })();
    const job = { id, promise };
    au.loading = job;
    try {
      const voice = await promise;
      if (au.loading !== job) {
        voice.dispose();
        throw new DOMException('Another voice was chosen', 'AbortError');
      }
      au.voice = voice;
      return voice;
    } catch (e) {
      if (e && e.code === 'calibrate' && e.reason === 'webgpu') {
        au.gpu = false;
        recordNaturalCheck({ ok: false, reason: 'webgpu' });
      }
      throw e;
    } finally {
      if (au.loading === job) au.loading = null;
      setWaiting('');
    }
  }

  async function hasWebGpu() {
    if (au.gpu !== null) return au.gpu;
    try {
      au.gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
    } catch (e) {
      au.gpu = false;
    }
    return au.gpu;
  }

  // Gets the voice ready a moment after a text opens, so play starts at once.
  let warmTimer = null;
  function warmVoiceSoon() {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      if (document.visibilityState !== 'visible' || !state.current || state.mode !== 'listen' || tts.playing) return;
      const eng = chooseEngine();
      if (eng.kind !== 'audio' || (au.voice && au.voice.id === eng.id) || au.loading) return;
      Promise.all([ensureVoice(eng.id), playerModule()]).catch((e) => {
        if (isAbort(e)) return;
        if (e && e.code === 'calibrate') audioFailed(e, eng);
        else console.warn('Readout: the voice didn’t load', e);
      });
    }, 1200);
  }

  /* ---------- playing, pausing, moving ---------- */

  function pausePlayback(opts) {
    if (!tts.playing) return;
    const o = opts || {};
    tts.playing = false;
    tts.token++;
    if (tts.engine === 'audio') {
      if (au.player) au.player.pause();
      tts.wordOffset = 0;
    } else {
      clearSpeechTimers();
      clearTimeout(tts.restartTimer);
      clearTimeout(tts.rateTimer);
      if (!o.keepOffset) tts.wordOffset = tts.lastBoundary > 0 ? tts.lastBoundary : 0;
      cancelSpeech();
    }
    setWaiting('');
    clearWord();
    onPlaybackStop();
    savePositionNow();
  }

  function finishPlayback() {
    const doc = state.current;
    tts.playing = false;
    tts.token++;
    clearSpeechTimers();
    clearWord();
    setWaiting('');
    state.idx = state.segs.length;
    tts.wordOffset = 0;
    highlightChunk(state.idx, { scroll: false });
    onPlaybackStop();
    savePositionNow(true);
    const byTimer = sleep.mode === 'end';
    if (byTimer) setSleep(0);
    const next = !byTimer && state.settings.autoNext && doc ? Core.nextInOrder(queue.order, doc.id, isFinished) : null;
    if (next && state.docs.some((d) => d.id === next)) {
      playNext(next);
      return;
    }
    toast(byTimer ? 'Sleep timer: stopped at the end of the text.' : 'Finished reading.');
  }

  function isFinished(id) {
    const p = state.positions.get(id);
    return !!(p && p.done);
  }

  // Play next text automatically: the next one in the library's order when listening began.
  function playNext(id) {
    const d = state.docs.find((x) => x.id === id);
    if (!d || !d.text.trim()) return;
    openDoc(id, { mode: 'listen', keepPlaying: true });
    toast(`Next: “${d.title}”.`);
    play(undefined, { queued: true });
  }

  function skip(delta) {
    const n = state.segs.length;
    if (!n) return;
    const base = state.idx >= n ? n : state.idx;
    seekTo(Core.clamp(base + delta, 0, n - 1));
  }

  // Jumps to a segment: tap, scrub, previous/next, a heading.
  function seekTo(i) {
    const n = state.segs.length;
    if (!n) return;
    i = Core.clamp(i, 0, n - 1);
    state.idx = i;
    tts.wordOffset = 0;
    lastManualScroll = 0;
    if (tts.playing && tts.engine === 'device') {
      speakCurrent(true);
      return;
    }
    // A paused player follows too, so play from the lock screen starts here.
    if (au.player && au.player.state !== 'ended' && au.player.state !== 'error') au.player.seek(i);
    else if (au.player && !tts.playing) dropPlayer();
    highlightChunk(i, { scroll: 'force' });
    if (!tts.playing) queuePositionSave();
  }

  function setRate(r) {
    const rate = Math.round(Core.clamp(Number(r) || 1, 0.5, rateMax()) * 100) / 100;
    if (rate === state.settings.rate) {
      renderRate();
      return;
    }
    state.settings.rate = rate;
    saveSettings();
    renderRate();
    renderPlayer();
    if (au.player) au.player.setSpeed(audioRate());
    if (au.preview) au.preview.setSpeed(audioRate());
    restartPlaybackAtWord(400);
  }

  function setPitch(p) {
    state.settings.pitch = Math.round(Core.clamp(Number(p) || 1, 0.5, 1.5) * 100) / 100;
    saveSettings();
    renderRate();
    restartPlaybackAtWord(400);
  }

  function setDeviceVoice(uri) {
    state.settings.voiceURI = uri || '';
    tts.voiceBroken = false;
    saveSettings();
    restartPlaybackAtWord(150);
  }

  /* ---------- preview ---------- */

  const PREVIEW_TEXT = 'This is how this voice sounds at this speed. On the third of June, Dr. Patel read 1,250 pages.';

  function stopPreview() {
    au.previewToken++;
    const p = au.preview;
    au.preview = null;
    if (p) {
      try {
        p.destroy();
      } catch (e) {
        /* ignore */
      }
    }
  }

  async function previewVoice() {
    pausePlayback();
    cancelSpeech();
    stopPreview();
    const mode = state.settings.voiceMode;
    if (mode === 'device') {
      if (!tts.ok) return;
      const u = new SpeechSynthesisUtterance('This is how this voice sounds at this speed.');
      u.rate = state.settings.rate;
      u.pitch = state.settings.pitch;
      const v = Core.pickVoice(tts.voices, state.settings.voiceURI);
      if (v) {
        u.voice = v;
        u.lang = Core.normalizeLang(v.lang);
      }
      tts.utter = u;
      const wait = Math.max(0, (IS_ANDROID ? 180 : 80) - (Date.now() - tts.lastCancelAt));
      setTimeout(() => {
        try {
          synth().speak(u);
        } catch (e) {
          /* ignore */
        }
      }, wait);
      return;
    }
    const id = kitVoiceId(mode);
    if (!au.installed.has(id)) {
      askDownload(id);
      return;
    }
    if (mode === 'natural' && naturalFails()) {
      toast(`${voiceName(id)} doesn’t run well on this device.`);
      return;
    }
    const my = ++au.previewToken;
    el.previewBtn.disabled = true;
    try {
      const [voice] = await Promise.all([ensureVoice(id), playerModule()]);
      if (my !== au.previewToken) return;
      let pv = null;
      pv = kit.P.createPlayer({
        audio: el.previewAudio,
        voice,
        segments: kit.K.plan(PREVIEW_TEXT, planOptions()),
        speed: audioRate(),
        cache: false,
        mediaSession: false,
        onState: (s) => {
          if (s === 'ended' && pv && au.preview === pv) stopPreview();
        },
        onError: (e) => {
          if (e && e.code !== 'segment' && pv && au.preview === pv) {
            stopPreview();
            toast(`Couldn’t play ${voiceName(id)} here.`);
          }
        },
      });
      au.preview = pv;
      pv.play();
    } catch (e) {
      if (isAbort(e)) return;
      if (e && e.code === 'calibrate') audioFailed(e, { id });
      else toast(`Couldn’t play ${voiceName(id)} here.`);
    } finally {
      el.previewBtn.disabled = false;
    }
  }

  /* ---------- keeping the phone awake, lock-screen controls ---------- */

  const wake = {
    sentinel: null,
    busy: false,
    reasons: new Set(),
    want(reason, on) {
      if (on) this.reasons.add(reason);
      else this.reasons.delete(reason);
      if (this.reasons.size) this.acquire();
      else this.release();
    },
    async acquire() {
      if (this.sentinel || this.busy || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      this.busy = true;
      try {
        const s = await navigator.wakeLock.request('screen');
        this.sentinel = s;
        s.addEventListener('release', () => {
          if (this.sentinel === s) this.sentinel = null;
        });
        if (!this.reasons.size) this.release();
      } catch (e) {
        /* not allowed right now */
      } finally {
        this.busy = false;
      }
    },
    release() {
      const s = this.sentinel;
      this.sentinel = null;
      if (s) s.release().catch(() => {});
    },
  };

  // The device voice's lock-screen controls. While the player reads, it has its own
  // (previous/next sentence, seek bar), and these come back when it is gone.
  function setupMediaSession() {
    if (!('mediaSession' in navigator) || au.player) return;
    const h = (action, fn) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch (e) {
        /* unsupported action */
      }
    };
    h('play', () => play());
    h('pause', () => pausePlayback());
    h('stop', () => pausePlayback());
    h('previoustrack', () => skip(-1));
    h('nexttrack', () => skip(1));
    h('seekbackward', () => skip(-1));
    h('seekforward', () => skip(1));
    h('seekto', null);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || au.player) return;
    try {
      const doc = state.current;
      if (doc && typeof window.MediaMetadata === 'function') {
        const md = navigator.mediaSession.metadata;
        if (!md || md.title !== doc.title) navigator.mediaSession.metadata = new MediaMetadata({ title: doc.title, artist: 'Readout', artwork: [icon(192), icon(512)] });
      }
      navigator.mediaSession.playbackState = tts.playing ? 'playing' : 'paused';
    } catch (e) {
      /* ignore */
    }
  }

  function onPlaybackStart() {
    if (state.settings.keepAwake && tts.engine === 'device') wake.want('play', true);
    updateMediaSession();
    renderPlayer();
  }

  function onPlaybackStop() {
    wake.want('play', false);
    updateMediaSession();
    saveSettings();
    renderPlayer();
    syncSoon(1500);
  }

  /* ---------- sleep timer ---------- */

  // 15-60 minutes, or the end of the text. The last 10 s fade out. It runs on timers that a
  // page playing audio keeps getting with the screen off, and on each sentence the player reports.
  const sleep = { mode: 0, until: 0, timer: null, fadeMs: 10000, lastMin: -1 };

  function setSleep(v) {
    clearInterval(sleep.timer);
    sleep.timer = null;
    sleep.until = 0;
    sleep.mode = 0;
    sleep.lastMin = -1;
    setVolume(1);
    if (v === 'end') sleep.mode = 'end';
    else if (Number(v) > 0) {
      sleep.mode = Number(v);
      sleep.until = Date.now() + Number(v) * 60000;
      sleep.timer = setInterval(sleepCheck, 500);
    }
    renderSleep();
    renderPlayer();
  }

  function sleepCheck() {
    if (!sleep.until) return;
    const left = sleep.until - Date.now();
    const min = Math.ceil(left / 60000);
    if (min !== sleep.lastMin) {
      sleep.lastMin = min;
      renderPlayer();
      renderSleep();
    }
    if (left > sleep.fadeMs) return;
    setVolume(Core.fadeGain(left, sleep.fadeMs));
    if (left > 0) return;
    const was = tts.playing;
    pausePlayback();
    setSleep(0);
    if (was) toast('Sleep timer: stopped reading.');
  }

  function setVolume(g) {
    tts.volume = g;
    if (au.el) au.el.volume = g;
  }

  function renderSleep() {
    if (!el.sleepChips) return;
    const cur = sleep.mode === 'end' ? 'end' : String(sleep.mode || 0);
    for (const b of el.sleepChips.querySelectorAll('[data-sleep]')) b.setAttribute('aria-pressed', String(b.dataset.sleep === cur));
    el.sleepValue.textContent = sleep.mode === 'end' ? 'At the end of the text' : sleep.until ? `${Math.max(1, Math.ceil((sleep.until - Date.now()) / 60000))} min left` : 'Off';
  }

  /* ================= voices: downloads, choices ================= */

  const MB = 1e6;
  const fmtMB = (b) => (b >= 10 * MB ? Math.round(b / MB) : Math.max(0.1, Math.round(b / 1e5) / 10)) + ' MB';
  const ACCENT_NAME = { 'en-US': 'American', 'en-GB': 'British' };
  const MODE_NAME = { natural: 'Natural', standard: 'Standard', device: 'Device' };
  const allKitVoices = () => [...new Set(Object.values(KIT_VOICES).flat())];
  const voiceInfo = new Map(); // id -> { installed, need, total, partial }

  // What's downloaded (and half downloaded) on this device.
  async function refreshVoices() {
    let V;
    try {
      V = await voiceModule();
    } catch (e) {
      return;
    }
    await Promise.all(
      allKitVoices().map(async (id) => {
        try {
          const st = await V.voiceStore.status(id);
          const partial = st.files.some((f) => f.bytes > 0 && !f.complete);
          voiceInfo.set(id, { installed: st.installed, need: Math.max(0, st.total - st.bytes), total: st.total, partial, bytes: st.bytes });
          if (st.installed) au.installed.add(id);
          else au.installed.delete(id);
        } catch (e) {
          /* OPFS unavailable: nothing is installed */
        }
      })
    );
    renderVoicePanel();
    renderVoiceList();
  }

  function netText() {
    if (navigator.onLine === false) return 'Offline';
    const c = navigator.connection;
    const t = c && c.type;
    if (t === 'wifi') return 'Wi-Fi';
    if (t === 'ethernet') return 'Wired network';
    if (t === 'cellular') return 'Mobile data';
    if (t === 'none') return 'Offline';
    return 'Not known (check that you’re on Wi-Fi)';
  }

  async function freeSpace() {
    try {
      const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      return e && e.quota ? Math.max(0, e.quota - (e.usage || 0)) : null;
    } catch (e) {
      return null;
    }
  }

  // The one-time download, asked first: what it is, its size, the connection, the free space.
  async function askDownload(id) {
    let V;
    try {
      V = await voiceModule();
    } catch (e) {
      toast('Couldn’t load the voice list. Check your connection.');
      return;
    }
    const entry = V.findVoice(id);
    if (!entry) return;
    if (au.dl) {
      toast(au.dl.id === id ? `${entry.name} is downloading.` : 'Another voice is downloading. Wait for it to finish.');
      return;
    }
    if (entry.engine === 'kokoro' && !(await hasWebGpu())) {
      const std = kitVoiceId('standard');
      toast(`${entry.name} needs WebGPU, which this browser doesn’t have. The standard voice works here.`, { action: 'Get it', onAction: () => askDownload(std) });
      return;
    }
    if (!playerSupported()) {
      toast('This browser can’t play downloaded voices. Readout uses the device voice here.');
      return;
    }
    let st = { total: entry.bytes, bytes: 0 };
    try {
      st = await V.voiceStore.status(id);
    } catch (e) {
      /* no OPFS: install() will say so */
    }
    const need = Math.max(0, st.total - st.bytes);
    const free = await freeSpace();
    const acc = ACCENT_NAME[entry.dialect] || '';
    el.voiceSheetTitle.textContent = `Download ${entry.name}?`;
    el.voiceSheetWhat.textContent =
      entry.engine === 'kokoro'
        ? `${entry.name} is a natural-sounding ${acc} voice. It runs on this device (on its graphics chip), works offline, and keeps reading with the screen off.`
        : `${entry.name} is a standard ${acc} voice that works on any phone, offline and with the screen off.`;
    el.voiceSheetSize.textContent = need < st.total - 1000 ? `${fmtMB(need)} more (${fmtMB(st.total)} in all)` : fmtMB(need);
    const net = netText();
    el.voiceSheetNet.textContent = net;
    el.voiceSheetSpace.textContent = free == null ? 'Not known' : free >= 1e9 ? `${(free / 1e9).toFixed(1)} GB` : fmtMB(free);
    const notes = [];
    if (free != null && free < need * 1.05) notes.push('There isn’t enough free space for this voice. Free up some space and try again.');
    else if (net === 'Mobile data') notes.push(`You’re on mobile data: this uses about ${fmtMB(need)} of it. On Wi-Fi it costs nothing.`);
    else if (net === 'Offline') notes.push('You’re offline. Connect to the internet to download.');
    notes.push('It downloads once and stays on this device. If the download stops, it picks up where it left off.');
    if (entry.license) notes.push(`Voice licence: ${entry.license}.`);
    el.voiceSheetNote.textContent = notes.join(' ');
    el.voiceSheetYes.disabled = (free != null && free < need * 1.05) || net === 'Offline';
    el.voiceSheetYes.onclick = () => {
      closeSheet(el.voiceSheet);
      downloadVoice(id);
    };
    openSheet(el.voiceSheet);
  }

  async function downloadVoice(id) {
    const V = await voiceModule();
    const entry = V.findVoice(id);
    if (au.dl) return;
    const ctrl = new AbortController();
    au.dl = { id, ctrl, done: 0, total: entry.bytes };
    renderVoicePanel();
    renderVoiceList();
    toast(`Downloading ${entry.name}. You can keep reading with the device voice meanwhile.`);
    wake.want('download', true);
    let ok = false;
    try {
      await V.voiceStore.install(id, {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (!au.dl || au.dl.id !== id) return;
          au.dl.done = p.done || 0;
          au.dl.total = p.total || au.dl.total;
          renderDownloadProgress();
        },
      });
      ok = true;
    } catch (e) {
      if (isAbort(e)) toast('Download stopped. Next time it picks up where it left off.');
      else if (e && (e.code === 'quota' || e.name === 'QuotaExceededError')) toast('There isn’t enough free space on this device for that voice.');
      else {
        console.warn('Readout voice download', e);
        toast(navigator.onLine === false ? 'The download stopped: you’re offline. It picks up where it left off next time.' : 'The download stopped. Tap Download to pick up where it left off.');
      }
    } finally {
      au.dl = null;
      wake.want('download', false);
    }
    await refreshVoices();
    if (!ok) return;
    const eng = chooseEngine();
    if (eng.kind === 'audio' && eng.id === id) {
      toast(`${entry.name} is ready.${tts.playing ? '' : ' Press play to listen.'}`);
      // Reading with the device voice now: carry on with the new voice from here.
      if (tts.playing && tts.engine === 'device') {
        const i = state.idx;
        pausePlayback();
        play(i);
      } else warmVoiceSoon();
    } else toast(`${entry.name} is downloaded.`);
  }

  function stopDownload() {
    if (au.dl) au.dl.ctrl.abort();
  }

  async function removeVoice(id, btn) {
    if (btn && btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Tap again to remove';
      setTimeout(() => {
        btn.dataset.confirm = '';
        btn.textContent = 'Remove';
      }, 4000);
      return;
    }
    const V = await voiceModule();
    if (au.dl && au.dl.id === id) {
      au.dl.ctrl.abort();
      await new Promise((r) => setTimeout(r, 200));
    }
    if (au.voice && au.voice.id === id) {
      pausePlayback();
      dropPlayer();
      stopPreview();
      au.voice.dispose();
      au.voice = null;
    }
    try {
      await V.voiceStore.remove(id);
      toast(`Removed ${V.findVoice(id).name} from this device.`);
    } catch (e) {
      toast('Couldn’t remove that voice.');
    }
    au.installed.delete(id);
    await refreshVoices();
  }

  // Something to try once with the device voice: a voice that keeps reading with the screen off.
  function offerVoiceOnce() {
    const s = state.settings;
    if (s.offeredVoice || au.offerShown || s.voiceMode === 'device' || !playerSupported() || au.installed.size || au.dl) return;
    au.offerShown = true;
    setTimeout(() => {
      if (au.installed.size || au.dl) return;
      s.offeredVoice = true;
      saveSettings();
      const id = kitVoiceId(s.voiceMode);
      const entry = kit.V && kit.V.findVoice(id);
      const size = entry ? fmtMB(entry.bytes) : s.voiceMode === 'natural' ? '326 MB' : '63 MB';
      const kind = s.voiceMode === 'natural' ? 'a natural voice' : 'a voice';
      toast(`For ${kind} that keeps reading with the screen off, download ${entry ? entry.name : 'one'} (${size}, once).`, { action: 'Download', onAction: () => askDownload(id) });
    }, 2500);
  }

  async function setVoiceMode(m) {
    if (!MODE_NAME[m] || m === state.settings.voiceMode) return;
    state.settings.voiceMode = m;
    saveSettings();
    au.broken = false;
    au.naturalBroken = false;
    switchEngineNow();
    renderRate();
    renderVoicePanel();
    if (m !== 'device') {
      await refreshVoices();
      const id = kitVoiceId(m);
      if (!au.installed.has(id) && !(au.dl && au.dl.id === id) && !(m === 'natural' && naturalFails())) askDownload(id);
    }
  }

  function setAccent(a) {
    if (a !== 'en-US' && a !== 'en-GB') return;
    if (a === accent() && state.settings.accent) return;
    state.settings.accent = a;
    saveSettings();
    replanCurrent(); // US and UK read dates, numbers and spellings differently
    renderVoicePanel();
    const m = state.settings.voiceMode;
    if (m !== 'device') {
      const id = kitVoiceId(m);
      if (!au.installed.has(id) && !au.dl && !(m === 'natural' && naturalFails())) askDownload(id);
    }
  }

  function setSpeaker(id) {
    const m = state.settings.voiceMode;
    if (m === 'device') return;
    const key = `${m}-${accent()}`;
    if (!(KIT_VOICES[key] || []).includes(id)) return;
    state.settings.voices = Object.assign({}, state.settings.voices, { [key]: id });
    saveSettings();
    switchEngineNow();
    renderVoicePanel();
    if (!au.installed.has(id) && !au.dl) askDownload(id);
  }

  // A different voice was chosen while reading: go on from here with it.
  function switchEngineNow() {
    const eng = chooseEngine();
    const same = eng.kind === 'device' ? tts.engine === 'device' : tts.engine === 'audio' && au.voice && au.voice.id === eng.id && !!au.player;
    if (same) return;
    if (tts.playing) {
      const i = state.idx;
      pausePlayback();
      dropPlayer();
      play(i);
    } else {
      dropPlayer();
      warmVoiceSoon();
    }
  }

  function checkNaturalAgain() {
    recordNaturalCheck(null);
    au.gpu = null;
    au.broken = false;
    au.naturalBroken = false;
    renderVoicePanel();
    const id = kitVoiceId('natural');
    if (!au.installed.has(id)) {
      askDownload(id);
      return;
    }
    if (au.voice && au.voice.id === id) {
      pausePlayback();
      dropPlayer();
      stopPreview();
      au.voice.dispose();
      au.voice = null;
    }
    ensureVoice(id)
      .then(() => {
        toast(`${voiceName(id)} works on this device.`);
        renderVoicePanel();
      })
      .catch((e) => {
        if (!isAbort(e)) audioFailed(e, { id });
      });
  }

  // The voice part of the speed sheet: mode, accent, speaker, and what's downloaded.
  function renderVoicePanel() {
    if (!el.vmodeGroup) return;
    const s = state.settings;
    const mode = s.voiceMode;
    const acc = accent();
    for (const i of el.vmodeGroup.querySelectorAll('input')) i.checked = i.value === mode;
    for (const i of el.accentGroup.querySelectorAll('input')) i.checked = i.value === acc;
    const device = mode === 'device';
    el.kitVoiceSelect.hidden = device;
    el.voiceSelect.hidden = !device;
    el.pitchField.hidden = !device;
    el.voiceBar.hidden = true;
    for (const b of [el.voiceGetBtn, el.voiceStopBtn, el.voiceRetryBtn]) b.hidden = true;
    if (device) {
      renderVoiceOptions();
      return;
    }
    const V = kit.V;
    if (!V) {
      el.voiceHint.textContent = 'Loading the voices…';
      voiceModule().then(refreshVoices, () => (el.voiceHint.textContent = 'Couldn’t load the voice list.'));
      return;
    }
    const key = `${mode}-${acc}`;
    const id = kitVoiceId(mode);
    const opts = (KIT_VOICES[key] || []).map((vid) => {
      const v = V.findVoice(vid);
      const o = document.createElement('option');
      o.value = vid;
      o.textContent = `${v.name} (${v.gender === 'female' ? 'female' : 'male'})${au.installed.has(vid) ? '' : ', not downloaded'}`;
      return o;
    });
    el.kitVoiceSelect.replaceChildren(...opts);
    el.kitVoiceSelect.value = id;
    const entry = V.findVoice(id);
    const info = voiceInfo.get(id) || { need: entry.bytes, total: entry.bytes };
    const eng = chooseEngine();
    const using = eng.kind === 'audio' ? `${voiceName(eng.id)} (${eng.mode})` : 'the device voice';
    let hint;
    if (!playerSupported()) hint = 'This browser can’t play downloaded voices, so Readout uses the device voice.';
    else if (au.dl && au.dl.id === id) {
      hint = downloadText();
      el.voiceBar.hidden = false;
      el.voiceStopBtn.hidden = false;
    } else if (mode === 'natural' && naturalFails()) {
      const c = naturalCheck();
      const why = au.gpu === false || (c && c.reason === 'webgpu') ? 'this browser has no WebGPU' : c && c.reason === 'slow' ? 'it’s too slow here' : 'its sound came out wrong here';
      hint = `${entry.name} doesn’t run well on this device (${why}). Readout uses ${using}.`;
      el.voiceRetryBtn.hidden = false;
      const std = kitVoiceId('standard');
      if (!au.installed.has(std)) {
        el.voiceGetBtn.hidden = false;
        el.voiceGetLabel.textContent = `Get the standard voice (${fmtMB((voiceInfo.get(std) || {}).need || 63.2 * MB)})`;
        el.voiceGetBtn.dataset.id = std;
      }
    } else if (au.installed.has(id)) {
      hint = eng.kind === 'audio' && eng.id === id ? `${entry.name} is on this device and keeps reading with the screen off.` : `${entry.name} is downloaded.`;
    } else {
      hint = info.partial ? `${entry.name}: ${fmtMB(info.bytes)} of ${fmtMB(info.total)} downloaded.` : `${entry.name} isn’t downloaded yet.`;
      hint += ` Until then Readout uses ${using}.`;
      el.voiceGetBtn.hidden = !!au.dl;
      el.voiceGetLabel.textContent = info.partial ? 'Resume download' : `Download (${fmtMB(info.need)})`;
      el.voiceGetBtn.dataset.id = id;
    }
    el.voiceHint.textContent = hint;
    renderDownloadProgress();
  }

  function downloadText() {
    const d = au.dl;
    if (!d) return '';
    return `Downloading ${voiceName(d.id)}: ${fmtMB(d.done)} of ${fmtMB(d.total)} (${Math.floor(d.total ? (d.done / d.total) * 100 : 0)}%)`;
  }

  let dlRender = 0;
  function renderDownloadProgress() {
    const d = au.dl;
    if (!d) return;
    const now = Date.now();
    if (now - dlRender < 250 && d.done < d.total) return;
    dlRender = now;
    const pct = d.total ? Math.min(100, (d.done / d.total) * 100) : 0;
    if (!el.voiceBar.hidden) {
      el.voiceBarFill.style.width = pct + '%';
      el.voiceHint.textContent = downloadText();
    }
    const row = el.voiceList && el.voiceList.querySelector(`[data-dl="${d.id}"]`);
    if (row) row.textContent = `Downloading: ${Math.floor(pct)}%`;
  }

  // Settings: the voices on this device, each with Remove.
  function renderVoiceList() {
    if (!el.voiceList || !kit.V) return;
    const V = kit.V;
    const rows = [];
    const kokoroCount = allKitVoices().filter((id) => au.installed.has(id) && V.findVoice(id).engine === 'kokoro').length;
    for (const id of allKitVoices()) {
      const info = voiceInfo.get(id);
      const downloading = au.dl && au.dl.id === id;
      if (!downloading && !(info && (info.installed || info.partial))) continue;
      const v = V.findVoice(id);
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'vl-name';
      name.textContent = v.name;
      const meta = document.createElement('span');
      meta.className = 'vl-meta';
      const kind = `${v.engine === 'kokoro' ? 'Natural' : 'Standard'}, ${ACCENT_NAME[v.dialect]}`;
      if (downloading) {
        meta.dataset.dl = id;
        meta.textContent = 'Downloading';
      } else if (info.installed) meta.textContent = `${kind}, ${v.engine === 'kokoro' && kokoroCount > 1 ? '0.5 MB (shares the natural voice model)' : fmtMB(info.total)}`;
      else meta.textContent = `${kind}, ${fmtMB(info.bytes)} of ${fmtMB(info.total)} downloaded`;
      name.appendChild(meta);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm';
      b.textContent = downloading ? 'Stop' : 'Remove';
      b.addEventListener('click', () => (downloading ? stopDownload() : removeVoice(id, b)));
      li.append(name, b);
      rows.push(li);
    }
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No voices downloaded yet. Pick Natural or Standard under Speed and voice.';
      rows.push(li);
    }
    el.voiceList.replaceChildren(...rows);
    renderDownloadProgress();
  }

  /* ================= dictation ================= */

  const dict = {
    on: false,
    rec: null,
    local: false,
    startedAt: 0,
    gotResult: false,
    quickEnds: 0,
    netErrors: 0,
    interim: '',
    lastFinal: '',
    lastFinalAt: 0,
  };

  function dictLang() {
    return state.settings.dictLang || navigator.language || 'en-US';
  }

  function toggleDictation() {
    if (dict.on) stopDictation();
    else startDictation();
  }

  async function startDictation() {
    if (!SR) {
      toast('Dictation isn’t available in this browser. Try Chrome.');
      return;
    }
    if (dict.on || !state.current) return;
    if (state.mode !== 'edit') setMode('edit');
    pausePlayback();
    dict.on = true;
    dict.quickEnds = 0;
    dict.netErrors = 0;
    dict.interim = '';
    el.dictInterim.textContent = '';
    el.dictLabel.textContent = 'Listening';
    el.dictation.hidden = false;
    el.dictateBtn.setAttribute('aria-pressed', 'true');
    el.dictateBtn.lastChild.textContent = 'Stop';
    wake.want('dictate', true);
    dict.local = false;
    if (state.settings.dictLocal && typeof SR.available === 'function') {
      const opts = { langs: [dictLang()], processLocally: true };
      try {
        const status = await SR.available(opts);
        if (status === 'available') dict.local = true;
        else if (status === 'downloadable' || status === 'downloading') {
          toast('Downloading on-device speech for this language. Dictation uses the online service until it finishes.');
          if (typeof SR.install === 'function') SR.install(opts).catch(() => {});
        }
      } catch (e) {
        /* fall back to the online service */
      }
    }
    if (dict.on) beginSession();
  }

  function beginSession() {
    if (!dict.on) return;
    let rec;
    try {
      rec = new SR();
    } catch (e) {
      stopDictation();
      toast('Dictation couldn’t start.');
      return;
    }
    rec.lang = dictLang();
    rec.interimResults = true;
    // Android Chrome repeats earlier words in continuous mode, so use one phrase per session there.
    rec.continuous = !IS_ANDROID;
    rec.maxAlternatives = 1;
    if (dict.local) {
      try {
        rec.processLocally = true;
      } catch (e) {
        /* ignore */
      }
    }
    dict.rec = rec;
    dict.startedAt = Date.now();
    dict.gotResult = false;

    rec.onresult = (e) => {
      if (dict.rec !== rec) return;
      dict.gotResult = true;
      dict.netErrors = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = (r[0] && r[0].transcript) || '';
        if (r.isFinal) commitDictation(t);
        else interim += t;
      }
      dict.interim = interim;
      el.dictInterim.textContent = interim;
    };
    rec.onerror = (e) => {
      const code = e.error;
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        stopDictation();
        toast('Microphone access is blocked. Allow it for this site in your browser’s settings.');
      } else if (code === 'audio-capture') {
        stopDictation();
        toast('No microphone was found.');
      } else if (code === 'language-not-supported') {
        stopDictation();
        toast('Dictation doesn’t support that language here. Pick another in Settings.');
      } else if (code === 'network') {
        dict.netErrors++;
        if (dict.netErrors >= 3) {
          stopDictation();
          toast('Dictation needs an internet connection.');
        }
      }
    };
    rec.onend = () => {
      if (dict.interim) {
        commitDictation(dict.interim);
        dict.interim = '';
        el.dictInterim.textContent = '';
      }
      if (!dict.on || dict.rec !== rec) {
        finishDictationUI();
        return;
      }
      const quick = Date.now() - dict.startedAt < 1000 && !dict.gotResult;
      dict.quickEnds = quick ? dict.quickEnds + 1 : 0;
      if (dict.quickEnds >= 6) {
        stopDictation();
        toast('Dictation keeps stopping. Check the microphone and your connection, then try again.');
        return;
      }
      setTimeout(beginSession, quick ? 400 : 120);
    };

    try {
      rec.start();
    } catch (e) {
      setTimeout(beginSession, 500);
    }
  }

  // Keeps the words heard so far and ignores anything the engine sends afterwards,
  // so stopping never loses the last phrase and never duplicates it.
  function stopDictation() {
    if (!dict.on) return;
    dict.on = false;
    const rec = dict.rec;
    dict.rec = null;
    wake.want('dictate', false);
    if (dict.interim) {
      commitDictation(dict.interim);
      dict.interim = '';
    }
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch (e) {
        /* ignore */
      }
    }
    finishDictationUI();
  }

  function finishDictationUI() {
    if (dict.on) return;
    if (sync.dirty) syncSoon(1500); // anything held back while dictating
    el.dictation.hidden = true;
    el.dictInterim.textContent = '';
    el.dictateBtn.setAttribute('aria-pressed', 'false');
    el.dictateBtn.lastChild.textContent = 'Dictate';
  }

  function commitDictation(raw) {
    let t = String(raw || '').trim();
    if (!t || !state.current) return;
    const now = Date.now();
    if (t === dict.lastFinal && now - dict.lastFinalAt < 2500) return; // duplicate final result
    dict.lastFinal = t;
    dict.lastFinalAt = now;
    if (state.settings.spokenPunct) t = Core.applySpokenPunctuation(t);
    const ta = el.editor;
    if (ta.value !== state.current.text) ta.value = state.current.text;
    const s = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
    const e = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : s;
    const piece = Core.formatInsert(ta.value.slice(Math.max(0, s - 200), s), t, ta.value.slice(e, e + 5));
    if (!piece) return;
    const atEnd = e >= ta.value.length;
    ta.setRangeText(piece, s, e, 'end');
    onEditorInput();
    if (atEnd) ta.scrollTop = ta.scrollHeight;
  }

  /* ================= editing, pasting, files ================= */

  const editing = { lastAt: 0, composing: false };

  function onEditorInput() {
    const doc = state.current;
    if (!doc) return;
    editing.lastAt = Date.now();
    doc.text = el.editor.value;
    doc.updatedAt = Date.now();
    if (!doc.titleLocked) {
      doc.title = Core.deriveTitle(doc.text);
      renderTitle();
    }
    touch(doc, true);
    state.dirty = true;
    scheduleSave(doc);
    renderLibrarySoon();
  }

  async function readClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText();
    } catch (e) {
      /* permission denied or unsupported */
    }
    return null;
  }

  function insertIntoEditor(text) {
    const ta = el.editor;
    const s = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
    const e = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : s;
    let piece = text;
    if (s === ta.value.length && s > 0 && !/\n\s*$/.test(ta.value)) piece = '\n\n' + piece;
    ta.setRangeText(piece, s, e, 'end');
    onEditorInput();
  }

  async function pasteIntoEditor() {
    const text = await readClipboard();
    if (text == null) {
      el.editor.focus();
      toast('Long-press in the text box and choose Paste.');
      return;
    }
    if (!text.trim()) {
      toast('The clipboard is empty. Copy some text first.');
      return;
    }
    insertIntoEditor(Core.normalizeText(text));
  }

  async function pasteAndPlay() {
    const text = await readClipboard();
    if (text == null) {
      newDoc();
      toast('Long-press in the text box and choose Paste.');
      return;
    }
    if (!text.trim()) {
      toast('The clipboard is empty. Copy some text first.');
      return;
    }
    addTextAndPlay(text);
  }

  function addTextAndPlay(text, title) {
    const doc = createDoc(Core.normalizeText(text), title);
    openDoc(doc.id, { mode: 'listen' });
    closeDrawer();
    play(0);
  }


  /* ---------- opening files (readkit extract) ---------- */

  // PDFs (scans too, with or without the scanner's hidden text layer), photos and
  // screenshots, Word, OpenDocument, PowerPoint, EPUB, RTF, web pages, Markdown and text all
  // become one Doc; its text without running heads, page numbers, footnotes and margin notes
  // (unless Settings keeps those notes) is what Readout stores.
  let fileNote = ''; // replaces the usual "Ready" message after opening a file

  const isPictureFile = (f) => /^image\//.test(f.type || '') || /\.(png|jpe?g|jfif|webp|gif|bmp|avif|heic)$/i.test(f.name || '');

  function textFromDoc(doc) {
    const notes = state.settings.includeNotes ? new Set(['margin', 'footnote']) : null;
    const blocks = (doc.blocks || []).filter((b) => b && b.text && (!b.skip || (notes && notes.has(b.skip))));
    return kit.K.docToText(blocks, { keepSkipped: true });
  }

  // The file's own name, unless a camera, phone or scanner made it up ("IMG_2031.jpg",
  // "scan0001.pdf"): then the title readkit found inside.
  function fileTitle(name, docTitle) {
    const base = String(name || '')
      .replace(/^.*[\\/]/, '')
      .replace(/\.[^.]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (base && !(kit.autoName && kit.autoName(name))) return base;
    return String(docTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120) || base;
  }

  // Asks once before the first OCR download; after a yes, scanned files just open.
  function askOcr(what, bytes) {
    if (state.settings.ocrOk) return Promise.resolve(true);
    hideToast();
    el.ocrWhat.textContent = what;
    el.ocrSize.textContent = fmtMB(bytes || 7 * MB);
    openSheet(el.ocrSheet);
    return new Promise((resolve) => {
      const finish = (ok) => {
        el.ocrSheet.removeEventListener('close', onClose);
        el.ocrYesBtn.removeEventListener('click', onYes);
        if (ok) {
          state.settings.ocrOk = true;
          saveSettings();
        }
        closeSheet(el.ocrSheet);
        resolve(ok);
      };
      const onYes = () => finish(true);
      const onClose = () => finish(false);
      el.ocrSheet.addEventListener('close', onClose);
      el.ocrYesBtn.addEventListener('click', onYes);
    });
  }

  // Progress in the toast, with Stop.
  function fileProgress(job, p, name) {
    if (job.ctrl.signal.aborted || el.ocrSheet.open) return;
    const page = /scanned page (\d+)/.exec((p && p.message) || '');
    if (page) {
      job.ocrIndex = (p.done || 0) + 1;
      job.ocrPages = p.total || 0;
    }
    let msg;
    if (p.stage === 'ocr-load' || p.stage === 'load' || p.stage === 'download') msg = 'Getting ready to read the pictures…';
    else if (p.stage === 'ocr' || p.stage === 'parse') {
      if (job.ocrPages > 1) msg = `Reading the text in page ${Math.min(job.ocrIndex, job.ocrPages)} of ${job.ocrPages}…`;
      else msg = job.picture ? 'Reading the text in the picture…' : 'Reading the text in the page…';
    } else if (p.stage === 'pdf' && p.total > 4 && p.done < p.total) msg = `Reading the PDF, page ${p.done + 1} of ${p.total}…`;
    else msg = `Opening “${name}”…`;
    toast(msg, { sticky: true, action: 'Stop', onAction: () => job.ctrl.abort() });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    el.fileInput.value = '';
    fileNote = '';
    if (!files.length) return;
    if (!kit.K) {
      toast(kit.failed ? 'Opening files didn’t load. Reload Readout to try again.' : 'Readout is still starting. Try again in a moment.');
      return;
    }
    let last = null;
    let added = 0;
    for (const f of files) {
      const job = { ctrl: new AbortController(), picture: isPictureFile(f), asked: false, declined: false, ocrIndex: 0, ocrPages: 0 };
      const blocks = [];
      let doc = null;
      let stopped = false;
      wake.want('file', true); // a locked phone pauses the page
      try {
        toast(`Opening “${f.name}”…`, { sticky: true, action: 'Stop', onAction: () => job.ctrl.abort() });
        try {
          doc = await kit.K.extract(f, {
            name: f.name,
            dialect: accent(),
            signal: job.ctrl.signal,
            allowOcr: async ({ bytes }) => {
              job.asked = true;
              const ok = await askOcr(job.picture ? `“${f.name}” is a picture` : `“${f.name}” is scanned pages`, bytes);
              job.declined = !ok;
              if (ok) fileProgress(job, { stage: 'ocr-load' }, f.name);
              return ok;
            },
            onProgress: (p) => p && fileProgress(job, p, f.name),
            onBlock: (b) => blocks.push(b),
          });
        } catch (e) {
          if (!isAbort(e)) throw e;
          // Stop keeps what was read so far.
          stopped = true;
          doc = { blocks, warnings: [], title: '' };
        }
        hideToast();
        const text = Core.normalizeText(textFromDoc(doc)).trim();
        const warnings = doc.warnings || [];
        if (!text) {
          const w = warnings.find((x) => x.type === 'unsupported' || x.type === 'drm');
          const ocrFailed = job.asked && !job.declined && warnings.some((x) => x.type === 'ocr-unavailable');
          toast(
            stopped
              ? `Stopped before any text of “${f.name}” was read.`
              : w
                ? w.text
                : ocrFailed
                  ? `Couldn’t read the pictures in “${f.name}”.${navigator.onLine === false ? ' Reading pictures needs a connection the first time.' : ''}`
                  : `No text to read in “${f.name}”.`
          );
          continue;
        }
        if (stopped) fileNote = 'Stopped. The pages read so far are here.';
        else if (!job.declined && warnings.some((w) => w.type === 'ocr-unavailable')) fileNote = 'Couldn’t read the pictures in this PDF, so only its text is here.';
        const title = fileTitle(f.name, doc.title);
        const cur = state.current;
        if (cur && files.length === 1 && !cur.text.trim()) {
          cur.text = text;
          cur.title = title || Core.deriveTitle(text);
          cur.titleLocked = !!title;
          cur.updatedAt = cur.titleAt = Date.now();
          touch(cur, true);
          scheduleSave(cur);
          last = cur;
        } else {
          last = createDoc(text, title);
        }
        added++;
      } catch (e) {
        console.warn('Readout file error', e);
        hideToast();
        toast(e && e.user ? e.user : `Couldn’t open “${f.name}”.${navigator.onLine === false ? ' Opening a PDF or picture needs a connection the first time.' : ''}`);
      } finally {
        wake.want('file', false);
      }
    }
    if (last) {
      flushDocs();
      openDoc(last.id, { mode: 'listen' });
      closeDrawer();
      toast(added > 1 ? `Added ${added} files.` : fileNote || 'Ready. Press play to listen.');
    }
  }

  /* ---------- the Android share sheet ---------- */

  function addSharedText(body, title) {
    if (/^https?:\/\/\S+$/i.test(body)) {
      toast('Readout got a link, not the page’s text. Select the text on the page and share that instead.');
      return false;
    }
    const doc = createDoc(Core.normalizeText(body), title && title !== body ? title : '');
    openDoc(doc.id, { mode: 'listen' });
    toast('Added. Press play to listen.');
    return true;
  }

  // Files and text shared to Readout: sw.js kept them in Cache Storage and opened ./?shared=1.
  async function openShared() {
    try {
      const cache = await caches.open('readout-share');
      const res = await cache.match(new URL('shared/meta.json', location.href).href);
      const meta = res ? await res.json() : null;
      const files = [];
      for (const f of (meta && meta.files) || []) {
        const r = await cache.match(f.key);
        if (r) files.push(new File([await r.blob()], f.name, { type: f.type || r.headers.get('Content-Type') || '' }));
      }
      for (const k of await cache.keys()) await cache.delete(k);
      if (files.length) {
        await handleFiles(files);
        return;
      }
      const body = ((meta && meta.text) || '').trim() || ((meta && meta.url) || '').trim();
      if (body) {
        addSharedText(body, ((meta && meta.title) || '').trim());
        return;
      }
    } catch (e) {
      console.warn('Readout: reading what was shared', e);
    }
    toast('Nothing came through from the share. Try sharing again.');
  }

  /* ================= more menu: copy, share, export ================= */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e2) {
        /* ignore */
      }
      ta.remove();
      return ok;
    }
  }

  async function shareDoc(doc) {
    if (navigator.share) {
      try {
        await navigator.share({ title: doc.title, text: doc.text });
      } catch (e) {
        if (e && e.name !== 'AbortError') {
          const ok = await copyText(doc.text);
          toast(ok ? 'Couldn’t open the share menu, so the text was copied instead.' : 'Couldn’t share this text.');
        }
      }
      return;
    }
    const ok = await copyText(doc.text);
    toast(ok ? 'Sharing isn’t available here, so the text was copied instead.' : 'Couldn’t share this text.');
  }

  function download(filename, text, type) {
    const blob = typeof Blob !== 'undefined' && text instanceof Blob ? text : new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function fileName(title, ext) {
    const base = String(title || 'readout')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return (base || 'readout') + '.' + ext;
  }

  function reflowDoc(doc) {
    const before = doc.text;
    const after = Core.reflow(before);
    if (after === before || after === before.trim()) {
      toast('The line breaks already look clean.');
      return;
    }
    applyDocText(doc, after);
    toast('Cleaned up line breaks.', { action: 'Undo', onAction: () => applyDocText(doc, before) });
  }

  async function onMoreAction(act) {
    const doc = state.current;
    closeSheet(el.moreSheet);
    if (!doc) return;
    if (act === 'copy') {
      toast((await copyText(doc.text)) ? 'Copied.' : 'Couldn’t copy. Select the text and copy it yourself.');
    } else if (act === 'share') {
      shareDoc(doc);
    } else if (act === 'txt') {
      download(fileName(doc.title, 'txt'), doc.text);
    } else if (act === 'md') {
      const body = /^\s*#/.test(doc.text) ? doc.text : `# ${doc.title}\n\n${doc.text}`;
      download(fileName(doc.title, 'md'), body, 'text/markdown;charset=utf-8');
    } else if (act === 'reflow') {
      reflowDoc(doc);
    } else if (act === 'chapters') {
      openChapters();
    } else if (act === 'audio') {
      saveAudio(doc);
    } else if (act === 'restart') {
      pausePlayback();
      if (state.mode !== 'listen') setMode('listen');
      seekTo(0);
      highlightChunk(0, { scroll: false });
      el.stage.scrollTo({ top: 0 });
      savePositionNow();
    } else if (act === 'pin') {
      doc.pinned = !doc.pinned;
      doc.pinAt = Date.now();
      touch(doc, false);
      scheduleSave(doc);
      renderLibrary();
      toast(doc.pinned ? 'Pinned to the top.' : 'Unpinned.');
    } else if (act === 'delete') {
      deleteDoc(doc.id);
    }
  }

  // Save audio: the text's audio as an Ogg file, from what the natural or standard voice has
  // read aloud so far (readkit keeps each sentence it makes in a cache on this device).
  async function saveAudio(doc) {
    const eng = chooseEngine();
    if (eng.kind !== 'audio') {
      toast('Save audio works with the natural and standard voices. Pick one under Speed and voice.');
      return;
    }
    if (!state.segs.length) return;
    toast('Collecting the audio…', { sticky: true });
    try {
      const [V, P, C] = await Promise.all([voiceModule(), playerModule(), import('./readkit/src/audio/clipstore.js')]);
      const entry = V.findVoice(eng.id);
      const clips = C.openClipStore();
      try {
        const now = au.player && au.voice && au.voice.id === eng.id ? au.player.generatedSpeed : P.snapSpeed(audioRate());
        const speeds = [...new Set([now, P.snapSpeed(audioRate()), 1, ...P.SPEEDS])];
        let best = null;
        for (const speed of speeds) {
          const keys = await C.segmentKeys(state.segs, { engine: entry.engine, revision: entry.revision, voice: eng.id, speed });
          let have = 0;
          for (const k of keys) if (await clips.has(k)) have++;
          if (!best || have > best.have) best = { speed, keys, have };
          if (have === keys.length) break;
        }
        hideToast();
        if (!best || !best.have) {
          toast(`Nothing to save yet. Readout keeps the audio of what ${entry.name} has read aloud, so listen to this text first.`);
          return;
        }
        const out = await clips.exportOgg(best.keys, { tags: { title: doc.title, artist: 'Readout' } });
        download(fileName(doc.title, 'ogg'), out && out.blob ? out.blob : out);
        const n = best.keys.length;
        toast(best.have < n ? `Saved the audio of the ${best.have} of ${n} sentences read aloud so far.` : 'Saved the audio of the whole text.');
      } finally {
        clips.close();
      }
    } catch (e) {
      console.warn('Readout: save audio', e);
      hideToast();
      toast('Couldn’t save the audio.');
    }
  }

  /* ================= backup ================= */

  function exportAll() {
    flushDocs();
    const data = {
      app: 'readout',
      version: 1,
      exportedAt: new Date().toISOString(),
      docs: state.docs,
      positions: [...state.positions.values()],
    };
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    download(`readout-backup-${stamp}.json`, JSON.stringify(data, null, 1), 'application/json');
    const n = state.docs.length;
    toast(`Exported ${n} ${n === 1 ? 'text' : 'texts'}.`);
  }

  async function importBackup(file) {
    el.backupInput.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      data = null;
    }
    if (!data || data.app !== 'readout' || !Array.isArray(data.docs)) {
      toast('That file isn’t a Readout backup.');
      return;
    }
    const before = new Set(state.docs);
    const prev = new Map(state.docs.map((d) => [d.id, d]));
    const r = Core.mergeDocs(state.docs, data.docs);
    state.docs = r.docs;
    for (const d of state.docs) {
      if (before.has(d)) continue;
      Core.seedVV(d);
      // Restoring a deleted text, or replacing this device's copy, counts as a new
      // change made here, so sync spreads it instead of undoing it.
      const tomb = sync.tombs[d.id];
      const old = prev.get(d.id);
      if (tomb || old) {
        d.vv = Core.maxVV(Core.maxVV(d.vv, tomb && tomb.vv), old && old.vv);
        d.tv = Core.maxVV(d.tv, old && old.tv);
        if (tomb) {
          delete sync.tombs[d.id];
          saveTombs();
        }
        touch(d, true);
      }
      store.putDoc(d).catch(onStoreError);
    }
    syncSoon();
    for (const p of data.positions || []) {
      if (!p || typeof p.id !== 'string' || !state.docs.some((d) => d.id === p.id)) continue;
      const cur = state.positions.get(p.id);
      if (!cur || (p.at || 0) > (cur.at || 0)) {
        state.positions.set(p.id, p);
        store.putPos(p).catch(onStoreError);
      }
    }
    const curId = state.current && state.current.id;
    const replaced = curId && !state.docs.includes(state.current);
    if (replaced) openDoc(curId);
    else if (!state.current && state.docs.length) openNextOrWelcome();
    renderLibrary();
    const parts = [];
    if (r.added) parts.push(`${r.added} new ${r.added === 1 ? 'text' : 'texts'}`);
    if (r.updated) parts.push(`${r.updated} updated`);
    toast(parts.length ? `Imported ${parts.join(' and ')}.` : 'Everything in that backup is already here.');
  }

  /* ================= sync ================= */

  // Texts sync through a secret gist on the user's GitHub account. Each sync reads
  // the gist, merges it with this device (Core.mergeSync), keeps the result here,
  // and writes back only the files that changed.
  const SYNC_MAX_TEXT = 3000000;
  const TOMB_DAYS = 180;
  const GIST_DESC = 'Readout sync. Readout keeps your texts here and updates this gist itself, so please don’t edit it.';
  const TOKEN_URL =
    'https://github.com/settings/personal-access-tokens/new?name=Readout+sync&description=Lets+Readout+sync+your+texts+through+a+secret+gist.&expires_in=none&gists=write';
  const STOPPED = new Set(['auth', 'denied', 'missing', 'newer']); // need the user before trying again

  const sync = {
    device: '',
    cfg: null, // { token, gistId, login }
    tombs: {}, // deleted docs: { id: { at, vv } }
    remote: null, // { etag, files } as last read from the gist
    raw: new Map(), // full copies of files over 1 MB, by their versioned URL
    running: null,
    again: false,
    timer: null,
    due: 0,
    dirty: false,
    lastOk: 0,
    lastTry: 0,
    error: '',
    retryAt: 0,
    backoff: 0,
    skipped: 0,
    pending: null, // a token waiting for "start syncing from this device"
    shown: new Set(),
  };

  function saveTombs() {
    store.set('tombs', sync.tombs).catch(onStoreError);
  }

  function syncError(kind, extra) {
    const e = new Error('sync ' + kind);
    e.kind = kind;
    return Object.assign(e, extra);
  }

  // One GitHub API call. Resolves to { status, headers, data } with the JSON body already read.
  async function gh(token, method, path, body, etag) {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2026-03-10',
    };
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-None-Match'] = etag;
    // no-store with our own If-None-Match: never a stale cached copy, and unchanged checks are free.
    const res = await fetchPatiently(CONFIG.githubApi + path, { method, headers, body: payload, cache: 'no-store' }, payload ? payload.length : 0);
    let data = null;
    if (res.status !== 304) {
      const text = await res.read();
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        if (res.ok) throw syncError('server');
      }
    }
    const out = { status: res.status, headers: res.headers, data };
    if (res.ok || res.status === 304) return out;
    const h = (k) => res.headers.get(k);
    const message = String((data && data.message) || '');
    if (res.status === 401) throw syncError('auth');
    if (res.status === 429 || ((res.status === 403 || res.status === 422) && (h('retry-after') || h('x-ratelimit-remaining') === '0' || /rate limit|spammed|abuse/i.test(message)))) {
      const wait = Number(h('retry-after')) * 1000 || (Number(h('x-ratelimit-reset')) * 1000 || 0) - Date.now();
      throw syncError('busy', { retryAt: Date.now() + Math.max(60000, wait || 0) });
    }
    if (res.status === 403) throw syncError('denied');
    if (res.status === 404) throw syncError(method === 'GET' ? 'missing' : 'denied'); // GitHub hides missing permissions as 404
    throw syncError('server');
  }

  // fetch() that gives up on a dead connection without cutting off slow ones: it
  // waits longer for big uploads, and once the reply starts, only a stall ends it.
  // Returns the Response with a read() that resolves to its text.
  async function fetchPatiently(url, init, uploadSize) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), CONFIG.netWait + (uploadSize || 0) / 5);
    let res;
    try {
      res = await fetch(url, Object.assign({}, init, ctrl ? { signal: ctrl.signal } : null));
    } catch (e) {
      throw syncError('offline');
    } finally {
      clearTimeout(timer);
    }
    res.read = async () => {
      if (!ctrl || !res.body || !res.body.getReader) return res.text().catch(() => Promise.reject(syncError('offline')));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = '';
      let stall = null;
      const wait = () => {
        clearTimeout(stall);
        stall = setTimeout(() => ctrl.abort(), CONFIG.netStall);
      };
      try {
        wait();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          wait();
          text += dec.decode(value, { stream: true });
        }
        return text + dec.decode();
      } catch (e) {
        throw syncError('offline');
      } finally {
        clearTimeout(stall);
      }
    };
    return res;
  }

  // Our files from a gist (an API response body). Files over 1 MB come back cut
  // short, so those are fetched in full. Their URLs name the exact version, so
  // unchanged ones are reused, and each one is kept as soon as it arrives.
  async function readGist(g) {
    const files = {};
    const urls = new Set();
    for (const f of Object.values((g && g.files) || {})) {
      if (!f || !Core.isSyncFile(f.filename)) continue;
      let text = typeof f.content === 'string' && !f.truncated ? f.content : null;
      if (text == null && f.raw_url) {
        urls.add(f.raw_url);
        text = sync.raw.get(f.raw_url);
        if (text == null) {
          const r = await fetchPatiently(f.raw_url, {}); // a plain request: raw_url refuses custom headers
          if (!r.ok) throw syncError('server');
          text = await r.read();
          sync.raw.set(f.raw_url, text);
        }
      }
      if (text == null) throw syncError('server');
      files[f.filename] = text;
    }
    for (const u of [...sync.raw.keys()]) if (!urls.has(u)) sync.raw.delete(u);
    return { id: g && g.id, owner: (g && g.owner && g.owner.login) || '', files };
  }

  // How much the current doc must stay put: 'busy' while the user types, dictates,
  // or listens (nothing from elsewhere is applied to it), 'open' in an idle editor
  // (plain updates show up, but a clash waits so the text being edited isn't swapped).
  function holdKind() {
    if (!state.current) return null;
    if (tts.playing || dict.on) return 'busy';
    if (state.mode !== 'edit' || document.activeElement !== el.editor) return null;
    return document.hasFocus() && (editing.composing || Date.now() - editing.lastAt < 10000) ? 'busy' : 'open';
  }

  async function runSync() {
    const cfg = sync.cfg;
    flushDocs();
    let remote = sync.remote;
    const res = await gh(cfg.token, 'GET', '/gists/' + cfg.gistId, null, remote && remote.etag);
    if (res.status !== 304 || !remote) remote = { etag: res.headers.get('ETag'), files: (await readGist(res.data)).files };
    if (sync.cfg !== cfg) return;
    const theirs = Core.parseSyncFiles(remote.files);
    if (theirs.newer) throw syncError('newer');
    if (theirs.bad.length) console.warn('Readout sync: unreadable files replaced', theirs.bad);

    const hold = holdKind();
    const cur = state.current;
    const docs = [];
    let skipped = 0;
    let held = false;
    for (const d of state.docs) {
      if (!d.text.trim()) continue;
      if (d.text.length > SYNC_MAX_TEXT) {
        skipped++;
        continue;
      }
      if (hold && d === cur) {
        // Something new for this doc arrived from elsewhere: hold both sides until the user is done.
        const r = theirs.docs.find((x) => x && x.id === d.id);
        const c = r && Core.compareVV(Core.syncDoc(d).vv, Core.syncDoc(r).vv);
        if (r && (c === 2 || (c === -1 && hold === 'busy'))) {
          docs.push(r);
          held = true;
          sync.dirty = true;
          continue;
        }
      }
      docs.push(d);
    }
    sync.skipped = skipped;
    const now = Date.now();
    const prefs = state.settings.lexiconAt ? { lexicon: state.settings.lexicon, at: state.settings.lexiconAt } : null;
    const m = Core.mergeSync({ docs, positions: [...state.positions.values()], tombs: sync.tombs, prefs }, theirs, {
      pruneBefore: now - TOMB_DAYS * 86400000,
      maxText: SYNC_MAX_TEXT,
    });
    applySynced(m, held || hold === 'busy' ? cur : null);

    const patch = Core.diffSyncFiles(Core.buildSyncFiles(m), remote.files);
    if (patch) {
      const res2 = await gh(cfg.token, 'PATCH', '/gists/' + cfg.gistId, { files: patch });
      remote = { etag: res2.headers.get('ETag'), files: (await readGist(res2.data)).files };
    }
    if (sync.cfg !== cfg) return;
    sync.remote = remote;
    sync.lastOk = Date.now();
    sync.error = '';
    sync.backoff = 0;
    store.set('sync', Object.assign({}, cfg, { lastOk: sync.lastOk })).catch(() => {});
    return held && hold === 'busy' && !tts.playing && !dict.on; // typing that will pause on its own
  }

  // Brings this device in line with a merge result.
  function applySynced(m, busy) {
    const cur = state.current;
    const local = new Map(state.docs.map((d) => [d.id, d]));
    const merged = new Map(m.docs.map((d) => [d.id, d]));
    let changed = false;
    let curText = false;
    let curGone = null;
    for (const d of m.docs) {
      const mine = local.get(d.id);
      // Busy, emptied, or too-long docs stay as they are here; the merge left them out.
      if (mine && (mine === busy || !mine.text.trim() || mine.text.length > SYNC_MAX_TEXT)) continue;
      if (!mine) {
        const nd = Object.assign({}, d);
        state.docs.push(nd);
        store.putDoc(nd).catch(onStoreError);
        changed = true;
      } else if (JSON.stringify(Core.syncDoc(mine)) !== JSON.stringify(d)) {
        if (mine === cur && mine.text !== d.text) curText = true;
        Object.assign(mine, d);
        pendingDocs.delete(mine.id);
        store.putDoc(mine).catch(onStoreError);
        changed = true;
      }
    }
    for (const mine of state.docs.slice()) {
      if (merged.has(mine.id) || mine === busy || !mine.text.trim() || mine.text.length > SYNC_MAX_TEXT) continue;
      if (mine === cur) curGone = mine;
      removeDocLocally(mine);
      changed = true;
    }
    let curMoved = false;
    for (const p of m.positions) {
      const mine = state.positions.get(p.id);
      if (mine && (mine.at || 0) >= p.at) continue;
      if (busy && busy.id === p.id) continue;
      state.positions.set(p.id, p);
      mirrorPosition(p);
      store.putPos(p).catch(onStoreError);
      if (cur && cur.id === p.id) curMoved = true;
      changed = true;
    }
    sync.tombs = m.tombs;
    saveTombs();
    // The pronunciation list from another device.
    let lexChanged = false;
    if (m.prefs && m.prefs.at > (state.settings.lexiconAt || 0)) {
      state.settings.lexicon = m.prefs.lexicon;
      state.settings.lexiconAt = m.prefs.at;
      saveSettings();
      if (el.settingsSheet.open) renderLexicon();
      lexChanged = true;
    }

    if (curGone) {
      state.current = null;
      openNextOrWelcome();
      toast(`“${curGone.title}” was deleted on another device.`);
    } else if (cur && (curText || curMoved) && state.current === cur) {
      if (curText) rebuildSegments();
      if (!tts.playing) {
        placeAtSaved(cur);
        if (au.player) dropPlayer(); // a paused player would resume at the old place
      }
      if (state.mode === 'edit') {
        if (curText) {
          const ta = el.editor;
          const s = ta.selectionStart;
          const e = ta.selectionEnd;
          ta.value = cur.text;
          if (document.activeElement === ta) ta.setSelectionRange(Math.min(s, ta.value.length), Math.min(e, ta.value.length));
        }
      } else if (!tts.playing) {
        renderReader();
        if (spans[curSpan]) scrollToSpan(spans[curSpan], true, 'auto');
      }
      renderView();
    }
    if (lexChanged && !tts.playing && state.current && !curGone) replanCurrent();
    if (changed) {
      renderTitle();
      renderLibrary();
    }
    if (m.copies.length) {
      toast(m.copies.length === 1 ? 'A text was changed on two devices at once, so Readout kept both versions.' : `${m.copies.length} texts were changed on two devices at once, so Readout kept both versions of each.`);
    }
  }

  function syncNow(manual) {
    if (!sync.cfg) return Promise.resolve();
    clearTimeout(sync.timer);
    sync.timer = null;
    sync.due = 0;
    if (sync.running) {
      sync.again = true;
      return sync.running;
    }
    if (!manual && (STOPPED.has(sync.error) || Date.now() < sync.retryAt)) {
      if (!STOPPED.has(sync.error)) sync.timer = setTimeout(syncNow, sync.retryAt - Date.now());
      return Promise.resolve();
    }
    renderSyncStatus(true);
    sync.running = (async () => {
      let held = false;
      try {
        do {
          sync.again = false;
          sync.dirty = false;
          sync.lastTry = Date.now();
          held = await runSync();
        } while (sync.again && sync.cfg);
        // Typing that waited for a change from elsewhere is looked at again once the typing pauses.
        if (held) syncSoon(Math.max(500, editing.lastAt + 10500 - Date.now()));
      } catch (e) {
        sync.dirty = true;
        onSyncError(e);
      } finally {
        sync.running = null;
        renderSyncStatus();
      }
    })();
    return sync.running;
  }

  // Waits for a pause in changes before syncing, but never more than 20 s, or a
  // minute while typing (Done and leaving the app sync right away). Each write
  // downloads the whole gist back, so fewer writes save phone data.
  function syncSoon(ms) {
    sync.dirty = true;
    if (!sync.cfg) return;
    const now = Date.now();
    const typing = state.mode === 'edit' && document.activeElement === el.editor;
    if (!sync.due) sync.due = now + (typing ? 60000 : 20000);
    clearTimeout(sync.timer);
    sync.timer = setTimeout(syncNow, Math.max(0, Math.min(now + (ms != null ? ms : typing ? 8000 : 4000), sync.due) - now));
  }

  function onSyncError(e) {
    const kind = (e && e.kind) || 'server';
    if (!e || !e.kind) console.warn('Readout sync error', e);
    sync.error = kind;
    if (kind === 'busy') sync.retryAt = e.retryAt;
    else if (kind === 'offline' || kind === 'server') {
      sync.backoff = Math.min(600000, sync.backoff ? sync.backoff * 2 : 30000);
      sync.retryAt = Date.now() + sync.backoff;
      sync.timer = setTimeout(syncNow, sync.backoff);
    }
    if (kind === 'missing') sync.remote = null;
    if (kind === 'denied') store.set('lastGistId', null).catch(() => {});
    if (STOPPED.has(kind) && !sync.shown.has(kind)) {
      sync.shown.add(kind);
      toast(syncMessage() + ' See Settings.');
    }
  }

  function syncMessage() {
    switch (sync.error) {
      case 'auth':
        return 'Sync stopped: GitHub no longer accepts the token. It may have expired or been deleted.';
      case 'denied':
        return 'Sync stopped: the token isn’t allowed to change gists.';
      case 'missing':
        return 'Sync stopped: the sync gist was deleted on GitHub.';
      case 'newer':
        return 'Another device synced with a newer version of Readout. Reload this page to update.';
      case 'busy':
        return 'GitHub asked Readout to slow down. It will try again in a minute.';
      case 'offline':
        return 'Offline. Readout will sync when you’re back online.';
      case 'server':
        return 'Couldn’t reach GitHub just now. Readout will try again.';
      default:
        return '';
    }
  }

  async function findSyncGist(token) {
    let best = null;
    for (let page = 1; page <= 5; page++) {
      const res = await gh(token, 'GET', `/gists?per_page=100&page=${page}`);
      const list = res.data;
      if (!Array.isArray(list) || !list.length) break;
      for (const g of list) {
        if (g && g.files && g.files[Core.SYNC_INDEX] && (!best || g.updated_at > best.updated_at)) best = g;
      }
      if (list.length < 100) break;
    }
    return best ? best.id : null;
  }

  // Whether a gist is a Readout sync gist, and whose it is.
  async function isSyncGist(token, id) {
    const g = await readGist((await gh(token, 'GET', '/gists/' + id)).data);
    return { ok: !!g.files[Core.SYNC_INDEX], owner: g.owner };
  }

  function setSyncMsg(text) {
    el.syncSetupMsg.textContent = text || '';
  }

  async function connectSync() {
    const key = Core.parseSyncKey(el.syncInput.value);
    if (!key) {
      setSyncMsg('That doesn’t look like a GitHub token or a Readout sync key. Tokens start with “github_pat_”.');
      return;
    }
    el.syncConnectBtn.disabled = true;
    setSyncMsg('Connecting…');
    sync.pending = null;
    renderSync();
    try {
      let login = '';
      const me = await gh(key.token, 'GET', '/user').catch((e) => {
        if (e.kind === 'auth' || e.kind === 'offline') throw e;
        return null; // a token limited to gists may not be allowed to read the profile
      });
      if (me) login = (me.data || {}).login || '';
      let gistId = key.gistId;
      if (gistId) {
        if (!(await isSyncGist(key.token, gistId)).ok) throw syncError('notours');
      } else {
        // A new token for a gist this device used before (say, after the old token
        // expired) rejoins it, if the gist belongs to the same GitHub account.
        const last = await store.get('lastGistId').catch(() => null);
        const g = last ? await isSyncGist(key.token, last).catch(() => null) : null;
        if (g && g.ok && (!login || g.owner.toLowerCase() === login.toLowerCase())) gistId = last;
        else gistId = await findSyncGist(key.token);
      }
      if (!gistId) {
        sync.pending = { token: key.token, login };
        setSyncMsg('');
        renderSync();
        return;
      }
      await startSync({ token: key.token, gistId, login }, false);
    } catch (e) {
      setSyncMsg(connectError(e));
    } finally {
      el.syncConnectBtn.disabled = false;
    }
  }

  function connectError(e) {
    switch (e && e.kind) {
      case 'auth':
        return 'GitHub didn’t accept that token. Check that you copied all of it, or make a new one.';
      case 'offline':
        return 'Couldn’t reach GitHub. Check your connection and try again.';
      case 'missing':
      case 'notours':
        return 'That sync key points to a gist that isn’t there anymore. Copy a fresh key from your other device.';
      case 'denied':
        return 'That token isn’t allowed to use gists. Make a new token with the link above.';
      case 'busy':
        return 'GitHub is busy. Try again in a minute.';
      default:
        console.warn('Readout sync connect error', e);
        return 'Something went wrong talking to GitHub. Try again.';
    }
  }

  async function createSyncGist() {
    const p = sync.pending;
    if (!p) return;
    el.syncCreateBtn.disabled = true;
    try {
      const empty = Core.buildSyncFiles({});
      const res = await gh(p.token, 'POST', '/gists', {
        description: GIST_DESC,
        public: false,
        files: { [Core.SYNC_INDEX]: { content: empty[Core.SYNC_INDEX] } },
      });
      const g = res.data || {};
      await startSync({ token: p.token, gistId: g.id, login: p.login }, true);
    } catch (e) {
      setSyncMsg(connectError(e));
    } finally {
      el.syncCreateBtn.disabled = false;
    }
  }

  async function startSync(cfg, created) {
    sync.cfg = cfg;
    sync.remote = null;
    sync.pending = null;
    sync.error = '';
    sync.retryAt = 0;
    sync.shown.clear();
    el.syncInput.value = '';
    setSyncMsg('');
    await store.set('sync', cfg);
    store.set('lastGistId', cfg.gistId).catch(() => {});
    renderSync();
    await syncNow(true);
    if (sync.error) return;
    toast(created ? 'Sync is on. To add another device, copy the sync key in Settings.' : 'Sync is on. Texts from your other devices are here now.');
  }

  function stopSync() {
    clearTimeout(sync.timer);
    sync.cfg = null;
    sync.remote = null;
    sync.error = '';
    sync.pending = null;
    store.set('sync', null).catch(onStoreError);
    renderSync();
    toast('Sync is off on this device. Your texts stay here.');
  }

  async function copySyncKey() {
    if (!sync.cfg) return;
    const ok = await copyText(Core.makeSyncKey(sync.cfg.gistId, sync.cfg.token));
    toast(ok ? 'Sync key copied. Paste it into Readout on your other device.' : 'Couldn’t copy the sync key.');
  }

  function renderSync() {
    if (!el.syncSetup) return;
    const on = !!sync.cfg;
    el.syncSetup.hidden = on;
    el.syncActive.hidden = !on;
    el.syncConfirm.hidden = on || !sync.pending;
    el.syncTokenLink.href = TOKEN_URL;
    renderSyncStatus();
  }

  function renderSyncStatus(working) {
    if (!el.syncStatus || !sync.cfg) return;
    const who = sync.cfg.login ? ` as ${sync.cfg.login}` : '';
    let msg;
    if (working || sync.running) msg = 'Syncing…';
    else if (sync.error) msg = syncMessage();
    else if (sync.lastOk) msg = `Synced with GitHub${who}, ${Core.relativeTime(sync.lastOk)}.`;
    else msg = `Connected to GitHub${who}.`;
    if (sync.skipped) msg += ` ${sync.skipped === 1 ? 'One very long text stays' : sync.skipped + ' very long texts stay'} on this device only.`;
    el.syncStatus.textContent = msg;
    el.syncFixBtn.hidden = !STOPPED.has(sync.error) || sync.error === 'newer';
    el.syncFixBtn.textContent = sync.error === 'missing' ? 'Set up sync again' : 'Use a new token';
  }

  // After a stop that needs the user: start over with the setup steps, keeping the texts.
  async function fixSync() {
    const cfg = sync.cfg;
    const missing = sync.error === 'missing';
    sync.cfg = null;
    sync.error = '';
    sync.remote = null;
    store.set('sync', null).catch(onStoreError);
    if (missing && cfg) {
      // Another device may already have made a new gist; join it rather than starting a second one.
      el.syncFixBtn.disabled = true;
      setSyncMsg('Looking for your sync on GitHub…');
      renderSync();
      const id = await findSyncGist(cfg.token).catch(() => null);
      el.syncFixBtn.disabled = false;
      // The same gist can come back after a passing GitHub error; rejoin it if it's really there.
      if (id && (id !== cfg.gistId || ((await isSyncGist(cfg.token, id).catch(() => null)) || {}).ok)) {
        await startSync({ token: cfg.token, gistId: id, login: cfg.login }, false);
        return;
      }
      setSyncMsg('');
      sync.pending = { token: cfg.token, login: cfg.login };
      renderSync();
      return;
    }
    renderSync();
    el.syncInput.focus();
  }

  /* ================= sheets ================= */

  function openSheet(d) {
    if (typeof d.showModal === 'function') {
      if (!d.open) d.showModal();
    } else d.setAttribute('open', '');
  }

  function closeSheet(d) {
    if (typeof d.close === 'function') {
      if (d.open) d.close();
    } else d.removeAttribute('open');
  }

  function fmtRate(r) {
    return String(Math.round(r * 100) / 100);
  }

  function renderRate() {
    const max = rateMax();
    if (state.settings.rate > max) state.settings.rate = max;
    const r = state.settings.rate;
    el.speedLabel.textContent = fmtRate(r) + '×';
    el.rateReadout.textContent = r.toFixed(2) + '×';
    if (el.rateSlider.max !== String(max) || !el.dialScale.childElementCount) {
      el.rateSlider.max = String(max);
      renderDialScale(max);
    }
    if (document.activeElement !== el.rateSlider) el.rateSlider.value = String(r);
    for (const b of el.rateChips.children) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === r));
      b.hidden = Number(b.dataset.rate) > max;
    }
    el.slowerBtn.disabled = r <= 0.5;
    el.fasterBtn.disabled = r >= max;
    const p = state.settings.pitch;
    if (document.activeElement !== el.pitchSlider) el.pitchSlider.value = String(p);
    el.pitchValue.textContent = Math.abs(p - 1) < 0.001 ? 'Normal' : p < 1 ? `Lower (${p.toFixed(2)})` : `Higher (${p.toFixed(2)})`;
  }

  // Tick labels under the speed dial: 0.5×, 1× and each whole speed up to the maximum.
  function renderDialScale(max) {
    const marks = [0.5, 1];
    for (let x = 2; x <= max; x++) marks.push(x);
    el.dialScale.replaceChildren(
      ...marks.map((m) => {
        const s = document.createElement('span');
        s.textContent = fmtRate(m) + '×';
        s.style.left = ((m - 0.5) / (max - 0.5)) * 100 + '%';
        return s;
      })
    );
  }

  function buildRateChips() {
    const chips = RATE_PRESETS.map((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.rate = String(r);
      b.textContent = fmtRate(r) + '×';
      return b;
    });
    el.rateChips.replaceChildren(...chips);
  }

  // The device voices (Device mode).
  function renderVoiceOptions() {
    const sel = el.voiceSelect;
    if (!sel) return;
    const voices = tts.voices.slice();
    const frag = document.createDocumentFragment();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'System default';
    frag.appendChild(def);
    let names = null;
    try {
      names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
    } catch (e) {
      /* ignore */
    }
    const label = (code) => {
      try {
        return (names && names.of(code)) || code;
      } catch (e) {
        return code;
      }
    };
    const userBase = (navigator.language || 'en').toLowerCase().split('-')[0];
    const groups = new Map();
    for (const v of voices) {
      const base = (Core.normalizeLang(v.lang).split('-')[0] || 'und').toLowerCase();
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(v);
    }
    const keys = [...groups.keys()].sort((a, b) => (b === userBase) - (a === userBase) || label(a).localeCompare(label(b)));
    for (const k of keys) {
      const og = document.createElement('optgroup');
      og.label = label(k);
      for (const v of groups.get(k).sort((a, b) => a.name.localeCompare(b.name))) {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = v.name + (v.localService === false ? ' (online)' : '');
        og.appendChild(o);
      }
      frag.appendChild(og);
    }
    sel.replaceChildren(frag);
    const uri = state.settings.voiceURI;
    sel.value = uri && voices.some((v) => v.voiceURI === uri) ? uri : '';
    if (state.settings.voiceMode !== 'device') return;
    el.voiceHint.textContent = !tts.ok
      ? 'This browser has no speech voices. Open Readout in Chrome.'
      : (IS_ANDROID ? 'For more or better device voices, open your phone’s text-to-speech settings and install voice data for Google’s speech engine. ' : voices.length ? '' : 'Loading voices… ') +
        'The device voice needs the screen on; Natural and Standard keep reading with it off.';
  }

  function repoUrl() {
    const host = location.hostname;
    if (!host.endsWith('.github.io')) return '';
    const owner = host.slice(0, -'.github.io'.length);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    return `https://github.com/${owner}/${repo || host}`;
  }

  function renderSettings() {
    const s = state.settings;
    for (const i of el.themeGroup.querySelectorAll('input')) i.checked = i.value === s.theme;
    for (const i of el.sizeGroup.querySelectorAll('input')) i.checked = i.value === s.size;
    el.followToggle.checked = !!s.follow;
    el.awakeToggle.checked = !!s.keepAwake;
    el.autoNextToggle.checked = !!s.autoNext;
    el.citeToggle.checked = s.skipCitations !== false;
    el.notesToggle.checked = !!s.includeNotes;
    el.punctToggle.checked = !!s.spokenPunct;
    el.localToggle.checked = !!s.dictLocal;
    el.localToggleRow.hidden = !(SR && typeof SR.available === 'function');
    el.dictLang.value = s.dictLang || '';
    const parts = [document.createTextNode(`Readout ${VERSION}. Works best in Chrome. `)];
    const url = repoUrl();
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Source on GitHub';
      parts.push(a);
    }
    if (store.memoryOnly) parts.push(document.createTextNode(' This browser isn’t allowing storage, so texts disappear when you close the page.'));
    el.about.replaceChildren(...parts);
    renderLexicon();
    renderVoiceList();
    refreshVoices();
    renderSync();
  }

  function buildDictLangs() {
    el.dictLang.replaceChildren(
      ...DICT_LANGS.map(([v, l]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = l;
        return o;
      })
    );
  }

  function applyTheme() {
    const root = document.documentElement;
    root.dataset.theme = state.settings.theme;
    root.dataset.size = state.settings.size;
    const dark = state.settings.theme === 'dark' || (state.settings.theme === 'system' && darkScheme.matches);
    if (el.themeColor) el.themeColor.setAttribute('content', dark ? '#131a2b' : '#f6f7f9');
  }

  /* ================= pronunciations ================= */

  function renderLexicon() {
    const list = Core.cleanLexicon(state.settings.lexicon);
    const rows = list.map(([word, say]) => {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 'lx-text';
      const w = document.createElement('b');
      w.textContent = word;
      const arrow = document.createElement('span');
      arrow.className = 'lx-arrow';
      arrow.textContent = '→';
      t.append(w, arrow, document.createTextNode(say));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn';
      b.setAttribute('aria-label', `Remove ${word}`);
      b.appendChild(useIcon('close'));
      b.addEventListener('click', () => setLexicon(list.filter((e) => e[0] !== word)));
      li.append(t, b);
      return li;
    });
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No pronunciations yet.';
      rows.push(li);
    }
    el.lexList.replaceChildren(...rows);
  }

  function setLexicon(list) {
    state.settings.lexicon = Core.cleanLexicon(list);
    state.settings.lexiconAt = Date.now();
    saveSettings();
    renderLexicon();
    replanCurrent();
    syncSoon();
  }

  function addLexicon() {
    const word = el.lexWord.value.trim();
    const say = el.lexSay.value.trim();
    if (!word || !say) {
      el.lexHint.textContent = 'Type the word and how to say it.';
      (word ? el.lexSay : el.lexWord).focus();
      return;
    }
    setLexicon([...Core.cleanLexicon(state.settings.lexicon), [word, say]]);
    el.lexWord.value = '';
    el.lexSay.value = '';
    el.lexHint.textContent = `Readout now says “${word}” as “${say}”.`;
    el.lexWord.focus();
  }

  /* ================= headings ================= */

  function openChapters() {
    const doc = state.current;
    if (!doc) return;
    const hs = Core.headingsOf(state.segs, doc.text);
    let here = -1;
    for (let k = 0; k < hs.length; k++) if (hs[k].index <= state.idx) here = k;
    el.chaptersList.replaceChildren(
      ...hs.map((h, k) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-item' + (k === here ? ' is-here' : '');
        b.dataset.level = String(Math.min(6, h.level));
        b.dataset.index = String(h.index);
        b.textContent = h.title;
        if (k === here) b.setAttribute('aria-current', 'true');
        return b;
      })
    );
    el.chaptersEmpty.hidden = hs.length > 0;
    openSheet(el.chaptersSheet);
    const cur = el.chaptersList.querySelector('.is-here');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }

  /* ================= toast ================= */

  let toastTimer = null;
  let toastHandler = null;
  function toast(msg, opts) {
    const o = opts || {};
    if (!el.toast) return;
    el.toastMsg.textContent = msg;
    toastHandler = o.onAction || null;
    el.toastAction.hidden = !o.action;
    el.toastAction.textContent = o.action || '';
    const shown = !el.toast.hidden;
    el.toast.hidden = false;
    if (!(o.sticky && shown)) {
      el.toast.style.animation = 'none';
      void el.toast.offsetWidth;
      el.toast.style.animation = '';
    }
    clearTimeout(toastTimer);
    if (!o.sticky) toastTimer = setTimeout(hideToast, o.action ? 6500 : 4000);
  }
  function hideToast() {
    el.toast.hidden = true;
    toastHandler = null;
  }

  /* ================= launch: share target, shortcuts ================= */

  function handleLaunchParams() {
    const params = new URLSearchParams(location.search);
    const keys = [...params.keys()].filter((k) => k !== 'local');
    if (!keys.length) return false;
    const action = params.get('action');
    const text = (params.get('text') || '').trim();
    const url = (params.get('url') || '').trim();
    const title = (params.get('title') || '').trim();
    const shared = params.get('shared');
    try {
      const keep = params.get('local') ? '?local=' + encodeURIComponent(params.get('local')) : '';
      history.replaceState(null, '', location.pathname + keep + location.hash);
    } catch (e) {
      /* ignore */
    }
    if (shared) {
      openShared();
      return false;
    }
    const body = text || url;
    if (body) return addSharedText(body, title);
    if (action === 'new' || action === 'dictate') {
      newDoc({ noFocus: action === 'dictate' });
      if (action === 'dictate') toast('Tap Dictate and start talking.');
      return true;
    }
    return false;
  }

  /* ================= events ================= */

  function cacheElements() {
    const ids = [
      'app', 'library', 'scrim', 'main', 'menuBtn', 'docTitle', 'modeBtn', 'moreBtn', 'stage', 'welcome', 'reader',
      'editorWrap', 'editor', 'dictation', 'dictLabel', 'dictInterim', 'dictStopBtn', 'dock', 'player', 'scrub',
      'progressPct', 'playerStatus', 'timeLeft', 'speedBtn', 'speedLabel', 'prevBtn', 'playBtn', 'playIcon', 'nextBtn', 'locateBtn',
      'editTools', 'pasteBtn', 'openBtn', 'dictateBtn', 'fileInput', 'backupInput', 'speedSheet', 'rateReadout',
      'rateSlider', 'dialScale', 'rateChips', 'slowerBtn', 'fasterBtn', 'vmodeGroup', 'accentGroup', 'kitVoiceSelect', 'voiceSelect',
      'previewBtn', 'voiceHint', 'voiceBar', 'voiceBarFill', 'voiceGetBtn', 'voiceGetLabel', 'voiceStopBtn', 'voiceRetryBtn',
      'pitchField', 'pitchSlider', 'pitchValue', 'sleepChips', 'sleepValue', 'moreSheet', 'pinLabel', 'chaptersSheet', 'chaptersList',
      'chaptersEmpty', 'settingsSheet', 'followToggle', 'awakeToggle', 'autoNextToggle', 'citeToggle', 'notesToggle', 'voiceList',
      'lexList', 'lexWord', 'lexSay', 'lexAddBtn', 'lexHint', 'dictLang', 'punctToggle', 'localToggleRow', 'localToggle',
      'exportAllBtn', 'importBtn', 'about', 'toast', 'toastMsg', 'toastAction', 'newBtn', 'search', 'docList', 'docEmpty',
      'installBtn', 'settingsBtn', 'pastePlayBtn', 'welcomeOpenBtn', 'welcomeNoteBtn', 'themeColor', 'themeGroup', 'sizeGroup',
      'syncSetup', 'syncActive', 'syncConfirm', 'syncTokenLink', 'syncInput', 'syncConnectBtn', 'syncSetupMsg', 'syncCreateBtn',
      'syncCancelBtn', 'syncStatus', 'syncNowBtn', 'syncKeyBtn', 'syncOffBtn', 'syncFixBtn', 'ocrSheet', 'ocrWhat', 'ocrSize',
      'ocrYesBtn', 'voiceSheet', 'voiceSheetTitle', 'voiceSheetWhat', 'voiceSheetSize', 'voiceSheetNet', 'voiceSheetSpace',
      'voiceSheetNote', 'voiceSheetYes', 'audio', 'previewAudio',
    ];
    for (const id of ids) el[id] = document.getElementById(id);
  }

  function isTyping(t) {
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function bindEvents() {
    el.menuBtn.addEventListener('click', openDrawer);
    el.scrim.addEventListener('click', closeDrawer);
    el.newBtn.addEventListener('click', () => newDoc());
    el.search.addEventListener('input', () => {
      state.query = el.search.value;
      renderLibrary();
    });
    el.docList.addEventListener('click', (e) => {
      const b = e.target.closest('.doc-item');
      if (!b) return;
      openDoc(b.dataset.id);
      closeDrawer();
    });
    el.settingsBtn.addEventListener('click', () => {
      renderSettings();
      closeDrawer();
      openSheet(el.settingsSheet);
    });

    el.docTitle.addEventListener('input', () => {
      const doc = state.current;
      if (!doc) return;
      const v = el.docTitle.value.trim();
      doc.titleLocked = !!v;
      doc.title = v || Core.deriveTitle(doc.text);
      doc.updatedAt = Date.now();
      doc.titleAt = doc.updatedAt;
      touch(doc, false);
      document.title = `${doc.title} | Readout`;
      scheduleSave(doc);
      renderLibrarySoon();
    });
    el.docTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        el.docTitle.blur();
      }
    });
    el.docTitle.addEventListener('blur', renderTitle);

    el.modeBtn.addEventListener('click', () => {
      if (state.mode === 'edit') setMode('listen');
      else {
        setMode('edit');
        if (desktop.matches) el.editor.focus();
      }
    });
    el.moreBtn.addEventListener('click', () => {
      if (!state.current) return;
      el.pinLabel.textContent = state.current.pinned ? 'Unpin' : 'Pin to top';
      openSheet(el.moreSheet);
    });
    el.moreSheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) onMoreAction(b.dataset.act);
    });
    el.chaptersList.addEventListener('click', (e) => {
      const b = e.target.closest('[data-index]');
      if (!b) return;
      closeSheet(el.chaptersSheet);
      seekTo(Number(b.dataset.index));
    });

    el.reader.addEventListener('click', (e) => {
      const s = e.target.closest('.chunk');
      if (!s) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length > 0) return;
      play(Number(s.dataset.i));
    });

    el.playBtn.addEventListener('click', togglePlay);
    el.prevBtn.addEventListener('click', () => skip(-1));
    el.nextBtn.addEventListener('click', () => skip(1));
    el.locateBtn.addEventListener('click', () => {
      lastManualScroll = 0;
      scrollToSpan(spans[curSpan], true);
    });
    el.speedBtn.addEventListener('click', () => {
      renderRate();
      renderVoicePanel();
      renderSleep();
      openSheet(el.speedSheet);
      refreshVoices();
    });

    const startScrub = () => (scrubbing = true);
    el.scrub.addEventListener('pointerdown', startScrub);
    el.scrub.addEventListener('touchstart', startScrub, { passive: true });
    el.scrub.addEventListener('input', () => {
      scrubbing = true;
      const n = state.segs.length;
      const i = Number(el.scrub.value);
      const max = Math.max(1, n - 1);
      el.scrub.style.setProperty('--fill', (i / max) * 100 + '%');
      el.progressPct.textContent = `Sentence ${i + 1} of ${n}`;
      el.timeLeft.textContent = '';
    });
    el.scrub.addEventListener('change', () => {
      scrubbing = false;
      seekTo(Number(el.scrub.value));
    });

    const markManual = () => (lastManualScroll = Date.now());
    el.stage.addEventListener('wheel', markManual, { passive: true });
    el.stage.addEventListener('touchmove', markManual, { passive: true });
    el.stage.addEventListener('mousedown', (e) => {
      if (e.target === el.stage) markManual();
    });

    el.rateSlider.addEventListener('input', () => setRate(el.rateSlider.value));
    el.rateChips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (b) setRate(Number(b.dataset.rate));
    });
    el.slowerBtn.addEventListener('click', () => setRate(state.settings.rate - 0.1));
    el.fasterBtn.addEventListener('click', () => setRate(state.settings.rate + 0.1));
    el.voiceSelect.addEventListener('change', () => setDeviceVoice(el.voiceSelect.value));
    el.kitVoiceSelect.addEventListener('change', () => setSpeaker(el.kitVoiceSelect.value));
    el.vmodeGroup.addEventListener('change', (e) => setVoiceMode(e.target.value));
    el.accentGroup.addEventListener('change', (e) => setAccent(e.target.value));
    el.previewBtn.addEventListener('click', previewVoice);
    el.voiceGetBtn.addEventListener('click', () => askDownload(el.voiceGetBtn.dataset.id || kitVoiceId(state.settings.voiceMode)));
    el.voiceStopBtn.addEventListener('click', stopDownload);
    el.voiceRetryBtn.addEventListener('click', checkNaturalAgain);
    el.pitchSlider.addEventListener('input', () => setPitch(el.pitchSlider.value));
    el.sleepChips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sleep]');
      if (!b) return;
      setSleep(b.dataset.sleep);
      if (sleep.mode) toast(sleep.mode === 'end' ? 'Readout will stop at the end of this text.' : `Readout will stop in ${sleep.mode} minutes.`);
    });

    for (const d of [el.speedSheet, el.moreSheet, el.settingsSheet, el.ocrSheet, el.voiceSheet, el.chaptersSheet]) {
      d.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) {
          closeSheet(d);
          return;
        }
        if (e.target === d) {
          const r = d.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(d);
        }
      });
    }
    el.speedSheet.addEventListener('close', stopPreview);

    el.editor.addEventListener('input', onEditorInput);
    el.editor.addEventListener('compositionstart', () => (editing.composing = true));
    el.editor.addEventListener('blur', () => {
      if (sync.dirty) syncSoon(800);
    });
    el.editor.addEventListener('compositionend', () => {
      editing.composing = false;
      editing.lastAt = Date.now();
    });
    el.editor.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        setMode('listen');
        play();
      }
    });
    el.pasteBtn.addEventListener('click', pasteIntoEditor);
    el.openBtn.addEventListener('click', () => el.fileInput.click());
    el.dictateBtn.addEventListener('click', toggleDictation);
    el.dictStopBtn.addEventListener('click', stopDictation);
    el.fileInput.addEventListener('change', () => handleFiles(el.fileInput.files));

    el.pastePlayBtn.addEventListener('click', pasteAndPlay);
    el.welcomeOpenBtn.addEventListener('click', () => el.fileInput.click());
    el.welcomeNoteBtn.addEventListener('click', () => newDoc());

    el.syncConnectBtn.addEventListener('click', connectSync);
    el.syncInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        connectSync();
      }
    });
    el.syncCreateBtn.addEventListener('click', createSyncGist);
    el.syncCancelBtn.addEventListener('click', () => {
      sync.pending = null;
      renderSync();
    });
    el.syncNowBtn.addEventListener('click', () => syncNow(true));
    el.syncKeyBtn.addEventListener('click', copySyncKey);
    el.syncOffBtn.addEventListener('click', stopSync);
    el.syncFixBtn.addEventListener('click', fixSync);
    window.addEventListener('online', () => {
      if (sync.error === 'offline' || sync.error === 'server') sync.retryAt = 0;
      syncNow();
    });
    // Picks up changes from other devices while Readout is open, unless it's reading aloud.
    setInterval(() => {
      if (sync.cfg && document.visibilityState === 'visible' && !tts.playing && Date.now() - sync.lastTry > 55000) syncNow();
      if (sync.cfg && el.settingsSheet.open) renderSyncStatus();
    }, 15000);

    el.exportAllBtn.addEventListener('click', exportAll);
    el.importBtn.addEventListener('click', () => el.backupInput.click());
    el.backupInput.addEventListener('change', () => importBackup(el.backupInput.files && el.backupInput.files[0]));

    el.themeGroup.addEventListener('change', (e) => {
      state.settings.theme = e.target.value;
      applyTheme();
      saveSettings();
    });
    el.sizeGroup.addEventListener('change', (e) => {
      state.settings.size = e.target.value;
      applyTheme();
      saveSettings();
      if (spans[curSpan]) scrollToSpan(spans[curSpan], true, 'auto');
    });
    el.followToggle.addEventListener('change', () => {
      state.settings.follow = el.followToggle.checked;
      saveSettings();
    });
    el.awakeToggle.addEventListener('change', () => {
      state.settings.keepAwake = el.awakeToggle.checked;
      saveSettings();
      wake.want('play', tts.playing && tts.engine === 'device' && state.settings.keepAwake);
    });
    el.autoNextToggle.addEventListener('change', () => {
      state.settings.autoNext = el.autoNextToggle.checked;
      saveSettings();
    });
    el.citeToggle.addEventListener('change', () => {
      state.settings.skipCitations = el.citeToggle.checked;
      saveSettings();
      replanCurrent();
    });
    el.notesToggle.addEventListener('change', () => {
      state.settings.includeNotes = el.notesToggle.checked;
      saveSettings();
    });
    el.lexAddBtn.addEventListener('click', addLexicon);
    for (const i of [el.lexWord, el.lexSay]) {
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (i === el.lexWord && !el.lexSay.value.trim()) el.lexSay.focus();
          else addLexicon();
        }
      });
    }
    el.punctToggle.addEventListener('change', () => {
      state.settings.spokenPunct = el.punctToggle.checked;
      saveSettings();
    });
    el.localToggle.addEventListener('change', () => {
      state.settings.dictLocal = el.localToggle.checked;
      saveSettings();
    });
    el.dictLang.addEventListener('change', () => {
      state.settings.dictLang = el.dictLang.value;
      saveSettings();
    });
    if (darkScheme.addEventListener) darkScheme.addEventListener('change', applyTheme);

    el.toastAction.addEventListener('click', () => {
      const h = toastHandler;
      hideToast();
      if (h) h();
    });

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape' && el.library.classList.contains('is-open')) {
        closeDrawer();
        el.menuBtn.focus();
        return;
      }
      const t = e.target;
      if (isTyping(t)) {
        if (e.key === 'Escape' && t === el.editor) setMode('listen');
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === ' ' || e.key === 'Enter') && t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return;
      if (!state.current) return;
      const k = e.key;
      if (k === ' ' || k === 'k') {
        e.preventDefault();
        if (state.mode === 'listen') togglePlay();
      } else if (k === 'ArrowLeft' || k === 'j') {
        e.preventDefault();
        skip(-1);
      } else if (k === 'ArrowRight' || k === 'l') {
        e.preventDefault();
        skip(1);
      } else if (k === '[' || k === '-') {
        setRate(state.settings.rate - 0.1);
      } else if (k === ']' || k === '=' || k === '+') {
        setRate(state.settings.rate + 0.1);
      } else if (k === 'e') {
        e.preventDefault();
        setMode(state.mode === 'edit' ? 'listen' : 'edit');
        if (state.mode === 'edit') el.editor.focus();
      } else if (k === 'n') {
        e.preventDefault();
        newDoc();
      }
    });

    // Paste anywhere outside a text field to add the text and start listening.
    document.addEventListener('paste', (e) => {
      if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text || !text.trim()) return;
      e.preventDefault();
      if (state.current && state.mode === 'edit') insertIntoEditor(Core.normalizeText(text));
      else addTextAndPlay(text);
    });

    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushDocs();
        if (state.current) savePositionNow();
        store.set('settings', state.settings).catch(() => {});
        if (sync.dirty) syncNow();
      } else {
        if (wake.reasons.size) wake.acquire();
        if (Date.now() - sync.lastTry > 5000) syncNow();
        if (tts.playing && curSpan >= 0 && spans[curSpan]) followSpan(spans[curSpan]);
      }
    });
    window.addEventListener('pagehide', () => {
      flushDocs();
      if (state.current) savePositionNow();
    });

    let installEvent = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvent = e;
      el.installBtn.hidden = false;
    });
    window.addEventListener('appinstalled', () => {
      installEvent = null;
      el.installBtn.hidden = true;
    });
    el.installBtn.addEventListener('click', async () => {
      if (!installEvent) return;
      installEvent.prompt();
      try {
        await installEvent.userChoice;
      } catch (e) {
        /* ignore */
      }
      installEvent = null;
      el.installBtn.hidden = true;
    });
  }

  // The service worker makes Readout work offline and cross-origin isolated (it adds the
  // COOP/COEP headers GitHub Pages can't send). A page isn't controlled on its first visit,
  // so it reloads once then.
  const COI_RELOAD = 'readout-coi-reload';
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return false;
    const local = LOOPBACK.test(location.hostname);
    if (location.protocol !== 'https:' && !local) return false;
    if (local && !CONFIG.swOnLocalhost) return false;
    let reg;
    try {
      reg = await navigator.serviceWorker.register('sw.js');
    } catch (e) {
      return false;
    }
    if (self.crossOriginIsolated) {
      sessionStorage.removeItem(COI_RELOAD);
      return false;
    }
    if (sessionStorage.getItem(COI_RELOAD)) return false; // reloaded once already (no credentialless here)
    // A new worker (the first visit, or the update from 1.x, whose worker adds no headers)
    // first keeps the app and readkit for offline use; the reload waits for it to take over.
    const pending = reg.installing || reg.waiting;
    if (pending) {
      await new Promise((r) => {
        const done = () => (pending.state === 'activated' || pending.state === 'redundant') && r();
        pending.addEventListener('statechange', done);
        done();
        setTimeout(r, 120000);
      });
    }
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => {
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true });
        setTimeout(r, 4000);
      });
    }
    // Never in the middle of something.
    const busy = tts.playing || dict.on || state.mode === 'edit' || !!document.querySelector('dialog[open]') || (el.toastAction && !el.toast.hidden && !el.toastAction.hidden);
    if (!navigator.serviceWorker.controller || busy) return false;
    sessionStorage.setItem(COI_RELOAD, '1');
    flushDocs();
    location.reload();
    return true;
  }

  /* ================= start ================= */

  async function init() {
    cacheElements();
    au.el = el.audio;
    buildRateChips();
    buildDictLangs();
    bindEvents();
    setupMediaSession();
    const kitReady = loadKit();
    kitReady.catch(() => {}); // handled below, once storage is open
    await store.init();
    let docs = [];
    let positions = [];
    let saved = null;
    let syncSaved = null;
    try {
      [docs, positions, saved] = await Promise.all([store.allDocs(), store.allPos(), store.get('settings')]);
      [sync.device, syncSaved, sync.tombs] = await Promise.all([store.get('device'), store.get('sync'), store.get('tombs')]);
    } catch (e) {
      onStoreError(e);
    }
    if (!sync.device) {
      sync.device = Core.uid();
      store.set('device', sync.device).catch(onStoreError);
    }
    if (!sync.tombs || typeof sync.tombs !== 'object') sync.tombs = {};
    if (syncSaved && syncSaved.token && syncSaved.gistId) {
      sync.cfg = { token: syncSaved.token, gistId: syncSaved.gistId, login: syncSaved.login || '' };
      sync.lastOk = syncSaved.lastOk || 0;
    }
    state.settings = Object.assign({}, DEFAULTS, saved || {});
    delete state.settings.background; // 1.x's "Try to keep reading when locked"
    if (!MODE_NAME[state.settings.voiceMode]) state.settings.voiceMode = DEFAULTS.voiceMode;
    applyTheme();
    renderRate();
    state.docs = (docs || []).filter((d) => d && typeof d.id === 'string' && typeof d.text === 'string');
    for (const p of positions || []) if (p && p.id) state.positions.set(p.id, p);
    mergeMirroredPositions();
    adoptOldWelcome();
    for (const d of state.docs) if (Core.seedVV(d)) store.putDoc(d).catch(onStoreError);
    await claimDeviceId();
    if (!state.docs.length && !state.settings.seenWelcome) {
      createWelcomeDoc();
      state.settings.seenWelcome = true;
      saveSettings();
    }
    try {
      await kitReady;
    } catch (e) {
      // Texts, editing, dictation, sync and the device voice (line by line) still work.
      console.error('Readout: readkit failed to load', e);
      kit.failed = true;
    }
    loadVoices();
    renderLibrary();
    if (!handleLaunchParams()) {
      const last = state.docs.find((d) => d.id === state.settings.lastDocId);
      if (last && !state.current) openDoc(last.id);
      else if (!state.current) openNextOrWelcome();
    }
    window.__readout = { state, tts, dict, sync, editing, Core, au, kit, sleep, queue, chooseEngine, seekTo, setSleep };
    registerServiceWorker();
    if (kit.failed) toast('Part of Readout didn’t load, so for now it can’t open files and reads line by line with the device voice. Reload to try again.');
    else if (!tts.ok && !playerSupported()) toast('This browser can’t read aloud. Open Readout in Chrome.');
    if (store.memoryOnly) toast('This browser isn’t allowing storage, so texts won’t be saved.');
    refreshVoices().then(() => {
      renderRate();
      warmVoiceSoon();
    });
    syncNow();
  }

  // Each open copy of Readout (a tab, the installed app) needs its own id for
  // sync to tell their changes apart. The first copy keeps the saved id.
  async function claimDeviceId() {
    if (!navigator.locks || !navigator.locks.request) return;
    const got = await new Promise((resolve) => {
      navigator.locks
        .request('readout-device-' + sync.device, { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          return lock ? new Promise(() => {}) : undefined;
        })
        .catch(() => resolve(true));
    });
    if (!got) sync.device = Core.uid();
  }

  // Welcome texts from before sync existed got random ids. Give an unedited one
  // the shared id so it matches the welcome text on other devices.
  function adoptOldWelcome() {
    if (state.docs.some((d) => d.id === 'welcome')) return;
    const old = state.docs.find((d) => d.text === WELCOME_TEXT && !d.vv && !d.pinned);
    if (!old) return;
    const pos = state.positions.get(old.id);
    removeDocLocally(old);
    const doc = Object.assign({}, old, { id: 'welcome', changedAt: 1, vv: {}, tv: {} });
    state.docs.push(doc);
    store.putDoc(doc).catch(onStoreError);
    if (pos) {
      const p = Object.assign({}, pos, { id: 'welcome' });
      state.positions.set('welcome', p);
      mirrorPosition(p);
      store.putPos(p).catch(onStoreError);
    }
    if (state.settings.lastDocId === old.id) state.settings.lastDocId = 'welcome';
  }

  const start = () =>
    init().catch((e) => {
      console.error('Readout failed to start', e);
      const p = document.createElement('p');
      p.style.cssText = 'padding:24px;font:16px system-ui';
      p.textContent = 'Readout couldn’t start in this browser. Try reloading, or open it in Chrome.';
      document.body.prepend(p);
    });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
