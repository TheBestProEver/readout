// The junk-token guard: OCR and PDF garbage such as '{P23gf49y' is never read aloud,
// while real codes (B12, CO2, x86, MP3, 4K, COVID-19, iPhone, Wi-Fi, C6H12O6, ISBNs) are kept.

import { Tracked } from './tracked.js';

const ELEMENTS = new Set(`H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr
Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt
Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og`.split(/\s+/));
const OK_SYMBOLS = new Set(['&', '+', '-', '=', '/', '%', '*', '#', '@', '$', '£', '€', '¥', '₹', '×', '÷', '±', '<', '>', '≤', '≥', '≠', '≈', '~', '→', '←', '↔', '⇒', '•', '·', '§', '§§', '¶', '°', '+/-', '->', '<-', '=>', '<=', '>=', '!=', '==', '<>', '<->', '^', '|', '\\']);
const VOWELLESS_OK = new Set(['https', 'xhtml', 'cwtch', 'crwth', 'cwmns', 'pffft', 'tsktsk', 'grrrl', 'nthly']);
const INTERJECTION = /^(?:h+m+|m+h*m+|s+h+|b+r+|g+r+|p+s+t+|p+f+t+|z+|m+|t+s+k+|c+r+|h+r+m+p+h*)$/;

// C6H12O6, C2H5OH, NaHCO3: element symbols with counts.
function isFormula(run) {
  if (!/^(?:[A-Z][a-z]?\d*)+$/.test(run)) return false;
  const els = run.match(/[A-Z][a-z]?/g);
  return els.length >= 2 && els.every((e) => ELEMENTS.has(e));
}

// Brackets, pipes and the like inside a word are OCR noise, except in maths.
function okInner(core) {
  return /^[\p{L}\p{N}_.,()+\-=−/]*\^[\p{L}\p{N}_.()+\-−]+$/u.test(core) || /^[\w.]+(?:<=?|>=?|->|<-|=>)[\w.-]+$/.test(core) || /^~\d/.test(core);
}

function symbolJunk(tok) {
  if (OK_SYMBOLS.has(tok)) return false;
  if (/\p{Extended_Pictographic}/u.test(tok)) return false;
  if (/^([-–—=_~*#•·.…!?])\1*$/.test(tok)) return false;
  if (/[{}|\\^`~¦]/.test(tok)) return true;
  // punctuation left over from spacing ('."', '),', '--') is tidied later, not junk
  const rest = tok.replace(/[.,;:!?'"“”‘’()[\]…\-–—*/]/g, '');
  if (!rest) return false;
  return tok.length >= 2 && !/^[$£€¥₹%#@&+=°§¶†‡]$/.test(rest);
}

// Spacing accents with nothing to sit on ('ʃ˚¨ˆ') only come from bad text layers.
const LOOSE_ACCENT = /[¨¯¸˚˙˛˜˝ˆˇ˘]/;
// A symbol inside a run of letters and digits: 'Xj3$k9#', 'a@1b'
const INNER_SYMBOL = /[\p{L}\p{N}][$#%*~|][\p{L}\p{N}]/u;
// ... but a prefixed dollar amount is money (rules/money.js reads it): 'US$5', 'C$20', 'HK$1.5bn'
const PREFIXED_DOLLARS = /^(?:US|AU|A|CA|C|NZ|HK|S)\$(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:k|K|m|M|mn|mln|mil|bn|bln|b|B|tn|T)?(?:\/[a-z]+)?$/;

export function isJunk(token) {
  const tok = String(token ?? '');
  if (!tok.trim()) return false;
  if (/[\x00-\x08\x0e-\x1f�]/.test(tok)) return true;
  const core = tok.replace(/^[(\[{"'“‘«¿¡]+/, '').replace(/[)\]}"'”’».,;:!?…]+$/, '');
  if (!/[\p{L}\p{N}]/u.test(core)) return symbolJunk(tok);
  if (/[{}[\]<>|\\^`~]/.test(core) && !okInner(core)) return true;
  if (LOOSE_ACCENT.test(core)) return true;
  if (INNER_SYMBOL.test(core) && /\p{N}/u.test(core) && /\p{L}/u.test(core) && !PREFIXED_DOLLARS.test(core)) return true;
  if (/^(?:0x)?[0-9a-f]{12,}$/i.test(core) && /\d/.test(core) && /[a-f]/i.test(core)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(core)) return true;
  // four or more letter/digit switches in one run: P23gf49y, a1b2c3d4, 0O0O0O
  for (const run of core.match(/[A-Za-z0-9]+/g) || []) {
    if (run.length >= 5 && run.match(/[A-Za-z]+|\d+/g).length >= 5 && !isFormula(run)) return true;
  }
  // long lowercase runs with no vowel at all: 'rnrnrnm', 'tlrnnm'
  const letters = core.replace(/[^A-Za-z]/g, '').toLowerCase();
  if (!INTERJECTION.test(letters)) {
    for (const run of core.match(/[a-z]{5,}/g) || []) {
      if (!/[aeiouy]/.test(run) && !VOWELLESS_OK.has(run)) return true;
    }
  }
  // I, l, 1 and | mixed together: 'lllIlll', 'Il1l'
  for (const run of core.match(/[Il1|]{4,}/g) || []) {
    if (new Set(run).size >= 2) return true;
  }
  return false;
}

// Tokens that later rules read specially (links, addresses, internal placeholders).
const PROTECTED = /:\/\/|^[("'[<]*www\.|@|[-]/i;

// Drops junk tokens from a Tracked in place and lists them in `dropped`.
export function junkTracked(t, dropped = []) {
  t.replace(/\S+/g, (m) => {
    const tok = m[0];
    if (PROTECTED.test(tok) || !isJunk(tok)) return null;
    dropped.push(tok);
    return '';
  });
  return t;
}

export function dropJunk(text) {
  const dropped = [];
  const t = junkTracked(Tracked.of(String(text ?? '')), dropped);
  return { text: t.s.replace(/[ \t]{2,}/g, ' '), dropped };
}
