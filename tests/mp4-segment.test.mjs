import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSegmentIndex,
  groupFragments,
  scanMoofOffsets,
} from "../web/mp4-segment.mjs";

/** 按真实结构拼一个 fMP4 头部：ftyp + moov + sidx + moof/mdat* */
function buildFixture({ timescale = 48000, frags = [5, 5, 5, 5], sidxVersion = 0 } = {}) {
  const box = (type, payload) => {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, 8 + payload.byteLength);
    for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
    const out = new Uint8Array(8 + payload.byteLength);
    out.set(head, 0);
    out.set(payload, 8);
    return out;
  };

  const ftyp = box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]));
  const moov = box("moov", new Uint8Array(40));

  // sidx 负载
  const entryBytes = 12 * frags.length;
  const preSize = 4 + 4 + 4 + (sidxVersion === 0 ? 8 : 16) + 4;
  const sidxPayload = new Uint8Array(preSize + entryBytes);
  const sv = new DataView(sidxPayload.buffer);
  sv.setUint8(0, sidxVersion);
  sv.setUint32(4, 1); // reference_ID
  sv.setUint32(8, timescale);
  let p = 12;
  if (sidxVersion === 0) {
    sv.setUint32(p, 0); p += 4; // earliest_presentation_time
    sv.setUint32(p, 0); p += 4; // first_offset
  } else {
    sv.setBigUint64(p, 0n); p += 8;
    sv.setBigUint64(p, 0n); p += 8;
  }
  sv.setUint16(p, 0); p += 2; // reserved
  sv.setUint16(p, frags.length); p += 2;

  // moof+mdat 每个片段固定 100 字节
  const FRAG_SIZE = 100;
  for (let i = 0; i < frags.length; i++) {
    sv.setUint32(p, FRAG_SIZE); // reference_type=0 高位，size=100
    p += 4;
    sv.setUint32(p, Math.round(frags[i] * timescale));
    p += 4;
    sv.setUint32(p, 0);
    p += 4;
  }
  const sidx = box("sidx", sidxPayload);

  const parts = [ftyp, moov, sidx];
  for (let i = 0; i < frags.length; i++) {
    parts.push(box("moof", new Uint8Array(40)));
    parts.push(box("mdat", new Uint8Array(FRAG_SIZE - 8 - 48)));
  }

  const total = parts.reduce((n, x) => n + x.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return { bytes: out, ftypSize: ftyp.byteLength, moovSize: moov.byteLength, sidxSize: sidx.byteLength, fragSize: FRAG_SIZE };
}

test("parses a real-shaped fMP4 index without gaps", () => {
  const fx = buildFixture();
  const idx = parseSegmentIndex(fx.bytes);
  assert.ok(idx, "should parse");
  const expectedInit = fx.ftypSize + fx.moovSize + fx.sidxSize;
  assert.equal(idx.initBytes, expectedInit);
  assert.equal(idx.timescale, 48000);
  assert.equal(idx.fragments.length, 4);
  assert.equal(idx.fragments[0].offset, expectedInit);
  assert.equal(idx.fragments[0].size, fx.fragSize);

  // 片段必须首尾相接、覆盖到文件末尾
  let cursor = expectedInit;
  let secs = 0;
  for (const f of idx.fragments) {
    assert.equal(f.offset, cursor, "fragment offsets must be contiguous");
    cursor += f.size;
    secs += f.seconds;
  }
  assert.equal(cursor, fx.bytes.byteLength);
  assert.ok(Math.abs(secs - 20) < 0.01, `total seconds ${secs} should be 20`);
});

test("supports sidx version 1", () => {
  const fx = buildFixture({ sidxVersion: 1 });
  const idx = parseSegmentIndex(fx.bytes);
  assert.ok(idx);
  assert.equal(idx.fragments.length, 4);
});

test("groups fragments without splitting them", () => {
  const fx = buildFixture({ frags: [5, 5, 5, 5, 5, 5, 5, 5] });
  const idx = parseSegmentIndex(fx.bytes);
  const groups = groupFragments(idx.fragments, 10);

  assert.ok(groups.length >= 3);
  let covered = 0;
  for (const g of groups) {
    assert.ok(g.endByte > g.startByte);
    assert.ok(g.seconds >= 10 || g === groups.at(-1), "only the last group may be short");
    covered += g.endByte - g.startByte;
  }
  assert.equal(covered, idx.fragments.reduce((n, f) => n + f.size, 0));

  // 分组的字节区间必须严格连续
  for (let i = 1; i < groups.length; i++)
    assert.equal(groups[i].startByte, groups[i - 1].endByte);
});

test("returns null when there is no sidx (caller falls back)", () => {
  // 只有 ftyp + moov + moof，没有索引
  const bytes = new Uint8Array(120);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 16); bytes.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  dv.setUint32(16, 16); bytes.set([0x6d, 0x6f, 0x6f, 0x76], 20); // moov
  dv.setUint32(32, 16); bytes.set([0x6d, 0x6f, 0x6f, 0x66], 36); // moof
  assert.equal(parseSegmentIndex(bytes), null);
});

test("returns null on truncated header", () => {
  const fx = buildFixture();
  const cut = fx.bytes.slice(0, 60);
  assert.equal(parseSegmentIndex(cut), null);
});

test("scans moof markers as a fallback", () => {
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 0, 16, 0x6d, 0x6f, 0x6f, 0x66], 8);
  bytes.set([0, 0, 0, 16, 0x6d, 0x6f, 0x6f, 0x66], 40);
  const found = scanMoofOffsets(bytes, 1000);
  assert.deepEqual(found, [1008, 1040]);
});
