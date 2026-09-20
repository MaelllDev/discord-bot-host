#!/usr/bin/env node
/**
 * Generates the BotPanel logo (web/public/logo.png) from scratch.
 *
 * No image library and no third-party artwork: the picture is rasterised here
 * from signed distance fields, so the file shipped in the repository is an
 * original asset owned by the project (see NOTICE.md). Run it whenever you want
 * to change the colours or the glyph:
 *
 *   node scripts/generate-logo.mjs
 *
 * The result is a 512x512 RGBA PNG with a transparent background.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "public", "logo.png");

// --- design -------------------------------------------------------------------
const MARGIN = 26; // transparent border
const RADIUS = 108; // corner radius of the plate
const TOP_LEFT = [99, 102, 241]; // indigo-500
const BOTTOM_RIGHT = [139, 92, 246]; // violet-500
const GLYPH = [238, 242, 255]; // indigo-50
const STROKE = 46; // glyph stroke width
const CHEVRON = [
  [
    [156, 176],
    [248, 256],
  ],
  [
    [248, 256],
    [156, 336],
  ],
];
const UNDERSCORE = [
  [292, 336],
  [378, 336],
];

// --- tiny raster helpers ------------------------------------------------------
const clamp = (value) => Math.min(1, Math.max(0, value));
const mix = (a, b, t) => a + (b - a) * t;

/** Signed distance from a point to a rounded rectangle (negative = inside). */
function roundedBoxDistance(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(px - cx) - (halfWidth - radius);
  const dy = Math.abs(py - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from a point to a segment (round caps included by construction). */
function segmentDistance(px, py, [from, to]) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = px - x1;
  const wy = py - y1;
  const length2 = vx * vx + vy * vy;
  const t = length2 === 0 ? 0 : clamp((wx * vx + wy * vy) / length2);
  return Math.hypot(wx - vx * t, wy - vy * t);
}

// --- render -------------------------------------------------------------------
const pixels = Buffer.alloc(SIZE * SIZE * 4);
const center = SIZE / 2;
const half = SIZE / 2 - MARGIN;
const strokes = [...CHEVRON, UNDERSCORE].map((segment) => ({ segment, halfThickness: STROKE / 2 }));

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;

    // 1 px of antialiasing on both the plate and the glyph.
    const plate = clamp(0.5 - roundedBoxDistance(px, py, center, center, half, half, RADIUS));
    if (plate <= 0) continue;

    const gradient = clamp((px + py) / (SIZE * 2));
    let r = mix(TOP_LEFT[0], BOTTOM_RIGHT[0], gradient);
    let g = mix(TOP_LEFT[1], BOTTOM_RIGHT[1], gradient);
    let b = mix(TOP_LEFT[2], BOTTOM_RIGHT[2], gradient);

    const glyph = Math.max(
      ...strokes.map(({ segment, halfThickness }) => clamp(0.5 - (segmentDistance(px, py, segment) - halfThickness))),
    );
    r = mix(r, GLYPH[0], glyph);
    g = mix(g, GLYPH[1], glyph);
    b = mix(b, GLYPH[2], glyph);

    const offset = (y * SIZE + x) * 4;
    pixels[offset] = Math.round(r);
    pixels[offset + 1] = Math.round(g);
    pixels[offset + 2] = Math.round(b);
    pixels[offset + 3] = Math.round(plate * 255);
  }
}

// --- PNG encoding (8-bit RGBA, no interlace) ----------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const scanlines = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  scanlines[y * (SIZE * 4 + 1)] = 0; // filter type: none
  pixels.copy(scanlines, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes, ${SIZE}x${SIZE})`);
