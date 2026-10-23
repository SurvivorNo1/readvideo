# readvideo — v0.1 behavior contract

Status: implementation begins after the first failing test run.

## Product

A single, elegant reading page. Paste a video link, extract existing captions using yt-dlp, and turn those captions into either a concise summary or a readable article using a user-configured API. No Ollama, account system, video download, or invented transcription.

Visual direction requested by the user: Apple-inspired restraint, white and light-gray surfaces, a blue accent, generous spacing, clear system typography. Keep the main operation to paste → generate. Show provider/key first and disclose advanced settings only when needed.

The initial app runs on the user's computer with a loopback-only Python backend. Static hosting alone cannot execute yt-dlp. Supported sites are the ones yt-dlp can currently extract; captions, authentication and network restrictions still vary by video.

## Acceptance contracts

- **A1 — Extract:** an HTTP(S) video link yields metadata and timestamped caption segments. Prefer the requested language and authored subtitles; automatic captions are a fallback. Download no video or audio. Reject playlist-only results, empty captions, private-network URLs and unsupported subtitle formats with actionable messages.
- **A2 — Read:** normalize VTT, SRT, YouTube JSON3 and Bilibili subtitle JSON; remove rolling-caption duplication while retaining time references. Display the transcript even when no LLM key is configured. Support importing a subtitle file as a fallback.
- **A3 — Generate:** summary and article are separate user choices. Ground output in supplied captions, keep source timestamps, and do not pretend to have watched images or audio. Split long transcripts into bounded chunks and synthesize all chunks; never silently truncate input. Surface API errors and empty responses.
- **A4 — Configure:** DeepSeek, Gemini and a custom OpenAI-compatible HTTPS endpoint. Editable model and API key. A cloud free tier is optional and provider-dependent; no claim that DeepSeek or all API use is free. A connection check sends a small real request.
- **A5 — Protect keys:** keys exist only in current browser/backend memory, never in localStorage, source, files, exception output, screenshots, history exports or Git. An injected debug key can only be sent to the official DeepSeek endpoint. Never forward it to a custom base URL. Do not follow API redirects with credentials.
- **A6 — Export:** copy or download Markdown containing the article, source link and metadata, never credentials. Timestamp links let the reader revisit the original source.
- **A7 — UI:** one page, one primary link input, a compact summary/article selector, a readable output area, a transcript tab and a configuration drawer. Show actual extraction/generation stages. Include clear empty, loading and failure states. Responsive at 390 px; keyboard focus visible; respect reduced motion.
- **A8 — Honest validation:** deterministic tests cover parsing, deduplication, chunking, configuration boundaries, error redaction, HTTP endpoints and unsafe UI text. Real video and DeepSeek smoke tests are separate, explicitly reported and never disguised as mocked success.

## Boundaries

No speech recognition for videos without captions, cookies imported from browsers, paywall bypass, automatic publication, multi-user hosting, or persistent API-key storage in v0.1. Imported and extracted captions are sent to the selected API provider only when the user requests generation.

## TDD sequence

1. Write this contract and backend acceptance tests.
2. Run them before implementation and preserve the expected failure result under ignored `.qa/`.
3. Implement the minimum behavior to pass, then refactor with tests green.
4. Add browser acceptance tests before wiring the UI; capture their initial failure.
5. Verify real extraction and the authorized DeepSeek connection, then capture real screenshots and prepare a reviewable repository.
