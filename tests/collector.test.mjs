import test from "node:test";
import assert from "node:assert/strict";
import { collectBilibiliAudio, collectorScript } from "../web/collector.mjs";

async function runFixture({ ranges = true, fail = false } = {}) {
  const original = {
    location: globalThis.location,
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  let active = 0,
    peak = 0,
    full = 0;
  const source = Uint8Array.from({ length: 1500000 }, (_, i) => i % 251);
  globalThis.location = new URL("https://www.bilibili.com/video/BV1VS4y1t7st/");
  globalThis.window = {
    __playinfo__: {
      data: {
        dash: {
          audio: [
            {
              bandwidth: 64000,
              baseUrl: "https://cdn.bilivideo.com/9/audio.m4s",
            },
          ],
        },
      },
    },
  };
  globalThis.document = { querySelector: () => null };
  globalThis.fetch = async (_url, options = {}) => {
    if (fail) return new Response("denied", { status: 403 });
    if (!options.headers?.Range) {
      full++;
      return new Response(source, {
        headers: { "content-length": String(source.length) },
      });
    }
    const [, lo, hi] = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 4));
    active--;
    const body = ranges ? source.slice(Number(lo), Number(hi) + 1) : source;
    return new Response(body, { status: ranges ? 206 : 200 });
  };
  try {
    return {
      result: await collectBilibiliAudio({ save: false }),
      source,
      peak,
      full,
    };
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}
test("manual collector is self-contained, never exports credentials, and assembles parallel audio", async () => {
  const { result, source, peak } = await runFixture();
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), source);
  assert.ok(peak > 1 && peak <= 4);
  assert.equal(result.parallel, true);
  assert.equal(result.filename, "readvideo-BV1VS4y1t7st-p1.m4a");
  assert.doesNotThrow(() => new Function(collectorScript()));
  assert.equal(
    /document\.cookie|localStorage|sessionStorage/.test(collectorScript()),
    false,
  );
});
test("range refusal falls back to one complete stream; HTTP errors never become audio", async () => {
  const { result, source, full } = await runFixture({ ranges: false });
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), source);
  assert.equal(result.parallel, false);
  assert.equal(full, 2);
  await assert.rejects(runFixture({ fail: true }), /403/);
});
