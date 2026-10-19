// readkit: any document -> clean, speakable text -> natural speech.
// This is the supported text side (DESIGN.md sections 1, 2 and 5); it needs no models.
// Voices and the player are their own supported modules, loaded on demand: voice.js and
// player.js at the repo root. Files under src/ are internal and may move between releases.

export { config, configure } from './src/config.js';
export { docToText, textToBlocks } from './src/doc.js';
export { sniff } from './src/sniff.js';
export { extract, autoName } from './src/extract.js';
export { plan } from './src/speech/plan.js';
export { verbalize } from './src/speech/verbalize.js';
export { splitSentences } from './src/speech/split.js';
// Text in pieces the device voice (speechSynthesis) can speak whole (no models, no DOM).
export { chunkText } from './src/voice/system.js';
// Calendar extraction (CalSnap): layout-preserving extraction, dates/times/places, events, .ics
export { extractLayout, layoutFromText, layoutFromBlocks, layoutFromPages } from './src/layout/layout.js';
export { findEntities, findEvents, toICS } from './src/calendar/calendar.js';
