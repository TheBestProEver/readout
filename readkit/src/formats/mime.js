// MIME documents: saved web pages (.mhtml, .mht) and e-mails (.eml). Finds the main HTML
// part (or the plain-text body), undoes quoted-printable or base64, and decodes its charset.

import { latin1 } from './util.js';
import { decodeText } from './text.js';

function parseHeaders(block) {
  const headers = new Map();
  const lines = block.split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && last) {
      headers.set(last, headers.get(last) + ' ' + line.trim());
      continue;
    }
    const c = line.indexOf(':');
    if (c <= 0) continue;
    last = line.slice(0, c).trim().toLowerCase();
    if (!headers.has(last)) headers.set(last, line.slice(c + 1).trim());
  }
  return headers;
}

// 'text/html; charset="utf-8"; boundary=x' -> { type, params }
function contentType(v) {
  const parts = String(v || 'text/plain').split(';');
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { type: parts[0].trim().toLowerCase(), params };
}

function quotedPrintable(s) {
  const out = new Uint8Array(s.length);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) {
      // '='
      if (s[i + 1] === '\r' && s[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (s[i + 1] === '\n') {
        i += 1;
        continue;
      }
      const h = parseInt(s.substr(i + 1, 2), 16);
      if (!Number.isNaN(h) && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
        out[o++] = h;
        i += 2;
        continue;
      }
    }
    out[o++] = c & 0xff;
  }
  return out.subarray(0, o);
}

function base64(s) {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const pad = clean.length % 4 === 1 ? clean.slice(0, -1) : clean;
  const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bodyBytes(raw, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'quoted-printable') return quotedPrintable(raw);
  if (enc === 'base64') {
    try {
      return base64(raw);
    } catch (e) {
      return new Uint8Array(0);
    }
  }
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i) & 0xff;
  return out;
}

// RFC 2047 encoded words in headers: =?utf-8?Q?Caf=C3=A9?= / =?utf-8?B?...?=
export function decodeHeader(v) {
  return String(v || '')
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([\w-]{1,40})\?([QqBb])\?([^?]{0,2000})\?=/g, (m, cs, enc, data) => {
      try {
        const bytes = enc.toUpperCase() === 'B' ? base64(data) : quotedPrintable(data.replace(/_/g, ' '));
        return new TextDecoder(cs).decode(bytes);
      } catch (e) {
        return m;
      }
    });
}

// One MIME entity (headers + body) starting at `start` in the binary string.
function parseEntity(s, start, end, depth) {
  let sep = s.indexOf('\r\n\r\n', start);
  let sepLen = 4;
  const lf = s.indexOf('\n\n', start);
  if (lf >= 0 && (sep < 0 || lf < sep)) {
    sep = lf;
    sepLen = 2;
  }
  if (sep < 0 || sep > end) sep = end;
  const headers = parseHeaders(s.slice(start, sep));
  const bodyStart = Math.min(end, sep + sepLen);
  const ct = contentType(headers.get('content-type'));
  const entity = { headers, type: ct.type, params: ct.params, bodyStart, bodyEnd: end, parts: [] };
  if (ct.type.startsWith('multipart/') && ct.params.boundary && depth < 6) {
    const delim = '--' + ct.params.boundary;
    let pos = s.indexOf(delim, bodyStart);
    while (pos >= 0 && pos < end) {
      const lineEnd = s.indexOf('\n', pos);
      if (s.startsWith(delim + '--', pos) || lineEnd < 0) break;
      const next = s.indexOf('\n' + delim, lineEnd);
      const partEnd = next < 0 || next > end ? end : next;
      // drop the CR before the next delimiter
      const realEnd = partEnd > 0 && s[partEnd - 1] === '\r' ? partEnd - 1 : partEnd;
      entity.parts.push(parseEntity(s, lineEnd + 1, realEnd, depth + 1));
      pos = next < 0 ? -1 : next + 1;
    }
  }
  return entity;
}

function textOfEntity(s, e) {
  const bytes = bodyBytes(s.slice(e.bodyStart, e.bodyEnd), e.headers.get('content-transfer-encoding'));
  return decodeText(bytes, { charset: e.params.charset }).text;
}

function isAttachment(e) {
  return /^attachment/i.test(e.headers.get('content-disposition') || '');
}

// Depth-first search for the readable body: HTML preferred, plain text otherwise.
function pick(e, want) {
  if (!e.parts.length) return e.type === want && !isAttachment(e) ? e : null;
  if (e.type === 'multipart/related' && want === 'text/html') {
    const root = e.params.start ? e.parts.find((p) => (p.headers.get('content-id') || '') === e.params.start) : null;
    if (root && root.type === 'text/html') return root;
  }
  for (const p of e.parts) {
    const got = pick(p, want);
    if (got) return got;
  }
  return null;
}

// bytes -> { html, text, url, subject }
export function readMime(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const s = latin1(u8);
  const top = parseEntity(s, 0, s.length, 0);
  const subject = decodeHeader(top.headers.get('subject') || '').trim();
  const url = top.headers.get('snapshot-content-location') || '';
  let html = pick(top, 'text/html');
  // A saved page whose root part is not marked text/html (rare): take the first part at the snapshot URL.
  if (!html && url) html = top.parts.find((p) => p.headers.get('content-location') === url) || null;
  if (html) return { html: textOfEntity(s, html), text: null, url: html.headers.get('content-location') || url, subject };
  const plain = pick(top, 'text/plain');
  return { html: null, text: plain ? textOfEntity(s, plain) : '', url, subject };
}

// Headers that mark a MIME document: "From: <Saved by Blink>", MIME-Version, Content-Type.
export function mimeKind(head) {
  const block = head.slice(0, head.search(/\r?\n\r?\n/) > 0 ? head.search(/\r?\n\r?\n/) : 4096);
  const lines = block.split(/\r?\n/).slice(0, 60);
  let headerLines = 0;
  for (const l of lines) {
    if (/^[A-Za-z][A-Za-z0-9-]{0,60}:/.test(l)) headerLines++;
    else if (!/^[ \t]/.test(l) && l.trim()) return null;
  }
  if (headerLines < 2) return null;
  const h = parseHeaders(block);
  const ct = contentType(h.get('content-type'));
  if (!h.has('mime-version') && !h.has('content-type')) return h.has('from') && h.has('subject') ? 'eml' : null;
  if (ct.type === 'multipart/related' || h.has('snapshot-content-location')) return 'mhtml';
  if (h.has('from') || h.has('to') || h.has('subject') || h.has('received')) return 'eml';
  return ct.type === 'text/html' || ct.type.startsWith('multipart/') ? 'mhtml' : null;
}
