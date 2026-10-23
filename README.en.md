# readvideo

**Turn videos into articles. Browser-only. No local service.**

[Open the app](https://survivorno1.github.io/readvideo/app/) · [Website](https://survivorno1.github.io/readvideo/en.html) · [中文](README.md)

![Real interface](docs/images/home.png)

Paste a link. Read accessible captions first. Otherwise explicitly share the video tab's audio and let Whisper transcribe inside the browser. Generate a short, medium, long or detailed article using your own API. No Python, yt-dlp, extension or local model service.

## Workflow

Configure your API, paste a link, choose a reading depth, then click **读取并生成**. Readable captions skip ASR. Supported YouTube/Bilibili links offer an inline player: explicitly share this readvideo tab's audio, then play from the intended start. Restricted embeds can fall back to the original site and sharing that video's tab. Stop when finished; the app drains the remaining queue before generating. Search, copy or export the full text. Embedded playback and full audio capture require actual platform validation; an iframe alone is not proof of success.

Desktop Chrome / Edge is the initial tab-audio target. The interface is Chinese; generated text supports Chinese and English. Bilingual product pages are available. The earlier Python prototype has been removed; it remains in Git history.

## Browser computation

- Automatically prefer captions, then explicit CORS-readable audio/video sources in readable pages, then authorized tab audio. Complete accessible audio is decoded without waiting for playback; restricted platform pages still require consent and playback.
- Completed transcripts are reused for the same URL and recognition language when changing article depth, without another recording or recognition pass.

- AudioWorklet captures mono PCM. A separate module Worker runs pinned Transformers.js 3.8.1 and Whisper tiny multilingual. Assets download on demand and can be browser-cached.
- WebGPU is optional. GPU initialization/inference failures retry the same audio on CPU. Users can force CPU/WASM, verified using real speech.
- Ordered 24-second windows retain context and the final short tail. Capture and recognition overlap. Pending time is visible; a 20-minute backlog stops capture and drains retained audio.
- Failure retains queued audio and earlier text. Retry on CPU or download pending audio as a WAV. Partial transcripts are labelled.
- GitHub Pages lacks cross-origin isolation headers, so WASM inference defaults to one thread. UI, audio and model processing are separated. Speed depends on the device; additional model workers are not advertised as unlimited acceleration.

## Articles and correction

English targets: short 200–350 words, medium 600–1,000, long 1,200–2,000, detailed 2,000–3,500. Chinese targets: 300–500, 800–1,500, 1,800–3,000 and 3,000–5,000 characters. Source density takes precedence; prompts forbid invented filler.

Prompts focus on source evidence, correct clear contextual transcription/punctuation errors, preserve numbers, units, negation, attribution and limitations, and flag uncertain names/terms. Relevant correction notes are included by instruction. Original captions remain unchanged; this is not external fact checking. All chunks are processed, with explicit limits rather than silent truncation.

## Permissions and privacy

Tab sharing grants access to playback, not a downloadable full audio track. The user operates the permission picker; no microphone fallback. Skipped passages cannot be recovered automatically. Capture timestamps and an optional source offset are affected by pauses, seeking, advertisements and speed changes. Captions on a platform are not necessarily CORS-readable by a webpage. Direct readable media links and subtitle imports are additional routes; this app does not bypass authentication or media protection.

Audio stays in the device browser. On requested generation, text and the memory-only key go directly to the selected HTTPS API. Keys never enter persistent browser storage or exports. Custom providers must support browser CORS. Free-tier access depends on the provider. There are no shared keys or Ollama dependency.

## Verification and development

Real Chrome CPU/WASM Whisper recognized the public JFK sample. Separately, a browser-direct DeepSeek call turned 64 cues into a 1,472-character Chinese article without a backend or proxy. See [verification](docs/verification.md). Synthetic test adapters do not prove the real permission picker or model; WebGPU is implemented but not the real acceptance path on this machine.

Users open the hosted app. Contributors use Node.js 24+:

```sh
npm ci
npm test
# Installed Chrome; PowerShell:
# $env:READVIDEO_BROWSER_CHANNEL='chrome'
npm run test:browser
npm run dev
npm run build
```

The development server serves static files only. CI tests gate static Pages deployment. `npm run test:asr:live` explicitly downloads a model and public speech; ordinary CI excludes it. Real API tests require an authorized key and may incur costs.

[Specification](SPEC.md) · [Contributing](CONTRIBUTING.md) · [MIT](LICENSE)

Uses [Transformers.js](https://github.com/huggingface/transformers.js) and [Whisper tiny ONNX](https://huggingface.co/onnx-community/whisper-tiny), each under its own license.
