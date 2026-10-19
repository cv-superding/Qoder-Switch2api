/**
 * 生成 Qoder-Switch2api 应用图标源图（1024x1024 PNG）。
 * 纯 Node 实现 PNG 编码（zlib deflate + CRC32），无外部依赖。
 * 用法：node scripts/gen-icon.mjs public/icon-src.png
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const OUT = process.argv[2] || "public/icon-src.png";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function inRoundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function ring(x, y, cx, cy, outer, inner) {
  const d = Math.hypot(x - cx, y - cy);
  return d <= outer && d >= inner;
}

const BG = [16, 24, 40]; // #101828
const BLUE = [91, 108, 255]; // #5b6cff
const GREEN = [0, 168, 112]; // #00a870
const DOT = [126, 240, 192]; // #7ef0c0

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let offset = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[offset] = 0; // filter: none
  offset += 1;
  for (let x = 0; x < SIZE; x += 1) {
    let color = BG;
    const radius = SIZE * 0.22;
    if (inRoundedRect(x, y, SIZE, radius)) {
      if (ring(x, y, SIZE * 0.40, SIZE * 0.40, SIZE * 0.26, SIZE * 0.175)) color = BLUE;
      if (ring(x, y, SIZE * 0.60, SIZE * 0.60, SIZE * 0.26, SIZE * 0.175)) color = GREEN;
      if (Math.hypot(x - SIZE * 0.63, y - SIZE * 0.37) <= SIZE * 0.045) color = DOT;
      if (Math.hypot(x - SIZE * 0.37, y - SIZE * 0.63) <= SIZE * 0.045) color = DOT;
    } else {
      color = [0, 0, 0];
    }
    raw[offset] = color[0];
    raw[offset + 1] = color[1];
    raw[offset + 2] = color[2];
    raw[offset + 3] = inRoundedRect(x, y, SIZE, radius) ? 255 : 0;
    offset += 4;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(OUT, png);
console.log(`written: ${OUT} (${png.length} bytes)`);
