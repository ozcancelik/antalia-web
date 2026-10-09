# antalia-web

Açık Türkçe metin okuma modelleri [Antalia 1](https://huggingface.co/cloud0day3/antalia-1) ve
[Antalia Mini](https://huggingface.co/cloud0day3/antalia-mini), tamamen tarayıcıda. Antalia 1 yüksek kalitelidir ve
ekran kartında (WebGPU) çalışır; Mini 23 MB'tır, ekran kartında da işlemcide de hızlıdır. Yazdığınız metin cihazınızdan
çıkmaz. Buradaki sesler yapay zekâyla üretilir.

A browser demo of Antalia 1 (304.6M-parameter Turkish rectified-flow TTS) with NVIDIA BigVGAN v2 as vocoder: ONNX
graphs on onnxruntime-web (WebGPU, WASM fallback), the model's own text normalizer ported to JavaScript.

The page starts with **Antalia Mini** ([cloud0day3/antalia-mini](https://huggingface.co/cloud0day3/antalia-mini),
7.6M parameters, 48 kHz, Apache-2.0): about 23 MB instead of 900 MB, run in a Web Worker on WebGPU or the CPU,
faster than real time either way (on an Apple laptop, Chrome, 8 steps: about 18× real time on WebGPU with first audio
after 0.3 s, 5.5× on one CPU thread with first audio after 0.8 s). Lower quality and a single voice; speaking styles do not apply to it.
The switch in the header loads Antalia 1 instead, after asking first unless its files are already cached, since they
are a 900 MB download.

**Canlı:** https://antalia-web.vercel.app/ · **Kod:** https://github.com/ozcancelik/antalia-web

**Model dosyaları:** [huggingface.co/ozcancelik/antalia-1-onnx](https://huggingface.co/ozcancelik/antalia-1-onnx)

## Model files

The ONNX files (about 900 MB) are too big for git and static hosting, so they live on Hugging Face:
[ozcancelik/antalia-1-onnx](https://huggingface.co/ozcancelik/antalia-1-onnx), with a model card that lists every
change made to the original weights. The deployed page loads them from there, pinned to a commit (`HF_REPO` and
`HF_REVISION` in `app.js`); on `localhost` it loads `models/` instead. They are stored in Cache Storage on first
load, so they download once.

Antalia Mini's ONNX graphs, text frontend data and manifest are loaded from its Hugging Face Space
([cloud0day3/antalia-mini](https://huggingface.co/spaces/cloud0day3/antalia-mini)), pinned to a commit (`MINI_REVISION`
in `app.js`, cache name `CACHE` in `mini/worker.js`).

To update them: upload the new files to the Hub, then set `HF_REVISION` to the new commit and bump `CACHE` in `tts.js`.

## Run

```sh
python3 -m http.server 8766    # then open http://localhost:8766
```

WebGPU needs `localhost` or HTTPS. For local runs, download the model files into `models/`:

```sh
hf download ozcancelik/antalia-1-onnx text.onnx flow.onnx vocoder.onnx meta.json --local-dir models
hf download --repo-type space cloud0day3/antalia-mini --revision 2c24b406fedada11bd731a2ec9f4535bfd354f03 \
  models/manifest.json models/text.onnx models/cond.onnx models/flow.onnx models/vocoder.fp16.onnx \
  assets/frontend-data.json.gz --local-dir models/mini
```

Measured on an Apple laptop GPU (Chrome, 16 steps): 6 s of speech in about 6 s, first audio after the whole first
chunk (up to 120 characters) is ready. 32 steps take twice as long. The WASM backend works but is far slower than
real time.

## Files

- `index.html`, `app.js` the page; `aura.js` the WebGL2 background, driven by the audio
- `tts.js` the engine: chunking, prosody presets, the guided Euler sampler loop, vocoding
- `normalize.js` port of `turkish_tts/normalize.py`
- `mini.js` Antalia Mini behind the same interface as `tts.js`; `mini/worker.js` runs it off the main thread;
  `mini/tts.js` and `mini/frontend.js` are copied unchanged from the model's Space
- `og.jpg`, `favicon.svg` share card and icon
- `models/` `text.onnx` (fp32), `flow.onnx` and `vocoder.onnx` (fp16 with fp32 islands), `meta.json`

The same seed does not give the same audio as the Python package: noise comes from a JavaScript PRNG.
Not ported: best-of-8 selection (needs Whisper and WavLM) and the recipe's noise-envelope pinning (absent from the
released code). Word highlighting is estimated from letter positions; the model has no aligner.

## Credits and license

Code: Apache-2.0, see `LICENSE` and `NOTICE`. Model files: their own licenses, below.

- Model: **Antalia 1** by Sezgin Saygili, Emre Kaplaner, Oncel Ozgul and Fikri San Koktas (Patientdesk.ai),
  [huggingface.co/cloud0day3/antalia-1](https://huggingface.co/cloud0day3/antalia-1), code
  [github.com/0daycloud/antalia](https://github.com/0daycloud/antalia). Weights under Antalia OpenRAIL-M: attribution
  required, synthetic audio must be disclosed, no impersonation or deceptive use. The ONNX files are conversions of
  its weights and carry the same license.
- Antalia Mini: **Antalia-2 Mini** by Patientdesk.ai, [huggingface.co/cloud0day3/antalia-mini](https://huggingface.co/cloud0day3/antalia-mini),
  Apache-2.0 (code, normalizer and weights). Its card asks that synthetic audio be disclosed and forbids
  impersonation, fraud and deceptive calls.
- Vocoder: [NVIDIA BigVGAN v2](https://huggingface.co/nvidia/bigvgan_v2_24khz_100band_256x) (MIT).
- Runtime: [onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT), loaded from jsDelivr.
