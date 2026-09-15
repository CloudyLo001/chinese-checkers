/**
 * Generates the PNG app icons and iOS home-screen launch images into public/.
 *
 * iOS ignores SVG for `apple-touch-icon` and `apple-touch-startup-image`, so
 * these have to be real PNGs.
 *
 * The app icons composite `assets/icon-source.png` — the board artwork, cut out
 * on transparency — onto a flat plate, scaled per output so the star clears
 * whichever mask the platform applies. The launch screens still rasterise the
 * star logo from signed distance fields, which antialiases cleanly at any size
 * and keeps the 2732px splashes small.
 *
 *   node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');
/** The board artwork, cut out on transparency, that every app icon is built from. */
const ICON_ART = join(ROOT, 'assets', 'icon-source.png');

// --- colours ---------------------------------------------------------------

const ICON_BG = [0xff, 0xd9, 0xe8];
const SPLASH_BG = [0xff, 0xe7, 0xf0];
const STAR = [0xe4, 0x86, 0xb0];
const MARBLES = [
  [0xff, 0x4d, 0x6d], // cherry
  [0x3a, 0xa0, 0xff], // sky
  [0xff, 0xc2, 0x33], // sunshine
  [0x2f, 0xd0, 0x7a], // mint
  [0xa8, 0x6b, 0xff], // grape
  [0x14, 0xc9, 0xc4], // lagoon
];

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}

function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour, no alpha (icons are opaque)
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing ---------------------------------------------------------------

function canvas(width, height, background) {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = background[0];
    data[i * 3 + 1] = background[1];
    data[i * 3 + 2] = background[2];
  }
  return { width, height, data };
}

/** Blends `color` into a pixel by `coverage` (0..1). */
function blend(target, x, y, color, coverage) {
  if (coverage <= 0) return;
  if (x < 0 || y < 0 || x >= target.width || y >= target.height) return;
  const i = (y * target.width + x) * 3;
  const a = Math.min(coverage, 1);
  target.data[i] = Math.round(target.data[i] * (1 - a) + color[0] * a);
  target.data[i + 1] = Math.round(target.data[i + 1] * (1 - a) + color[1] * a);
  target.data[i + 2] = Math.round(target.data[i + 2] * (1 - a) + color[2] * a);
}

/** Fills every pixel whose signed distance (in pixels, negative inside) is covered. */
function fillSdf(target, box, color, sdf) {
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(target.width - 1, Math.ceil(box[2]));
  const y1 = Math.min(target.height - 1, Math.ceil(box[3]));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const distance = sdf(x + 0.5, y + 0.5);
      blend(target, x, y, color, 0.5 - distance);
    }
  }
}

function circle(target, cx, cy, r, color) {
  fillSdf(target, [cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2], color, (x, y) =>
    Math.hypot(x - cx, y - cy) - r,
  );
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function strokePolygon(target, points, width, color) {
  const half = width / 2;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const box = [
    Math.min(...xs) - half - 2,
    Math.min(...ys) - half - 2,
    Math.max(...xs) + half + 2,
    Math.max(...ys) + half + 2,
  ];
  fillSdf(target, box, color, (x, y) => {
    let distance = Infinity;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      distance = Math.min(distance, segmentDistance(x, y, a[0], a[1], b[0], b[1]));
    }
    return distance - half;
  });
}

/**
 * The logo: a Star of David outline with a marble at each of the six points.
 * `scale` is relative to a 512-unit design box centred on (cx, cy).
 */
function drawLogo(target, cx, cy, scale) {
  const unit = scale / 512;
  const tip = 186 * unit;
  const strokeWidth = Math.max(15 * unit, 1.3);

  const triangle = (offsetDegrees) =>
    [0, 120, 240].map((angle) => {
      const radians = ((angle + offsetDegrees - 90) * Math.PI) / 180;
      return [cx + Math.cos(radians) * tip, cy + Math.sin(radians) * tip];
    });

  strokePolygon(target, triangle(0), strokeWidth, STAR);
  strokePolygon(target, triangle(60), strokeWidth, STAR);

  const marbleRadius = 32 * unit;
  const marbleOrbit = 138 * unit;
  for (let i = 0; i < 6; i++) {
    const radians = ((i * 60 - 90) * Math.PI) / 180;
    circle(
      target,
      cx + Math.cos(radians) * marbleOrbit,
      cy + Math.sin(radians) * marbleOrbit,
      marbleRadius,
      MARBLES[i],
    );
  }
}

// --- outputs ---------------------------------------------------------------

function writeLogoIcon(name, size, logoScale, background = ICON_BG, dir = OUT) {
  const image = canvas(size, size, background);
  drawLogo(image, size / 2, size / 2, size * logoScale);
  writeFileSync(join(dir, name), encodePng(size, size, image.data));
  return name;
}

/**
 * Composites the board artwork onto a `size` square, scaled so its height is
 * `coverage` of the canvas. A `background` colour flattens the result to opaque
 * RGB — the App Store icon is rejected if it carries an alpha channel — while
 * `null` keeps the canvas transparent for Android's adaptive foreground layer.
 */
async function writeArtIcon(name, size, coverage, background = ICON_BG, dir = OUT) {
  const art = await sharp(ICON_ART)
    .resize({ width: Math.round(size * coverage), height: Math.round(size * coverage), fit: 'inside' })
    .toBuffer();
  const plate = {
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background
        ? { r: background[0], g: background[1], b: background[2], alpha: 1 }
        : { r: 0, g: 0, b: 0, alpha: 0 },
    },
  };
  const composited = await sharp(plate)
    .composite([{ input: art, gravity: 'centre' }])
    .png()
    .toBuffer();
  // Second pass: `removeAlpha` only sees the flat plate if it shares a pipeline
  // with the composite, so drop the channel once the artwork is already burnt in.
  const image = sharp(composited);
  await (background ? image.removeAlpha() : image).png({ compressionLevel: 9 }).toFile(join(dir, name));
  return name;
}

function writeSplash(width, height) {
  const image = canvas(width, height, SPLASH_BG);
  drawLogo(image, width / 2, height / 2, Math.min(width, height) * 0.42);
  const name = `splash-${width}x${height}.png`;
  writeFileSync(join(OUT, name), encodePng(width, height, image.data));
  return name;
}

export const IPHONE_SCREENS = [
  [320, 568, 2], // SE (1st gen), 5s
  [375, 667, 2], // SE (2nd/3rd gen), 8
  [414, 736, 3], // 8 Plus
  [375, 812, 3], // X, XS, 11 Pro, 12/13 mini
  [414, 896, 2], // XR, 11
  [414, 896, 3], // XS Max, 11 Pro Max
  [390, 844, 3], // 12, 13, 14
  [428, 926, 3], // 12/13 Pro Max, 14 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [430, 932, 3], // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  [402, 874, 3], // 16 Pro
  [440, 956, 3], // 16 Pro Max
];

mkdirSync(OUT, { recursive: true });

const written = [
  // The board detail is lost at favicon size, so let the star fill the square.
  await writeArtIcon('favicon-32.png', 32, 0.94),
  await writeArtIcon('apple-touch-icon.png', 180, 0.82),
  await writeArtIcon('icon-192.png', 192, 0.82),
  await writeArtIcon('icon-512.png', 512, 0.82),
  /*
   * Maskable icons are cropped to a circle whose diameter is 80% of the icon.
   * The star's points sit on its own circumcircle, so a height of 0.76 keeps
   * every point inside that safe zone.
   */
  await writeArtIcon('icon-maskable-512.png', 512, 0.76),
];

for (const [width, height, ratio] of IPHONE_SCREENS) {
  written.push(writeSplash(width * ratio, height * ratio));
}

console.log(`wrote ${written.length} files`);
for (const name of written) console.log(`  ${name}`);
