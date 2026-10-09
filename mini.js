// Antalia Mini (cloud0day3/antalia-mini: 7.6M parameters, 48 kHz) behind the same interface as Antalia in tts.js, so
// the page can switch between the two. The model itself runs in mini/worker.js.

export class AntaliaMini {
  static MB = 23; // manifest.json's sizes of the four graphs, for progress

  static async load(backend, base, onProgress = () => {}) {
    const worker = new Worker(new URL("./mini/worker.js", import.meta.url), { type: "module" });
    try {
      await new Promise((resolve, reject) => {
        worker.onmessage = ({ data: m }) => {
          if (m.type === "progress") onProgress("download", m.total ? m.got / m.total : 0);
          else if (m.type === "compile") onProgress("compile", 1);
          else if (m.type === "ready") resolve();
          else if (m.type === "error") reject(new Error(m.message));
        };
        worker.onerror = (e) => reject(new Error(e.message || "worker failed to start"));
        // the worker resolves relative URLs from mini/
        worker.postMessage({ type: "load", backend, base: new URL(base, location.href).href });
      });
    } catch (e) {
      worker.terminate();
      throw e;
    }
    return new AntaliaMini(worker);
  }

  constructor(worker) {
    this.worker = worker;
    this.rate = 48000;
    this.ids = 0;
    this.listeners = new Map();
    worker.onmessage = ({ data: m }) => this.listeners.get(m.id)?.(m);
  }

  async release() { this.worker.terminate(); }

  // Yields Float32Array chunks of 48 kHz audio, pauses included. onPiece({ text, words, starts, seconds }) runs
  // before a chunk's audio; as in tts.js, word start times are estimated from character positions.
  async *stream(text, { seed = 0, steps = 8, speed = 1, onPiece = () => {} } = {}) {
    const id = ++this.ids, queue = [];
    let wake = null, finished = false;
    this.listeners.set(id, (m) => { queue.push(m); wake?.(); });
    this.worker.postMessage({ type: "speak", id, text, seed, steps, speed });
    try {
      for (;;) {
        while (!queue.length) await new Promise((r) => (wake = r));
        const m = queue.shift();
        if (m.type === "done") { finished = true; return; }
        if (m.type === "error") { finished = true; throw new Error(m.message); }
        const words = m.text.split(" "), seconds = m.speech / this.rate, starts = [];
        for (let i = 0, at = 0; i < words.length; at += words[i].length + 1, i++) starts.push((at / m.text.length) * seconds);
        onPiece({ text: m.text, words, starts, seconds });
        yield m.audio;
      }
    } finally {
      this.listeners.delete(id);
      if (!finished) this.worker.postMessage({ type: "cancel", id });
    }
  }
}
