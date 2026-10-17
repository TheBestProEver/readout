// A string that remembers where each of its characters came from in the source text.
// Every rewrite (cleaning, verbalizing) goes through replace(), so after "Dr. Patel paid
// $5" becomes "Doctor Patel paid five dollars" we still know that "five dollars" came
// from "$5". plan() turns this into the word alignment used for highlighting.
//
// For character i, [a[i], b[i]) is its source range. Inserted text maps to the whole
// range of what it replaced; the ranges never go backwards.

export class Tracked {
  constructor(s, a, b) {
    this.s = s;
    this.a = a;
    this.b = b;
  }

  // Identity mapping for text that starts at `base` in the source.
  static of(text, base = 0) {
    const s = String(text);
    const n = s.length;
    const a = new Int32Array(n);
    const b = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = base + i;
      b[i] = base + i + 1;
    }
    return new Tracked(s, a, b);
  }

  // New text standing for source characters [from, to): 'Three.' for a list marker '3)'.
  static span(text, from, to) {
    const s = String(text);
    return new Tracked(s, new Int32Array(s.length).fill(from), new Int32Array(s.length).fill(to));
  }

  // Joins tracked pieces, with an untracked separator mapped to the gap between them.
  static concat(parts, sep = ' ') {
    let n = 0;
    parts.forEach((p, k) => (n += p.s.length + (k && sep ? sep.length : 0)));
    const a = new Int32Array(n);
    const b = new Int32Array(n);
    let s = '';
    let pos = 0;
    parts.forEach((p, k) => {
      if (k && sep) {
        const at = p.a.length ? p.a[0] : pos ? b[pos - 1] : 0;
        a.fill(at, pos, pos + sep.length);
        b.fill(at, pos, pos + sep.length);
        pos += sep.length;
        s += sep;
      }
      s += p.s;
      a.set(p.a, pos);
      b.set(p.b, pos);
      pos += p.s.length;
    });
    return new Tracked(s, a, b);
  }

  get length() {
    return this.s.length;
  }

  // Source range covered by characters [i, j) of this string.
  range(i, j) {
    if (j <= i) {
      const at = i < this.a.length ? this.a[i] : this.b.length ? this.b[this.b.length - 1] : 0;
      return [at, at];
    }
    let lo = this.a[i];
    let hi = this.b[j - 1];
    // Ranges are monotonic, but be safe if a rule ever emits parts out of order.
    for (let k = i; k < j; k++) {
      if (this.a[k] < lo) lo = this.a[k];
      if (this.b[k] > hi) hi = this.b[k];
    }
    return [lo, hi];
  }

  // Rewrites every match of the global regex `re` (a regex without the g flag rewrites
  // its first match only). `fn(m, s)` gets the exec() match and the current string and returns:
  //   - a string (mapped to the whole match), or
  //   - an array of parts, each a string (whole match) or [text, from, to] with from/to
  //     relative to the match, so words can map to just their own source characters, or
  //   - null/undefined, or the match itself, to leave it alone.
  // `fn` may also be a constant string.
  replace(re, fn) {
    const s = this.s;
    re.lastIndex = 0;
    let m = re.exec(s);
    if (!m) return this;
    const a = this.a;
    const b = this.b;
    const out = [];
    // ops: [-1, from, to] copies source-mapped characters; [len, lo, hi] maps new text
    const ops = [];
    let total = 0;
    let last = 0;
    const copy = (from, to) => {
      if (to <= from) return;
      out.push(s.slice(from, to));
      ops.push(-1, from, to);
      total += to - from;
    };
    const emit = (text, from, to) => {
      if (!text) return;
      // `from`/`to` are absolute indexes into s; an empty range maps to a point
      let lo;
      let hi;
      if (to > from) {
        lo = a[from];
        hi = b[to - 1];
      } else {
        lo = hi = from < a.length ? a[from] : b.length ? b[b.length - 1] : 0;
      }
      out.push(text);
      ops.push(text.length, lo, hi);
      total += text.length;
    };
    const once = !re.global;
    let changed = false;
    for (; m; m = once ? null : re.exec(s)) {
      const len = m[0].length;
      if (!len) {
        re.lastIndex++;
        continue;
      }
      const i = m.index;
      const r = typeof fn === 'string' ? fn : fn(m, s);
      if (r == null || r === m[0]) continue;
      changed = true;
      copy(last, i);
      if (typeof r === 'string') emit(r, i, i + len);
      else {
        for (const p of r) {
          if (typeof p === 'string') emit(p, i, i + len);
          else emit(p[0], i + p[1], i + Math.max(p[1], p[2]));
        }
      }
      last = i + len;
    }
    if (!changed) return this;
    copy(last, s.length);
    const A = new Int32Array(total);
    const B = new Int32Array(total);
    let pos = 0;
    for (let k = 0; k < ops.length; k += 3) {
      const n = ops[k];
      if (n < 0) {
        const from = ops[k + 1];
        const to = ops[k + 2];
        A.set(a.subarray(from, to), pos);
        B.set(b.subarray(from, to), pos);
        pos += to - from;
      } else {
        A.fill(ops[k + 1], pos, pos + n);
        B.fill(ops[k + 2], pos, pos + n);
        pos += n;
      }
    }
    this.s = out.join('');
    this.a = A;
    this.b = B;
    return this;
  }
}
