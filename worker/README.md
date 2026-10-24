# Optional Cloudflare transport

This service is for public Bilibili videos. It resolves exposed captions first,
otherwise streams an independent AAC/M4A audio track to readvideo. Whisper runs
on the visitor's device; article generation goes directly to their configured
model provider. No personal application server is involved.

## Deployment

From the repository root, run `npm ci`, then authenticate with `wrangler login`.
Configure `ALLOWED_ORIGINS` in `worker/wrangler.jsonc` with your frontend origin.
Set a random secret of at least 32 characters using
`wrangler secret put MEDIA_SECRET --config worker/wrangler.jsonc`, then run
`npm run worker:deploy`. Never commit the secret, credentials or signed media URLs.

Enter the deployed HTTPS root URL under the app's advanced settings. A verified
public deployment can instead be set in `web/deployment.mjs` before building the
static site. The repository default remains empty until live acceptance passes.
GitHub Pages does not execute this Worker source.

## Limits and privacy

- One hour per video part; 32 MB maximum audio transfer. Audio is streamed, not
  stored or transcoded. Range requests are supported when the source honors them.
- Tickets expire after 15 minutes. Supported API hosts, media hosts and redirects
  are restricted. This is not an arbitrary URL proxy.
- The configured Cloudflare limiter allows 60 requests per minute per IP and
  location. The origin allowlist is an additional browser control, not user
  authentication. Public deployments still require quota monitoring.
- Free Workers have request and CPU limits. Streaming avoids full-file memory
  buffering; it does not guarantee unlimited users or platform availability.
  See [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/).
- The Worker receives the submitted video link, recognition language and network
  request metadata, and carries audio traffic. It receives no Bilibili cookies or
  LLM API key. Bilibili login in another tab does not authenticate Worker requests.
- Public videos can still be refused based on platform policy, region or network.
  Restricted/paid content and account login are not implemented.

## Verification

`npm test` covers transport contracts with explicit fixtures. The manual GitHub
Actions workflow **Worker live network check** tests a real deployment, including
complete audio, SHA-256 and a matching byte range, without API keys or cookies.
It saves only sanitized metadata. It does not prove browser ASR or article
generation. On 2026-10-24 the deployed service returned health 200 but resolve 502
for the sample: the platform rejected a Worker request. Link-only production
acceptance remains incomplete; no speed result is claimed for this route.
