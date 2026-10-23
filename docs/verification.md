# Browser-only verification, v0.3

## Contract and tests

SPEC.md records the browser-only workflow before implementation. The first JavaScript test run failed because web/core.mjs did not exist (.qa/tdd-web-red.txt, ignored local evidence). Core implementation then passed. A floating-point duration assertion was corrected to numeric tolerance rather than claiming a product defect.

Unit tests cover resampling, full window coverage and stop tail, overlap/timestamp merging, parsing, four article depths/correction, all-chunk synthesis, HTTPS configuration/error redaction, ordered queue failure/drain/retry, retaining recoverable audio rather than transferring it away, WAV recovery, caption-first routing/CORS fallback, source validation and static-package boundaries.

The 12 deterministic browser scenarios cover static initialization without /api/, captions skipping ASR, four depths, safe model rendering, full export despite filtering, key non-persistence, explicit consent routing, denied/no-audio capture, stopping tracks, actual AudioWorklet processing of a synthetic stream with an explicitly mocked model Worker, subtitle import and mobile overflow. These do not claim a real permission-picker interaction or real model inference.

## Real browser CPU inference

The opt-in tests/asr-live.mjs ran in real desktop Chrome with CPU forced, using actual Transformers.js 3.8.1 and the onnx-community/whisper-tiny quantized model. No adapters and no application backend were used. It downloaded the public JFK sample from the Transformers.js documentation dataset and recognized a sentence containing “country.” The observed result contained one timestamped cue and 111 displayed characters. Screenshot: docs/images/browser-asr.png. Raw evidence remains in ignored .qa/asr-live-result.json.

This verifies browser WASM inference without a GPU and readable direct audio. It does not prove tab-audio permission availability on every browser or access to all platform captions. WebGPU acceleration/fallback is implemented but is not the real acceptance path on this machine.

## Real browser-direct LLM call

The opt-in tests/llm-web-live.mjs received an authorized DeepSeek key through a hidden-input launcher and memory-only stdin pipe. It entered the key into a password field, closed settings, imported a previously extracted 64-cue public TED transcript and called DeepSeek directly from Chrome using CORS. No application backend/proxy was involved. The actual result was a 1,472-character Chinese article; browser storage contained no key. Screenshot: docs/images/article.png.

This verifies the real browser-direct API and current article prompt, separately from the real ASR sample. It is not represented as one real tab-capture-to-article end-to-end run. Gemini/custom presets have no credential-based live evidence in this session.

## Data and deployment

Model code/weights are network downloads. Audio processing runs on the device. Only requested article generation sends text to the selected provider. No credential is bundled in code, screenshots, exports or Git. Packaging uses an explicit static-file allowlist, excluding Python runtime, recordings, fixture servers and .qa/.

Previous Python evidence is historical in Git and is not claimed as validation of the browser-only application.
