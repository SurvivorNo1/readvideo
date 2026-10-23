# Contributing

Start with the behavior contract in `SPEC.md`. For a bug, first add a failing example under `tests/`, implement the smallest fix, and rerun the relevant tests. Keep the page focused on paste → read; avoid adding account systems, dashboards or unrequested integrations.

Run `python -m unittest discover -s tests -v` for backend changes. For interface changes, use `npm ci`, install Chromium with `npx playwright install chromium`, then run `npm run test:browser`. Installed Chrome can be selected with `READVIDEO_BROWSER_CHANNEL=chrome`.

The browser server is an explicit test fixture. Never describe its generated text as live extraction or model output. Real external checks must be opt-in, use an authorized credential, and state any failure or platform restriction.

Do not commit API keys, cookies, extracted third-party subtitles, local histories, `.venv/` or `.qa/`. Never print request headers or model-provider error bodies. Report subtitle bugs with a tiny original/redistributable fixture, format, timestamps and expected text. yt-dlp integration should use the subtitle downloader, not a general video download.
