// readkit/voice.js: the supported voice API (DESIGN.md section 3). Stable across releases;
// the files under src/ are internal and may move. Nothing heavy loads until createVoice():
// the engine, its runtime and the model start in a worker then.
export { createVoice, voiceCatalog, voiceStore, defaultVoice, fallbackVoice, findVoice, DEFAULT_VOICE } from './src/voice/voice.js';
// The device's own voices (speechSynthesis): no download, no PCM, so not for createPlayer().
export { systemVoices, createSystemVoice, hasSpeech, chunkText } from './src/voice/system.js';
