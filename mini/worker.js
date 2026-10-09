// Antalia Mini off the main thread: the text frontend, the four ONNX graphs and the iSTFT all run here, so the page
// and its background stay smooth.
//   -> {type: "load", base, backend}           (backend: "webgpu" or "wasm")
//   <- {type: "progress", got, total} ... {type: "ready"}
//   -> {type: "speak", id, text, seed, steps, speed}
//   <- {type: "chunk", id, text, audio, speech} ... {type: "done", id}   (speech: samples before the pause)
//   -> {type: "cancel", id}
//   <- {type: "error", id?, message}
import { ORT, bytes } from "../tts.js";
import { Engine, PRECISIONS, pauseAfter, speak, splitModelText } from "./tts.js";
import { createFrontend, decodeAsset } from "./frontend.js";

// Bump when the files at the pinned revision change; older caches are deleted on the next load.
const CACHE = "antalia-mini-v1";
const GRAPHS = ["text", "cond", "flow", "vocoder"];
let engine = null, frontend = null;
const cancelled = new Set();

async function load(base, backend) {
  const manifest = JSON.parse(new TextDecoder().decode(await bytes(base + "models/manifest.json", undefined, CACHE)));
  const gpu = backend === "webgpu";
  const ort = await import(ORT + (gpu ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"));
  ort.env.wasm.wasmPaths = ORT;
  ort.env.wasm.numThreads = 1; // threads need a cross-origin isolated page
  // "mixed", the release's default: the acoustic graphs in fp32, the vocoder from the fp16 weights
  const names = GRAPHS.map((k) => `${k}${PRECISIONS.mixed[k]}.onnx`);
  const total = names.reduce((a, n) => a + manifest.files[n].bytes, 0), got = {};
  const [data, ...buffers] = await Promise.all([
    bytes(base + "assets/frontend-data.json.gz", undefined, CACHE),
    ...names.map((n) => bytes(base + "models/" + n, (g) => {
      got[n] = g;
      postMessage({ type: "progress", got: Object.values(got).reduce((a, b) => a + b, 0), total });
    }, CACHE)),
  ]);
  postMessage({ type: "compile" });
  frontend = createFrontend(await decodeAsset(data));
  frontend.warmup();
  engine = await Engine.create(ort, Object.fromEntries(GRAPHS.map((k, i) => [k, buffers[i]])), manifest,
    gpu ? ["webgpu", "wasm"] : ["wasm"]);
}

async function synth({ id, text, seed, steps, speed }) {
  const modelText = frontend.modelText(text), chunks = splitModelText(modelText);
  const stream = speak(engine, modelText, { seed, steps, speed: engine.defaults.speed * speed });
  if (!cancelled.has(id)) for await (const { audio, index, count } of stream) {
    if (cancelled.has(id)) break;
    const speech = index < count - 1 ? audio.length - pauseAfter(chunks[index]).length : audio.length;
    postMessage({ type: "chunk", id, text: chunks[index], audio, speech }, [audio.buffer]);
    await new Promise((r) => setTimeout(r)); // lets a cancel message in before the next chunk
  }
  cancelled.delete(id);
  postMessage({ type: "done", id });
}

let queue = Promise.resolve();
onmessage = ({ data: m }) => {
  if (m.type === "cancel") { cancelled.add(m.id); return; }
  queue = queue
    .then(() => (m.type === "load" ? load(m.base, m.backend).then(() => postMessage({ type: "ready" })) : synth(m)))
    .catch((e) => postMessage({ type: "error", id: m.id, message: String(e?.message || e) }));
};
