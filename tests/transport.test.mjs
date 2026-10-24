import test from "node:test";
import assert from "node:assert/strict";
import { resolveThroughEdge, edgeEndpoint } from "../web/edge.mjs";
test("edge client requires HTTPS, sends only video identity/language and validates the returned transport", async () => {
  assert.equal(
    edgeEndpoint("https://example.workers.dev/"),
    "https://example.workers.dev",
  );
  assert.throws(() => edgeEndpoint("http://evil.example"));
  assert.throws(() => edgeEndpoint("https://user:secret@example.workers.dev"));
  let body;
  const source = await resolveThroughEdge(
    "https://www.bilibili.com/video/av1/",
    "zh",
    "https://example.workers.dev",
    async (_url, options) => {
      body = JSON.parse(options.body);
      assert.equal(options.credentials, "omit");
      return Response.json({
        kind: "media",
        url: "https://example.workers.dev/media?ticket=fixture",
        title: "Video",
      });
    },
  );
  assert.deepEqual(body, {
    url: "https://www.bilibili.com/video/av1/",
    language: "zh",
  });
  assert.equal(source.kind, "media");
  assert.equal(source.transport, "cloudflare");
  await assert.rejects(
    resolveThroughEdge(
      "https://www.bilibili.com/video/av1/",
      "auto",
      "https://example.workers.dev",
      async () =>
        Response.json({
          kind: "media",
          url: "https://unrelated.example/audio",
        }),
    ),
    /响应/,
  );
});
test("edge errors are clear and captions are normalized without accepting an unrelated source URL", async () => {
  await assert.rejects(
    resolveThroughEdge(
      "https://www.bilibili.com/video/av1/",
      "auto",
      "https://example.workers.dev",
      async () =>
        Response.json({ error: "unsafe provider body" }, { status: 502 }),
    ),
    /视频解析/,
  );
  const source = await resolveThroughEdge(
    "https://www.bilibili.com/video/av1/",
    "auto",
    "https://example.workers.dev",
    async () =>
      Response.json({
        kind: "captions",
        url: "https://unrelated.example/",
        title: "Title",
        segments: [{ start: 0, end: 2, text: "Public captions." }],
      }),
  );
  assert.equal(source.url, "https://www.bilibili.com/video/av1/");
  assert.equal(source.segments[0].text, "Public captions.");
});
