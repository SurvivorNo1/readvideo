# Specification and verification

## SDD trace

The behavior contract was written before implementation in `SPEC.md`. A1/A2 map to `tests/test_transcript.py`; A3/A4/A5 map to `tests/test_llm.py` and `tests/test_api.py`; A6/A7 map to `tests/browser.mjs`. A8 separates deterministic fixture tests from live service evidence.

## Observed TDD sequence

1. Backend tests first failed because the implementation package did not exist. The ignored local record is `.qa/tdd-red.txt`.
2. The first implementation passed 26 tests.
3. Browser acceptance tests were written before the real UI. After correcting a test-runner timeout argument, the UI RED result specifically showed that the video-link input did not exist (`.qa/tdd-ui-red.txt`). The completed single-page interface passed all 10 scenarios.
4. DeepSeek-specific and credential validation tests first exposed missing non-thinking mode and control-character handling, then passed after implementation (`.qa/tdd-provider-red.txt`). The suite reached 29 tests.
5. A real TED extraction exposed HLS subtitle playlists. A new failing test led to using yt-dlp's native subtitle downloader. A second real observation showed its successful HLS result can be `(None, True)` with a valid output file; the regression fixture was updated before correcting the success check. The suite reached 30 tests.

These are actual development observations. The local red logs are not uploaded because machine-specific traces are unnecessary public artifacts. The repository's first commit contains the completed implementation, not a fabricated red/green commit history.

## Automated verification

v0.2 adds five backend tests written before implementation: four length profiles and budgets, contextual correction safeguards, multi-chunk synthesis retaining the selected depth, invalid-length rejection, and forwarding through the real local API. Their first run failed on the missing length parameter and missing forwarding, then passed. Two new browser scenarios first failed on the absent length control, then passed: all four length selections are sent to generation; filtering a transcript never removes its final cue from export. A public-site packaging test checks the output allowlist and every local asset/language/anchor link. Current totals: **36 Python tests and 12 deterministic browser scenarios**.

30 backend tests cover subtitle formats, rolling-caption deduplication, language selection, chunk preservation, input URL boundaries, segmented subtitle delegation, timestamp formatting, configuration isolation, DeepSeek mode, errors that do not reflect credentials, browser-session tokens, local API behavior and static-file allowlisting.

10 browser scenarios cover the single-page layout and settings drawer, extraction/generation UI flow, model HTML rendered as text, source-time links, Markdown export, absence of credentials in browser storage, caption-only mode, missing-caption errors, subtitle import and mobile overflow. They use a test server whose adapters are explicitly mocked; they do not claim yt-dlp or an LLM succeeded live.

## Live checks

The development machine separately verified a public TED video, “How to start a movement”, through yt-dlp: 64 English authored-caption cues. It verified an authorized DeepSeek `deepseek-flash` connection, then completed the actual browser flow from pasted URL through extraction to a 1,517-character Chinese article. The full live-browser smoke runner is `tools/live_browser.mjs`; it requires a running local server and an explicitly configured API, and may incur provider usage charges. It is never run automatically in CI.

Live outputs and full extracted captions stay in ignored `.qa/`, not public test fixtures. The screenshots in the README are captured from the running application. Free-tier Gemini and other custom providers are configurable but have not been live-tested using a credential in this development session.

The successful live TED/DeepSeek article above was generated with v0.1. A v0.2 detailed-article live rerun stopped at video extraction due to a network/platform read failure. It is not reported as a successful v0.2 generation. The subsequent network-enabled server restart was blocked by the execution environment's automatic approval quota, not by a test assertion. Length and correction changes are covered by the deterministic tests above; no claim of completed external factual verification is made.

The first v0.2 hosted browser run hit the fixture startup deadline before opening a browser. Startup now reports child-process errors and allows a 30-second cold start on Windows runners; this changes test infrastructure, not application behavior.
