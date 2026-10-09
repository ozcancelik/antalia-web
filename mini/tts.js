// Antalia-2 Mini inference in the browser: four ONNX graphs and the glue between them, reproducing
// antalia_mini.api.Antalia.say of the release (same defaults, options and noise: the same text and seed give
// the same audio). Every glue step mirrors web/tools/pipeline.py line for line (that file is what
// verify_onnx.py checks against the released package); keep the two in step.
//
//   text.onnx    ids (1, L) int64                -> h (1, L, 192), logd (1, L)
//   durations    logd -> frames per symbol: double-sound stretch, / speed, round half to even, clamp 1..60
//   frameIndex   durations -> frame-to-symbol index (1, T), T rounded up to a multiple of 2
//   cond.onnx    h, idx                          -> ctok, cnull (1, T/2, 192)
//   TorchRandn   x0 = torch.randn(T/2, 256) * temperature, one generator per utterance
//   flow.onnx    x, ctok, cnull, t, dt, cfg      -> x + (vc + (cfg-1)(vc-vu)) * dt   (run `steps` times)
//   vocoder.onnx z (1, T/2, 256)                 -> mel (1, 128, T), re / im (1, 1025, T)
//   istft        n_fft 2048, hop 512, Hann, centred -> 48 kHz audio, T * 512 samples
//   edges        cut the spoken prefix / suffix away (5 ms fades)
//   pause, OutputChain   silence between chunks, tone EQ (shelves at 210 Hz and 4 kHz), soft limiter

export const SAMPLE_RATE = 48000;
const N_FFT = 2048, HOP = 512, STACK = 2, N_MELS = 128, BINS = N_FFT / 2 + 1, MAX_DUR = 60;
const SPACE_ID = 3; // " " in the symbol table
const GRAPHS = ["text", "cond", "flow", "vocoder"];

// Which file of each graph a precision loads ("" = fp32, ".fp16" = the release's fp16 weights stored as float16,
// ".int8" = dynamic int8 MatMuls). Every variant computes in fp32. "mixed", the default: the acoustic graphs in
// fp32, so durations and mel are exactly Antalia().say's, and the vocoder (half the bytes) from the fp16 weights,
// which moves the audio by ~0.03 dB log-spectral distance (web/tests/onnx_verify). All-fp16 is 7 MB smaller but
// flips a rounded duration on ~1 sentence in 20, as Antalia(variant="fp16") does.
export const PRECISIONS = {
  mixed: { text: "", cond: "", flow: "", vocoder: ".fp16" },
  fp32: { text: "", cond: "", flow: "", vocoder: "" },
  fp16: { text: ".fp16", cond: ".fp16", flow: ".fp16", vocoder: ".fp16" },
  int8: { text: ".int8", cond: ".int8", flow: ".int8", vocoder: ".int8" },
};
const f32 = Math.fround;

// ----------------------------------------------------------------------------------- noise: torch.randn
/** torch.Generator().manual_seed(seed) and then torch.randn(n, 256, generator=g) calls, as on the CPU:
 * mt19937, a float in [0, 1) from the low 24 bits of each draw, Box-Muller over blocks of 16 (the first 8
 * values pair with the next 8) in float32. Equal to torch up to the last bit of log / cos / sin. */
export class TorchRandn {
  constructor(seed) {
    const s = new Uint32Array(624);
    s[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) s[i] = (Math.imul(1812433253, s[i - 1] ^ (s[i - 1] >>> 30)) + i) >>> 0;
    this.s = s;
    this.i = 624;
  }

  u32() {
    const s = this.s;
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (s[k] & 0x80000000) | (s[(k + 1) % 624] & 0x7fffffff);
        s[k] = s[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = s[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** n standard normal floats (n a multiple of 16), times `scale` in float32 */
  randn(n, scale = 1) {
    const out = new Float32Array(n), u = new Float32Array(16), sc = f32(scale);
    for (let b = 0; b < n; b += 16) {
      for (let j = 0; j < 16; j++) u[j] = (this.u32() & 0xffffff) * 5.9604644775390625e-8; // 2^-24, exact
      for (let j = 0; j < 8; j++) {
        const r = f32(Math.sqrt(f32(-2 * f32(Math.log(f32(1 - u[j]))))));
        const th = f32(2 * Math.PI * u[j + 8]);
        out[b + j] = f32(f32(r * f32(Math.cos(th))) * sc);
        out[b + j + 8] = f32(f32(r * f32(Math.sin(th))) * sc);
      }
    }
    return out;
  }
}

// ----------------------------------------------------------------------------------- glue
const roundHalfEven = (x) => {
  const f = Math.floor(x), d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

/** log durations (float32, per symbol) -> frames per symbol, as Antalia._acoustic computes them. */
export function durations(logd, ids, speed, gemStretch = 1) {
  const L = ids.length, ld = Float32Array.from(logd);
  if (gemStretch !== 1) {
    // double sounds are long in Turkish: the second of a pair inside a word ("berraktı"), the gap between a
    // pair across a word boundary ("alerjim mahvediyor")
    const g = f32(Math.log(gemStretch));
    for (let j = 2; j < L - 1; j++) {
      if (ids[j] === ids[j - 1] && ids[j] !== SPACE_ID) ld[j] = f32(ld[j] + g);
      else if (ids[j - 1] === SPACE_ID && ids[j] === ids[j - 2]) ld[j - 1] = f32(ld[j - 1] + g);
    }
  }
  const sp = f32(speed), dur = new Array(L);
  for (let j = 0; j < L; j++) dur[j] = Math.min(MAX_DUR, Math.max(1, roundHalfEven(f32(f32(Math.exp(ld[j])) / sp))));
  return dur;
}

export function frameIndex(dur) {
  const L = dur.length;
  const cum = new Array(L);
  let s = 0;
  for (let i = 0; i < L; i++) { s += dur[i]; cum[i] = s; }
  const T = Math.ceil(s / STACK) * STACK;
  const idx = new BigInt64Array(T);
  let j = 0;
  for (let f = 0; f < T; f++) {
    while (j < L && cum[j] <= f) j++;          // searchsorted(cum, f, side="right")
    idx[f] = BigInt(Math.min(j, L - 1));
  }
  return idx;
}

// iSTFT: per frame a real inverse FFT, Hann window, overlap-add, divided by the summed squared window,
// trimmed by n_fft / 2 on both sides (torch.istft with center=True). The real inverse FFT of size 2048 runs
// as one complex inverse FFT of size 1024 over the even/odd samples packed as real/imaginary parts.
const M = N_FFT / 2;
const WINDOW = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
const BITREV = new Uint32Array(M);
{
  const bits = Math.log2(M);
  for (let i = 0; i < M; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    BITREV[i] = r;
  }
}
const COS_M = new Float64Array(M / 2), SIN_M = new Float64Array(M / 2);  // twiddles of the size-M transform
for (let i = 0; i < M / 2; i++) { COS_M[i] = Math.cos((2 * Math.PI * i) / M); SIN_M[i] = Math.sin((2 * Math.PI * i) / M); }
const COS_N = new Float64Array(M), SIN_N = new Float64Array(M);          // e^{+2 pi i k / N} for the odd half
for (let i = 0; i < M; i++) { COS_N[i] = Math.cos((2 * Math.PI * i) / N_FFT); SIN_N[i] = Math.sin((2 * Math.PI * i) / N_FFT); }

function inverseFFT(xr, xi) {
  // in place, size M, unnormalised inverse transform (e^{+i...})
  for (let i = 0; i < M; i++) {
    const j = BITREV[i];
    if (j > i) { let t = xr[i]; xr[i] = xr[j]; xr[j] = t; t = xi[i]; xi[i] = xi[j]; xi[j] = t; }
  }
  for (let size = 2; size <= M; size <<= 1) {
    const half = size >> 1, step = M / size;
    for (let start = 0; start < M; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS_M[k * step], wi = SIN_M[k * step];
        const a = start + k, b = a + half;
        const tr = xr[b] * wr - xi[b] * wi, ti = xr[b] * wi + xi[b] * wr;
        xr[b] = xr[a] - tr; xi[b] = xi[a] - ti;
        xr[a] += tr; xi[a] += ti;
      }
    }
  }
}

/** re, im: (1025 x T) row-major -> Float32Array of T * HOP samples (the last HOP are zeros, as the vocoder pads). */
export function istft(re, im, T) {
  const n = N_FFT + HOP * (T - 1);
  const y = new Float64Array(n), env = new Float64Array(n);
  const zr = new Float64Array(M), zi = new Float64Array(M);
  // frame-major copies: reading a frame's 1025 bins with stride T thrashes the cache
  const fr = new Float32Array(BINS * T), fi = new Float32Array(BINS * T);
  for (let k = 0; k < BINS; k++) {
    const row = k * T;
    for (let t = 0; t < T; t++) { fr[t * BINS + k] = re[row + t]; fi[t * BINS + k] = im[row + t]; }
  }
  for (let t = 0; t < T; t++) {
    const base = t * BINS;
    // x[2m] + i x[2m+1] = IDFT_M(E + i O) / N, with E[k] = X[k] + X[k+M], O[k] = (X[k] - X[k+M]) e^{2 pi i k/N},
    // X[k+M] = conj(X[M-k]); the imaginary parts of the DC and Nyquist bins are ignored, as irfft does
    for (let k = 0; k < M; k++) {
      const ar = fr[base + k], ai = k === 0 ? 0 : fi[base + k];
      const br = fr[base + M - k], bi = k === 0 ? 0 : -fi[base + M - k];
      const er = ar + br, ei = ai + bi, dr = ar - br, di = ai - bi;
      const or = dr * COS_N[k] - di * SIN_N[k], oi = dr * SIN_N[k] + di * COS_N[k];
      zr[k] = er - oi; zi[k] = ei + or;
    }
    inverseFFT(zr, zi);
    const off = t * HOP;
    for (let m = 0; m < M; m++) {
      const i = 2 * m, w0 = WINDOW[i], w1 = WINDOW[i + 1];
      y[off + i] += (zr[m] / N_FFT) * w0;
      y[off + i + 1] += (zi[m] / N_FFT) * w1;
      env[off + i] += w0 * w0;
      env[off + i + 1] += w1 * w1;
    }
  }
  const a = N_FFT / 2, len = n - N_FFT;
  const out = new Float32Array(T * HOP);
  for (let i = 0; i < len; i++) {
    const e = env[a + i];
    out[i] = y[a + i] / (e > 1e-11 ? e : 1);
  }
  return out;
}

// ----------------------------------------------------------------------------------- engine
export class Engine {
  /** ort: the onnxruntime-web module; buffers: {text, cond, flow, vocoder} -> ArrayBuffer;
   * manifest: models/manifest.json (symbols, the release's defaults and options) */
  static async create(ort, buffers, manifest, providers = ["wasm"]) {
    const e = new Engine();
    e.ort = ort;
    e.sessions = {};
    e.defaults = { steps: 4, cfg: 1, speed: 1, temperature: 1, ...(manifest.defaults || {}) };
    e.options = { prefix: "", suffix: "", prefix_initials: null, gem_stretch: 1, tone: null, fade_ms: 5, ...(manifest.options || {}) };
    e.symbolId = new Map(manifest.symbols.map((c, i) => [c, i]));
    const opts = { executionProviders: providers, graphOptimizationLevel: "all" };
    for (const k of GRAPHS) e.sessions[k] = await ort.InferenceSession.create(new Uint8Array(buffers[k]), opts);
    return e;
  }

  /** model text -> ids with BOS / EOS, characters outside the symbol table dropped (== antalia_mini.text.encode) */
  encode(text) {
    const ids = [1];
    for (const c of text) {
      const id = this.symbolId.get(c);
      if (id !== undefined && id > 2) ids.push(id);
    }
    ids.push(2);
    return ids;
  }

  /** One chunk of model text -> 48 kHz audio with the spoken prefix / suffix cut away (before the output
   * chain). rng: the utterance's TorchRandn. Returns {audio, timings, frames}. */
  async synthChunk(text, rng, { steps, cfg, speed, temperature } = {}) {
    const { ort, sessions: s, options: o, defaults: d } = this;
    steps = Math.max(1, Math.trunc(steps || d.steps));
    cfg = cfg ?? d.cfg;
    speed = speed > 0 ? speed : d.speed;
    temperature = temperature ?? d.temperature;
    const now = () => performance.now();
    const tm = {};
    let t0 = now();
    const pre = o.prefix && (o.prefix_initials == null || o.prefix_initials.includes(text.slice(0, 1))) ? o.prefix : "";
    const suf = o.suffix || "";
    const nPre = pre ? this.encode(pre).length - 2 : 0, nSuf = suf ? this.encode(suf).length - 2 : 0;
    const ids = this.encode(pre + text + suf);
    const L = ids.length;
    const r1 = await s.text.run({ ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, L]) });
    const dur = durations(r1.logd.data, ids, speed, o.gem_stretch);
    tm.text = now() - t0; t0 = now();

    const idx = frameIndex(dur);
    const T = idx.length, N = T / STACK;
    const r2 = await s.cond.run({ h: r1.h, idx: new ort.Tensor("int64", idx, [1, T]) });
    tm.cond = now() - t0; t0 = now();

    let x = new ort.Tensor("float32", rng.randn(N * N_MELS * STACK, temperature), [1, N, N_MELS * STACK]);
    const dtv = 1 / steps;
    const dt = new ort.Tensor("float32", new Float32Array([dtv]), [1]);
    const cfgT = new ort.Tensor("float32", new Float32Array([cfg]), [1]);
    for (let i = 0; i < steps; i++) {
      const r = await s.flow.run({ x, ctok: r2.ctok, cnull: r2.cnull, t: new ort.Tensor("float32", new Float32Array([i * dtv]), [1]), dt, cfg: cfgT });
      if (i) x.dispose?.();
      x = r.x_next;
    }
    tm.flow = now() - t0; t0 = now();

    const r4 = await s.vocoder.run({ z: x });
    tm.vocoder = now() - t0; t0 = now();
    let audio = istft(r4.re.data, r4.im.data, T);
    tm.istft = now() - t0;
    for (const k of [r1.h, r1.logd, r2.ctok, r2.cnull, x, r4.mel, r4.re, r4.im]) k.dispose?.();

    if (pre || suf) {
      // api._edges: keep the frame span of the chunk's own text (after BOS + prefix, before suffix + EOS)
      let cum = 0, a = 0, b = 0;
      for (let j = 0; j < L; j++) {
        cum += dur[j];
        if (j === nPre) a = cum;
        if (j === L - 2 - nSuf) b = cum;
      }
      audio = audio.slice(pre ? a * HOP : 0, suf ? b * HOP : audio.length);
      const fade = Math.floor((o.fade_ms * SAMPLE_RATE) / 1000);
      if (pre && fade && audio.length > 2 * fade) for (let i = 0; i < fade; i++) audio[i] = f32(audio[i] * fadeIn(i, fade));
      if (suf && fade && audio.length > 2 * fade) {
        const off = audio.length - fade;
        for (let i = 0; i < fade; i++) audio[off + i] = f32(audio[off + i] * fadeOut(i, fade));
      }
    }
    return { audio, timings: tm, frames: T };
  }
}

// np.linspace(0, 1, n, dtype=float32) and np.linspace(1, 0, n, dtype=float32), element i
const fadeIn = (i, n) => (i === n - 1 ? 1 : f32(i * (1 / (n - 1))));
const fadeOut = (i, n) => (i === n - 1 ? 0 : f32(i * (-1 / (n - 1)) + 1));

/** Silence after a chunk that is not the last: 0.12 s after a sentence, 0.06 s after a clause. */
export function pauseAfter(chunk) {
  return new Float32Array(Math.floor((/[.?!]$/.test(chunk.trimEnd()) ? 0.12 : 0.06) * SAMPLE_RATE));
}

// ----------------------------------------------------------------------------------- output chain
const LIMIT_THRESHOLD = 10 ** (-1 / 20), LIMIT_CEILING = 10 ** (-0.1 / 20);

function shelf(f0, gainDb, high, q = 0.707) {
  // RBJ cookbook low / high shelf, normalised [b0, b1, b2, a1, a2]
  const A = 10 ** (gainDb / 40), w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0), s = 2 * Math.sqrt(A) * alpha;
  const b = high
    ? [A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s)]
    : [A * (A + 1 - (A - 1) * c + s), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - s)];
  const a = high
    ? [A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s]
    : [A + 1 + (A - 1) * c + s, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - s];
  return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
}

/** post.OutputChain at 48 kHz: with tone [low dB, high dB], a low shelf at 210 Hz and a high shelf at 4 kHz
 * (replacing the default EQ, no make-up gain), then the soft limiter (knee from -1 dBFS, ceiling -0.1 dBFS).
 * The release applies the shelves as an FIR of their impulse response; the same biquads run recursively here.
 * State carries across chunks, so chunk by chunk equals the whole utterance at once. */
export class OutputChain {
  constructor(tone) {
    this.sections = tone ? [shelf(210, tone[0], false), shelf(4000, tone[1], true)] : [];
    this.state = this.sections.map(() => [0, 0, 0, 0]);
  }

  process(x) {
    const n = x.length, out = new Float32Array(n);
    if (!this.sections.length) {
      for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, x[i]));
      return out;
    }
    const y = Float64Array.from(x);
    this.sections.forEach(([b0, b1, b2, a1, a2], k) => {
      let [x1, x2, y1, y2] = this.state[k];
      for (let i = 0; i < n; i++) {
        const v = y[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = o;
        y[i] = o;
      }
      this.state[k] = [x1, x2, y1, y2];
    });
    const room = LIMIT_CEILING - LIMIT_THRESHOLD;
    for (let i = 0; i < n; i++) {
      const v = y[i], a = Math.abs(v);
      out[i] = a > LIMIT_THRESHOLD ? Math.sign(v) * (LIMIT_THRESHOLD + room * Math.tanh((a - LIMIT_THRESHOLD) / room)) : v;
    }
    return out;
  }
}

// ----------------------------------------------------------------------------------- one utterance
/** Antalia.stream: model text -> audio chunks (first sentence first) through one noise generator and one
 * output chain; joined, the chunks equal Antalia.say(text, seed) of the release.
 * Yields {audio, index, count, timings}. */
export async function* speak(engine, modelText, { seed = 0, steps, cfg, speed, temperature } = {}) {
  const chunks = splitModelText(modelText);
  const rng = new TorchRandn(seed), chain = new OutputChain(engine.options.tone);
  for (let k = 0; k < chunks.length; k++) {
    const { audio, timings } = await engine.synthChunk(chunks[k], rng, { steps, cfg, speed, temperature });
    const t0 = performance.now();
    let w = audio;
    if (k < chunks.length - 1) {
      const p = pauseAfter(chunks[k]);
      w = new Float32Array(audio.length + p.length);
      w.set(audio);
    }
    w = chain.process(w);
    timings.post = performance.now() - t0;
    yield { audio: w, index: k, count: chunks.length, timings };
  }
}

// ----------------------------------------------------------------------------------- text chunks
// api.split_model_text: sentences packed up to 300 characters (~18 s), a longer sentence cut at commas, then
// at spaces; the first chunk packs only up to 80 characters (but always holds the whole first sentence), so
// playback starts after the first sentence.
const pyLen = (s) => Array.from(s).length;

function pack(pieces, maxChars, sep = " ") {
  const out = [];
  let cur = "";
  for (const p of pieces) {
    if (pyLen(p) > maxChars) {
      if (cur) { out.push(cur); cur = ""; }
      if (sep === " " && p.includes(" ")) out.push(...pack(p.split(" "), maxChars));
      else { const cp = Array.from(p); for (let i = 0; i < cp.length; i += maxChars) out.push(cp.slice(i, i + maxChars).join("")); }
      continue;
    }
    if (cur && pyLen(cur) + 1 + pyLen(p) > maxChars) { out.push(cur); cur = p; }
    else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

export function splitModelText(text, maxChars = 300, firstChars = 80) {
  const sentences = text.trim().split(/(?<=[.?!])\s+/u).map((s) => s.trim()).filter(Boolean);
  const pieces = [];
  for (const s of sentences) {
    if (pyLen(s) > maxChars) pieces.push(...pack(s.split(/(?<=[,;:])\s+/u).filter(Boolean), maxChars));
    else pieces.push(s);
  }
  if (!pieces.length) return [];
  let chunks;
  if (firstChars) {
    let head = "", used = 0;
    for (const p of pieces) {
      if (head && pyLen(head) + 1 + pyLen(p) > firstChars) break;
      head = head ? `${head} ${p}` : p;
      used++;
    }
    chunks = [head, ...pack(pieces.slice(used), maxChars)];
  } else chunks = pack(pieces, maxChars);
  return chunks.filter((c) => /\p{L}/u.test(c));
}
