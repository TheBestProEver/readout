// Contexts for Roman numerals. The cue words extend NVIDIA NeMo-text-processing
// roman/key_word.tsv (Apache-2.0: chapter, class, part, article, section, paragraph).
// The regnal names are readkit's own list.

// '<cue> IV' is read as a cardinal: 'Chapter four', 'World War two', 'Type one diabetes'.
export const CUES = `Chapter Chapters Class Part Parts Article Articles Section Sections Paragraph Book Books Volume Vol Act Scene
Appendix Annex Schedule Phase Stage Level Type Title Psalm Psalms Canto Grade Unit Lesson Round Episode Season Series
Division Tier Category Mark Mk Plate Exhibit Amendment Clause Rule Track Movement Op Wave Step Problem Exercise Question
Lecture Session Form Year Apollo Gemini Figure Table Sura Surah Item Number`.split(/\s+/);
export const CUE_PHRASES = ['World War', 'Super Bowl', 'Star Wars Episode', 'Vatican Council'];

// '<name> VIII' is read as 'the Eighth': 'Henry the Eighth', 'Pope John Paul the Second'.
export const REGNAL_NAMES = `Henry Edward George William Elizabeth Charles James Richard Mary Anne Victoria John Louis Philip
Peter Catherine Frederick Napoleon Ramesses Ramses Pius Benedict Gregory Leo Paul Innocent Clement Urban Alexander
Nicholas Ivan Ferdinand Isabella Francis Constantine Ptolemy Alfonso Carlos Felipe Juan Gustav Gustavus Haakon Olaf
Harald Christian Wilhelm Otto Rudolf Selim Mehmed Suleiman Darius Xerxes Cyrus Amenhotep Thutmose Seti Ludwig Edmund
Malcolm David Robert Stephen Matilda Harold Canute Cnut Ethelred Kenneth Rama Bhumibol Boniface Celestine Sixtus Julius
Adrian Hadrian Eugene Martin Honorius Theodore Basil Michael Andronikos Manuel Leopold Maximilian Joseph Sigismund
Casimir Sobieski Vladislav Wladyslaw Stanislaus Erik Eric Magnus Valdemar Margaret Juliana Beatrix Wilhelmina Albert
Baudouin Umberto Vittorio Emmanuel Pedro Joao Sancho Afonso Duarte Manuel Fuad Farouk Abdullah Hussein Faisal Mohammed
Hassan Akihito Rainier Grimaldi Mswati Letsie Tupou Kamehameha Liliuokalani Jadwiga Zog Carol Mihai Boris Simeon
Ferdinand Alexios Romanos Justinian Herod Antiochus Seleucus Cleopatra Arsinoe Berenice Agrippa`.split(/\s+/);
// Titles that make the next capitalized word a regnal name: 'King Zog I', 'Pope Pius XII'.
export const REGNAL_TITLES = ['King', 'Queen', 'Pope', 'Emperor', 'Empress', 'Tsar', 'Czar', 'Tsarina', 'Kaiser', 'Sultan', 'Pharaoh', 'Shah', 'Prince', 'Princess', 'Duke', 'Duchess', 'Grand Duke', 'Earl', 'Count', 'Countess', 'Baron', 'Saint'];
