# readvideo

**Turn videos into articles.** [中文](README.md) · [Website](https://survivorno1.github.io/readvideo/en.html)

Extract complete captions with [yt-dlp](https://github.com/yt-dlp/yt-dlp), then generate a quick summary or a short, medium, long or detailed article with your own API. One restrained page. MIT licensed. No Ollama.

![Real application](docs/images/home.png)

## Run locally

Requires Python 3.10+. Windows: download the repository, extract it, double-click `run.bat`. Manual setup:

```sh
git clone https://github.com/SurvivorNo1/readvideo.git
cd readvideo
python3 -m venv .venv
# macOS / Linux:
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python app.py --open-browser
# Windows:
# .venv\Scripts\python -m pip install -r requirements.txt
# .venv\Scripts\python app.py --open-browser
```

Open [localhost:4174](http://127.0.0.1:4174). The backend listens only on loopback. Keep it running while using the app. GitHub Pages hosts a bilingual product website, not an extraction backend.

1. Open **API 配置** (API settings). Choose DeepSeek, Gemini or a custom Chat Completions endpoint. Enter your key and test the connection.
2. Paste a video link. Choose quick summary or article, then an article length. Click **提取并生成** (extract and generate).
3. Read, revisit timestamps, copy or export Markdown. **原字幕** shows the full selected track. Search only filters its display: exports include every cue.

The app interface is currently Chinese. Generated content supports Chinese and English through the advanced output-language setting.

## Reading depths and correction

English article targets: short 200–350 words, medium 600–1,000, long 1,200–2,000, detailed 2,000–3,500. Chinese targets: 300–500, 800–1,500, 1,800–3,000, 3,000–5,000 characters. These are instructions, not enforced minimums: sparse source material stays shorter.

Prompts focus on the actual topic and evidence. They instruct the model to correct clear transcription and punctuation errors, preserve numbers, units, negation and attribution, flag uncertain names/terms, and include relevant correction notes. Original captions remain unchanged. There is no external fact checking; model correction is fallible.

Long transcripts are chunked and synthesized. Limits raise explicit errors rather than silently truncating the source. “Complete captions” means every normalized cue of the selected available track, not speech-to-text for videos with no captions or all language tracks.

## APIs and privacy

Keys remain in browser/backend runtime memory. They are not saved in browser persistent storage or exports. Generation sends captions to your chosen API provider. Caption-only extraction needs no LLM key. Gemini or a compatible provider may offer a free tier, subject to its own eligibility and limits; DeepSeek is not assumed free. Custom endpoints must use HTTPS. There are no shared credentials.

Platform restrictions, login requirements and missing captions can prevent extraction. Import VTT, SRT, YouTube JSON3 or Bilibili JSON as a fallback. This version downloads no video/audio and performs no speech recognition.

## Development

```sh
python -m unittest discover -s tests -v
npm ci
# With installed Chrome:
# Windows PowerShell: $env:READVIDEO_BROWSER_CHANNEL='chrome'
# macOS / Linux: export READVIDEO_BROWSER_CHANNEL=chrome
npm run test:browser
python tools/build_site.py .qa/pages
```

See [SPEC.md](SPEC.md), [verification](docs/verification.md) and [contributing](CONTRIBUTING.md). Deterministic tests use explicit adapters; live API tests are opt-in and may incur costs. Free-tier Gemini has not been live-tested in this development session.

MIT license. yt-dlp remains an external dependency under its own license.
