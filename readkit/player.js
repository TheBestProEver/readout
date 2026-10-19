// readkit/player.js: the supported player API (DESIGN.md section 4). Stable across releases;
// the files under src/ are internal and may move.
export { createPlayer, playerSupport, snapSpeed, SPEEDS, MIN_SPEED, MAX_SPEED } from './src/audio/player.js';
// The clip cache (IndexedDB) the player keeps generated audio in, for an app that exports
// a document's audio or clears the cache without a player.
export { openClipStore, segmentKeys } from './src/audio/clipstore.js';
