# Contributing

Read SPEC.md first. Production is browser-only. Do not introduce an application server, proxy, credential storage or hidden cloud ASR. Preserve the restrained single-page interface.

Use Node.js 24+, `npm ci`, `npm test`, and `npm run test:browser` with installed Chrome (`READVIDEO_BROWSER_CHANNEL=chrome`). `npm run dev` serves static authoring files; `npm run build` packages the reviewed public allowlist. End users open the hosted app.

Write regression tests for data loss, capture lifecycle, routing, queueing and credential boundaries. Unit/adaptor tests cannot be reported as real model or browser-consent evidence. Run optional real ASR/API tests only with authorization. Never commit keys, full captured recordings, `.qa/` or browser profiles. Keep model code pinned and downloads on demand.

Report browser/device, CPU or WebGPU mode, expected/observed behavior and reproduction steps, with credentials and private source material removed.
