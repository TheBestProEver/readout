// A stand-in for the GitHub gist API, shared by the browser tests (sync.e2e.mjs, v2.e2e.mjs).
import crypto from 'node:crypto';
import http from 'node:http';

export function fakeGitHub() {
  const tokens = new Map(); // token -> login
  const gists = new Map();
  const blobs = new Map();
  const log = [];
  const api = { tokens, gists, log, faults: [], listSecret: true, base: '', slow: null };
  const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, Link, Location, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
  };
  const send = (res, status, body, headers, slow) => {
    const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors, headers));
    if (!slow || !data) return res.end(data);
    const buf = Buffer.from(data);
    const size = Math.ceil(buf.length / slow.pieces);
    let i = 0;
    const next = () => {
      if (res.destroyed) return;
      if (i >= slow.pieces) return res.end();
      res.write(buf.subarray(i * size, (i + 1) * size));
      i++;
      setTimeout(next, i === Math.floor(slow.pieces / 2) && slow.stallMs ? slow.stallMs : slow.everyMs);
    };
    next();
  };
  const MB = 1024 * 1024;
  const cut = (s, bytes) => Buffer.from(s).subarray(0, bytes).toString('utf8');
  const gistJson = (g, withContent) => {
    const files = {};
    for (const [name, f] of g.files) {
      const size = Buffer.byteLength(f.content);
      files[name] = { filename: name, type: 'application/json', language: 'JSON', raw_url: `${api.base}/raw/${g.id}/${f.sha}/${encodeURIComponent(name)}`, size };
      if (withContent) Object.assign(files[name], { truncated: size > MB, content: size > MB ? cut(f.content, MB) : f.content, encoding: 'utf-8' });
    }
    return { id: g.id, url: `${api.base}/gists/${g.id}`, description: g.description, public: g.public, owner: { login: g.owner }, files, created_at: g.created_at, updated_at: g.updated_at, truncated: false };
  };
  const setFile = (g, name, content) => {
    const s = sha(content);
    blobs.set(s, content);
    g.files.set(name, { content, sha: s });
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const entry = { method: req.method, path: url.pathname + url.search, status: 0 };
      log.push(entry);
      const done = (status, b, h) => {
        entry.status = status;
        const slow = api.slow && api.slow.match(req.method, url.pathname) ? api.slow : null;
        send(res, status, b, h, slow);
      };
      if (url.pathname.startsWith('/raw/')) {
        // Like gist.githubusercontent.com: plain GETs only, preflights are refused.
        if (req.method === 'OPTIONS') return done(403, 'no');
        const [, , , s] = url.pathname.split('/');
        return blobs.has(s) ? done(200, blobs.get(s), { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=300' }) : done(404, 'missing');
      }
      if (req.method === 'OPTIONS') {
        entry.status = 204;
        res.writeHead(204, Object.assign({}, cors, {
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match, If-Modified-Since, X-GitHub-Api-Version',
          'Access-Control-Max-Age': '86400',
        }));
        return res.end();
      }
      const fault = api.faults.find((f) => f.match(req.method, url.pathname));
      if (fault) {
        if (fault.once) api.faults.splice(api.faults.indexOf(fault), 1);
        if (fault.drop) {
          entry.status = 'dropped';
          return req.socket.destroy();
        }
        return done(fault.status, { message: 'injected' }, fault.headers);
      }
      if (req.headers['x-github-api-version'] !== '2026-03-10') return done(400, { message: 'bad api version header' });
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const login = auth && tokens.get(auth[1]);
      if (!login) return done(401, { message: 'Bad credentials' });
      let json = null;
      if (body) {
        try {
          json = JSON.parse(body);
        } catch (e) {
          return done(400, { message: 'Problems parsing JSON' });
        }
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/user') return done(200, { login });
      if (url.pathname === '/gists' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') || 1);
        const per = Number(url.searchParams.get('per_page') || 30);
        const mine = [...gists.values()].filter((g) => g.owner === login && (g.public || api.listSecret));
        return done(200, mine.slice((page - 1) * per, page * per).map((g) => gistJson(g, false)));
      }
      if (url.pathname === '/gists' && req.method === 'POST') {
        if (!json || json.public !== false || !json.files) return done(422, { message: 'Validation Failed' });
        const id = crypto.randomBytes(16).toString('hex');
        const now = new Date().toISOString();
        const g = { id, owner: login, description: json.description, public: false, files: new Map(), created_at: now, updated_at: now };
        for (const [name, f] of Object.entries(json.files)) {
          if (!f || typeof f.content !== 'string' || !f.content) return done(422, { message: 'Validation Failed: content empty' });
          setFile(g, name, f.content);
        }
        gists.set(id, g);
        return done(201, gistJson(g, true));
      }
      if (parts[0] === 'gists' && parts.length === 2) {
        const g = gists.get(parts[1]);
        if (!g) return done(404, { message: 'Not Found' });
        if (req.method === 'GET') {
          const out = JSON.stringify(gistJson(g, true));
          const etag = 'W/"' + sha(out) + '"';
          if (req.headers['if-none-match'] === etag) return done(304, undefined, { ETag: etag });
          return done(200, out, { ETag: etag, 'Cache-Control': 'private, max-age=60, s-maxage=60' });
        }
        if (req.method === 'PATCH') {
          if (g.owner !== login) return done(404, { message: 'Not Found' });
          for (const [name, f] of Object.entries((json && json.files) || {})) {
            // Like GitHub: null, or an object with neither content nor filename, deletes the file.
            if (f === null || (typeof f === 'object' && !('content' in f) && !('filename' in f))) g.files.delete(name);
            else if (typeof f.content === 'string' && f.content) setFile(g, name, f.content);
            else return done(422, { message: 'Validation Failed' });
          }
          if (!g.files.size) return done(422, { message: 'Validation Failed: no files' });
          g.updated_at = new Date().toISOString();
          const out = JSON.stringify(gistJson(g, true));
          return done(200, out, { ETag: 'W/"' + sha(out) + '"' });
        }
      }
      done(404, { message: 'Not Found' });
    });
  });
  api.server = server;
  api.readFiles = (id) => Object.fromEntries([...gists.get(id).files].map(([k, f]) => [k, f.content]));
  api.writeFile = (id, name, content) => setFile(gists.get(id), name, content);
  return api;
}

