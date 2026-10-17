// Things a listener doesn't want read out: citations, footnote markers, DOIs.

const BRACKET_CITE = /[ \t]?\[(?:\d{1,4}(?:[ \t]?[–\-,;][ \t]?\d{1,4}){0,40}(?:,[ \t]?(?:p|pp)\.[ \t]?\d+(?:[–-]\d+)?)?|citation needed|clarification needed|according to whom\?|by whom\?|when\?|who\?|which\?|dubious(?: – discuss)?|discuss|verification needed|failed verification|better source needed|page needed|full citation needed|note \d+|n \d+|nb \d+|[a-z])\]/gi;

const CITE_NUM = '\\[\\d{1,4}(?:[ \\t]?[–\\-,;][ \\t]?\\d{1,4}){0,40}\\]';
const CITE_CHAIN = new RegExp(`[ \\t]?${CITE_NUM}(?:[ \\t]?(?:[–—\\-,;&]|and)?[ \\t]?${CITE_NUM})+`, 'g');

const NAME = "(?:[A-Z][\\p{L}'’\\-]+|van|von|de|der|den|del|da|di|la|le|du)";
const YEAR = '(?:(?:1[5-9]|20)\\d\\d[a-z]?|n\\.d\\.|in press|forthcoming)';
const LOCATOR = '(?:,\\s?(?:p|pp|ch|chap|sec|para)\\.?\\s?\\d+(?:[–-]\\d+)?)';
// (Patel, 2020) (Patel et al., 2019; Lee & Park, 2021) (see Jones 1999a, p. 4)
const CITE_PART = new RegExp(`^(?:(?:see|see also|e\\.g\\.,?|cf\\.|i\\.e\\.,?|but see|also)\\s+)?${NAME}(?:[\\s,]+(?:${NAME}|et al\\.?|and|&))*,?\\s+${YEAR}(?:,\\s?${YEAR})*${LOCATOR}?$`, 'u');
const BARE_YEAR = new RegExp(`^${YEAR}${LOCATOR}?$`);

function isCitation(inner) {
  if (inner.length > 400) return false;
  return inner.split(/;\s*/).every((p) => CITE_PART.test(p.trim()));
}

export function skipRules(t, ctx) {
  if (ctx.skip.citations) {
    // chains of numbered citations: '[1]–[3] and [5]', '[2], [4]'
    if (t.s.includes('][') || /\]\s?(?:[–—\-,;&]|and)\s?\[/.test(t.s)) t.replace(CITE_CHAIN, '');
    if (t.s.includes('[')) t.replace(BRACKET_CITE, '');
    if (t.s.includes('(')) {
      t.replace(/[ \t]?\(([^()\n]{3,400})\)/g, (m, s) => {
        const inner = m[1].trim();
        if (isCitation(inner)) return '';
        // a bare year after a name: 'Darwin (1859)', 'Patel et al. (2020)'
        if (BARE_YEAR.test(inner) && /(?:[A-Z][\p{L}'’-]+|al\.)\s*$/u.test(s.slice(Math.max(0, m.index - 40), m.index + (m[0][0] === '(' ? 0 : 1)))) return '';
        return null;
      });
    }
    // DOIs, arXiv and PubMed ids
    t.replace(/(?<![\w./])(?:doi:\s?|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/[^\s"<>]+|(?<![\w])(?:arXiv:\s?\d{4}\.\d{4,5}(?:v\d+)?|PMID:?\s?\d{5,9})/gi, (m) => {
      const trail = /[.,;:)\]]+$/.exec(m[0]);
      return trail ? trail[0] : '';
    });
    // a footnote number glued after sentence punctuation in PDFs: 'end.12 Next', 'studies,3 which'
    t.replace(/(?<=[a-z)][.!?]["'”’)]?)\d{1,3}(?=\s+["“]?[A-Z]|\s*$)|(?<=[a-z][,;])\d{1,3}(?=\s+[a-z])/g, '');
  }
  if (ctx.skip.footnoteMarks) {
    // ('A*' is a British exam grade, not a footnote)
    t.replace(/(?<=[\p{L}\p{N}.,;:!?)"'])(?<!(?<![\p{L}])A)[*†‡]+(?=\s|$|[.,;:!?)])/gu, '');
  }
  return t;
}
