// Starts readkit's module workers.
//
// Normally this is new Worker(url, { type: 'module' }). A page made cross-origin isolated by
// a service worker instead of server headers (static hosts such as GitHub Pages; see
// lab/sw.js) has one catch: a worker script outside that service worker's scope is fetched
// without it, arrives without a Cross-Origin-Embedder-Policy header and is refused. A tiny
// blob: module that imports the real one inherits the page's policy and its service worker,
// so the import (same origin) goes through. config.workerBootstrap: 'auto' (blob only in that
// case), 'blob' (always) or 'url' (never).
import { config } from './config.js';

function outsideControllerScope(href) {
  try {
    const sw = typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) return false;
    // the default scope is the service worker script's directory
    return !href.startsWith(new URL('./', sw.scriptURL).href);
  } catch (e) {
    return false;
  }
}

export function moduleWorker(url, opts = {}) {
  const href = String(url);
  const mode = config.workerBootstrap || 'auto';
  const blob = mode === 'blob' || (mode === 'auto' && typeof self !== 'undefined' && self.crossOriginIsolated && outsideControllerScope(href));
  if (!blob) return new Worker(href, { ...opts, type: 'module' });
  const src = URL.createObjectURL(new Blob([`import ${JSON.stringify(href)};\n`], { type: 'text/javascript' }));
  const w = new Worker(src, { ...opts, type: 'module' });
  // the worker keeps its own copy once loaded; free the URL soon after
  setTimeout(() => URL.revokeObjectURL(src), 60000);
  return w;
}
