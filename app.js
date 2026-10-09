import { Antalia, FILES, wavBlob } from "./tts.js";
import { AntaliaMini } from "./mini.js";
import { createAura } from "./aura.js";

const $ = (id) => document.getElementById(id);
const SAMPLES = [
  ["Randevu", "Merhaba, randevunuzu yarın saat 14:30 için yeniden planladım. Uygun değilse bana yazmanız yeterli."],
  ["Soru", "İşlemi şimdi tamamlamamı ister misiniz, yoksa daha sonra mı arayalım?"],
  ["Sabah", "Sabah güneşi sessiz sokağın taşlarına yavaşça vuruyordu."],
  ["Ödeme", "Toplam tutar ₺1.275,50 ve indirim oranı %18 olarak görünüyor."],
  ["Özür", "Maalesef başvurunuz bu aşamada onaylanmadı, fakat yeniden değerlendirme isteyebilirsiniz."],
];
const QUIPS = [
  "Ne yazarsan okurum. Doktor yazısı hariç.",
  "Kahve molası istemeyen tek seslendirme sanatçısı.",
  "Bu cümle de yapay zekâ ürünüdür, söylemedi deme.",
];

// The models the page can run. Antalia 1's files come from this folder when running locally and from the Hugging Face
// repo (pinned to a commit) elsewhere, since they are too big for git and static hosting. Antalia Mini's come from its
// own Space, also pinned; locally from models/mini/, laid out as in the Space.
const HF_REPO = "ozcancelik/antalia-1-onnx", HF_REVISION = "5d07cd4cd1d53a18168683fee696bd1907db88e7";
const MINI_SPACE = "cloud0day3/antalia-mini", MINI_REVISION = "2c24b406fedada11bd731a2ec9f4535bfd354f03";
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) || location.hostname.endsWith(".local");
const MODELS = {
  "antalia-1": {
    name: "Antalia 1", engine: Antalia, wav: "antalia-1.wav",
    base: LOCAL ? "models/" : `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/`,
    mb: Math.round(Object.values(FILES).reduce((a, b) => a + b, 0) / 1e6),
    steps: [["16", "Hızlı: 16 adım"], ["32", "Yüksek: 32 adım (iki kat yavaş)"]], defaultSteps: "16",
    quips: ["Üç yüz milyon parametre, tek bir ses.", "Ne bulut var ne sunucu. Sadece senin ekran kartın.",
            "Yavaş konuşurum ama düşünerek konuşurum."],
  },
  mini: {
    name: "Antalia Mini", engine: AntaliaMini, wav: "antalia-mini.wav",
    base: LOCAL ? "models/mini/" : `https://huggingface.co/spaces/${MINI_SPACE}/resolve/${MINI_REVISION}/`,
    mb: AntaliaMini.MB,
    steps: [["4", "Hızlı: 4 adım"], ["8", "Yüksek: 8 adım"]], defaultSteps: "8",
    quips: ["Yedi buçuk milyon parametre, koca bir ses.", "Ne bulut var ne sunucu. Sadece senin işlemcin.",
            "Küçüğüm ama hızlıyım."],
  },
};
let modelKey = "antalia-1";
const current = () => MODELS[modelKey];

let aura = null;
try { aura = createAura($("aura")); } catch (e) { console.warn("background disabled:", e); }

let model = null, audio = null, run = 0, playing = null, lastChunks = null;

// ---------- small UI helpers ----------

function hint(msg, err = false) { $("hint").textContent = msg; $("hint").className = "hint" + (err ? " err" : ""); }
function setButton(mode) {
  const b = $("speak");
  b.classList.toggle("stop", mode === "stop");
  b.disabled = mode === "loading";
  b.dataset.mode = mode;
}
let quip = "";
function idleLead() {
  const quips = [...current().quips, ...QUIPS].filter((q) => q !== quip);
  quip = quips[Math.floor(Math.random() * quips.length)];
  $("lead").className = "lead idle";
  $("lead").textContent = quip;
  $("sub").hidden = false;
}
$("lead").addEventListener("click", () => {
  if (playing || !model || !$("lead").classList.contains("idle")) return;
  $("text").value = quip; autosize(); $("speak").click();
});
function autosize() { const t = $("text"); t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; }

for (const [name, text] of SAMPLES) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = name; b.title = text;
  b.onclick = () => { $("text").value = text; autosize(); $("text").focus(); };
  $("samples").append(b);
}
$("text").addEventListener("input", autosize);
autosize();

// The quality choices differ per model; keeps the current one when the new model has it.
function fillSteps() {
  const m = current(), was = $("steps").value;
  $("steps").replaceChildren(...m.steps.map(([v, label]) => new Option(label, v)));
  $("steps").value = m.steps.some(([v]) => v === was) ? was : m.defaultSteps;
}
fillSteps();

// Shows the settings and credits that apply to the chosen model.
function showModel() {
  const mini = modelKey === "mini";
  for (const b of $("models").children) b.setAttribute("aria-pressed", String(b.dataset.model === modelKey));
  $("styleField").hidden = mini;
  $("backend").options[1].text = mini ? "İşlemci (WASM)" : "İşlemci (WASM), çok yavaş";
  $("credit1").hidden = mini; $("creditMini").hidden = !mini;
  for (const el of document.querySelectorAll(".model-name")) el.textContent = current().name;
}

// settings are remembered in this browser; the model first, since it decides the quality choices
const SETTINGS_KEY = "antalia-settings", SETTINGS = ["speed", "pitch", "seed", "backend", "steps", "style"];
function saveSettings() {
  const values = Object.fromEntries(SETTINGS.map((id) => [id, $(id).value]));
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ model: modelKey, ...values })); } catch { }
}
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  if (MODELS[saved.model]) { modelKey = saved.model; fillSteps(); }
  for (const id of SETTINGS) {
    const el = $(id), v = saved[id];
    if (v == null) continue;
    if (el.tagName === "SELECT" ? [...el.options].some((o) => o.value === v) : Number.isFinite(+v)) el.value = v;
  }
} catch { }
for (const id of SETTINGS) $(id).addEventListener("change", saveSettings);
showModel();

const fill = (r) => r.style.setProperty("--p", (r.value - r.min) / (r.max - r.min) * 100 + "%");
$("speed").oninput = () => { fill($("speed")); $("speedOut").textContent = (+$("speed").value).toFixed(2) + "×"; };
$("speed").oninput();
$("speed").ondblclick = () => { $("speed").value = 1; $("speed").oninput(); saveSettings(); };
$("pitch").oninput = () => {
  const v = +$("pitch").value;
  fill($("pitch"));
  $("pitchOut").textContent = v ? `${v > 0 ? "+" : "−"}${Math.abs(v)} yarım ton` : "Doğal";
  for (const b of $("presets").children) b.setAttribute("aria-pressed", String(+b.dataset.pitch === v));
};
$("pitch").oninput();
$("pitch").ondblclick = () => { $("pitch").value = 0; $("pitch").oninput(); saveSettings(); };
for (const b of $("presets").children)
  b.onclick = () => { $("pitch").value = b.dataset.pitch; $("pitch").oninput(); saveSettings(); };
$("reseed").onclick = () => { $("seed").value = Math.floor(Math.random() * 100000); saveSettings(); };
// The panel opens upward from the composer; on a short window it scrolls instead of running off the top.
function fitSettings() {
  const s = $("settings");
  if (s.hidden) return;
  s.style.maxHeight = "";
  s.style.maxHeight = Math.max(160, s.getBoundingClientRect().bottom - 12) + "px";
}
addEventListener("resize", fitSettings);
$("toggleSettings").onclick = () => {
  const open = $("settings").hidden;
  $("settings").hidden = !open;
  $("toggleSettings").setAttribute("aria-expanded", String(open));
  fitSettings();
};
document.addEventListener("click", (e) => {
  if (!$("settings").hidden && !e.target.closest("#settings, #toggleSettings")) {
    $("settings").hidden = true; $("toggleSettings").setAttribute("aria-expanded", "false");
  }
});
$("fullscreen").onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); $("speak").click(); }
  else if (e.key === "Escape" && playing) stop();
  else if ((e.key === "f" || e.key === "F") && !e.target.closest("textarea, input, select")) $("fullscreen").click();
});
$("download").onclick = () => {
  if (!lastChunks) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(wavBlob(lastChunks.chunks, lastChunks.rate)); a.download = lastChunks.name; a.click();
};

// ---------- model ----------

// onnxruntime-web cannot create two WebGPU sessions at once, so loads run one after another
let loading = Promise.resolve();
function load() { loading = loading.then(loadModel); return loading; }

async function loadModel() {
  const m = current(), mini = m.engine === AntaliaMini;
  let backend = $("backend").value;
  if (backend === "webgpu" && !navigator.gpu) {
    backend = "wasm"; $("backend").value = "wasm";
    if (!mini) hint("Bu tarayıcıda WebGPU yok; model işlemcide çalışacak ve çok yavaş olacak. Chrome ya da Edge önerilir, " +
         "ya da ayarlardan Antalia Mini'yi seçin.", true);
  } else if (mini) hint("⌘/Ctrl + Enter ile seslendirin");
  setButton("loading");
  const old = model;
  model = null;
  await old?.release();
  $("mBackend").textContent = "Model yükleniyor…";
  $("progress").hidden = false;
  try {
    model = await m.engine.load(backend, m.base, (stage, p) => {
      aura?.setCharge(p);
      $("mBackend").textContent = stage === "compile" ? "Model hazırlanıyor…" : `Model yükleniyor, %${Math.round(p * 100)}`;
      $("progress").textContent = stage === "compile" ? "" :
        `${Math.round(p * m.mb)} / ${m.mb} MB · bir kez iner, sonra tarayıcıda saklanır`;
    });
    $("progress").textContent = backend === "webgpu" ? "Ekran kartı ısınıyor…" : "Hazırlanıyor…";
    for await (const _ of model.stream("Merhaba.", { steps: 1 })) { } // compiles the GPU shaders once
    $("progress").hidden = true;
    aura?.setCharge(1);
    $("mBackend").innerHTML = backend === "webgpu" ? "<b>Ekran kartında</b> çalışıyor" : "<b>İşlemcide</b> çalışıyor";
    setButton("speak");
    if (!$("hint").classList.contains("err")) hint("⌘/Ctrl + Enter ile seslendirin");
  } catch (e) {
    console.error(e);
    $("progress").hidden = true;
    $("mBackend").textContent = "Model yüklenemedi";
    hint(`Model yüklenemedi: ${e.message}. Sayfayı yenileyin; olmazsa Chrome ya da Edge'in güncel sürümünü deneyin.`, true);
  }
}
$("backend").onchange = () => { if (playing) stop(); load(); };
for (const b of $("models").children) b.onclick = () => {
  if (b.dataset.model === modelKey) return;
  modelKey = b.dataset.model;
  if (playing) stop();
  fillSteps(); showModel(); saveSettings(); idleLead(); load();
};

function audioGraph() {
  if (audio) return audio;
  const ctx = new AudioContext(); // buffers carry each model's own rate; the browser resamples them
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const master = ctx.createGain();
  master.connect(analyser);
  analyser.connect(ctx.destination);
  aura?.setAnalyser(analyser);
  audio = { ctx, master };
  return audio;
}

// ---------- speaking ----------

// Plays a stream of chunks `ratio` times faster by linear interpolation, carrying the read position and the last
// sample across chunks so there are no clicks at the joins.
function resampler(ratio) {
  if (ratio === 1) return (x) => x;
  let pos = 0, prev = 0;
  return (x) => {
    const n = x.length, y = new Float32Array(Math.ceil((n - pos) / ratio) + 1);
    let k = 0;
    for (; pos <= n - 1; pos += ratio) {
      const i = Math.floor(pos), f = pos - i, a = i < 0 ? prev : x[i], b = i + 1 < n ? x[i + 1] : a;
      y[k++] = a + (b - a) * f;
    }
    pos -= n; prev = x[n - 1];
    return y.subarray(0, k);
  };
}

function stop() {
  run++;
  if (playing) for (const s of playing.sources) try { s.stop(); } catch { }
  playing = null;
  setButton("speak");
  idleLead();
}

$("speak").onclick = async () => {
  if (playing) return stop();
  const text = $("text").value.trim();
  if (!model) return;
  if (!text) { hint("Seslendirmek için bir şey yazın.", true); $("text").focus(); return; }
  const { ctx, master } = audioGraph();
  await ctx.resume();

  const id = ++run;
  const p = playing = { sources: [], pieces: [], pending: null, at: ctx.currentTime + 0.08, done: false, shown: null, word: -1 };
  const chunks = [], stats = {}, t0 = performance.now(), rate = model.rate;
  let first = null;
  setButton("stop");
  hint("Hazırlanıyor… Esc ile durdurabilirsiniz");
  $("sub").hidden = true;
  $("lead").className = "lead"; $("lead").textContent = "…";
  requestAnimationFrame(() => follow(id));

  try {
    // pitch: the model speaks `ratio` times slower and playback runs `ratio` times faster, so tempo stays
    const ratio = 2 ** (+$("pitch").value / 12), shift = resampler(ratio);
    const style = $("style").value;
    const stream = model.stream(text, {
      speed: +$("speed").value / ratio, seed: Math.max(0, +$("seed").value || 0), steps: +$("steps").value,
      preset: style === "auto" ? null : style || null, autoStyle: style === "auto", stats,
      onPiece: (info) => {
        p.pending = { ...info, starts: info.starts.map((s) => s / ratio), seconds: info.seconds / ratio, start: null };
        p.pieces.push(p.pending);
      },
    });
    for await (const raw of stream) {
      if (id !== run) return;
      const chunk = shift(raw);
      if (!chunk.length) continue;
      if (first === null) { first = performance.now() - t0; hint("Esc ile durdurabilirsiniz"); }
      const buf = ctx.createBuffer(1, chunk.length, rate);
      buf.copyToChannel(chunk, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(master);
      p.at = Math.max(p.at, ctx.currentTime + 0.02);
      src.start(p.at);
      if (p.pending) { p.pending.start = p.at; p.pending = null; }
      p.at += buf.duration;
      p.sources.push(src);
      chunks.push(chunk);
    }
    p.done = true;
    const secs = chunks.reduce((a, c) => a + c.length, 0) / rate, total = performance.now() - t0;
    $("mFirst").hidden = $("mRtf").hidden = false;
    $("mFirst").querySelector("b").textContent = `${(first / 1000).toFixed(1)} sn`;
    $("mRtf").querySelector("b").textContent = `${(secs / (total / 1000)).toFixed(1)}× gerçek zaman`;
    lastChunks = { chunks, rate, name: current().wav }; $("download").hidden = false;
  } catch (e) {
    console.error(e);
    if (id === run) { stop(); hint(`Seslendirilemedi: ${e.message}`, true); }
  }
};

// Light each word as it is heard. The model has no aligner, so word times are estimated from letter positions.
function follow(id) {
  if (id !== run || !playing) return;
  const p = playing, t = audio.ctx.currentTime;
  const piece = p.pieces.filter((x) => x.start !== null && x.start <= t + 0.03).at(-1);
  if (piece && piece !== p.shown) {
    p.shown = piece; p.word = -1;
    $("lead").className = "lead";
    $("lead").replaceChildren(...piece.words.flatMap((w, i) => {
      const s = document.createElement("span");
      s.className = "w"; s.textContent = w; s.dataset.i = i;
      return i ? [" ", s] : [s];
    }));
  }
  if (piece) {
    const rel = t - piece.start;
    let w = -1;
    for (let i = 0; i < piece.words.length; i++) if ((piece.starts[i] ?? Infinity) <= rel) w = i;
    if (rel > piece.seconds) w = piece.words.length;
    if (w !== p.word) {
      if (w > p.word && w < piece.words.length) aura?.pulse();
      p.word = w;
      for (const s of $("lead").children) {
        const i = +s.dataset.i;
        s.className = "w" + (i < w ? " said" : i === w ? " now" : "");
      }
    }
  }
  if (p.done && t > p.at + 0.15) {
    playing = null;
    setButton("speak");
    hint("⌘/Ctrl + Enter ile tekrar seslendirin");
    for (const s of $("lead").children) s.className = "w said";
    setTimeout(() => { if (!playing && run === id) idleLead(); }, 2500);
    return;
  }
  requestAnimationFrame(() => follow(id));
}

idleLead();
load();
