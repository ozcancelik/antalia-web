# antalia-web

Açık Türkçe metin okuma modeli [Antalia 1](https://huggingface.co/cloud0day3/antalia-1), tamamen tarayıcıda.
Model ekran kartında (WebGPU) çalışır; yazdığınız metin cihazınızdan çıkmaz. Buradaki sesler yapay zekâyla üretilir.

A browser demo of Antalia 1 (304.6M-parameter Turkish rectified-flow TTS) with NVIDIA BigVGAN v2 as vocoder: ONNX
graphs on onnxruntime-web (WebGPU, WASM fallback), the model's own text normalizer ported to JavaScript.

**Canlı:** https://antalia-web.vercel.app/ · **Kod:** https://github.com/ozcancelik/antalia-web

**Model dosyaları:** [huggingface.co/ozcancelik/antalia-1-onnx](https://huggingface.co/ozcancelik/antalia-1-onnx)

## Model files

The ONNX files (about 900 MB) are too big for git and static hosting, so they live on Hugging Face:
[ozcancelik/antalia-1-onnx](https://huggingface.co/ozcancelik/antalia-1-onnx), with a model card that lists every
change made to the original weights. The deployed page loads them from there, pinned to a commit (`HF_REPO` and
`HF_REVISION` in `app.js`); on `localhost` it loads `models/` instead. They are stored in Cache Storage on first
load, so they download once.

To update them: rebuild with the tools in `../antalia` (see its README), upload to the Hub, then set `HF_REVISION` to
the new commit and bump `CACHE` in `tts.js`.

## Run

```sh
python3 -m http.server 8766    # then open http://localhost:8766
```

WebGPU needs `localhost` or HTTPS. For local runs, put the model files in `models/`, either built with `../antalia` or
downloaded:

```sh
hf download ozcancelik/antalia-1-onnx text.onnx flow.onnx vocoder.onnx meta.json --local-dir models
```

Measured on an Apple laptop GPU (Chrome, 16 steps): 6 s of speech in about 6 s, first audio after the whole first
chunk (up to 120 characters) is ready. 32 steps take twice as long. The WASM backend works but is far slower than
real time.

## Files

- `index.html`, `app.js` the page; `aura.js` the WebGL2 background, driven by the audio
- `tts.js` the engine: chunking, prosody presets, the guided Euler sampler loop, vocoding
- `normalize.js` port of `turkish_tts/normalize.py` (checked against Python by `../antalia/tools/check_normalize.py`)
- `bench.html` timing page
- `og.jpg`, `favicon.svg` share card (made by `../antalia/tools/make_og.py`) and icon
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
- Vocoder: [NVIDIA BigVGAN v2](https://huggingface.co/nvidia/bigvgan_v2_24khz_100band_256x) (MIT).
- Runtime: [onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT), loaded from jsDelivr.
