/**
 * fMP4 分段索引解析（B 站的 .m4s 音轨就是这个结构）。
 *
 * 目的：把一个几十 MB 的音频文件，按 sidx 里的片段表切成若干段，
 * 每段「初始化段 + 连续的 moof/mdat」都是一个能独立 decodeAudioData 的 MP4。
 *
 * 为什么要这么做：一次解码整段 148 分钟的音频会产生 1.5 GB 的 AudioBuffer，
 * 分段之后每段只有几十 MB，峰值内存与视频长度无关。
 *
 * sidx 结构（ISO/IEC 14496-12 SegmentIndexBox）：
 *   box header (8 或 16 字节)
 *   version + flags        (4)
 *   reference_ID           (4)
 *   timescale              (4)
 *   earliest_presentation_time  (v0:4 / v1:8)
 *   first_offset                (v0:4 / v1:8)
 *   reserved (2) + reference_count (2)
 *   然后每个条目 12 字节：
 *     reference_type(1bit) | referenced_size(31bit)
 *     subsegment_duration(32bit)
 *     starts_with_SAP(1bit) | SAP_type(3bit) | SAP_delta_time(28bit)
 */

const HEADER = 8;

function readBox(bytes, view, pos) {
  if (pos + HEADER > bytes.length) return null;
  let size = view.getUint32(pos);
  const type = String.fromCharCode(
    bytes[pos + 4],
    bytes[pos + 5],
    bytes[pos + 6],
    bytes[pos + 7],
  );
  let headerSize = HEADER;
  if (size === 1) {
    if (pos + 16 > bytes.length) return null;
    // 用 Number 而不是 BigInt：文件最大几 GB，远小于 Number.MAX_SAFE_INTEGER
    size = Number(view.getBigUint64(pos + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = bytes.length - pos; // 延伸到文件末尾
  }
  if (size < headerSize) return null;
  return { pos, size, type, headerSize };
}

/**
 * 解析 sidx，得到片段表。
 * @param {Uint8Array} bytes 文件头部（至少要覆盖到 sidx 结束）
 * @returns {null | {initBytes:number, timescale:number, fragments:Array<{offset:number,size:number,seconds:number,start:number}>}}
 */
export function parseSegmentIndex(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  let sawMoov = false;
  let initBytes = 0;

  for (let i = 0; i < 64; i++) {
    const box = readBox(bytes, view, pos);
    if (!box) return null;

    if (box.type === "moov") sawMoov = true;

    if (box.type === "sidx") {
      const parsed = parseSidx(bytes, view, box, pos);
      if (!parsed) return null;
      // 初始化段 = 第一个 moof 之前的所有内容
      initBytes = parsed.dataStart;
      if (!sawMoov) return null;
      return {
        initBytes,
        timescale: parsed.timescale,
        fragments: parsed.fragments,
      };
    }

    // sidx 一定在第一个 moof 之前；遇到 moof 还没见到 sidx 就说明没有索引
    if (box.type === "moof") return null;

    pos += box.size;
    if (pos >= bytes.length) return null;
  }
  return null;
}

function parseSidx(bytes, view, box, boxStart) {
  let p = boxStart + box.headerSize;
  if (p + 12 > bytes.length) return null;

  const version = bytes[p];
  p += 4; // version + flags

  p += 4; // reference_ID
  const timescale = view.getUint32(p);
  p += 4;
  if (!timescale) return null;

  if (version === 0) p += 8;
  else p += 16; // earliest_presentation_time + first_offset

  p += 2; // reserved
  const count = view.getUint16(p);
  p += 2;

  if (p + count * 12 > bytes.length) return null; // 头部窗口不够大

  const sidxEnd = boxStart + box.size;
  // first_offset：从 sidx 盒子结束到第一个被引用片段的距离
  const firstOffsetPos = boxStart + box.headerSize + 4 + 4 + 4 + (version === 0 ? 4 : 8);
  const firstOffset =
    version === 0
      ? view.getUint32(firstOffsetPos)
      : Number(view.getBigUint64(firstOffsetPos));

  let cursor = sidxEnd + firstOffset;
  const dataStart = cursor;

  const fragments = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const w1 = view.getUint32(p);
    const duration = view.getUint32(p + 4);
    p += 12;

    const refType = w1 >>> 31;
    const refSize = w1 & 0x7fffffff;
    if (!refSize) continue;

    const seconds = duration / timescale;
    // refType=1 表示这一条指向另一个 sidx（分层索引），本文件不会出现，跳过
    if (refType === 0) {
      fragments.push({ offset: cursor, size: refSize, seconds, start: at });
      at += seconds;
    }
    cursor += refSize;
  }

  if (!fragments.length) return null;
  return { timescale, fragments, dataStart };
}

/**
 * 把片段按时间分组。分组边界对齐到片段边界，不切断片段。
 * @param {Array} fragments parseSegmentIndex 的结果
 * @param {number} secondsPerChunk 每组大约多少秒
 * @returns {Array<{startByte:number, endByte:number, seconds:number, offset:number}>}
 */
export function groupFragments(fragments, secondsPerChunk = 300) {
  const groups = [];
  let current = null;
  let at = 0;

  for (const f of fragments) {
    if (!current) {
      current = {
        startByte: f.offset,
        endByte: f.offset + f.size,
        seconds: f.seconds,
        offset: at,
      };
    } else {
      current.endByte = f.offset + f.size;
      current.seconds += f.seconds;
    }
    at += f.seconds;

    if (current.seconds >= secondsPerChunk) {
      groups.push(current);
      current = null;
    }
  }
  if (current) groups.push(current);
  return groups;
}

/**
 * 没有 sidx 时的兜底：在已知字节里扫 moof 标记，得到片段起始位置。
 * 只在「按字节块下载并就地扫描」时使用。
 */
export function scanMoofOffsets(bytes, baseOffset = 0) {
  const out = [];
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (
      bytes[i + 4] === 0x6d && // m
      bytes[i + 5] === 0x6f && // o
      bytes[i + 6] === 0x6f && // o
      bytes[i + 7] === 0x66 //   f
    ) {
      out.push(baseOffset + i);
    }
  }
  return out;
}
