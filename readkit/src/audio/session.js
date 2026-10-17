// Media Session: lock-screen / notification metadata, buttons and seek bar. Android shows a
// seek bar only with a seekto handler and a finite duration, so the player passes an estimated
// document length (seconds at speed 1) and keeps refining it. Handlers other than pause and
// stop carry user activation, so they may call play().

const ms = () => (typeof navigator !== 'undefined' && navigator.mediaSession) || null;

export const ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward', 'stop'];

function artworkList(artwork) {
  if (!artwork) return [];
  const list = Array.isArray(artwork) ? artwork : [artwork];
  return list.map((a) => (typeof a === 'string' ? { src: a, sizes: '512x512', type: /\.svg$/i.test(a) ? 'image/svg+xml' : 'image/png' } : a));
}

// handlers: { play, pause, previous, next, seekTo(seconds), seekBy(deltaSeconds), stop }
export function createMediaSession({ metadata, handlers = {}, skipSeconds = 10 } = {}) {
  const s = ms();
  const set = (action, fn) => {
    if (!s) return;
    try {
      s.setActionHandler(action, fn);
    } catch (e) {
      /* action not supported by this browser */
    }
  };
  const call = (name, ...args) => {
    const fn = handlers[name];
    if (fn) {
      try {
        fn(...args);
      } catch (e) {
        /* a handler bug must not break the session */
      }
    }
  };
  set('play', () => call('play'));
  set('pause', () => call('pause'));
  set('stop', handlers.stop ? () => call('stop') : null);
  set('previoustrack', () => call('previous'));
  set('nexttrack', () => call('next'));
  set('seekto', (d) => {
    if (d && Number.isFinite(d.seekTime)) call('seekTo', Math.max(0, d.seekTime));
  });
  set('seekbackward', (d) => call('seekBy', -((d && d.seekOffset) || skipSeconds)));
  set('seekforward', (d) => call('seekBy', (d && d.seekOffset) || skipSeconds));

  let last = null;
  const session = {
    supported: !!s,
    setMetadata(md) {
      if (!s || !md || typeof MediaMetadata === 'undefined') return;
      try {
        s.metadata = new MediaMetadata({ title: md.title || '', artist: md.artist || '', album: md.album || '', artwork: artworkList(md.artwork) });
      } catch (e) {
        /* bad artwork entries */
      }
    },
    // 'playing' | 'paused' | 'none'
    setState(state) {
      if (!s) return;
      try {
        s.playbackState = state;
      } catch (e) {
        /* ignore */
      }
    },
    // duration and position in seconds; rate > 0. Invalid values are clamped, never thrown.
    setPosition({ duration, position, playbackRate = 1 }) {
      if (!s || !s.setPositionState) return;
      if (!(duration > 0) || !Number.isFinite(duration)) return;
      const p = Math.max(0, Math.min(duration, +position || 0));
      const r = playbackRate > 0 && Number.isFinite(playbackRate) ? playbackRate : 1;
      last = { duration, position: p, playbackRate: r };
      try {
        s.setPositionState(last);
      } catch (e) {
        /* ignore */
      }
    },
    get position() {
      return last;
    },
    destroy() {
      if (!s) return;
      for (const a of ACTIONS) set(a, null);
      try {
        s.metadata = null;
        s.playbackState = 'none';
        if (s.setPositionState) s.setPositionState();
      } catch (e) {
        /* ignore */
      }
    },
  };
  if (metadata) session.setMetadata(metadata);
  return session;
}
