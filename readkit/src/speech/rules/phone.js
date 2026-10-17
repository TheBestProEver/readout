// Phone numbers, read in groups with a pause between them.
//   US: (312) 555-0199, 312-555-0199, 312.555.0199, +1 312 555 0199, 1-800-555-0199, 'call 555-0199'
//   UK: 020 7946 0958, 07700 900123, 0161 496 0000, +44 20 7946 0958, +44 (0)20 7946 0958
//   elsewhere: +33 1 23 45 67 89
//   'call 911', 'dial 999': digit by digit

import { digits } from '../numbers.js';

const groups = (list) => list.map((g) => digits(g, 'oh')).join(', ');
// Toll-free area codes are said 'eight hundred'.
const area = (g) => (/^[2-9]00$/.test(g) ? digits(g[0]) + ' hundred' : digits(g, 'oh'));
const say = (lead, a, b, c) => (lead ? 'one, ' : '') + [area(a), digits(b, 'oh'), digits(c, 'oh')].join(', ');

const END = '(?![\\w\\-]|\\.\\d)';
const US_PAREN = new RegExp(`(?<![\\w+\\-.])(?:(\\+?1)[\\s.\\-]?)?\\((\\d{3})\\)[\\s.\\-]?(\\d{3})[\\s.\\-](\\d{4})${END}`, 'g');
// Same separator throughout, so '100 200 3000' (a list) isn't a phone number.
const US_SEP = new RegExp(`(?<![\\w+\\-.])(?:(\\+?1)[.\\-])?(\\d{3})([.\\-])(\\d{3})\\3(\\d{4})${END}`, 'g');
const US_PLUS = new RegExp(`(?<![\\w+\\-.])\\+1[\\s.\\-]?(\\d{3})[\\s.\\-](\\d{3})[\\s.\\-](\\d{4})${END}`, 'g');
const US_LOCAL = /(?<=\b(?:call|phone|tel|telephone|fax|dial|text|ring|cell|mobile|number|at|on|or)[:.]?[ \t]{1,3})(\d{3})-(\d{4})(?![\w\-])/gi;
const UK = new RegExp(`(?<![\\w+\\-.])(?:(\\+44)[ \\t]?(?:\\(0\\)[ \\t]?)?|0)(\\d{2,4})[ \\t\\-](\\d{3,6})(?:[ \\t\\-](\\d{3,4}))?${END}`, 'g');
const INTL = /(?<![\w+])\+(\d{1,3})((?:[ \t.\-]\(?\d{1,5}\)?){2,6})(?![\w\-])/g;
const EMERGENCY = /(?<=\b(?:call|dial|ring|phone|text|Call|Dial|Ring|Phone|Text)[ \t](?:NHS[ \t]|the police on[ \t])?|\bNHS[ \t])(911|999|112|111|101|988|211|311|411)\b/g;

export function phoneRules(t) {
  if (!/\d{3}/.test(t.s)) return t;
  t.replace(US_PAREN, (m) => say(m[1], m[2], m[3], m[4]));
  t.replace(US_PLUS, (m) => say(true, m[1], m[2], m[3]));
  t.replace(US_SEP, (m) => say(m[1], m[2], m[4], m[5]));
  t.replace(US_LOCAL, (m) => groups([m[1], m[2]]));
  t.replace(UK, (m) => {
    const parts = [m[2], m[3], m[4]].filter(Boolean);
    // ten digits after the leading 0 or +44
    if (parts.join('').length !== 10) return null;
    if (m[1]) return 'plus four four, ' + groups(parts);
    return groups(['0' + parts[0], ...parts.slice(1)]);
  });
  if (t.s.includes('+')) {
    t.replace(INTL, (m) => {
      const parts = m[2].match(/\d+/g);
      const n = m[1].length + parts.join('').length;
      if (n < 8 || n > 15) return null;
      return 'plus ' + digits(m[1]) + ', ' + groups(parts);
    });
  }
  t.replace(EMERGENCY, (m) => digits(m[1]));
  return t;
}
