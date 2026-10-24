# Browser-only verification, v0.3

Platform-specific observations and a timed CPU benchmark are recorded separately in [platform-evaluation.md](platform-evaluation.md). That report explicitly distinguishes verified caption routing from the still-unverified platform audio-capture workflow.

## Contract and tests

SPEC.md records the browser-only workflow before implementation. The first JavaScript test run failed because web/core.mjs did not exist (.qa/tdd-web-red.txt, ignored local evidence). Core implementation then passed. A floating-point duration assertion was corrected to numeric tolerance rather than claiming a product defect.

Unit tests cover resampling, full window coverage and stop tail, overlap/timestamp merging, parsing, four article depths/correction, all-chunk synthesis, HTTPS configuration/error redaction, ordered queue failure/drain/retry, retaining recoverable audio rather than transferring it away, WAV recovery, caption-first routing/CORS fallback, source validation and static-package boundaries.

The 12 deterministic browser scenarios cover static initialization without /api/, captions skipping ASR, four depths, safe model rendering, full export despite filtering, key non-persistence, explicit consent routing, denied/no-audio capture, stopping tracks, actual AudioWorklet processing of a synthetic stream with an explicitly mocked model Worker, subtitle import and mobile overflow. These do not claim a real permission-picker interaction or real model inference.

The inline-player change adds recognized-domain embed validation and same-tab audio-constraint tests before implementation, plus a browser regression for showing YouTube inline without opening a popup, requesting current-tab audio and retaining an explicit original-site fallback. Current totals are 20 unit tests and 17 browser scenarios. Real embed playback observations are separate in platform-evaluation.md; actual platform-audio authorization remains unverified.

The Bilibili public-info route adds URL/part parsing, subtitle-host restrictions, and an opaque sandbox iframe isolated from app credentials and storage. Browser regression uses an explicit callback adapter inside the real sandbox frame to test parent-DOM denial, message validation, timeout cleanup and subtitle display without capture. Opaque-frame network interception differed in this Chrome build, so this regression is not presented as an actual endpoint test. Separately, the actual JSONP callback from api.bilibili.com returned code 0, cid 785724558 and no exposed subtitles in the user's Chrome on the public readvideo origin; the sandbox was removed after completion. Full audio retrieval was not verified: all six observed CDN candidates returned HTTP 403 from readvideo.

Compatibility regressions were added before their fixes: readable HTML previously fell through to capture despite an explicit audio source, and completed ASR transcripts were not reused when generating another article length. The tests observed both failures before implementation. Additional deterministic coverage checks subtitle priority, relative media URLs after redirects, audio-first selection, denied media access, decoding a complete fixture WAV without playback and preserving the original page link. The model in these regressions is an explicit adapter, not a new real-platform speed result.

## Real browser CPU inference

The opt-in tests/asr-live.mjs ran in real desktop Chrome with CPU forced, using actual Transformers.js 3.8.1 and the onnx-community/whisper-tiny quantized model. No adapters and no application backend were used. It downloaded the public JFK sample from the Transformers.js documentation dataset and recognized a sentence containing “country.” The observed result contained one timestamped cue and 111 displayed characters. Screenshot: docs/images/browser-asr.png. Raw evidence remains in ignored .qa/asr-live-result.json.

This verifies browser WASM inference without a GPU and readable direct audio. It does not prove tab-audio permission availability on every browser or access to all platform captions. WebGPU acceleration/fallback is implemented but is not the real acceptance path on this machine.

## Real browser-direct LLM call

The opt-in tests/llm-web-live.mjs received an authorized DeepSeek key through a hidden-input launcher and memory-only stdin pipe. It entered the key into a password field, closed settings, imported a previously extracted 64-cue public TED transcript and called DeepSeek directly from Chrome using CORS. No application backend/proxy was involved. The actual result was a 1,472-character Chinese article; browser storage contained no key. Screenshot: docs/images/article.png.

This verifies the real browser-direct API and current article prompt, separately from the real ASR sample. It is not represented as one real tab-capture-to-article end-to-end run. Gemini/custom presets have no credential-based live evidence in this session.

## Data and deployment

Model code/weights are network downloads. Audio processing runs on the device. Only requested article generation sends text to the selected provider. No credential is bundled in code, screenshots, exports or Git. Packaging uses an explicit static-file allowlist, excluding Python runtime, recordings, fixture servers and .qa/.

Previous Python evidence is historical in Git and is not claimed as validation of the browser-only application.
