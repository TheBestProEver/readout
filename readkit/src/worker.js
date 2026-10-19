// Starts readkit's module workers.
//
// Normally this is new Worker(url, { type: 'module' }). A page made cross-origin isolated by
// a service worker instead of server headers (static hosts such as GitHub Pages; see
// lab/sw.js) has one catch: a worker script outside that service worker's scope is fetched
// without it, arrives without a Cross-Origin-Embedder-Policy header and is refused. A tiny
// blob: module that imports the real one inherits the page's policy and its service worker,
// so the import (same origin) goes through. The same blob module starts a worker whose script
// is on another origin (readkit imported from a CDN, as in the README's quick start): new
// Worker() refuses a cross-origin script outright, while a module may import one (a CORS
// fetch, which jsDelivr allows). config.workerBootstrap: 'auto' (blob only in those cases),
// 'blob' (always) or 'url' (never). Extension pages never need it, and a Manifest V3 CSP
// refuses blob: workers, so 'auto' never uses it there.
import { config } from './config.js';

const extensionPage = () => typeof location !== 'undefined' && /^(?:chrome|moz|safari-web)-extension:$/.test(location.protocol);

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

function otherOrigin(href) {
  try {
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && new URL(href, location.href).origin !== location.origin;
  } catch (e) {
    return false;
  }
}

// 'blob' or 'url': how moduleWorker() starts the worker at href
export function bootstrapFor(href) {
  const mode = config.workerBootstrap || 'auto';
  if (mode === 'blob') return 'blob';
  if (mode !== 'auto' || extensionPage()) return 'url';
  if (otherOrigin(href)) return 'blob';
  return typeof self !== 'undefined' && self.crossOriginIsolated && outsideControllerScope(href) ? 'blob' : 'url';
}

export function moduleWorker(url, opts = {}) {
  const href = String(url);
  if (bootstrapFor(href) !== 'blob') return new Worker(href, { ...opts, type: 'module' });
  const src = URL.createObjectURL(new Blob([`import ${JSON.stringify(href)};\n`], { type: 'text/javascript' }));
  const w = new Worker(src, { ...opts, type: 'module' });
  // the worker keeps its own copy once loaded; free the URL soon after
  setTimeout(() => URL.revokeObjectURL(src), 60000);
  return w;
}
