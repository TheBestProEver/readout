// Abbreviations that are expanded only in context. The titles and several general
// entries come from NVIDIA NeMo-text-processing whitelist/lj_speech.tsv and
// whitelist/tts.tsv (Apache-2.0), regrouped by the context each needs. See README.md.

// Before a capitalized name: 'Dr. Patel', 'Mr Jones', 'Prof. Lee'. `dotless` titles are
// also expanded without a full stop, as British English writes them.
export const TITLES = {
  Mr: 'Mister', Mrs: 'Missus', Ms: 'Miz', Mx: 'Mix', Messrs: 'Messieurs', Mme: 'Madame', Mlle: 'Mademoiselle',
  Dr: 'Doctor', Drs: 'Doctors', Prof: 'Professor', Profs: 'Professors', Rev: 'Reverend', Revd: 'Reverend', Fr: 'Father',
  Hon: 'Honorable', Gen: 'General', Lt: 'Lieutenant', Col: 'Colonel', Maj: 'Major', Capt: 'Captain', Cmdr: 'Commander',
  Cdr: 'Commander', Adm: 'Admiral', Brig: 'Brigadier', Sgt: 'Sergeant', Cpl: 'Corporal', Pvt: 'Private', Pte: 'Private',
  Gov: 'Governor', Sen: 'Senator', Rep: 'Representative', Pres: 'President', Supt: 'Superintendent', Insp: 'Inspector',
  Det: 'Detective', Cllr: 'Councillor', Amb: 'Ambassador', Atty: 'Attorney', Asst: 'Assistant', Assoc: 'Associate',
  St: 'Saint', Ste: 'Sainte', Mt: 'Mount', Ft: 'Fort', Sr: 'Sister', Br: 'Brother', Sgts: 'Sergeants', Rt: 'Right',
};
export const DOTLESS_TITLES = new Set(['Mr', 'Mrs', 'Ms', 'Mx', 'Dr', 'Prof', 'Revd', 'Rev', 'Fr', 'Cllr', 'Sgt', 'Cpl', 'Pte', 'Capt', 'Col', 'Lt', 'Maj', 'Det', 'Insp', 'Supt', 'St', 'Mt', 'Messrs', 'Mme', 'Mlle', 'Rt', 'Hon']);
// Titles that also take a lowercase word after them ('Mr. and Mrs. Jones').
export const ALWAYS_TITLES = new Set(['Mr', 'Mrs', 'Ms', 'Mx', 'Messrs', 'Hon', 'Rt']);

// After a name: 'Martin Luther King Jr.'
export const POST_NAME = { Jr: 'Junior', Jnr: 'Junior', Sr: 'Senior', Snr: 'Senior', Esq: 'Esquire' };

// After a street name or number: 'Elm St.', '5th Ave', 'Mulholland Dr.'
export const STREETS = {
  St: 'Street', Ave: 'Avenue', Av: 'Avenue', Rd: 'Road', Blvd: 'Boulevard', Ln: 'Lane', Dr: 'Drive', Ct: 'Court',
  Pl: 'Place', Sq: 'Square', Hwy: 'Highway', Pkwy: 'Parkway', Cres: 'Crescent', Terr: 'Terrace', Gdns: 'Gardens',
  Expy: 'Expressway', Fwy: 'Freeway', Bldg: 'Building',
};

// Only before a number: 'Fig. 3', 'pp. 12-14', 'No. 5', 's. 21'. Those in
// BEFORE_NUMBER_NODOT also work without a full stop ('No 10 Downing Street', 'Fig 3').
// ROMAN_AFTER ones also take a Roman numeral ('Book II, ch. III', 'Vol. IV').
export const BEFORE_NUMBER = {
  Fig: 'Figure', fig: 'figure', Figs: 'Figures', figs: 'figures', Eq: 'Equation', eq: 'equation', Eqs: 'Equations',
  eqs: 'equations', Eqn: 'Equation', eqn: 'equation', Tab: 'Table', Tbl: 'Table', Ch: 'Chapter', ch: 'chapter',
  Chs: 'Chapters', chs: 'chapters', Chap: 'Chapter', chap: 'chapter', Cap: 'Chapter', cap: 'chapter', Sec: 'Section', sec: 'section', Secs: 'Sections',
  Sect: 'Section', sect: 'section', Sects: 'Sections', sects: 'sections', Fol: 'Folio', fol: 'folio', fols: 'folios',
  Vol: 'Volume', vol: 'volume', Vols: 'Volumes', vols: 'volumes', Bk: 'Book', bk: 'book', Bks: 'Books',
  p: 'page', pp: 'pages', pg: 'page', Pg: 'Page', pgs: 'pages', No: 'Number', no: 'number', Nos: 'Numbers',
  nos: 'numbers', Nr: 'Number', Art: 'Article', art: 'article', Arts: 'Articles', Para: 'Paragraph', para: 'paragraph',
  Paras: 'Paragraphs', paras: 'paragraphs', Pt: 'Part', pt: 'part', Pts: 'Parts', Ex: 'Example', ex: 'exercise', Ref: 'Reference',
  Refs: 'References', Thm: 'Theorem', Lem: 'Lemma', Def: 'Definition', Prop: 'Proposition', Cor: 'Corollary',
  Exh: 'Exhibit', App: 'Appendix', Apx: 'Appendix', Sch: 'Schedule', Reg: 'Regulation', Regs: 'Regulations',
  s: 'section', ss: 'sections', cl: 'clause', Cl: 'Clause', Rm: 'Room', rm: 'room', Apt: 'Apartment',
  apt: 'apartment', Ste: 'Suite', Ext: 'extension', ext: 'extension', Tel: 'telephone', tel: 'telephone', Op: 'Opus',
  Ln: 'Line', l: 'line', ll: 'lines', v: 'verse', vv: 'verses', Max: 'Maximum', max: 'maximum', Min: 'Minimum',
  Avg: 'Average', avg: 'average', Approx: 'Approximately',
};
export const BEFORE_NUMBER_NODOT = new Set(['No', 'Fig', 'Figs', 'Eq', 'Eqs', 'Vol', 'Vols', 'Para', 'Paras', 'para', 'Art', 'Rm', 'Apt', 'Ext', 'ext', 'Op', 'Pt', 'Sec', 'Ch', 'Chap', 'Tab', 'Ref', 'Refs', 'Bk', 'pg', 'Pg']);
export const ROMAN_AFTER = new Set(['Ch', 'ch', 'Chs', 'chs', 'Chap', 'chap', 'Vol', 'vol', 'Vols', 'vols', 'Bk', 'bk', 'Pt', 'pt', 'Pts', 'Art', 'art', 'Sec', 'sec', 'Sect', 'sect', 'Para', 'para', 'No', 'App', 'Apx', 'Sch', 'p', 'pp', 'fol']);

// Anywhere (they are not ordinary words).
export const GENERAL = [
  ['e.g.', 'for example'], ['e.g', 'for example'], ['eg.', 'for example'], ['i.e.', 'that is'], ['i.e', 'that is'],
  ['ie.', 'that is'], ['i. e.', 'that is'], ['e. g.', 'for example'], ['q. v.', 'which see'],
  ['viz', 'namely'], ['inst.', 'instant'], ['ult.', 'ultimo'], ['prox.', 'proximo'], ['cf.', 'compare'], ['Cf.', 'Compare'], ['viz.', 'namely'], ['a.k.a.', 'also known as'],
  ['a.k.a', 'also known as'], ['aka', 'also known as'], ['N.B.', 'note'], ['n.b.', 'note'], ['NB:', 'Note:'],
  ['vs.', 'versus'], ['vs', 'versus'], ['Vs.', 'versus'], ['v.s.', 'versus'],
  ['approx.', 'approximately'], ['approx', 'approximately'], ['Approx.', 'Approximately'], ['esp.', 'especially'],
  ['incl.', 'including'], ['excl.', 'excluding'], ['w/o', 'without'], ['w/', 'with'], ['W/', 'With'], ['b/c', 'because'],
  ['c/o', 'care of'], ['a/c', 'account'], ['n/a', 'not applicable'], ['N/A', 'not applicable'], ['and/or', 'and or'],
  ['dept.', 'department'], ['Dept.', 'Department'], ['dept', 'department'], ['govt', 'government'],
  ['Govt', 'Government'], ["gov't", 'government'], ["Gov't", 'Government'], ["int'l", 'international'],
  ["Int'l", 'International'], ["nat'l", 'national'], ["Nat'l", 'National'], ['univ.', 'university'],
  ['Univ.', 'University'], ['misc.', 'miscellaneous'], ['Misc.', 'Miscellaneous'], ['et seq.', 'and following'],
  ['ibid.', 'ibid'], ['Ibid.', 'Ibid'], ['bldg.', 'building'], ['Bldg.', 'Building'], ['attn:', 'attention:'],
  ['Attn:', 'Attention:'], ['pls', 'please'], ['Pls', 'Please'], ['plz', 'please'], ['thx', 'thanks'], ['Thx', 'Thanks'],
  ['pcm', 'per calendar month'], ['YoY', 'year over year'], ['QoQ', 'quarter over quarter'], ['p.a.', 'per annum'], ['p.w.', 'per week'], ['Mfg.', 'Manufacturing'],
  ['Intl.', 'International'], ['RE:', 'Re:'], ['FW:', 'Forward:'], ['Fw:', 'Forward:'], ['FWD:', 'Forward:'], ['Fwd:', 'Forward:'], ['Assn.', 'Association'], ["Ass'n", 'Association'], ['Ph.D.', 'P H D'],
  ['Ph.D', 'P H D'], ['Ph. D.', 'P H D'], ['D.Phil.', 'D Phil'], ['q.v.', 'which see'], ['op. cit.', 'op cit'],
  ['loc. cit.', 'loc cit'], ['sc.', 'namely'], ['ff.', 'and following'], ['seq.', 'following'], ['resp.', 'respectively'],
];
// Expanded anywhere, keeping the full stop when they end the sentence ('... and so on, etc.').
export const SENTENCE_END = [
  ['etc.', 'et cetera'], ['etc', 'et cetera'], ['&c.', 'et cetera'], ['&c', 'et cetera'], ['et al.', 'and others'],
  ['et al', 'and others'], ['Inc.', 'Incorporated'], ['Ltd.', 'Limited'], ['Ltd', 'Limited'], ['Corp.', 'Corporation'],
  ['Bros.', 'Brothers'], ['plc', 'P L C'], ['PLC', 'P L C'], ['LLC', 'L L C'], ['LLP', 'L L P'], ['Co.', 'Company'],
];

export const WEEKDAYS = { Mon: 'Monday', Tue: 'Tuesday', Tues: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Thur: 'Thursday', Thurs: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
