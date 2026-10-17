// readkit: any document -> clean, speakable text -> natural speech.
// The text side (extract, plan) needs no models. Voices and the player load on demand
// from their own modules: src/voice/voice.js and src/audio/player.js.

export { config, configure } from './src/config.js';
export { docToText, textToBlocks } from './src/doc.js';
export { sniff } from './src/sniff.js';
export { extract } from './src/extract.js';
export { plan } from './src/speech/plan.js';
export { verbalize } from './src/speech/verbalize.js';
export { splitSentences } from './src/speech/split.js';
