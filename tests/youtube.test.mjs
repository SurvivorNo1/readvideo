import test from "node:test";
import assert from "node:assert/strict";
import { parseYouTubeId } from "../server/resolve-core.mjs";

test("recognizes every common YouTube URL shape", () => {
  const cases = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=10", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ];
  for (const [input, expected] of cases)
    assert.equal(parseYouTubeId(input), expected, input);
});

test("does not mistake other platforms or malformed ids for YouTube", () => {
  const cases = [
    "https://www.bilibili.com/video/BV1Sj2aB9EXf/",
    "dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=tooshort",
    "https://youtu.be/",
    "https://www.youtube.com/@somechannel",
    "",
  ];
  for (const input of cases) assert.equal(parseYouTubeId(input), null, input);
});
