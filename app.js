/* Readout: paste text and hear it read aloud, or dictate notes. No build step, no dependencies. */
(() => {
  'use strict';

  const Core = window.ReadoutCore;
  const VERSION = '1.0.0';
  const CONFIG = Object.assign(
    {
      pdfjsBase: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.6.205/build/',
      fastEndCheck: true,
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

  const DEFAULTS = {
    rate: 1,
    pitch: 1,
    voiceURI: '',
    theme: 'system',
    size: 'm',
    follow: true,
    keepAwake: true,
    background: false,
    dictLang: '',
    spokenPunct: true,
    dictLocal: false,
    cps: 14.5, // learned speaking speed in characters per second at 1x
    lastDocId: null,
    seenWelcome: false,
  };

  const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

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
    chunks: [],
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
  function savePositionNow(finishedNow) {
    clearTimeout(posTimer);
    posTimer = null;
    const doc = state.current;
    if (!doc) return;
    const n = state.chunks.length;
    const finished = finishedNow === true || (n > 0 && state.idx >= n);
    const i = Math.min(state.idx, Math.max(0, n - 1));
    const ch = state.chunks[i];
    const offset = finished ? doc.text.length : ch ? ch.start + (tts.playing ? 0 : tts.wordOffset || 0) : 0;
    const progress = n ? (finished ? 1 : state.cum[i] / state.cum[n]) : 0;
    const p = { id: doc.id, offset, progress, done: finished, at: Date.now() };
    state.positions.set(doc.id, p);
    mirrorPosition(p);
    store.putPos(p).catch(onStoreError);
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
      pinned: false,
    };
    state.docs.push(doc);
    store.putDoc(doc).catch(onStoreError);
    requestPersist();
    renderLibrarySoon();
    return doc;
  }

  function dropDocQuietly(doc) {
    const i = state.docs.indexOf(doc);
    if (i >= 0) state.docs.splice(i, 1);
    pendingDocs.delete(doc.id);
    state.positions.delete(doc.id);
    forgetMirroredPosition(doc.id);
    store.deleteDoc(doc.id).catch(() => {});
    store.deletePos(doc.id).catch(() => {});
  }

  function openDoc(id, opts) {
    const o = opts || {};
    const doc = state.docs.find((d) => d.id === id);
    if (!doc) return;
    pausePlayback();
    stopDictation();
    flushDocs();
    const prev = state.current;
    if (prev && prev !== doc && !prev.text.trim()) dropDocQuietly(prev);
    state.current = doc;
    state.settings.lastDocId = doc.id;
    saveSettings();
    rebuildChunks();
    const pos = state.positions.get(doc.id);
    tts.wordOffset = 0;
    if (pos && pos.done) {
      state.idx = state.chunks.length;
    } else if (pos && state.chunks.length) {
      state.idx = Core.findChunkIndex(state.chunks, pos.offset);
      const ch = state.chunks[state.idx];
      if (ch && pos.offset > ch.start && pos.offset < ch.end) tts.wordOffset = pos.offset - ch.start;
    } else {
      state.idx = 0;
    }
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
  }

  function showWelcome() {
    pausePlayback();
    stopDictation();
    state.current = null;
    state.chunks = [];
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
    const ch = state.chunks[Math.min(state.idx, state.chunks.length - 1)];
    const ratio = ch && doc.text.length ? ch.start / doc.text.length : 0;
    doc.text = text;
    doc.updatedAt = Date.now();
    if (!doc.titleLocked) doc.title = Core.deriveTitle(text);
    scheduleSave(doc);
    if (state.current === doc) {
      rebuildChunks();
      state.idx = Core.findChunkIndex(state.chunks, Math.round(ratio * text.length));
      tts.wordOffset = 0;
      if (state.mode === 'edit') el.editor.value = text;
      renderView();
      renderReader();
    }
    renderLibrarySoon();
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

  function rebuildChunks() {
    const doc = state.current;
    state.chunks = doc ? Core.chunkText(doc.text) : [];
    state.cum = Core.prefixLengths(state.chunks);
    state.dirty = false;
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
    state.mode = 'listen';
    if (state.dirty || !state.chunks.length) {
      const n = state.chunks.length;
      const ch = state.chunks[Math.min(state.idx, n - 1)];
      const finished = n > 0 && state.idx >= n;
      rebuildChunks();
      state.idx = finished ? state.chunks.length : ch ? Core.findChunkIndex(state.chunks, ch.start) : 0;
    }
    renderView();
    if (wasEditing || !spans.length) renderReader();
  }

  function renderReader() {
    const doc = state.current;
    const frag = document.createDocumentFragment();
    spans = [];
    curSpan = -1;
    if (doc) {
      const text = doc.text;
      let pos = 0;
      for (let i = 0; i < state.chunks.length; i++) {
        const c = state.chunks[i];
        if (c.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, c.start)));
        const s = document.createElement('span');
        s.className = 'chunk';
        s.dataset.i = String(i);
        s.textContent = text.slice(c.start, c.end);
        frag.appendChild(s);
        spans.push(s);
        pos = c.end;
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
    const n = state.chunks.length;
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
    const playing = tts.playing;
    el.playIcon.setAttribute('href', playing ? '#i-pause' : '#i-play');
    el.playBtn.setAttribute('aria-label', playing ? 'Pause' : finished ? 'Play again from the start' : 'Play');
    el.playBtn.classList.toggle('is-paused-ready', !playing);
    el.playBtn.disabled = n === 0;
    el.prevBtn.disabled = n === 0;
    el.nextBtn.disabled = n === 0;
  }

  /* ================= speech engine ================= */

  const tts = {
    ok: 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
    voices: [],
    playing: false,
    token: 0,
    utter: null, // kept so Chrome can't garbage-collect the utterance before onend fires
    wordOffset: 0,
    lastBoundary: 0,
    lastCancelAt: 0,
    errors: 0,
    fastEnds: 0,
    voiceBroken: false,
    watchdog: null,
    keepAlive: null,
    restartTimer: null,
    rateTimer: null,
  };
  const synth = () => window.speechSynthesis;

  function clearSpeechTimers() {
    clearInterval(tts.watchdog);
    clearInterval(tts.keepAlive);
    tts.watchdog = null;
    tts.keepAlive = null;
  }

  function cancelSpeech() {
    try {
      const s = synth();
      if (s.speaking || s.pending || s.paused) {
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

  function togglePlay() {
    if (tts.playing) pausePlayback();
    else play();
  }

  function play(fromIdx) {
    if (!state.current) return;
    if (!tts.ok) {
      toast('This browser can’t read aloud. Open Readout in Chrome.');
      return;
    }
    if (state.mode !== 'listen') setMode('listen');
    if (!state.current || !state.chunks.length) {
      toast('There’s nothing to read in this text yet.');
      return;
    }
    stopDictation();
    if (typeof fromIdx === 'number') {
      state.idx = Core.clamp(fromIdx, 0, state.chunks.length - 1);
      tts.wordOffset = 0;
    }
    if (state.idx >= state.chunks.length) {
      state.idx = 0;
      tts.wordOffset = 0;
    }
    lastManualScroll = 0;
    const wasPlaying = tts.playing;
    tts.playing = true;
    tts.errors = 0;
    tts.fastEnds = 0;
    if (!wasPlaying) onPlaybackStart();
    speakCurrent(true);
  }

  function speakCurrent(interrupt) {
    const my = ++tts.token;
    clearSpeechTimers();
    clearTimeout(tts.restartTimer);

    const run = () => {
      if (my !== tts.token || !tts.playing) return;
      const doc = state.current;
      const ch = state.chunks[state.idx];
      if (!doc || !ch) {
        finishPlayback();
        return;
      }
      const raw = doc.text.slice(ch.start, ch.end);
      const off = tts.wordOffset > 0 && tts.wordOffset < raw.length ? tts.wordOffset : 0;
      tts.wordOffset = 0;
      const spoken = Core.speakable(raw).slice(off);
      highlightChunk(state.idx);
      if (!/[\p{L}\p{N}]/u.test(spoken)) {
        advance(my);
        return;
      }

      const u = new SpeechSynthesisUtterance(spoken);
      u.rate = state.settings.rate;
      u.pitch = state.settings.pitch;
      u.volume = 1;
      const voice = currentVoice();
      if (voice) {
        u.voice = voice;
        u.lang = Core.normalizeLang(voice.lang);
      }
      const expectedMs = (spoken.length / (state.settings.cps * state.settings.rate)) * 1000;
      const t0 = performance.now();
      let finished = false;
      let forced = false;
      tts.lastBoundary = off;

      const done = (kind, ev) => {
        if (finished || my !== tts.token) return;
        finished = true;
        clearSpeechTimers();
        if (kind === 'end' || forced) onUtteranceEnd(my, spoken.length, performance.now() - t0, expectedMs, !!voice);
        else onUtteranceError(my, ev, off, !!voice);
      };
      u.onend = () => done('end');
      u.onerror = (ev) => done('error', ev);
      u.onboundary = (ev) => {
        if (my !== tts.token || finished) return;
        if (ev.name && ev.name !== 'word') return;
        const ci = off + (ev.charIndex || 0);
        tts.lastBoundary = ci;
        markWord(ci, ev.charLength);
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
    advance(my);
  }

  function onUtteranceError(my, ev, off, usedVoice) {
    const code = (ev && ev.error) || 'unknown';
    if (code === 'interrupted' || code === 'canceled') {
      // Something outside Readout cut in (a call, another app). Keep the place.
      if (tts.playing) {
        tts.wordOffset = Math.max(off, tts.lastBoundary || 0);
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
      tts.wordOffset = off;
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

  function advance(my) {
    if (my !== tts.token || !tts.playing) return;
    if (state.idx + 1 >= state.chunks.length) {
      finishPlayback();
      return;
    }
    state.idx++;
    speakCurrent(false);
  }

  function pausePlayback(opts) {
    if (!tts.playing) return;
    const o = opts || {};
    tts.playing = false;
    tts.token++;
    clearSpeechTimers();
    clearTimeout(tts.restartTimer);
    clearTimeout(tts.rateTimer);
    if (!o.keepOffset) tts.wordOffset = tts.lastBoundary > 0 ? tts.lastBoundary : 0;
    cancelSpeech();
    clearWord();
    onPlaybackStop();
    savePositionNow();
  }

  function finishPlayback() {
    tts.playing = false;
    tts.token++;
    clearSpeechTimers();
    clearWord();
    state.idx = state.chunks.length;
    tts.wordOffset = 0;
    highlightChunk(state.idx, { scroll: false });
    onPlaybackStop();
    savePositionNow(true);
    toast('Finished reading.');
  }

  function skip(delta) {
    const n = state.chunks.length;
    if (!n) return;
    const base = state.idx >= n ? n : state.idx;
    state.idx = Core.clamp(base + delta, 0, n - 1);
    tts.wordOffset = 0;
    lastManualScroll = 0;
    if (tts.playing) speakCurrent(true);
    else {
      highlightChunk(state.idx, { scroll: 'force' });
      queuePositionSave();
    }
  }

  function restartPlaybackAtWord(delay) {
    if (!tts.playing) return;
    clearTimeout(tts.rateTimer);
    tts.rateTimer = setTimeout(() => {
      if (!tts.playing) return;
      tts.wordOffset = tts.lastBoundary || 0;
      speakCurrent(true);
    }, delay);
  }

  function setRate(r) {
    const rate = Math.round(Core.clamp(Number(r) || 1, 0.5, 4) * 100) / 100;
    if (rate === state.settings.rate) {
      renderRate();
      return;
    }
    state.settings.rate = rate;
    saveSettings();
    renderRate();
    renderPlayer();
    restartPlaybackAtWord(400);
  }

  function setPitch(p) {
    state.settings.pitch = Math.round(Core.clamp(Number(p) || 1, 0.5, 1.5) * 100) / 100;
    saveSettings();
    renderRate();
    restartPlaybackAtWord(400);
  }

  function setVoice(uri) {
    state.settings.voiceURI = uri || '';
    tts.voiceBroken = false;
    saveSettings();
    restartPlaybackAtWord(150);
  }

  function previewVoice() {
    if (!tts.ok) return;
    pausePlayback();
    cancelSpeech();
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

  function silentWavUrl(seconds) {
    const rate = 8000;
    const n = rate * seconds;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const w = (o, str) => {
      for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
    };
    w(0, 'RIFF');
    v.setUint32(4, 36 + n, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    w(36, 'data');
    v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  // Experimental: a silent looping track gives the page an active media session,
  // which can keep Android from suspending it when the screen locks.
  const bgAudio = {
    audio: null,
    start() {
      if (!state.settings.background) return;
      try {
        if (!this.audio) {
          this.audio = new Audio(silentWavUrl(12));
          this.audio.loop = true;
          this.audio.preload = 'auto';
          this.audio.setAttribute('playsinline', '');
        }
        const p = this.audio.play();
        if (p && p.catch) p.catch(() => {});
      } catch (e) {
        /* ignore */
      }
    },
    stop() {
      if (this.audio) this.audio.pause();
    },
  };

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
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
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      const doc = state.current;
      if (doc && typeof window.MediaMetadata === 'function') {
        const md = navigator.mediaSession.metadata;
        if (!md || md.title !== doc.title) {
          const icon = (s) => ({ src: new URL(`icons/icon-${s}.png`, location.href).href, sizes: `${s}x${s}`, type: 'image/png' });
          navigator.mediaSession.metadata = new MediaMetadata({ title: doc.title, artist: 'Readout', artwork: [icon(192), icon(512)] });
        }
      }
      navigator.mediaSession.playbackState = tts.playing ? 'playing' : 'paused';
    } catch (e) {
      /* ignore */
    }
  }

  function onPlaybackStart() {
    if (state.settings.keepAwake) wake.want('play', true);
    bgAudio.start();
    updateMediaSession();
    renderPlayer();
  }

  function onPlaybackStop() {
    wake.want('play', false);
    bgAudio.stop();
    updateMediaSession();
    saveSettings();
    renderPlayer();
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

  function onEditorInput() {
    const doc = state.current;
    if (!doc) return;
    doc.text = el.editor.value;
    doc.updatedAt = Date.now();
    if (!doc.titleLocked) {
      doc.title = Core.deriveTitle(doc.text);
      renderTitle();
    }
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

  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(CONFIG.pdfjsBase + 'pdf.min.mjs')
        .then((lib) => {
          lib.GlobalWorkerOptions.workerSrc = CONFIG.pdfjsBase + 'pdf.worker.min.mjs';
          return lib;
        })
        .catch((e) => {
          pdfjsPromise = null;
          throw e;
        });
    }
    return pdfjsPromise;
  }

  function pageText(items) {
    const lines = [];
    let line = '';
    let lastY = null;
    let lastH = 10;
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform ? it.transform[5] : null;
      const h = it.height || lastH;
      if (lastY !== null && y !== null && it.str && Math.abs(y - lastY) > h * 0.5) {
        if (line.trim()) lines.push(line);
        line = '';
        if (Math.abs(y - lastY) > h * 1.9) lines.push('');
      }
      line += it.str;
      if (it.str) {
        lastY = y;
        lastH = h || lastH;
      }
      if (it.hasEOL) {
        if (line.trim()) lines.push(line);
        line = '';
      }
    }
    if (line.trim()) lines.push(line);
    return lines
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  async function pdfToText(file) {
    toast('Reading the PDF…');
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      if (pdf.numPages > 4 && p % 5 === 0) toast(`Reading the PDF, page ${p} of ${pdf.numPages}…`);
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      pages.push(pageText(content.items));
      if (page.cleanup) page.cleanup();
    }
    try {
      await pdf.destroy();
    } catch (e) {
      /* ignore */
    }
    return Core.reflow(pages.join('\n\n'));
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    el.fileInput.value = '';
    if (!files.length) return;
    let last = null;
    let added = 0;
    for (const f of files) {
      try {
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
        const text = isPdf ? await pdfToText(f) : Core.normalizeText(await f.text());
        if (!text.trim()) {
          toast(`“${f.name}” has no text Readout can read. Scanned PDFs are images, not text.`);
          continue;
        }
        const title = f.name.replace(/\.[^.]+$/, '');
        const cur = state.current;
        if (cur && files.length === 1 && !cur.text.trim()) {
          cur.text = text;
          cur.title = title;
          cur.titleLocked = true;
          cur.updatedAt = Date.now();
          scheduleSave(cur);
          last = cur;
        } else {
          last = createDoc(text, title);
        }
        added++;
      } catch (e) {
        console.warn('Readout file error', e);
        toast(`Couldn’t open “${f.name}”.${navigator.onLine === false ? ' Opening a PDF needs a connection the first time.' : ''}`);
      }
    }
    if (last) {
      flushDocs();
      openDoc(last.id, { mode: 'listen' });
      closeDrawer();
      toast(added > 1 ? `Added ${added} files.` : 'Ready. Press play to listen.');
    }
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
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
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
    } else if (act === 'restart') {
      pausePlayback();
      state.idx = 0;
      tts.wordOffset = 0;
      if (state.mode !== 'listen') setMode('listen');
      highlightChunk(0, { scroll: false });
      el.stage.scrollTo({ top: 0 });
      savePositionNow();
    } else if (act === 'pin') {
      doc.pinned = !doc.pinned;
      scheduleSave(doc);
      renderLibrary();
      toast(doc.pinned ? 'Pinned to the top.' : 'Unpinned.');
    } else if (act === 'delete') {
      deleteDoc(doc.id);
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
    const r = Core.mergeDocs(state.docs, data.docs);
    state.docs = r.docs;
    for (const d of state.docs) if (!before.has(d)) store.putDoc(d).catch(onStoreError);
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
    const r = state.settings.rate;
    el.speedLabel.textContent = fmtRate(r) + '×';
    el.rateReadout.textContent = r.toFixed(2) + '×';
    if (document.activeElement !== el.rateSlider) el.rateSlider.value = String(r);
    for (const b of el.rateChips.children) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === r));
    el.slowerBtn.disabled = r <= 0.5;
    el.fasterBtn.disabled = r >= 4;
    const p = state.settings.pitch;
    if (document.activeElement !== el.pitchSlider) el.pitchSlider.value = String(p);
    el.pitchValue.textContent = Math.abs(p - 1) < 0.001 ? 'Normal' : p < 1 ? `Lower (${p.toFixed(2)})` : `Higher (${p.toFixed(2)})`;
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
    el.voiceHint.textContent = !tts.ok
      ? 'This browser has no speech voices. Open Readout in Chrome.'
      : IS_ANDROID
        ? 'For more or better voices, open your phone’s text-to-speech settings and install voice data for Google’s speech engine.'
        : voices.length
          ? ''
          : 'Loading voices…';
  }

  function repoUrl() {
    const host = location.hostname;
    if (!host.endsWith('.github.io')) return '';
    const owner = host.slice(0, -'.github.io'.length);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    return `https://github.com/${owner}/${repo || host}`;
  }

  function renderSettings() {
    for (const i of el.themeGroup.querySelectorAll('input')) i.checked = i.value === state.settings.theme;
    for (const i of el.sizeGroup.querySelectorAll('input')) i.checked = i.value === state.settings.size;
    el.followToggle.checked = !!state.settings.follow;
    el.awakeToggle.checked = !!state.settings.keepAwake;
    el.bgToggle.checked = !!state.settings.background;
    el.punctToggle.checked = !!state.settings.spokenPunct;
    el.localToggle.checked = !!state.settings.dictLocal;
    el.localToggleRow.hidden = !(SR && typeof SR.available === 'function');
    el.dictLang.value = state.settings.dictLang || '';
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
    el.toast.hidden = false;
    el.toast.style.animation = 'none';
    void el.toast.offsetWidth;
    el.toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, o.action ? 6500 : 4000);
  }
  function hideToast() {
    el.toast.hidden = true;
    toastHandler = null;
  }

  /* ================= launch: share target, shortcuts ================= */

  function handleLaunchParams() {
    const params = new URLSearchParams(location.search);
    if (![...params.keys()].length) return false;
    const action = params.get('action');
    const text = (params.get('text') || '').trim();
    const url = (params.get('url') || '').trim();
    const title = (params.get('title') || '').trim();
    try {
      history.replaceState(null, '', location.pathname + location.hash);
    } catch (e) {
      /* ignore */
    }
    const body = text || url;
    if (body) {
      if (/^https?:\/\/\S+$/i.test(body)) {
        toast('Readout got a link, not the page’s text. Select the text on the page and share that instead.');
        return false;
      }
      const doc = createDoc(Core.normalizeText(body), title && title !== body ? title : '');
      openDoc(doc.id, { mode: 'listen' });
      toast('Added. Press play to listen.');
      return true;
    }
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
      'progressPct', 'timeLeft', 'speedBtn', 'speedLabel', 'prevBtn', 'playBtn', 'playIcon', 'nextBtn', 'locateBtn',
      'editTools', 'pasteBtn', 'openBtn', 'dictateBtn', 'fileInput', 'backupInput', 'speedSheet', 'rateReadout',
      'rateSlider', 'rateChips', 'slowerBtn', 'fasterBtn', 'voiceSelect', 'previewBtn', 'voiceHint', 'pitchSlider',
      'pitchValue', 'moreSheet', 'pinLabel', 'settingsSheet', 'followToggle', 'awakeToggle', 'bgToggle', 'dictLang',
      'punctToggle', 'localToggleRow', 'localToggle', 'exportAllBtn', 'importBtn', 'about', 'toast', 'toastMsg',
      'toastAction', 'newBtn', 'search', 'docList', 'docEmpty', 'installBtn', 'settingsBtn', 'pastePlayBtn',
      'welcomeOpenBtn', 'welcomeNoteBtn', 'themeColor', 'themeGroup', 'sizeGroup',
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
      renderVoiceOptions();
      openSheet(el.speedSheet);
    });

    const startScrub = () => (scrubbing = true);
    el.scrub.addEventListener('pointerdown', startScrub);
    el.scrub.addEventListener('touchstart', startScrub, { passive: true });
    el.scrub.addEventListener('input', () => {
      scrubbing = true;
      const n = state.chunks.length;
      const i = Number(el.scrub.value);
      const max = Math.max(1, n - 1);
      el.scrub.style.setProperty('--fill', (i / max) * 100 + '%');
      el.progressPct.textContent = `Sentence ${i + 1} of ${n}`;
      el.timeLeft.textContent = '';
    });
    el.scrub.addEventListener('change', () => {
      scrubbing = false;
      const i = Number(el.scrub.value);
      tts.wordOffset = 0;
      state.idx = i;
      lastManualScroll = 0;
      if (tts.playing) speakCurrent(true);
      else {
        highlightChunk(i, { scroll: 'force' });
        queuePositionSave();
      }
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
    el.voiceSelect.addEventListener('change', () => setVoice(el.voiceSelect.value));
    el.previewBtn.addEventListener('click', previewVoice);
    el.pitchSlider.addEventListener('input', () => setPitch(el.pitchSlider.value));

    for (const d of [el.speedSheet, el.moreSheet, el.settingsSheet]) {
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

    el.editor.addEventListener('input', onEditorInput);
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
      wake.want('play', tts.playing && state.settings.keepAwake);
    });
    el.bgToggle.addEventListener('change', () => {
      state.settings.background = el.bgToggle.checked;
      saveSettings();
      if (state.settings.background && tts.playing) bgAudio.start();
      else bgAudio.stop();
    });
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
      } else if (wake.reasons.size) {
        wake.acquire();
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

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !local) return;
    if (local && !CONFIG.swOnLocalhost) return;
    const reg = () => navigator.serviceWorker.register('sw.js').catch(() => {});
    if (document.readyState === 'complete') reg();
    else window.addEventListener('load', reg);
  }

  /* ================= start ================= */

  async function init() {
    cacheElements();
    buildRateChips();
    buildDictLangs();
    bindEvents();
    setupMediaSession();
    await store.init();
    let docs = [];
    let positions = [];
    let saved = null;
    try {
      [docs, positions, saved] = await Promise.all([store.allDocs(), store.allPos(), store.get('settings')]);
    } catch (e) {
      onStoreError(e);
    }
    state.settings = Object.assign({}, DEFAULTS, saved || {});
    applyTheme();
    renderRate();
    state.docs = (docs || []).filter((d) => d && typeof d.id === 'string' && typeof d.text === 'string');
    for (const p of positions || []) if (p && p.id) state.positions.set(p.id, p);
    mergeMirroredPositions();
    if (!state.docs.length && !state.settings.seenWelcome) {
      createDoc(WELCOME_TEXT, 'Welcome to Readout');
      state.settings.seenWelcome = true;
      saveSettings();
    }
    loadVoices();
    renderLibrary();
    if (!handleLaunchParams()) {
      const last = state.docs.find((d) => d.id === state.settings.lastDocId);
      if (last) openDoc(last.id);
      else openNextOrWelcome();
    }
    registerServiceWorker();
    if (!tts.ok) toast('This browser can’t read aloud. Open Readout in Chrome.');
    if (store.memoryOnly) toast('This browser isn’t allowing storage, so texts won’t be saved.');
    window.__readout = { state, tts, dict, Core };
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
