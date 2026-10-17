// Small helpers shared by the rule modules.

// Words that usually start a sentence. After an abbreviation that can also end one
// ('etc.', 'U.S.', 'p.m.', 'Inc.'), one of these means the full stop ends the sentence.
export const STARTERS = new Set(`The A An It Its This That These Those He She We They I You In On At But And Or So Yet For
However There Here His Her Our Their My Your If When While After Before As Since Then Now Also Some Many Most All No Not
Every Each Both Neither Either What Who Why How Where Which Although Though Because Unless Until Today Yesterday Tomorrow
Meanwhile Still Instead Thus Hence Therefore Moreover Furthermore Finally First Second Third Next Last Other Such Only Even
Just Please Thanks Thank Let Do Does Did Is Are Was Were Has Have Had Can Could Will Would Should Might Must Mr Mrs Ms Dr
Several Few Another One Two Three Four Five Six Seven Eight Nine Ten Earlier Later Overall Indeed Nevertheless Similarly
Likewise Again Despite During Under Over With Without From To By Of About Yes Well Oh OK Okay Sure Sorry Hi Hello Dear
Note Remember Keep Bring Take Make Call See Add Use Go Come Get Put Turn Click Open Close Check Read Send Visit Contact
Ask Tell Try Find Look Stop Start Wait Give Leave Mix Stir Bake Cook Heat Place Pour Serve Cut Combine Whisk Preheat
Write Enter Select Choose Press Follow Join Meet Sign Fill Return Buy Pay Order Book Watch Listen Think Imagine Consider
Never Always Sometimes Perhaps Maybe Otherwise Afterwards Soon Once Whether Whatever Whoever Unlike Like Beyond Along
Across Among Between Within Following According Besides Together Above Below Around Inside Outside Toward Towards Upon
Nor Nobody Nothing Everyone Everything Someone Something Anyone Nobody None Most Much More Less Few Plus Also Yet`.split(/\s+/));

const END = /[\s"')\]]*$/y;
const NEXT_WORD = /\s+([A-Z][a-z]*)/y;
const NEXT_CAP = /\s+["'“‘(]*(\p{Lu}[\p{L}]*)/uy;
// Capitalized words that carry on a sentence after 'p.m.': '5 p.m. Eastern', 'p.m. EST'
const AFTER_TIME = /^(?:Eastern|Pacific|Central|Mountain|Atlantic|Greenwich|British|GMT|BST|UTC|EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|IST|AEST|ET|PT|CT|MT|Z)$/;

// Like endDot, but any capitalized word after the abbreviation starts a new sentence
// ('etc. Bring', '5 p.m. Then'), except a time zone after a time.
export function endDotCap(s, i) {
  if (atEnd(s, i)) return '.';
  NEXT_CAP.lastIndex = i;
  const m = NEXT_CAP.exec(s);
  return m && !AFTER_TIME.test(m[1]) ? '.' : '';
}

// Nothing but closing punctuation and spaces until the end of the string.
export function atEnd(s, i) {
  END.lastIndex = i;
  return END.test(s);
}

// After an abbreviation whose full stop was consumed: put it back if the sentence ends there.
export function endDot(s, i) {
  if (atEnd(s, i)) return '.';
  NEXT_WORD.lastIndex = i;
  const m = NEXT_WORD.exec(s);
  return m && STARTERS.has(m[1]) ? '.' : '';
}

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// One regex alternation from a list of literal strings, longest first.
export const alternation = (list) => [...new Set(list)].sort((a, b) => b.length - a.length).map(escapeRe).join('|');

export const capitalize = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);

export const spellLetters = (w) => w.replace(/[^A-Za-z]/g, '').toUpperCase().split('').join(' ');

// The word just before index i (letters, digits, dots, apostrophes), at most 40 chars back.
export function wordBefore(s, i) {
  const m = /([\w.'’-]+)\s*$/.exec(s.slice(Math.max(0, i - 40), i));
  return m ? m[1] : '';
}

// The word just after index i.
const AFTER = /\s*([\w'’-]+)/y;
export function wordAfter(s, i) {
  AFTER.lastIndex = i;
  const m = AFTER.exec(s);
  return m ? m[1] : '';
}
