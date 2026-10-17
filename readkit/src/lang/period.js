// Older English spellings (17th-19th century print: Hume, Johnson, Defoe, Austen,
// the King James Bible) that the modern word list lacks. OCR correction must keep
// them: 'expence' is what the page says, not a misread of 'expense'.
// A short list of forms, plus rules for regular patterns (publick -> public,
// errour -> error, surprize -> surprise, loveth -> love), each checked against the
// modern word list so only real old spellings of real words pass.

const LIST = (
  'expence expences recompence recompenced dispence dispenced chuse chuses chusing encrease encreased encreases encreasing ' +
  'encreasingly intire intirely croud crouds crouded cloaths cloathed cloathing cloath oeconomy oeconomical oeconomist ' +
  'oeconomists chymist chymists chymistry chymical desart desarts phrenzy controul controuled controuling controuls ' +
  'uncontroulable ancle ancles befal befel befals dependance independance negociate negociated negociating negociation ' +
  'negociations negociator rhime rhimes falshood falshoods chace chaced cotemporary cotemporaries thro antient antiently ' +
  'antients compleatly compleated burthens burthened burthensome murther murthers murthered ' +
  'murtherer murtherers fewel skreen skreens stomack stomacks spunge sope gulph gulphs lanthorn sallad cyder segar tyger ' +
  'tygers syren artizan artizans partizans recal recals inthral dutchess dutchy groupe slily stupify ' +
  'dropt stopt stept mixt fixt drest prest opprest possest distrest cloke shoar tenour neice seise seised ' +
  'onely meer meerly aera aeras phaenomenon phaenomena aetherial ballances ballanced reflexion reflexions ' +
  'inflexions musick publick publickly logick physick critick criticks rhetorick ' +
  'arithmetick mechanick mechanicks politicks catholick domestick domesticks traffick trafficks ' +
  'authour authours errour errours terrour terrours horrour governour governours emperour emperours ambassadour ' +
  'ambassadours superiour superiours inferiour inferiours exteriour interiour anteriour posteriour mirrour mirrours ' +
  'tenour oratour successour successours predecessour predecessours ancestour ancestours surprize surprized surprizing ' +
  'surprizes enterprize enterprizes despight spight atchieve atchieved atchievement atchievements chearful chearfully ' +
  'chearfulness intreat intreated intreaty intreaties inclose inclosed inclosure inclosures indorse indorsed ' +
  'imbark imbarked imploy imployed imployment imployments goeth doeth doest goest seeth'
).split(' ');

const SET = new Set(LIST);
export const periodWords = SET;

// Old forms that the modern list already has: never "corrected" to their modern
// neighbours, however unsure the OCR was ('shew' is not a misread 'show').
export const archaic = new Set(
  (
    'shew shews shewn shewed shewing compleat burthen partizan serjeant ballance inflexion connexion connexions ' +
    'almanack hath doth thee thou thy thine ye whilst amongst tho hither thither whither whence wherefore saith shalt ' +
    'wilt gaol gaols waggon waggons stile sate spake brake clomb holpen wrought durst hast mayst mightst couldst ' +
    'wouldst shouldst wast wert'
  ).split(' ')
);

// Old endings and the modern ones they stand for.
const RULES = [
  [/ick(s|ly|al|ally)?$/, 'ic$1'], // publick, musick, logically
  [/our(s|ed|ing)?$/, 'or$1'], // errour, governour (only when the -or form is a word and the -our form isn't)
  [/ence(s|d)?$/, 'ense$1'], // expence, recompence
  [/iz(e|es|ed|ing)$/, 'is$1'], // surprize
  [/^oe/, 'e'], // oeconomy
  [/ae/, 'e'], // phaenomena
  [/([^aeiou])eth$/, '$1e'], // maketh, giveth, loveth
  [/eth$/, ''], // goeth, speaketh
  [/([^aeiou])est$/, '$1e'], // makest, givest
  [/([wk])est$/, '$1'], // knowest, speakest
];

// Is `w` (lowercase, no punctuation) an older spelling of a modern word?
// `has` is the modern word list's has().
export function isPeriod(w, has) {
  if (!w || w.length < 4) return false;
  if (SET.has(w)) return true;
  if (has(w)) return false;
  for (const [re, to] of RULES) {
    if (!re.test(w)) continue;
    const modern = w.replace(re, to);
    if (modern !== w && modern.length >= 3 && has(modern)) return true;
  }
  return false;
}
