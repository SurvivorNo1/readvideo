import test from "node:test";
import assert from "node:assert/strict";
import { bilibiliVideo, discoverBilibili } from "../web/bilibili.mjs";
import { embeddedPlayer } from "../web/source.mjs";
test("Bilibili URLs preserve part selection and reject lookalikes", () => {
  assert.deepEqual(
    bilibiliVideo("https://www.bilibili.com/video/av728835116/?p=2"),
    { aid: "728835116", part: 2 },
  );
  assert.deepEqual(bilibiliVideo("https://m.bilibili.com/video/BV1VS4y1t7st"), {
    bvid: "BV1VS4y1t7st",
    part: 1,
  });
  assert.equal(
    bilibiliVideo("https://bilibili.com.evil.test/video/av1/"),
    null,
  );
  assert.equal(
    bilibiliVideo("https://user:pass@www.bilibili.com/video/av1/"),
    null,
  );
  assert.equal(bilibiliVideo("https://www.bilibili.com/video/av1/?p=0"), null);
  assert.match(
    embeddedPlayer("https://www.bilibili.com/video/av728835116/?p=2").url,
    /page=2/,
  );
});
test("public metadata captions are preferred; wrong part and unsafe subtitle URLs never pass", async () => {
  const url = "https://www.bilibili.com/video/av728835116/";
  const info = {
    code: 0,
    data: {
      title: "Public title",
      cid: 9,
      pages: [
        { cid: 9, part: "First" },
        { cid: 10, part: "Second" },
      ],
      subtitle: {
        list: [
          {
            lan: "en",
            subtitle_url: "https://aisubtitle.hdslb.com/public.json",
          },
        ],
      },
    },
  };
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({
        body: [{ from: 0, to: 1, content: "Full public caption" }],
      }),
    );
  };
  const caption = await discoverBilibili(url, "en", async () => info, fetcher);
  assert.equal(caption.kind, "captions");
  assert.equal(caption.segments[0].text, "Full public caption");
  const second = await discoverBilibili(
    url + "?p=2",
    "en",
    async () => info,
    fetcher,
  );
  assert.equal(second.kind, "capture");
  assert.match(second.title, /Second/);
  assert.equal(fetchCount, 1);
  const unsafe = structuredClone(info);
  unsafe.data.subtitle.list[0].subtitle_url = "https://evil.test/secret";
  assert.equal(
    (await discoverBilibili(url, "en", async () => unsafe, fetcher)).kind,
    "capture",
  );
  assert.equal(fetchCount, 1);
  assert.equal(
    (await discoverBilibili(url + "?p=3", "en", async () => info, fetcher))
      .reason,
    "part-unavailable",
  );
});
