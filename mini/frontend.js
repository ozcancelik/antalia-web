// Antalia Mini text frontend, ported from antalia_mini/text (__init__.py, normalize.py, foreign.py)
// to a dependency-free ES module for browsers (Chrome, Safari 16.4+) and Node.
//
//   const fe = await loadFrontend("assets/frontend-data.json.gz");
//   fe.toModelText("15 Ekim'de 1.250.000 TL ödendi.")   // == antalia_mini.text.to_model_text
//   fe.encode(fe.toModelText(raw))                      // == antalia_mini.text.encode
//
// The Python is the source of truth; every function below mirrors one there, in the same order, and
// web/tests/parity/run_parity.mjs checks exact output equality. Python regular expressions are
// written here in Python syntax and translated by `py()` (Unicode \w \d \s \b, Python $, and the
// IGNORECASE rule that i, I, ı and İ all match each other). Where Python raises (a KeyError in
// `_respell_span` for a lexicon term matched with a dotless ı, e.g. "ınstagram"), this port throws an
// Error whose name is the Python exception's.
//
// Data (CMU respellings, Turkish vocabulary sets, reviewed lexicon) comes from the asset built by
// web/tools/build_frontend_data.py.
//
// Known residual difference: the Unicode version. Python 3.12's unicodedata is Unicode 15.0; JS
// engines use their own (Node 24: 17.0). For characters assigned after 15.0 (new emoji, scripts),
// \p{L}/\p{N}/\p{So}, NFKC and case mappings can disagree with Python (e.g. a new emoji is dropped
// as So here but kept by Python, which sees it as unassigned). Everything else is exact as far as
// the parity test reaches (web/tests/parity: 1167 sentences, 100%). Python int() is unbounded, so
// numbers are BigInt here; \d is Unicode Nd as in Python (Arabic-Indic digits are read too).

// ---------------------------------------------------------------- Python regex translation

const W = "\\p{L}\\p{N}_"; // Python 3 str \w: str.isalnum() or "_"
const S = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"; // str.isspace()
const BOUNDARY = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`; // Unicode \b
const I4 = "iIıİ"; // re.IGNORECASE: each of these matches all four
const JS_SYNTAX = "^$\\.*+?()[]{}|/";
const CLASS_SPECIAL = {
  "^\\W\\d_": "[\\p{L}\\p{Nl}\\p{No}]", // letters (and non-decimal numerics), as Python's [^\W\d_]
  "^\\W_": "[\\p{L}\\p{N}]",
};
const reCache = new Map();

/** Translate a Python `re` pattern (str, Unicode) to an equivalent JS RegExp ("u" is always on;
 * "i" means re.IGNORECASE). */
function py(src, flags = "") {
  const cacheKey = flags + "\u0000" + src;
  const hit = reCache.get(cacheKey);
  if (hit) return hit;
  const ic = flags.includes("i");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      const d = src[i + 1];
      i += 2;
      if (d === "w") out += `[${W}]`;
      else if (d === "W") out += `[^${W}]`;
      else if (d === "d") out += "\\p{Nd}";
      else if (d === "D") out += "\\P{Nd}";
      else if (d === "s") out += `[${S}]`;
      else if (d === "S") out += `[^${S}]`;
      else if (d === "b") out += BOUNDARY;
      else if (/[1-9]/.test(d)) out += "\\" + d;
      else if (/[A-Za-z0]/.test(d)) throw new Error(`py(): unsupported escape \\${d} in ${src}`);
      else out += literal(d, ic);
      continue;
    }
    if (c === "[") {
      const [cls, next] = translateClass(src, i, ic);
      out += cls;
      i = next;
      continue;
    }
    if (c === ".") out += "[^\\n]";
    else if (c === "$") out += "(?=\\n?(?![\\s\\S]))"; // Python $: the end, or before a final newline
    else if (c === "(" && src[i + 1] === "?" && src[i + 2] === "P") throw new Error("py(): named groups unsupported");
    else if (ic && I4.includes(c)) out += "[iIıİ]";
    else out += c;
    i++;
  }
  const re = new RegExp(out, "u" + flags);
  reCache.set(cacheKey, re);
  return re;
}

function literal(ch, ic) {
  if (JS_SYNTAX.includes(ch)) return "\\" + ch;
  if (ic && I4.includes(ch)) return "[iIıİ]";
  return ch;
}

function translateClass(src, start, ic) {
  let j = start + 1;
  if (src[j] === "^") j++;
  if (src[j] === "]") j++; // a "]" first in the class is literal in Python
  while (src[j] !== "]") {
    if (src[j] === "\\") j++;
    j++;
    if (j >= src.length) throw new Error("py(): unterminated class in " + src);
  }
  const raw = src.slice(start + 1, j);
  if (CLASS_SPECIAL[raw]) return [CLASS_SPECIAL[raw], j + 1];
  let k = 0;
  let neg = "";
  if (raw[0] === "^") {
    neg = "^";
    k = 1;
  }
  let body = "";
  for (; k < raw.length; k++) {
    const c = raw[k];
    if (c === "\\") {
      const d = raw[++k];
      if (d === "w") body += W;
      else if (d === "d") body += "\\p{Nd}";
      else if (d === "s") body += S;
      else if (/[A-Za-z0-9]/.test(d)) throw new Error(`py(): unsupported class escape \\${d} in ${src}`);
      else body += "-]\\^[".includes(d) ? "\\" + d : d;
    } else if (c === "[") body += "\\[";
    else if (c === "]") body += "\\]";
    else body += c;
  }
  if (ic) {
    const probe = new RegExp(`[${body}]`, "iu");
    if ([...I4].some((ch) => probe.test(ch))) body += I4;
  }
  return [`[${neg}${body}]`, j + 1];
}

/** Python re.escape (3.7+): escapes ()[]{}?*+-|^$\.&~# and whitespace controls. */
function pyEscape(s) {
  return s.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, "\\$&");
}

const g = (src, flags = "") => py(src, "g" + flags);

/** re.sub with a function: the callback gets a match-like array (m[0], m[1]..., m.index, m.input);
 * unmatched groups are undefined (Python None). */
function sub(re, text, fn) {
  return text.replace(re, (...args) => {
    let n = args.length;
    if (typeof args[n - 1] === "object" && args[n - 1] !== null) n--; // named groups object
    const input = args[n - 1];
    const index = args[n - 2];
    const m = args.slice(0, n - 2);
    m.index = index;
    m.input = input;
    return fn(m);
  });
}

const endCache = new Map();
function endAnchored(src, flags) {
  const key = flags + "\u0000" + src;
  let re = endCache.get(key);
  if (!re) {
    re = new RegExp("^(?:" + py(src, flags).source + ")(?![\\s\\S])", "u" + flags);
    endCache.set(key, re);
  }
  return re;
}

// ---------------------------------------------------------------- Python str helpers

class PyError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

/** Strict dict lookup: a missing key raises KeyError, as Python's d[k]. */
function getKey(map, key) {
  const v = map.get(key);
  if (v === undefined) throw new PyError("KeyError", JSON.stringify(key));
  return v;
}

const cps = (s) => Array.from(s); // Python indexes strings by code point
const cpLen = (s) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const lastChar = (s) => {
  const a = cps(s);
  return a[a.length - 1];
};
const firstChar = (s) => (s === "" ? "" : String.fromCodePoint(s.codePointAt(0)));
const RE_UPPER = /[\p{Uppercase}]/u;
const RE_LOWER = /[\p{Lowercase}]/u;
const RE_TITLE = /\p{Lt}/u;
const RE_ALPHA = /^\p{L}+$/u;
const RE_ASCII = /^[\x00-\x7f]*$/;
const RE_ND = /^\p{Nd}$/u;
const RE_SPACE_RUN = new RegExp(`[${S}]+`, "gu");
const RE_STRIP = new RegExp(`^[${S}]+|[${S}]+$`, "gu");

function isUpper(s) {
  let cased = false;
  for (const c of s) {
    if (RE_LOWER.test(c) || RE_TITLE.test(c)) return false;
    if (RE_UPPER.test(c)) cased = true;
  }
  return cased;
}

function isLower(s) {
  let cased = false;
  for (const c of s) {
    if (RE_UPPER.test(c) || RE_TITLE.test(c)) return false;
    if (RE_LOWER.test(c)) cased = true;
  }
  return cased;
}

const isAlpha = (s) => RE_ALPHA.test(s);
const isAscii = (s) => RE_ASCII.test(s);
const isDigitStr = (s) => s.length > 0 && cps(s).every((c) => RE_ND.test(c));
const pyStrip = (s) => s.replace(RE_STRIP, "");
const pySplit = (s) => s.split(RE_SPACE_RUN).filter((x) => x !== "");
const pyLower = (s) => s.toLowerCase();
const pyUpper = (s) => s.toUpperCase();
const capitalize = (s) => (s === "" ? "" : pyUpper(firstChar(s)) + pyLower(s.slice(firstChar(s).length)));

/** Value of a Unicode decimal digit (Nd comes in contiguous runs of 0..9). */
function digitValue(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 48 && cp <= 57) return cp - 48;
  let start = cp;
  while (RE_ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/** Python int() of a string of decimal digits, as a BigInt (Python ints are unbounded). */
function pyInt(s) {
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  let n = 0n;
  for (const c of s) {
    if (!RE_ND.test(c)) throw new PyError("ValueError", `invalid literal for int(): ${s}`);
    n = n * 10n + BigInt(digitValue(c));
  }
  return n;
}

const ljust = (s, width, fill) => s + fill.repeat(Math.max(0, width - cpLen(s)));
const map = (obj) => new Map(Object.entries(obj));
const translate = (s, table) => {
  let out = "";
  for (const c of s) {
    const r = table.get(c);
    out += r === undefined ? c : r;
  }
  return out;
};

// ---------------------------------------------------------------- normalize.py

const _WHITESPACE = g("\\s+");
const _LETTER_THEN_DIGIT = g("(?<=[^\\W\\d_])(?=\\d)");
const _DIGIT_THEN_LETTER = g("(?<=\\d)(?=[^\\W\\d_])");
const _LONE_LETTER_BY_DIGIT = g("\\b([A-ZÇĞİÖŞÜQWX])(?= \\d)|(?<=\\d )([A-ZÇĞİÖŞÜQWX])\\b");
const _APOSTROPHES = map({ "’": "'", "‘": "'", "`": "'", "´": "'" });
const _QUOTES = new Set('"“”„«»');
const _TURKISH_CASE = map({ I: "ı", İ: "i" });
const _EMAIL = g("\\b[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+\\b");
const _URL = g(
  "\\b(?:https?://)?(?:www\\.)?[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|net|org|gov|edu|info|io|ai|tr)\\b(?:/[\\w./-]*)?",
  "i",
);
const _ADDRESS_WORDS = map({
  www: "dabılyu dabılyu dabılyu",
  com: "kom",
  net: "net",
  org: "org",
  gov: "gov",
  info: "info",
  gmail: "cimeyl",
  hotmail: "hotmeyl",
  outlook: "autluk",
  yahoo: "yahu",
  icloud: "ayklaud",
});
const _RANGE = g("(?<![\\d\\-–])(\\d[\\d.:,]*)\\s*[-–]\\s*(\\d[\\d.:,]*)(?![\\d\\-–])");
const _PHONE = g("(?<!\\d)(\\+90[\\s-]?)?(0?)\\(?(\\d{3})\\)?[\\s-]?(\\d{3})[\\s-]?(\\d{2})[\\s-]?(\\d{2})(?!\\d)");
const _VOWELS = new Set("aeıioöuüAEIİOÖUÜ");
const _PER_UNIT = map({ sn: "saniye", sa: "saat", dk: "dakika" });
const _CAPS_LEXICON = map({
  MR: "emar", SMS: "esemes", NTV: "entivi", YÖK: "yök", BİM: "bim", ŞOK: "şok", COVID: "kovid",
  MEB: "meb", İTÜ: "itü", IBAN: "iban", İETT: "ietete", ALO: "alo", MİT: "mit", OK: "okey",
  TSH: "teseha", MHRS: "meharese", HES: "hes",
  CEO: "siio", PR: "piar", DJ: "dijey", TV: "tivi", FBI: "efbiay", CNN: "sienen", VIP: "viaypi",
  HD: "heyçdi",
});
const _CAPS_WORD_SRC = "\\b[A-ZÇĞİÖŞÜQWX]{2,}\\b";
const _CAPS_WORD = g(_CAPS_WORD_SRC);
const _WORD = g("\\b[^\\W\\d_]{2,}\\b");
const _ONES = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const _TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
const _MONTHS = new Map([
  [1, "ocak"], [2, "şubat"], [3, "mart"], [4, "nisan"], [5, "mayıs"], [6, "haziran"],
  [7, "temmuz"], [8, "ağustos"], [9, "eylül"], [10, "ekim"], [11, "kasım"], [12, "aralık"],
]);
const _ABBREVIATIONS = [
  ["dr.", "doktor"], ["prof.", "profesör"], ["vb.", "ve benzeri"], ["vs.", "vesaire"], ["örn.", "örneğin"],
  ["no.", "numara"], ["mg", "miligram"], ["kg", "kilogram"], ["gr", "gram"], ["km", "kilometre"],
  ["cm", "santimetre"], ["mm", "milimetre"], ["lt", "litre"], ["ml", "mililitre"], ["kb", "kilobayt"],
  ["mb", "megabayt"], ["gb", "gigabayt"], ["tb", "terabayt"], ["tl", "lira"],
  ["doç.", "doçent"], ["uzm.", "uzman"], ["op.", "operatör"], ["yrd.", "yardımcı"],
  ["öğr. üyesi", "öğretim üyesi"], ["öğr. gör.", "öğretim görevlisi"], ["dt.", "diş hekimi"],
  ["dyt.", "diyetisyen"], ["psk.", "psikolog"], ["fzt.", "fizyoterapist"], ["hemş.", "hemşire"],
  ["ecz.", "eczacı"], ["av.", "avukat"], ["müh.", "mühendis"], ["hz.", "hazreti"], ["bkz.", "bakınız"],
  ["vd.", "ve diğerleri"],
  ["mah.", "mahallesi"], ["cad.", "caddesi"], ["cd.", "caddesi"], ["sok.", "sokak"], ["sk.", "sokak"],
  ["bul.", "bulvarı"], ["blv.", "bulvarı"], ["apt.", "apartmanı"], ["ltd. şti.", "limited şirketi"],
  ["şti.", "şirketi"],
];
const _BEFORE_A_WORD = new Set([
  "doç.", "uzm.", "op.", "yrd.", "dt.", "dyt.", "psk.", "fzt.", "hemş.", "ecz.", "av.", "müh.", "hz.", "mah.",
  "cad.", "cd.", "sok.", "sk.", "bul.", "blv.", "apt.",
]);
const _NUMBER_UNITS_LIST = [
  ["m", "metre"], ["g", "gram"], ["cc", "sisi"], ["mcg", "mikrogram"], ["μg", "mikrogram"], ["IU", "ünite"],
  ["kcal", "kilokalori"], ["mmHg", "milimetre cıva"], ["dk", "dakika"], ["sn", "saniye"], ["sa", "saat"],
  ["ms", "milisaniye"], ["dl", "desilitre"],
];
const _NUMBER_UNITS = new Map(_NUMBER_UNITS_LIST);
const _AREA_UNITS = map({ m: "metre", km: "kilometre", cm: "santimetre" });
const _ORDINAL_HEADS =
  "Dünya|Lig|Ordu|Kolordu|Tümen|Dönem|Meclis|Kurultay|Kongre|Uluslararası|Ulusal|Olağan|Olağanüstü|Geleneksel" +
  "|Yıl|Yüzyıl|Sınıf|Kat|Blok|Etap|Bölge|Asliye|Ağır|Sulh|İcra|Aile|Selim|Murat|Murad|Mehmet|Mehmed|Mahmut" +
  "|Mahmud|Ahmet|Ahmed|Osman|Bayezid|Beyazıt|Süleyman|Mustafa|Abdülhamid|Abdülmecid|Louis|Henry|Napolyon";
const _WEEKDAYS = new Map([
  ["Pzt", "pazartesi"], ["Sal", "salı"], ["Çar", "çarşamba"], ["Per", "perşembe"], ["Cum", "cuma"],
  ["Cmt", "cumartesi"], ["Paz", "pazar"],
]);
const _LETTER_NAMES = map({
  A: "a", B: "be", C: "ce", Ç: "çe", D: "de", E: "e", F: "fe", G: "ge", Ğ: "yumuşak ge", H: "he", I: "ı",
  İ: "i", J: "je", K: "ke", L: "le", M: "me", N: "ne", O: "o", Ö: "ö", P: "pe", R: "re", S: "se", Ş: "şe",
  T: "te", U: "u", Ü: "ü", V: "ve", Y: "ye", Z: "ze", Q: "kü", W: "dabılyu", X: "iks",
});
const _INITIALISM_LETTERS = new Map([..._LETTER_NAMES, ["K", "ka"], ["I", "i"]]);
const _ROMAN = "(?:XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|IX|VIII|VII|VI|IV|III|II)";
const _ROMAN_VALUES = map({ I: 1, V: 5, X: 10 });
const _ORDINAL_EXCEPTIONS = map({
  bir: "birinci", iki: "ikinci", üç: "üçüncü", dört: "dördüncü", beş: "beşinci", altı: "altıncı",
  yedi: "yedinci", sekiz: "sekizinci", dokuz: "dokuzuncu", on: "onuncu", yirmi: "yirminci", otuz: "otuzuncu",
  kırk: "kırkıncı", elli: "ellinci", altmış: "altmışıncı", yetmiş: "yetmişinci", seksen: "sekseninci",
  doksan: "doksanıncı", yüz: "yüzüncü", bin: "bininci", milyon: "milyonuncu", milyar: "milyarıncı",
});
// Python sorts a set by length (its order among equal lengths varies with the hash seed); two different
// stems of equal length never match at the same place, so any order among them gives the same result.
const _SPOKEN_STEMS = [
  ...new Set([
    ..._ONES, ..._TENS.filter(Boolean), "yüz", "bin", "milyon", "milyar", "trilyon", "lira", "kuruş", "dolar",
    "avro", "sent", "sterlin", "peni", "saniye", "dakika", "saat", "buçuk", "metrekare", "metreküp",
    "kilometrekare", "santimetrekare", "kilometreküp", "santimetreküp",
    ..._ABBREVIATIONS.map(([, v]) => v.split(" ").at(-1)),
    ..._NUMBER_UNITS_LIST.map(([, v]) => v.split(" ").at(-1)),
    ..._ORDINAL_EXCEPTIONS.values(),
  ]),
].sort((a, b) => cpLen(b) - cpLen(a));
const _SPOKEN_STEM_SUFFIX = g(
  "\\b(" + _SPOKEN_STEMS.map(pyEscape).join("|") + "|\\w+(?:inci|ıncı|üncü|uncu|nci|ncı|ncü|ncu))'([a-zçğıöşü]+)\\b",
);

export function turkishLower(text) {
  return pyLower(translate(text, _TURKISH_CASE)).replaceAll("\u0307", "");
}

function normalizeOrthography(text) {
  let n = translate(text.normalize("NFKC"), _APOSTROPHES);
  n = Array.from(n).filter((c) => !_QUOTES.has(c)).join("");
  n = n.replaceAll("''", "");
  return pyStrip(n.replace(_WHITESPACE, " "));
}

const _ABBREVIATION_RULES = [..._ABBREVIATIONS]
  .sort((a, b) => cpLen(b[0]) - cpLen(a[0]))
  .map(([abbreviation, expansion]) => {
    const rules = [];
    let pattern;
    if (abbreviation.endsWith(".")) {
      rules.push([g(`(?<!\\w)${pyEscape(abbreviation)}\\s*(?=\\w)`, "i"), `${expansion} `]);
      if (_BEFORE_A_WORD.has(abbreviation)) return rules;
      pattern = `(?<!\\w)${pyEscape(abbreviation)}`;
    } else {
      pattern = `(?<!\\w)${pyEscape(abbreviation)}(?!\\w)`;
    }
    rules.push([g(pattern, "i"), expansion]);
    return rules;
  })
  .flat();

const R = {
  quoteCaps: g("'([A-ZÇĞİÖŞÜ]+)\\b"),
  noName: g(
    "(?<!\\bsokak )(?<!\\bsokağı )(?<!\\bcadde )(?<!\\bcaddesi )(?<!\\bbulvarı )(?<!\\bmahallesi )(?<!\\bapartmanı )" +
      "(?<=[^\\W\\d_] )no\\b\\.?:?(?=\\s)",
    "i",
  ),
  noNumber: g("\\bno\\s*[:.]\\s*(?=\\d)", "i"),
  daire: g("\\bD\\s*:\\s*(?=\\d)"),
  tel: g("\\bTel\\s*:"),
  sayfa: g("\\bs\\.\\s*(?=\\d)"),
  iban: g("\\bTR(\\d{2})((?:\\s?\\d{4}){5})\\s?(\\d{2})\\b"),
  dotted: g("\\b(?:[A-ZÇĞİÖŞÜ]\\.){2,}"),
  pH: g("\\bpH\\b"),
  h2o: g("\\bH2O\\b"),
  pylori: g("\\bH\\.\\s*pylori\\b", "i"),
  xray: g("\\bX-?ray\\b", "i"),
  hane: g("\\b(hane(?:si|leri)?)\\s+(\\d{2,6})\\b"),
  hba1c: g("\\bHbA1c\\b"),
  blood: g("\\b(AB|A|B|0)\\s?Rh\\s?\\(?([+-])\\)?"),
  pressure: g("\\b(\\d{2,3})/(\\d{2,3})\\s*mmHg\\b"),
  times: g("(\\bgünde\\s+)?\\b(\\d+)\\s?[xX×]\\s?(\\d+)\\b"),
  kmh: g("(?<![\\d.,])(\\d+(?:,\\d+)?)\\s?km/(?:sa|s|h)\\b"),
  dose: g("(?<![\\d.,])(\\d+(?:,\\d+)?)\\s?(mg|mcg|g|ml)/kg\\b"),
  area: g("(?<=\\d) ?(km|cm|m)([23])(?!\\w)"),
  units: g("(?<=\\d) ?(" + _NUMBER_UNITS_LIST.map(([k]) => pyEscape(k)).join("|") + ")(?![\\w/])"),
  litre: g("(?<=\\d) L\\b(?![/'’])(?!\\s*\\d)"),
  weekday: g("\\b(" + [..._WEEKDAYS.keys()].join("|") + ")\\b\\.?(?=\\s*(?:[-–,/]|\\d|$))"),
  weekdayRange: g(
    "\\b(pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar)\\s*[-–]\\s*" +
      "(pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar)\\b",
    "i",
  ),
  currencySymbol: g("([₺$€£])\\s*((?:\\d{1,3}(?:\\.\\d{3})+)|\\d+)(?:[,.](\\d{1,2}))?"),
  currencyAfter: g("(?<![\\d.,])((?:\\d{1,3}(?:\\.\\d{3})+)|\\d+)(?:,(\\d{1,2}))?\\s?(?:([₺$€£])|(TL|USD|EUR|GBP)\\b)"),
  code: g(
    "(?<=\\d)[A-ZÇĞİÖŞÜQWX]{1,6}(?=\\d|\\b)|\\b[A-ZÇĞİÖŞÜQWX]{1,6}(?=\\d)|(?<=\\d )[A-ZÇĞİÖŞÜQWX]{2,6}(?= \\d)",
  ),
  letterDash: g("(?<=[^\\W\\d_])-(?=\\d)"),
  date: g("\\b(\\d{1,2})[./-](\\d{1,2})[./-](\\d{4})\\b"),
  isoDate: g("\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b"),
  percentBefore: g("%\\s*(\\d+(?:[,.]\\d+)?)"),
  percentAfter: g("(?<![\\d.,])(\\d+(?:,\\d+)?)\\s?%"),
  minus: g("(?<![\\w.,:)\\]])-(?=\\d)"),
  duration: g("\\b(\\d{1,2}):([0-5]\\d):([0-5]\\d)\\b"),
  time: g("\\b([01]?\\d|2[0-3])[:.]([0-5]\\d)\\b"),
  slashPair: g("\\b(\\d{1,2})/(\\d{1,2})\\b"),
  slash: g("\\b(\\d+)/(\\d+)\\b"),
  thousands: g("\\b\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?\\b"),
  decimal: g("\\b(\\d+)[,.](\\d+)\\b"),
  ordinalSuffix: g("\\b(\\d+)'?(?:inci|ıncı|üncü|uncu|nci|ncı|ncü|ncu)\\b"),
  ordinalDotWord: g("\\b(\\d+)\\.(?=[a-zçğıöşü])"),
  ordinalDot: g("\\b([1-9]\\d*)\\.(?=\\s+(?:[a-zçğıöşü]|(?:" + _ORDINAL_HEADS + ")\\b))"),
  longDigits: g("\\b\\d{5,}\\b"),
  zeroDigits: g("\\b0\\d+\\b"),
  digits: g("\\b\\d+\\b"),
  noSu: g("\\bno\\.'?s[ıu]\\b", "i"),
  perUnit: g("(?<=\\w)/(sn|sa|dk)\\b", "i"),
  unitPer: g("\\b(mg|kg|g|km|m|cm|ml)/(kg|g|m|l|lt|ml|saat|gün)\\b"),
  sayin: g("\\bSn\\.\\s*(?=[A-ZÇĞİÖŞÜ])"),
  initialism: g("\\b[A-ZÇĞİÖŞÜQWX]{2,6}\\b"),
  loneLetter: g("(?<![\\w.'-])([A-ZÇĞİÖŞÜQWX])(\\.(?=\\s+[a-zçğıöşü]))?(?![\\w-])"),
  spacedSlash: g("\\s+/\\s+"),
  wordSlash: g("(?<=[^\\W\\d_])/(?=[^\\W\\d_])"),
  spaceBeforePunct: g("\\s+([,.;:!?])"),
  leading: g("^[\\s,]+|(?<=[,.;:!?])\\s*,"),
  // _replace_symbols
  degree: g("(?<=\\d)\\s?°\\s?C?(?![^\\W\\d_])"),
  plus: g("(?<=\\d)\\s?\\+\\s?(?=\\d)|(?<=\\s)\\+(?=\\s)"),
  equals: g("(?<=[\\d\\s])=(?=[\\d\\s])"),
  hashtag: g("(?<![\\w&])#(?=[^\\W\\d_])"),
  emphasis: g("\\*+|_{2,}"),
  // helpers
  scheme: py("^https?://", "i"),
  addressSplit: py("([.@/_-])", "g"),
  vitaminBefore: py("vitamin\\w*\\s+(?:\\w+\\s+ve\\s+)?$", "i"),
  vitaminAfter: py("\\s+vitamin", "iy"),
  doseWord: py("\\s*(?:tablet|kapsül|şurup|ölçek|damla|doz|puf|kaşık|ampul|draje|saşe|fitil|iğne)", "iy"),
  romanOrdinal: g("\\b(" + _ROMAN + "|I(?=\\.\\s+Dünya))\\.\\s+(?=[A-ZÇĞİÖŞÜ])"),
  romanAfterTitle: g("\\b([A-ZÇĞİÖŞÜ][^\\W\\d_]*\\s+)(" + _ROMAN + ")\\b(?![.'’]?[^\\W\\d_])"),
  threeConsonants: py("[^AEIİOÖUÜ]{3}"),
  sepComma: py("[,.]"),
};

/** re.match at the start of `s` (sticky regex from position 0). */
function matchAtStart(re, s) {
  re.lastIndex = 0;
  return re.test(s);
}

function normalizeForModel(text) {
  // The typographic minus sign (U+2212) is read like "-": "−5 derece" -> "eksi beş derece".
  let n = normalizeOrthography(text.replaceAll("\u2212", "-"));
  n = lowerIfShouted(n);
  n = replaceRoman(n);
  n = sub(R.quoteCaps, n, (m) => "'" + turkishLower(m[1]));
  n = n.replace(R.noName, "numarası");
  n = n.replace(R.noNumber, "numara ");
  n = n.replace(R.daire, "daire ");
  n = n.replace(R.tel, "telefon:");
  n = n.replace(R.sayfa, "sayfa ");
  n = sub(_EMAIL, n, replaceAddress);
  n = sub(_URL, n, replaceAddress);
  n = replaceSymbols(n);
  n = sub(R.iban, n, replaceIban);
  n = sub(R.dotted, n, (m) => cps(m[0]).filter((c) => c !== ".").map((c) => getKey(_INITIALISM_LETTERS, c)).join(""));
  n = n.replace(R.pH, "pe ha");
  n = n.replace(R.h2o, "haş iki o");
  n = n.replace(R.pylori, "ha pilori");
  n = n.replace(R.xray, "iksrey");
  n = sub(R.hane, n, (m) => `${m[1]} ${digitSequenceToWords(m[2])}`);
  n = n.replace(R.hba1c, "ha be a bir ce");
  n = sub(R.blood, n, replaceBloodGroup);
  n = sub(R.pressure, n, (m) =>
    `${withDative(numberToWords(pyInt(m[1])))} ${numberToWords(pyInt(m[2]))} milimetre cıva`);
  n = sub(R.times, n, replaceTimes);
  n = sub(R.kmh, n, (m) => `saatte ${numericToWords(m[1])} kilometre`);
  n = sub(R.dose, n, (m) => `kilogram başına ${numericToWords(m[1])} ${getKey(_DOSE_UNITS, m[2])}`);
  n = sub(R.area, n, (m) => " " + getKey(_AREA_UNITS, m[1]) + (m[2] === "2" ? "kare" : "küp"));
  n = sub(R.units, n, (m) => " " + getKey(_NUMBER_UNITS, m[1]));
  n = n.replace(R.litre, " litre");
  n = sub(R.weekday, n, (m) => getKey(_WEEKDAYS, m[1]));
  n = n.replace(R.weekdayRange, "$1 ile $2");
  n = sub(R.currencySymbol, n, (m) => currencyWords(m[1], m[2], m[3]));
  n = sub(R.currencyAfter, n, (m) => currencyWords(m[3] || getKey(_CURRENCY_CODES, m[4]), m[1], m[2]));
  n = sub(R.code, n, (m) =>
    _CAPS_LEXICON.has(m[0]) || isPronounceable(m[0])
      ? m[0]
      : " " + cps(m[0]).map((c) => getKey(_INITIALISM_LETTERS, c)).join(" ") + " ");
  n = n.replace(_LETTER_THEN_DIGIT, " ").replace(_DIGIT_THEN_LETTER, " ");
  n = n.replace(R.letterDash, " ");
  n = sub(_LONE_LETTER_BY_DIGIT, n, (m) => getKey(_LETTER_NAMES, m[1] || m[2]));
  n = sub(R.date, n, (m) => replaceDateParts(m[1], m[2], m[3], m[0]));
  n = sub(R.isoDate, n, (m) => replaceDateParts(m[3], m[2], m[1]));
  n = sub(R.percentBefore, n, (m) => `yüzde ${numericToWords(m[1])}`);
  n = sub(R.percentAfter, n, (m) => `yüzde ${numericToWords(m[1])}`);
  n = sub(_PHONE, n, replacePhone);
  n = sub(_RANGE, n, replaceRange);
  n = n.replace(R.minus, "eksi ");
  n = sub(R.duration, n, replaceDuration);
  n = sub(R.time, n, replaceTime);
  n = sub(R.slashPair, n, replaceSlashPair);
  n = n.replace(R.slash, "$1 bölü $2");
  n = sub(R.thousands, n, (m) => numericToWords(m[0]));
  n = sub(R.decimal, n, (m) => decimalToWords(m[0]));
  n = sub(R.ordinalSuffix, n, (m) => ordinalToWords(pyInt(m[1])));
  n = sub(R.ordinalDotWord, n, (m) => ordinalToWords(pyInt(m[1])));
  n = sub(R.ordinalDot, n, (m) => ordinalToWords(pyInt(m[1])));
  n = sub(R.longDigits, n, (m) => digitSequenceToWords(m[0]));
  n = sub(R.zeroDigits, n, (m) => digitGroupToWords(m[0]));
  n = sub(R.digits, n, (m) => numberToWords(pyInt(m[0])));
  n = n.replace(R.noSu, "numarası");
  n = sub(R.perUnit, n, (m) => " bölü " + getKey(_PER_UNIT, pyLower(m[1])));
  n = n.replace(R.unitPer, "$1 bölü $2");
  n = n.replace(R.sayin, "sayın ");
  for (const [re, expansion] of _ABBREVIATION_RULES) n = sub(re, n, () => expansion);
  n = sub(R.initialism, n, replaceInitialism);
  n = sub(R.loneLetter, n, replaceLoneLetter);
  n = sub(_SPOKEN_STEM_SUFFIX, n, attachSuffix);
  n = n.replace(R.spacedSlash, ", ");
  n = n.replace(R.wordSlash, " ");
  n = n.replace(R.spaceBeforePunct, "$1");
  n = n.replace(R.leading, "");
  return pyStrip(n.replace(_WHITESPACE, " "));
}

/** number_to_words for a BigInt (or a safe integer Number). */
export function numberToWords(number) {
  number = BigInt(number);
  if (number < 0n) return `eksi ${numberToWords(-number)}`;
  if (number < 10n) return _ONES[Number(number)];
  if (number < 100n) {
    const tens = Number(number / 10n);
    const ones = Number(number % 10n);
    return !ones ? _TENS[tens] : `${_TENS[tens]} ${_ONES[ones]}`;
  }
  if (number < 1000n) {
    const hundreds = Number(number / 100n);
    const remainder = number % 100n;
    const prefix = hundreds === 1 ? "yüz" : `${_ONES[hundreds]} yüz`;
    return !remainder ? prefix : `${prefix} ${numberToWords(remainder)}`;
  }
  const scales = [[1000000000000n, "trilyon"], [1000000000n, "milyar"], [1000000n, "milyon"], [1000n, "bin"]];
  for (const [scale, label] of scales) {
    if (number >= scale) {
      const count = number / scale;
      const remainder = number % scale;
      const prefix = scale === 1000n && count === 1n ? label : `${numberToWords(count)} ${label}`;
      return !remainder ? prefix : `${prefix} ${numberToWords(remainder)}`;
    }
  }
  throw new PyError("ValueError", `number is too large to normalize: ${number}`);
}

function replaceDateParts(dayText, monthText, yearText, original) {
  const day = pyInt(dayText);
  const month = pyInt(monthText);
  const year = pyInt(yearText);
  if (!(1n <= day && day <= 31n) || !(month >= 1n && month <= 12n)) {
    return original !== undefined ? original : `${yearText}-${monthText}-${dayText}`;
  }
  return `${numberToWords(day)} ${_MONTHS.get(Number(month))} ${numberToWords(year)}`;
}

const _CURRENCY_CODES = map({ TL: "₺", USD: "$", EUR: "€", GBP: "£" });
const _SYMBOLS = map({ "&": " ve ", "•": " , ", "▪": " , ", "►": " , ", "→": " , ", "⇒": " , " });
const RE_DROP_CATEGORY = /^[\p{So}\p{Cs}\p{Co}]$/u;

function replaceSymbols(text) {
  text = text.replace(R.degree, " derece");
  text = text.replace(R.plus, " artı ");
  text = text.replace(R.equals, " eşittir ");
  text = text.replace(R.hashtag, "heşteg ");
  text = text.replace(R.emphasis, "");
  text = translate(text, _SYMBOLS);
  let out = "";
  for (const c of text) if (!RE_DROP_CATEGORY.test(c)) out += c;
  return out.replaceAll("\ufe0f", "").replaceAll("\u200d", "");
}

function replaceIban(m) {
  const groups = m[2].includes(" ") ? [m[1], ...pySplit(m[2]), m[3]] : [m[1], m[2], m[3]];
  return "te re, " + groups.map(digitSequenceToWords).join(", ");
}

function replaceBloodGroup(m) {
  const group = m[1] === "0" ? "sıfır" : cps(m[1]).map((c) => getKey(_INITIALISM_LETTERS, c)).join("");
  return `${group} eraj ${m[2] === "+" ? "pozitif" : "negatif"}`;
}

function replaceRange(m) {
  const start = m[1];
  const end = m[2];
  if (fullmatchRe("\\d{4}", start) && fullmatchRe("\\d{2}", end) && pyInt(end) === (pyInt(start) + 1n) % 100n) {
    return `${start} ${pyInt(end)}`;
  }
  if (isDigitStr(start) && isDigitStr(end) && pyInt(start) > pyInt(end)) return `${start} ${end}`;
  return `${start} ile ${end}`;
}

function replaceLoneLetter(m) {
  const letter = firstChar(m[0]);
  const text = m.input;
  const start = m.index;
  const end = m.index + m[0].length;
  const following = firstChar(text.slice(end));
  if ("OI".includes(letter) || ("AE".includes(letter) && [",", "!", "?"].includes(following))) return m[0];
  const initial = m[2] || following === ".";
  const vitamin = R.vitaminBefore.test(text.slice(0, start)) || matchAtStart(R.vitaminAfter, text.slice(end));
  return getKey(initial || vitamin ? _INITIALISM_LETTERS : _LETTER_NAMES, letter);
}

const _DOSE_UNITS = map({ mg: "miligram", mcg: "mikrogram", g: "gram", ml: "mililitre" });

function replaceTimes(m) {
  const daily = m[1];
  const first = numberToWords(pyInt(m[2]));
  const second = numberToWords(pyInt(m[3]));
  if (daily || matchAtStart(R.doseWord, m.input.slice(m.index + m[0].length))) {
    return `${daily || ""}${first} defa ${second}`;
  }
  return `${withDative(first)} ${second}`;
}

function lastVowel(words) {
  const a = cps(words);
  for (let k = a.length - 1; k >= 0; k--) if (_VOWELS.has(a[k])) return a[k];
  return "e";
}

function withDative(words) {
  if (words.endsWith("dört")) return words.slice(0, -1) + "de";
  const vowel = "aıou".includes(lastVowel(words)) ? "a" : "e";
  return `${words}${_VOWELS.has(lastChar(words)) ? "y" : ""}${vowel}`;
}

function currencyWords(symbol, whole, fraction) {
  const [unit, subunit] = getKey(
    new Map([["₺", ["lira", "kuruş"]], ["$", ["dolar", "sent"]], ["€", ["avro", "sent"]], ["£", ["sterlin", "peni"]]]),
    symbol,
  );
  let value = `${numberToWords(pyInt(whole.replaceAll(".", "")))} ${unit}`;
  if (fraction && pyInt(ljust(fraction, 2, "0")) !== 0n) {
    value += ` ${numberToWords(pyInt(ljust(fraction, 2, "0")))} ${subunit}`;
  }
  return value;
}

function replacePhone(m) {
  const [country, trunk, ...groups] = m.slice(1);
  const spoken = country ? ["artı doksan"] : [];
  spoken.push(trunk ? `sıfır ${digitGroupToWords(groups[0])}` : digitGroupToWords(groups[0]));
  for (const group of groups.slice(1)) spoken.push(digitGroupToWords(group));
  return spoken.join(", ");
}

function digitGroupToWords(value) {
  let k = 0;
  while (value[k] === "0") k++;
  const stripped = value.slice(k);
  const zeros = Array(k).fill("sıfır");
  return (stripped ? [...zeros, numberToWords(pyInt(stripped))] : zeros).join(" ");
}

function turkishUpper(c) {
  return c === "i" ? "İ" : c === "ı" ? "I" : pyUpper(c);
}

function replaceSlashPair(m) {
  const numerator = pyInt(m[1]);
  const denominator = pyInt(m[2]);
  if (0n < numerator && numerator < denominator && denominator <= 10n) {
    return `${withLocative(numberToWords(denominator))} ${numberToWords(numerator)}`;
  }
  if ((numerator === 7n && denominator === 24n) || (numerator === 24n && denominator === 7n)) {
    return `${numberToWords(numerator)} ${numberToWords(denominator)}`;
  }
  return `${numberToWords(numerator)} bölü ${numberToWords(denominator)}`;
}

function withLocative(words) {
  const vowel = "aıou".includes(lastVowel(words)) ? "a" : "e";
  const consonant = "çfhkpsşt".includes(lastChar(words)) ? "t" : "d";
  return `${words}${consonant}${vowel}`;
}

const _ADDRESS_PIECES = map({ ".": "nokta", "@": "et", "/": "bölü", _: "alt tire", "-": "tire" });

function replaceAddress(m) {
  let address = m[0].replace(R.scheme, "");
  address = address.replace(/\/+$/u, "");
  const spoken = [];
  for (const piece of address.split(R.addressSplit)) {
    if (_ADDRESS_PIECES.has(piece)) spoken.push(_ADDRESS_PIECES.get(piece));
    else if (piece) {
      const lower = pyLower(piece);
      if (_ADDRESS_WORDS.has(lower)) spoken.push(_ADDRESS_WORDS.get(lower));
      else if (cpLen(lower) <= 2 && isAlpha(lower)) {
        spoken.push(cps(turkishLower(lower)).map((c) => _LETTER_NAMES.get(turkishUpper(c)) ?? c).join(" "));
      } else spoken.push(piece);
    }
  }
  return spoken.join(" ");
}

function replaceDuration(m) {
  const [hours, minutes, seconds] = [m[1], m[2], m[3]].map(pyInt);
  const parts = [];
  if (hours) parts.push(`${numberToWords(hours)} saat`);
  if (minutes) parts.push(`${numberToWords(minutes)} dakika`);
  if (seconds || !parts.length) parts.push(`${numberToWords(seconds)} saniye`);
  return parts.join(" ");
}

function attachSuffix(m) {
  let stem = m[1];
  let suffix = m[2];
  let sfx = cps(suffix);
  if (!_VOWELS.has(lastChar(stem)) && sfx.length > 1 && "yns".includes(sfx[0]) && _VOWELS.has(sfx[1])) {
    sfx = sfx.slice(1);
  }
  if (_VOWELS.has(sfx[0])) stem = stem.replace(/buçuk$/u, "buçuğ").replace(/dört$/u, "dörd");
  let vowel = lastVowel(stem);
  const out = [];
  sfx.forEach((ch, index) => {
    let c = ch;
    if ("ae".includes(c)) c = "aıou".includes(vowel) ? "a" : "e";
    else if ("ıiuü".includes(c)) {
      const back = "aıou".includes(vowel);
      const round = "ouöü".includes(vowel);
      c = back ? (round ? "u" : "ı") : round ? "ü" : "i";
    } else if (index === 0 && "dt".includes(c)) c = "çfhkpsşt".includes(lastChar(stem)) ? "t" : "d";
    if (_VOWELS.has(c)) vowel = c;
    out.push(c);
  });
  return stem + out.join("");
}

function replaceTime(m) {
  const hour = m[1];
  const minute = m[2];
  const hourWords = numberToWords(pyInt(hour));
  if (pyInt(minute) === 0n) return hourWords;
  const minuteWords = minute.startsWith("0") ? digitSequenceToWords(minute) : numberToWords(pyInt(minute));
  return `${hourWords} ${minuteWords}`;
}

function fullmatchRe(src, s) {
  return endAnchored(src, "").test(s);
}

function numericToWords(value) {
  if (fullmatchRe("\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?", value)) {
    const plain = value.replaceAll(".", "");
    const comma = plain.indexOf(",");
    const whole = comma < 0 ? plain : plain.slice(0, comma);
    const fraction = comma < 0 ? "" : plain.slice(comma + 1);
    return fraction ? decimalToWords(`${whole},${fraction}`) : numberToWords(pyInt(whole));
  }
  return R.sepComma.test(value) ? decimalToWords(value) : numberToWords(pyInt(value));
}

function decimalToWords(value) {
  const at = value.search(R.sepComma);
  if (at < 0) throw new PyError("ValueError", "not enough values to unpack");
  const whole = value.slice(0, at);
  const fraction = value.slice(at + 1);
  const wholeWords = numberToWords(pyInt(whole));
  if (fraction === "5" && pyInt(whole) !== 0n) return `${wholeWords} buçuk`;
  const fractionWords = cpLen(fraction) <= 2 ? digitGroupToWords(fraction) : digitSequenceToWords(fraction);
  return `${wholeWords} virgül ${fractionWords}`;
}

function digitSequenceToWords(value) {
  return cps(value).map((d) => _ONES[digitValue(d)]).join(" ");
}

function ordinalToWords(number) {
  const words = numberToWords(number).split(" ");
  const last = words[words.length - 1];
  words[words.length - 1] = _ORDINAL_EXCEPTIONS.get(last) ?? `${last}inci`;
  return words.join(" ");
}

function romanToInt(numeral) {
  let total = 0;
  for (let i = 0; i < numeral.length; i++) {
    const value = getKey(_ROMAN_VALUES, numeral[i]);
    total += i + 1 < numeral.length && getKey(_ROMAN_VALUES, numeral[i + 1]) > value ? -value : value;
  }
  return BigInt(total);
}

function replaceRoman(text) {
  text = sub(R.romanOrdinal, text, (m) => ordinalToWords(romanToInt(m[1])) + " ");
  return sub(R.romanAfterTitle, text, (m) => m[1] + numberToWords(romanToInt(m[2])));
}

function lowerIfShouted(text) {
  const words = Array.from(text.matchAll(_WORD), (m) => m[0]);
  const capitals = words.filter((w) => fullmatchRe(_CAPS_WORD_SRC, w));
  const spokenWords = capitals.filter(isPronounceable).length;
  return spokenWords >= 3 && capitals.length >= 0.7 * words.length ? turkishLower(text) : text;
}

function replaceInitialism(m) {
  const word = m[0];
  if (_CAPS_LEXICON.has(word)) return _CAPS_LEXICON.get(word);
  if (isPronounceable(word)) return word;
  return cps(word).map((c) => getKey(_INITIALISM_LETTERS, c)).join("");
}

function isPronounceable(word) {
  const chars = cps(word);
  if (chars.length < 4) return false;
  const vowels = chars.filter((c) => _VOWELS.has(c)).length;
  return vowels / chars.length >= 0.3 && !R.threeConsonants.test(word);
}

// ---------------------------------------------------------------- foreign.py

const LETTERS = map({
  A: "ey", B: "bi", C: "si", D: "di", E: "i", F: "ef", G: "ci", H: "eyç", I: "ay", J: "cey",
  K: "key", L: "el", M: "em", N: "en", O: "o", P: "pi", Q: "kyu", R: "ar", S: "es", T: "ti",
  U: "yu", V: "vi", W: "dabılyu", X: "eks", Y: "vay", Z: "zi",
});
const _TR_LETTERS = new Set("çğıöşüÇĞİÖŞÜ");
const _TOKEN = g("(?<![\\w@./])([A-Za-z][A-Za-z0-9]*)(['’][a-zçğıöşü]+)?(?![\\w@])");
const _CAMEL = g("[A-Z]{2,}(?=[A-Z][a-z]|\\b|[0-9]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+");
const _PROTECTED = g(
  "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+" +
    "|(?:https?://|www\\.)\\S+" +
    "|\\b[\\w-]+(?:\\.[\\w-]+)*\\.(?:com|net|org|ai|io|co|app|dev|gov|edu|tr|me|info)(?:\\.[a-z]{2})?\\b",
  "i",
);

const trLower = (w) => pyLower(w.replaceAll("I", "ı").replaceAll("İ", "i"));
const RE_ASCII_ALPHA = /^[A-Za-z]+$/;

function decodeData(data) {
  if (data.format !== 1) throw new Error("frontend data: unsupported format " + data.format);
  const cmu = new Map();
  const turkish = new Set(data.trBlockExtra || []);
  let prevK = "";
  let prevV = "";
  for (const line of data.cmu.split("\n")) {
    let sep = line.indexOf("\t");
    const blocked = sep < 0;
    if (blocked) sep = line.indexOf("|");
    const k = prevK.slice(0, line.charCodeAt(0) - 48) + line.slice(1, sep);
    const v = prevV.slice(0, line.charCodeAt(sep + 1) - 48) + line.slice(sep + 2);
    cmu.set(k, v);
    if (blocked) turkish.add(k);
    prevK = k;
    prevV = v;
  }
  const known = new Set(data.known ? data.known.split("\n") : []);
  return { cmu, turkish, known, lexicon: data.lexicon.map(([k, v]) => [k, v]) };
}

/** Build the frontend from the parsed asset object (see web/tools/build_frontend_data.py). */
export function createFrontend(data) {
  const { cmu, turkish, known, lexicon: builtinLexicon } = decodeData(data);

  function isEnglish(word) {
    if (!isAscii(word) || !isAlpha(word) || cps(word).some((c) => _TR_LETTERS.has(c))) return false;
    if (!cmu.has(pyLower(word))) return false;
    return !turkish.has(trLower(word)) && !turkish.has(pyLower(word));
  }

  function looksEnglish(word) {
    return RE_ASCII_ALPHA.test(word) && cmu.has(pyLower(word));
  }

  const knownInTurkish = (word) => known.has(pyLower(word));

  function hasInnerCapital(word) {
    const chars = cps(word);
    return chars.slice(1).some(isUpper) && chars.some(isLower);
  }

  const splitCamel = (word) => Array.from(word.matchAll(_CAMEL), (m) => m[0]);

  function respellPart(part) {
    if (isDigitStr(part)) return part;
    if (isUpper(part) && cpLen(part) <= 5) {
      const many = cpLen(part) > 1;
      return cps(part).map((c) => (many ? capitalize(getKey(LETTERS, c)) : getKey(LETTERS, c))).join(" ");
    }
    if (part === "i" || part === "e") return getKey(LETTERS, pyUpper(part));
    const r = cmu.get(pyLower(part));
    return r === undefined ? null : r;
  }

  const up = (t) => (firstChar(t) === "i" ? "İ" + t.slice(1) : pyUpper(firstChar(t)) + t.slice(firstChar(t).length));

  function respell(word) {
    const parts = hasInnerCapital(word) ? splitCamel(word) : [word];
    let spoken = [];
    for (const part of parts) {
      const r = respellPart(part);
      if (r === null) return null;
      spoken.push(r);
    }
    spoken = spoken.map((sp, k) =>
      isUpper(firstChar(parts[k])) || (k === 0 && isUpper(firstChar(word))) ? up(sp) : sp);
    const merged = [];
    parts.forEach((p, k) => {
      const sp = spoken[k];
      if (merged.length && ((cpLen(p) <= 2 && !isUpper(p)) || (k === 1 && (parts[0] === "i" || parts[0] === "e")))) {
        merged[merged.length - 1] = merged[merged.length - 1] + trLower(sp);
      } else merged.push(sp);
    });
    const text = merged.join(" ");
    return hasInnerCapital(word) || isUpper(firstChar(word)) ? up(text) : text;
  }

  function addressTerms(text, lex) {
    const spans = Array.from(text.matchAll(_PROTECTED), (m) => m[0]);
    if (!spans.length) return [];
    return lex.filter(([term]) => {
      const re = py(`(?<![^\\W_])${pyEscape(term)}(?![^\\W_])`, "i");
      return spans.some((span) => re.test(span));
    });
  }

  function respellForeign(text, lex, auto = true) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(_PROTECTED)) {
      out.push(respellSpan(text.slice(last, m.index), lex, auto));
      const span = m[0];
      out.push(span.includes("@") ? pyLower(span) : span);
      last = m.index + span.length;
    }
    out.push(respellSpan(text.slice(last), lex, auto));
    return out.join("");
  }

  const lexCache = new WeakMap();
  // The pattern matches ignoring case, which also pairs the dotted and dotless i of both cases
  // ("İnstagram", "ınstagram", "Nıke"), so the lookup key folds them the same way.
  const key = (t) => pyLower(t.replaceAll("İ", "i").replaceAll("I", "i").replaceAll("ı", "i"));

  function compileLexicon(lex) {
    let c = lexCache.get(lex);
    if (c) return c;
    const terms = lex.map(([t]) => t).sort((a, b) => cpLen(b) - cpLen(a)); // stable, like sorted()
    const says = new Map(lex);
    const pattern = py("(?<!\\w)(" + terms.map(pyEscape).join("|") + ")(?=['’]|[^\\w]|$)", "gi");
    const byLower = new Map();
    for (const t of terms) byLower.set(key(t), says.get(t));
    c = { pattern, byLower };
    lexCache.set(lex, c);
    return c;
  }

  function respellSpan(text, lex, auto) {
    if (!lex || !lex.length) return auto ? autoRespell(text) : text;
    const { pattern, byLower } = compileLexicon(lex);
    const out = [];
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      out.push(auto ? autoRespell(text.slice(last, m.index)) : text.slice(last, m.index));
      const term = m[1];
      const say = byLower.get(key(term));
      if (say === undefined) {               // a case pairing the key does not fold: leave the words alone
        out.push(term);
        last = m.index + m[0].length;
        continue;
      }
      const kept = key(say) === key(term);
      out.push(kept && auto ? englishI(term) : kept ? term : say);
      last = m.index + m[0].length;
    }
    out.push(auto ? autoRespell(text.slice(last)) : text.slice(last));
    return out.join("");
  }

  function englishI(word) {
    if (isUpper(word) && cpLen(word) <= 5) return word;
    return word.includes("I") && looksEnglish(word) ? word.replaceAll("I", "İ") : word;
  }

  function autoRespell(text) {
    return sub(_TOKEN, text, (m) => {
      const word = m[1];
      const suffix = m[2] || "";
      if (isUpper(word) && cpLen(word) <= 5) return m[0];
      if (knownInTurkish(word) || !(hasInnerCapital(word) || isEnglish(word))) return englishI(word) + suffix;
      const r = respell(word);
      return (r !== null ? r : englishI(word)) + suffix;
    });
  }

  function normalizeForCasedModel(text) {
    const merged = builtinLexicon;
    const inAddresses = addressTerms(text, merged);
    text = respellForeign(text, merged, true);
    let normalized = normalizeForModel(text);
    if (inAddresses.length) normalized = respellForeign(normalized, inAddresses, false);
    normalized = sub(_CAPS_WORD, normalized, (m) => turkishLower(m[0]));
    return translate(normalized, _TURKISH_CASE);
  }

  function toModelText(raw) {
    return cleanModelText(turkishLower(normalizeForCasedModel(raw.normalize("NFC"))));
  }

  /** antalia_mini.api.model_text: if the normaliser fails on some input, read the text as written
   * (lowercased), so synthesis never fails on text. */
  function modelText(raw) {
    try {
      return toModelText(raw);
    } catch (err) {
      console.warn("[antalia-mini] text normaliser failed; reading the text as written:", err);
      return cleanModelText(turkishLower(raw.normalize("NFC")));
    }
  }

  /** The first call compiles ~90 Unicode regexes (about 50-150 ms); later calls take well under 1 ms.
   * loadFrontend() runs this once so the first real sentence is fast. */
  function warmup() {
    toModelText(
      "Dr. Ayşe 15.10.2026'da 14:30'da ₺1.250,50 ödedi; PatientDesk'e www.patientdesk.ai, " +
        "ILKER.SAHIN85@gmail.com, 0532 123 45 67, %3, 3-5 gün, 2x1 tablet, 5 mg/kg, II. Selim, SGK, D vitamini.",
    );
  }

  return {
    warmup,
    SYMBOLS,
    SYMBOL_TO_ID,
    PAD, BOS, EOS,
    normalizeForCasedModel,
    normalizeForModel,
    toModelText,
    modelText,
    cleanModelText,
    encode,
    turkishLower,
    // foreign.py pieces, for tests and debugging
    isEnglish, looksEnglish, respell, respellForeign: (t, lex = builtinLexicon, auto = true) => respellForeign(t, lex, auto),
  };
}

// ---------------------------------------------------------------- __init__.py

export const PAD = 0;
export const BOS = 1;
export const EOS = 2;
const LETTERS_TR = "abcçdefgğhıijklmnoöpqrsştuüvwxyz";
const PUNCT = " .,?!'-:;";
export const SYMBOLS = ["<pad>", "<bos>", "<eos>", ...PUNCT, ...LETTERS_TR, ..."âîû"];
export const SYMBOL_TO_ID = new Map(SYMBOLS.map((s, i) => [s, i]));
const _FOLD = map({ "’": "'", "‘": "'", "`": "'", "´": "'", "–": "-", "—": "-", "…": ".", "\u00a0": " ", "\t": " ", "\n": " " });
const _DROP = g("[^abcçdefgğhıijklmnoöpqrsştuüvwxyzâîû .,?!'\\-:;]");
const _SPACE_PUNCT = g("\\s+([.,?!:;])");

export function cleanModelText(t) {
  t = translate(t, _FOLD);
  t = t.replace(_DROP, " ");
  t = t.replace(_SPACE_PUNCT, "$1");
  return pyStrip(t.replace(_WHITESPACE, " "));
}

export function encode(modelText) {
  const ids = [BOS];
  for (const c of modelText) {
    const id = SYMBOL_TO_ID.get(c);
    if (id !== undefined) ids.push(id);
  }
  ids.push(EOS);
  return ids;
}

// ---------------------------------------------------------------- loading

/** Bytes of the asset (gzipped or not: the server may already have decoded it) -> parsed object. */
export async function decodeAsset(bytes) {
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
    u8 = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder("utf-8").decode(u8));
}

/** Fetch the asset and build the frontend. */
export async function loadFrontend(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`frontend data: HTTP ${res.status} for ${url}`);
  const fe = createFrontend(await decodeAsset(await res.arrayBuffer()));
  fe.warmup();
  return fe;
}
