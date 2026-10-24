import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorker,
  videoIdentity,
  mediaTarget,
  parseRange,
  signTicket,
  verifyTicket,
  pageJSON,
} from "../worker/index.mjs";
const origin = "https://survivorno1.github.io";
const env = {
  ALLOWED_ORIGINS: origin,
  MEDIA_SECRET: "test-only-secret-that-is-long-enough-for-hmac",
  BILI_LIMIT: { limit: async () => ({ success: true }) },
};
const post = (body) =>
  new Request("https://edge.example/resolve", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("public page JSON is parsed as data, including nested braces and escaped strings", () => {
  assert.deepEqual(
    pageJSON(
      '<script>window.__INITIAL_STATE__ = {"videoData":{"title":"a } b \\\" c","pages":[{"cid":9}]}};</script>',
      "__INITIAL_STATE__",
    ).videoData.pages,
    [{ cid: 9 }],
  );
  assert.equal(
    pageJSON(
      "<script>window.__INITIAL_STATE__ = alert(1)</script>",
      "__INITIAL_STATE__",
    ),
    null,
  );
});
test("browser public metadata can skip Worker metadata requests while identity and duration remain bounded", async () => {
  const fixture = fixtures();
  const worker = createWorker({ fetcher: fixture.fetcher });
  const hint = {
    aid: 728835116,
    bvid: "BV1VS4y1t7st",
    cid: 9,
    part: 1,
    duration: 118,
    title: "Browser public metadata",
  };
  const response = await worker.fetch(
    post({
      url: "https://www.bilibili.com/video/av728835116/",
      public_info: hint,
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(
    fixture.calls.some((c) => c.url.pathname === "/x/web-interface/view"),
    false,
  );
  for (const invalid of [
    { ...hint, aid: 1 },
    { ...hint, cid: -1 },
    { ...hint, duration: 3601 },
    { ...hint, part: 2 },
  ]) {
    assert.equal(
      (
        await worker.fetch(
          post({
            url: "https://www.bilibili.com/video/av728835116/",
            public_info: invalid,
          }),
          env,
        )
      ).status,
      400,
    );
  }
});
test("a public video page supplies metadata and audio when the metadata API rejects requests", async () => {
  const fixture = fixtures();
  const worker = createWorker({
    fetcher: async (value, options) => {
      const u = new URL(value);
      if (u.pathname === "/x/web-interface/view")
        return new Response(null, { status: 412 });
      if (u.hostname === "www.bilibili.com")
        return new Response(
          '<script>window.__INITIAL_STATE__={"videoData":{"title":"Public page source","bvid":"BV1VS4y1t7st","cid":9,"pages":[{"cid":9,"duration":118}]}};</script><script>window.__playinfo__={"code":0,"data":{"dash":{"audio":[{"baseUrl":"https://cdn.bilivideo.com/audio.m4s","bandwidth":64000}]}}};</script>',
        );
      return fixture.fetcher(value, options);
    },
    now: () => 1000,
  });
  const response = await worker.fetch(
    post({ url: "https://www.bilibili.com/video/av728835116/" }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "Public page source");
  assert.equal(
    fixture.calls.some((c) => c.url.pathname.endsWith("playurl")),
    false,
  );
});
test("anonymous platform initialization can recover a rejected metadata request without accepting user cookies", async () => {
  const fixture = fixtures();
  const worker = createWorker({
    fetcher: async (value, options) => {
      const u = new URL(value);
      if (u.pathname === "/x/frontend/finger/spi")
        return Response.json({ code: 0, data: { b_3: "public-anonymous-id" } });
      if (
        u.pathname === "/x/web-interface/view" &&
        !options.headers.has("Cookie")
      )
        return new Response(null, { status: 412 });
      if (u.hostname === "api.bilibili.com")
        assert.equal(
          options.headers.get("Cookie"),
          "buvid3=public-anonymous-id",
        );
      return fixture.fetcher(value, options);
    },
  });
  assert.equal(
    (
      await worker.fetch(
        post({ url: "https://www.bilibili.com/video/av1/" }),
        env,
      )
    ).status,
    200,
  );
});
test("signed metadata detail recovers legacy API denial and signed audio is used", async () => {
  const fixture = fixtures();
  let signedCalls = 0;
  const worker = createWorker({
    fetcher: async (value, options) => {
      const u = new URL(value);
      if (
        u.pathname === "/x/web-interface/view" ||
        u.pathname === "/x/player/playurl"
      )
        return new Response(null, { status: 412 });
      if (u.pathname === "/x/frontend/finger/spi")
        return Response.json({ code: 0, data: { b_3: "anonymous" } });
      if (u.pathname === "/x/web-interface/nav")
        return Response.json({
          code: -101,
          data: {
            wbi_img: {
              img_url:
                "https://i0.hdslb.com/bfs/wbi/" + "a".repeat(32) + ".png",
              sub_url:
                "https://i0.hdslb.com/bfs/wbi/" + "b".repeat(32) + ".png",
            },
          },
        });
      if (u.pathname === "/x/web-interface/wbi/view/detail") {
        assert.match(u.searchParams.get("w_rid"), /^[a-f0-9]{32}$/);
        signedCalls++;
        return Response.json({
          code: 0,
          data: {
            View: {
              bvid: "BV1VS4y1t7st",
              cid: 9,
              title: "Signed source",
              pages: [{ cid: 9, duration: 118 }],
            },
          },
        });
      }
      return fixture.fetcher(value, options);
    },
  });
  const response = await worker.fetch(
    post({ url: "https://www.bilibili.com/video/av728835116/" }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(signedCalls, 1);
  assert.equal((await response.json()).title, "Signed source");
});
test("Worker restricts video IDs, media destinations and byte ranges", () => {
  assert.deepEqual(
    videoIdentity("https://www.bilibili.com/video/av728835116/?p=2"),
    { aid: "728835116", part: 2 },
  );
  assert.throws(() =>
    videoIdentity("https://bilibili.com.evil.test/video/av1/"),
  );
  assert.throws(() => videoIdentity("https://www.bilibili.com/video/av1/?p=0"));
  for (const url of [
    "http://cdn.bilivideo.com/a",
    "https://user:pass@cdn.bilivideo.com/a",
    "https://cdn.bilivideo.com:444/a",
    "https://localhost/a",
    "https://bilivideo.com.evil.test/a",
  ])
    assert.throws(() => mediaTarget(url));
  assert.equal(
    mediaTarget("https://cdn.bilivideo.com/a").hostname,
    "cdn.bilivideo.com",
  );
  assert.deepEqual(parseRange("bytes=0-1023"), { start: 0, end: 1023 });
  assert.throws(() => parseRange("bytes=0-1,5-6"));
  assert.throws(() => parseRange("bytes=10-2"));
});
test("public metadata JSONP is parsed without executing response scripts", async () => {
  const fixture = fixtures();
  const worker = createWorker({
    fetcher: async (value, options) => {
      const u = new URL(value);
      if (u.pathname === "/x/web-interface/view") {
        assert.equal(u.searchParams.get("callback"), "__readvideoPublic");
        return new Response(
          "__readvideoPublic(" +
            JSON.stringify({
              code: 0,
              data: {
                bvid: "BV1VS4y1t7st",
                cid: 9,
                title: "JSONP source",
                pages: [{ cid: 9, duration: 118 }],
              },
            }) +
            ");",
        );
      }
      return fixture.fetcher(value, options);
    },
  });
  const response = await worker.fetch(
    post({ url: "https://www.bilibili.com/video/av1/" }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "JSONP source");
});
test("tickets are authenticated, expire, and cannot authorize a different destination", async () => {
  const token = await signTicket(
    { url: "https://cdn.bilivideo.com/a", exp: 1100 },
    env.MEDIA_SECRET,
  );
  assert.equal((await verifyTicket(token, env.MEDIA_SECRET, 1000)).exp, 1100);
  await assert.rejects(verifyTicket(token, env.MEDIA_SECRET, 1200));
  await assert.rejects(verifyTicket(token + "x", env.MEDIA_SECRET, 1000));
  await assert.rejects(verifyTicket(token, "wrong-secret", 1000));
});
function fixtures({ subtitle = false, redirect = false } = {}) {
  const calls = [];
  return {
    calls,
    fetcher: async (value, options = {}) => {
      const url = new URL(value);
      calls.push({ url, options });
      if (url.pathname === "/x/web-interface/view")
        return Response.json({
          code: 0,
          data: {
            title: "Actual source fixture",
            bvid: "BV1VS4y1t7st",
            cid: 9,
            duration: 118,
            pages: [{ cid: 9, part: "First" }],
            subtitle: { list: [] },
          },
        });
      if (url.pathname === "/x/player/v2")
        return Response.json({
          code: 0,
          data: {
            subtitle: {
              subtitles: subtitle
                ? [
                    {
                      lan: "en",
                      subtitle_url: "https://aisubtitle.hdslb.com/public.json",
                    },
                  ]
                : [],
            },
          },
        });
      if (url.pathname.endsWith("/playurl"))
        return Response.json({
          code: 0,
          data: {
            dash: {
              audio: [
                {
                  mimeType: "audio/mp4",
                  codecs: "mp4a.40.2",
                  bandwidth: 64000,
                  baseUrl: "https://cdn.bilivideo.com/audio.m4s",
                },
              ],
            },
          },
        });
      if (url.hostname === "aisubtitle.hdslb.com")
        return Response.json({
          body: [{ from: 0, to: 1, content: "Public caption first." }],
        });
      if (url.hostname === "cdn.bilivideo.com") {
        if (redirect)
          return new Response(null, {
            status: 302,
            headers: { Location: "https://127.0.0.1/private" },
          });
        assert.equal(
          options.headers.get("Referer"),
          "https://www.bilibili.com/",
        );
        return new Response(new Uint8Array(1024).fill(7), {
          status: 206,
          headers: {
            "Content-Type": "audio/mp4",
            "Content-Length": "1024",
            "Content-Range": "bytes 0-1023/100000",
          },
        });
      }
      throw Error("Unexpected upstream");
    },
  };
}
test("upstream rejection identifies the failing API without exposing its body", async () => {
  const worker = createWorker({
    fetcher: async () =>
      new Response("private upstream detail", { status: 412 }),
  });
  const response = await worker.fetch(
    post({ url: "https://www.bilibili.com/video/av1/" }),
    env,
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error, /view.*412/);
  assert.doesNotMatch(body.error, /private upstream/);
});
test("one resolve call returns audio ticket; media streams with range and never forwards provider keys or cookies", async () => {
  const f = fixtures(),
    worker = createWorker({ fetcher: f.fetcher, now: () => 1000 });
  const resolved = await worker.fetch(
    post({
      url: "https://www.bilibili.com/video/av728835116/",
      language: "auto",
    }),
    env,
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.headers.get("Access-Control-Allow-Origin"), origin);
  const source = await resolved.json();
  assert.equal(source.kind, "media");
  assert.equal(source.title, "Actual source fixture");
  const media = await worker.fetch(
    new Request(source.url, {
      headers: { Origin: origin, Range: "bytes=0-1023" },
    }),
    env,
  );
  assert.equal(media.status, 206);
  assert.equal((await media.arrayBuffer()).byteLength, 1024);
  for (const { options } of f.calls) {
    const headers = new Headers(options.headers);
    assert.equal(headers.has("Authorization"), false);
    assert.equal(headers.has("Cookie"), false);
  }
});
test("a partial upstream response cannot masquerade as a complete audio download", async () => {
  const worker = createWorker({ fetcher: fixtures().fetcher, now: () => 1000 });
  const token = await signTicket(
    { url: "https://cdn.bilivideo.com/audio.m4s", exp: 2000 },
    env.MEDIA_SECRET,
  );
  const response = await worker.fetch(
    new Request("https://edge.example/media?ticket=" + token, {
      headers: { Origin: origin },
    }),
    env,
  );
  assert.equal(response.status, 502);
});
test("captions take priority, and expired tickets, unexpected origins, rate limits and unsafe redirects fail closed", async () => {
  const captions = fixtures({ subtitle: true }),
    c = createWorker({ fetcher: captions.fetcher, now: () => 1000 });
  const resolved = await c.fetch(
    post({ url: "https://www.bilibili.com/video/av728835116/" }),
    env,
  );
  assert.equal(
    (await resolved.json()).segments[0].text,
    "Public caption first.",
  );
  assert.equal(
    captions.calls.some((x) => x.url.pathname.endsWith("playurl")),
    false,
  );
  const denied = await c.fetch(
    new Request("https://edge.example/resolve", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    }),
    env,
  );
  assert.equal(denied.status, 403);
  const limited = await c.fetch(
    post({ url: "https://www.bilibili.com/video/av1/" }),
    { ...env, BILI_LIMIT: { limit: async () => ({ success: false }) } },
  );
  assert.equal(limited.status, 429);
  const f = fixtures({ redirect: true }),
    w = createWorker({ fetcher: f.fetcher, now: () => 1000 });
  assert.equal(
    (await w.fetch(post({ url: "https://www.bilibili.com/video/av1/" }), env))
      .status,
    422,
  );
  const token = await signTicket(
    { url: "https://cdn.bilivideo.com/audio.m4s", exp: 2000 },
    env.MEDIA_SECRET,
  );
  assert.equal(
    (
      await w.fetch(
        new Request("https://edge.example/media?ticket=" + token, {
          headers: { Origin: origin },
        }),
        env,
      )
    ).status,
    502,
  );
  assert.equal(
    f.calls.some((x) => x.url.hostname === "127.0.0.1"),
    false,
  );
});
