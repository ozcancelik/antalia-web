// Antalia's Turkish text normalizer (turkish_tts/normalize.py, normalize_for_model + turkish_lower), ported line by
// line: the model was trained on its output, so it has to match. tools/check_normalize checks it against Python.
//
// Python's \b and \w are Unicode-aware and JavaScript's are ASCII-only, so word boundaries are written out as
// lookarounds over letters, digits and underscore.

const W = "[\\p{L}\\p{N}_]";
const START = `(?<!${W})`; // \b before a word character
const END = `(?!${W})`; // \b after a word character
const re = (src, flags = "") => new RegExp(src.replaceAll("\\b<", START).replaceAll("\\b>", END), "gu" + flags);

const ONES = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
const MONTHS = ["", "ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos", "eylül", "ekim",
  "kasım", "aralık"];
const ABBREVIATIONS = {
  "dr.": "doktor", "prof.": "profesör", "sn.": "sayın", "vb.": "ve benzeri", "vs.": "vesaire", "örn.": "örneğin",
  kg: "kilogram", gr: "gram", km: "kilometre", cm: "santimetre", mm: "milimetre", lt: "litre", ml: "mililitre",
  kb: "kilobayt", mb: "megabayt", gb: "gigabayt", tb: "terabayt", tl: "Türk lirası",
};
const LETTER_NAMES = {
  A: "a", B: "be", C: "ce", Ç: "çe", D: "de", E: "e", F: "fe", G: "ge", Ğ: "yumuşak ge", H: "he", I: "ı", İ: "i",
  J: "je", K: "ke", L: "le", M: "me", N: "ne", O: "o", Ö: "ö", P: "pe", R: "re", S: "se", Ş: "şe", T: "te", U: "u",
  Ü: "ü", V: "ve", Y: "ye", Z: "ze", Q: "kü", W: "dabılyu", X: "iks",
};
const ORDINAL_EXCEPTIONS = {
  bir: "birinci", iki: "ikinci", üç: "üçüncü", dört: "dördüncü", beş: "beşinci", altı: "altıncı", yedi: "yedinci",
  sekiz: "sekizinci", dokuz: "dokuzuncu", on: "onuncu", yirmi: "yirminci", otuz: "otuzuncu", kırk: "kırkıncı",
  elli: "ellinci", altmış: "altmışıncı", yetmiş: "yetmişinci", seksen: "sekseninci", doksan: "doksanıncı",
  yüz: "yüzüncü", bin: "bininci", milyon: "milyonuncu", milyar: "milyarıncı",
};
const CAPS = "A-ZÇĞİÖŞÜQWX";
// stable sort, longest first, as sorted(..., key=len, reverse=True)
const ABBREVIATION_RES = Object.entries(ABBREVIATIONS)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([abbr, expansion]) => [re(`(?<!${W})${abbr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!${W})`, "i"), expansion]);

// BigInt throughout: grouped numbers like 1.234.567.890.123.456 are read whole, as in Python.
export function numberToWords(value) {
  const n = BigInt(value);
  if (n < 0n) return `eksi ${numberToWords(-n)}`;
  if (n < 10n) return ONES[n];
  if (n < 100n) return n % 10n ? `${TENS[n / 10n]} ${ONES[n % 10n]}` : TENS[n / 10n];
  if (n < 1000n) {
    const prefix = n / 100n === 1n ? "yüz" : `${ONES[n / 100n]} yüz`;
    return n % 100n ? `${prefix} ${numberToWords(n % 100n)}` : prefix;
  }
  for (const [scale, label] of [[10n ** 12n, "trilyon"], [10n ** 9n, "milyar"], [10n ** 6n, "milyon"], [1000n, "bin"]]) {
    if (n >= scale) {
      const count = n / scale, rest = n % scale;
      const prefix = scale === 1000n && count === 1n ? label : `${numberToWords(count)} ${label}`;
      return rest ? `${prefix} ${numberToWords(rest)}` : prefix;
    }
  }
}

const number = (digits) => numberToWords(BigInt(digits));
const digitSequence = (s) => [...s].map((d) => ONES[+d]).join(" ");
const decimal = (value) => {
  const [whole, fraction] = value.split(/[,.](.*)/su);
  return `${number(whole)} virgül ${digitSequence(fraction)}`;
};
const numeric = (value) => {
  if (/^\d{1,3}(?:\.\d{3})+$/.test(value)) return number(value.replaceAll(".", ""));
  return /[,.]/.test(value) ? decimal(value) : number(value);
};
const ordinal = (n) => {
  const words = numberToWords(n).split(" ");
  words[words.length - 1] = ORDINAL_EXCEPTIONS[words.at(-1)] ?? `${words.at(-1)}inci`;
  return words.join(" ");
};

const APOSTROPHES = { "’": "'", "‘": "'", "`": "'", "´": "'" };

export function normalizeOrthography(text) {
  return text.normalize("NFKC").replace(/[’‘`´]/g, (c) => APOSTROPHES[c]).replace(/["“”„«»]/g, "")
    .replace(/\s+/gu, " ").trim();
}

export function normalizeForModel(text) {
  let s = normalizeOrthography(text);
  s = s.replace(/(?<=\p{L})(?=\d)/gu, " ").replace(/(?<=\d)(?=\p{L})/gu, " ");
  s = s.replace(re(`\\b<([${CAPS}])(?= \\d)|(?<=\\d )([${CAPS}])\\b>`), (_, a, b) => LETTER_NAMES[a ?? b]);
  s = s.replace(re("\\b<(\\d{1,2})[./-](\\d{1,2})[./-](\\d{4})\\b>"), (m, d, mo, y) => {
    const day = +d, month = +mo;
    if (day < 1 || day > 31 || !MONTHS[month]) return m;
    return `${numberToWords(day)} ${MONTHS[month]} ${numberToWords(+y)}`;
  });
  s = s.replace(/([₺$€])\s*((?:\d{1,3}(?:\.\d{3})+)|\d+)(?:[,.](\d{1,2}))?/gu, (_, sym, whole, fraction) => {
    const [unit, subunit] = { "₺": ["lira", "kuruş"], $: ["dolar", "sent"], "€": ["avro", "sent"] }[sym];
    let v = `${number(whole.replaceAll(".", ""))} ${unit}`;
    if (fraction && +fraction) v += ` ${numberToWords(+fraction.padEnd(2, "0"))} ${subunit}`;
    return v;
  });
  s = s.replace(/%\s*(\d+(?:[,.]\d+)?)/gu, (_, v) => `yüzde ${numeric(v)}`);
  s = s.replace(re("\\b<([01]?\\d|2[0-3])[:.]([0-5]\\d)\\b>"), (_, h, m) => {
    const hour = numberToWords(+h);
    if (+m === 0) return hour;
    return `${hour} ${m.startsWith("0") ? digitSequence(m) : numberToWords(+m)}`;
  });
  s = s.replace(re("\\b<(\\d{1,2})/(\\d{1,2})\\b>"), (_, a, b) => `${numberToWords(+a)} ${numberToWords(+b)}`);
  s = s.replace(re("\\b<\\d{1,3}(?:\\.\\d{3})+\\b>"), (m) => number(m.replaceAll(".", "")));
  s = s.replace(re("\\b<(\\d+)[,.](\\d+)\\b>"), (m) => decimal(m));
  s = s.replace(re("\\b<(\\d+)\\.(?=\\s|$)"), (_, n) => ordinal(n));
  s = s.replace(re("\\b<\\d{5,}\\b>"), (m) => digitSequence(m));
  s = s.replace(re("\\b<\\d+\\b>"), (m) => number(m));
  for (const [pattern, expansion] of ABBREVIATION_RES) s = s.replace(pattern, expansion);
  s = s.replace(re(`\\b<[${CAPS}]{2,6}\\b>`), (m) => [...m].map((c) => LETTER_NAMES[c]).join(" "));
  s = s.replace(/\s+([,.;:!?])/gu, "$1");
  return s.replace(/\s+/gu, " ").trim();
}

export function turkishLower(text) {
  return text.replace(/I/g, "ı").replace(/İ/g, "i").toLowerCase().replaceAll("̇", "");
}

export const normalize = (text) => turkishLower(normalizeForModel(text));
