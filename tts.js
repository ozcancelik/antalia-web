// Antalia 1 in the browser: text -> 24 kHz audio with onnxruntime-web (WebGPU, or WASM as fallback).
// Mirrors turkish_tts.crossflow_train (_chunk_text, _synthesize_loaded_crossflow) and CrossFlow.sample.
import { normalize, turkishLower } from "./normalize.js";

export const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
let ort = null;

// Model files are kept in Cache Storage, so they download once. Bump the version when anything in models/ changes;
// older caches are deleted on the next load.
const CACHE = "antalia-models-v1";

// Fetches a file, reporting bytes as they arrive: the flow graph alone is 570 MB. `name` is the cache to keep it in;
// older versions of that cache (same name, lower number) are deleted.
export async function bytes(url, onBytes = () => {}, name = CACHE) {
  let cache = null;
  try {
    const family = name.replace(/\d+$/, "");
    for (const key of await caches.keys()) if (key.startsWith(family) && key !== name) await caches.delete(key);
    cache = await caches.open(name);
  } catch {} // no Cache Storage outside a secure context: plain fetch
  const hit = await cache?.match(url).catch(() => null);
  if (hit) {
    const buf = await hit.arrayBuffer();
    onBytes(buf.byteLength, buf.byteLength);
    return buf;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +res.headers.get("content-length") || 0;
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onBytes(got, total);
  }
  const buf = new Uint8Array(got);
  for (let o = 0, i = 0; i < parts.length; o += parts[i].length, i++) buf.set(parts[i], o);
  try { await cache?.put(url, new Response(buf, { headers: { "content-type": "application/octet-stream" } })); }
  catch {} // full storage: still works, just not cached
  return buf.buffer;
}

// Whether a file is already in Cache Storage, so loading it costs no download.
export async function isCached(url, name = CACHE) {
  try { return !!(await (await caches.open(name)).match(url)); } catch { return false; }
}

export const RATE = 24000;
export const FILES = { text: 78.3e6, flow: 570.2e6, vocoder: 252.4e6 }; // for progress before content-length arrives

// ---------- text: _chunk_text and validate_crossflow_synthesis_text ----------

// Normalizes first, so "Dr. Kaya" is not cut at its dot. Python stops there; a part still over the limit (a long
// sentence without commas) would exceed the token budget or rush, so here it is also split between words.
export function chunkText(text, limit) {
  const stripped = normalize(text.trim());
  if (limit <= 0 || stripped.length <= limit) return [stripped];
  const parts = [];
  for (const sentence of stripped.split(/(?<=[.!?;:])\s+/u)) {
    for (const part of sentence.length > limit ? sentence.split(/(?<=,)\s+/u) : [sentence]) {
      if (part.length <= limit) { parts.push(part); continue; }
      let line = "";
      for (const word of part.split(" ")) {
        if (line && line.length + 1 + word.length > limit) { parts.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
      }
      if (line) parts.push(line);
    }
  }
  const chunks = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? `${current} ${part}`.trim() : part;
    if (current && candidate.length > limit) { chunks.push(current); current = part; }
    else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------- prosody: blend_prosody_preset and the auto-style router ----------

const EMPATHY = ["üzgün", "özür", "maalesef", "anlıyor", "endişe", "sabrınız"];

function blend(base, target, strength) {
  return base.map((b, i) => Math.max(-5, Math.min(5, b + strength * (target[i] - b))));
}

function chunkStyle(chunk) {
  if (chunk.includes("?")) return "questions_confirmations";
  const lowered = turkishLower(chunk);
  return EMPATHY.some((k) => lowered.includes(k)) ? "restrained_emotion" : null;
}

// ---------- seeded Gaussian noise (a JS PRNG: the same seed does not give torch.randn's noise) ----------

function gaussian(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (n) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
      const r = Math.sqrt(-2 * Math.log(1 - uniform())), th = 2 * Math.PI * uniform();
      out[i] = r * Math.cos(th);
      if (i + 1 < n) out[i + 1] = r * Math.sin(th);
    }
    return out;
  };
}

// CrossFlow.sample's time grid: uniform, bent toward t = 0 by the sway coefficient.
function schedule(steps, sway) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const u = i / steps;
    return u + sway * (Math.cos((Math.PI / 2) * u) - 1 + u);
  });
}

const i64 = (arr) => new ort.Tensor("int64", BigInt64Array.from(arr, (x) => BigInt(x)), [1, arr.length]);
const f32 = (arr, dims) => new ort.Tensor("float32", arr, dims);
const scalar = (v) => f32(Float32Array.of(v), [1]);

export class Antalia {
  static async load(backend = "webgpu", base = "models/", onProgress = () => {}) {
    ort = await import(ORT + (backend === "webgpu" ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"));
    ort.env.wasm.wasmPaths = ORT;
    const meta = await (await fetch(base + "meta.json")).json();
    const opts = { executionProviders: backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
                   graphOptimizationLevel: "all" };
    const names = ["text", "flow", "vocoder"], done = {};
    const total = names.reduce((a, n) => a + FILES[n], 0);
    const report = (stage) => onProgress(stage, names.reduce((a, n) => a + (done[n] ?? 0), 0) / total);
    const sessions = {};
    for (const name of names) {
      const buf = await bytes(base + name + ".onnx", (got, size) => {
        done[name] = size ? (got / size) * FILES[name] : Math.min(got, FILES[name]);
        report("download");
      });
      report("compile");
      sessions[name] = await ort.InferenceSession.create(buf, opts);
    }
    const model = new Antalia(meta, sessions, backend);
    const { ctx } = await model.text.run({ ids: i64([1]) }); // the text-free branch of guidance: one <unk>
    model.nullCtx = await ctx.getData();
    ctx.dispose?.();
    return model;
  }

  constructor(meta, sessions, backend) {
    Object.assign(this, sessions);
    this.backend = backend;
    this.rate = RATE;
    this.meta = meta;
    this.recipe = meta.recipe;
    this.stoi = new Map(meta.vocab.map((ch, i) => [ch, i]));
  }

  async release() {
    for (const s of [this.text, this.flow, this.vocoder]) await s?.release().catch(() => {});
  }

  // The chunks that will be spoken, each normalized and stripped of characters the model never saw (<unk> got no
  // gradient in training, so it would make an arbitrary sound).
  pieces(text) {
    return chunkText(text, this.recipe.chunk_character_limit)
      .map((c) => [...normalize(c)].filter((ch) => this.stoi.has(ch) && ch !== "<unk>").join("").trim())
      .filter((c) => /\p{L}/u.test(c));
  }

  prosody(chunk, preset, autoStyle) {
    const mean = this.recipe.prosody;
    const style = autoStyle ? chunkStyle(chunk) : null;
    const name = style ?? preset;
    return name && this.meta.presets[name] ? blend(mean, this.meta.presets[name], 1) : mean;
  }

  // Yields Float32Array chunks of 24 kHz audio, one per text chunk, with pauses between.
  // onPiece({ text, words, starts, seconds }) runs before a chunk's audio. The model has no aligner, so word start
  // times are estimated from character positions.
  async *stream(text, { seed = 0, steps = this.recipe.steps, speed = 1, preset = null, autoStyle = true,
                        guidance = this.recipe.text_guidance_scale, stats = {}, onPiece = () => {},
                        noise = (k, n) => gaussian(seed + k * 100000)(n) } = {}) {
    const r = this.recipe, hop = this.meta.hop, C = this.meta.mel_channels;
    const pieces = this.pieces(text);
    stats.pieces = pieces;
    stats.text = stats.flow = stats.vocoder = 0;
    const grid = schedule(steps, r.sway_coefficient);
    for (let k = 0; k < pieces.length; k++) {
      const piece = pieces[k];
      let t0 = performance.now();
      const ids = [...piece].map((ch) => this.stoi.get(ch)).slice(0, this.meta.max_text_tokens);
      const L = ids.length;
      const out = await this.text.run({ ids: i64(ids) });
      const ctx1 = await out.ctx.getData(), logFrames = (await out.log_frames.getData())[0];
      out.ctx.dispose?.(); out.log_frames.dispose?.();
      const predicted = Math.round(Math.exp(logFrames));
      const letters = [...piece].filter((ch) => !/\s/u.test(ch)).length;
      const floor = Math.ceil(letters * r.min_seconds_per_char * RATE / hop);
      const T = Math.max(8, Math.min(this.meta.max_frames, Math.round(Math.max(predicted, floor) / speed)));
      stats.text += performance.now() - t0;

      // row 0: the text; row 1: the null text, padded and masked
      t0 = performance.now();
      const ctx2 = new Float32Array(2 * L * 768);
      ctx2.set(ctx1, 0);
      ctx2.set(this.nullCtx, L * 768);
      const mask = new Uint8Array(2 * L);
      mask.fill(1, 0, L); mask[L] = 1;
      const feeds = {
        ctx: f32(ctx2, [2, L, 768]), tmask: new ort.Tensor("bool", mask, [2, L]),
        prosody: f32(Float32Array.from(this.prosody(piece, preset, autoStyle)), [1, 6]),
        guidance: scalar(guidance), rescale: scalar(r.guidance_rescale),
      };
      let x = f32(noise(k, T * C), [1, T, C]);
      for (let s = 0; s < steps; s++) {
        const res = await this.flow.run({ ...feeds, x, t: scalar(grid[s]), dt: scalar(grid[s + 1] - grid[s]) });
        x = res.x_next;
      }
      const mel = await x.getData();
      (stats.mels ??= []).push(mel);
      stats.flow += performance.now() - t0;

      t0 = performance.now();
      const { audio } = await this.vocoder.run({ mel: f32(mel, [1, T, C]) });
      const wav = await audio.getData();
      audio.dispose?.();
      stats.vocoder += performance.now() - t0;

      const words = piece.split(" "), seconds = wav.length / RATE, starts = [];
      for (let i = 0, at = 0; i < words.length; at += words[i].length + 1, i++) starts.push((at / piece.length) * seconds);
      onPiece({ text: piece, words, starts, seconds });
      yield wav;
      if (k + 1 < pieces.length) yield new Float32Array(Math.round(r.chunk_pause_seconds * RATE));
    }
  }
}

export function wavBlob(chunks, rate = RATE) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + 2 * n), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + 2 * n, true); str(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, 2 * n, true);
  let o = 44;
  for (const c of chunks) for (const x of c) { v.setInt16(o, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true); o += 2; }
  return new Blob([buf], { type: "audio/wav" });
}
