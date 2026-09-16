/*
 * Generates the PWA / notification icons for EduMemo.
 *
 * Why this exists: Web Push on Android/iOS needs the app to be installable, and
 * installability needs a *real, square PNG* icon of at least 192px (and 512px
 * for the full install UI). The repository shipped a wide wordmark PNG and a
 * JPEG that the manifest declared as a 192x192 PNG, which browsers reject --
 * so there was no installable app. This script draws the icons from flat brand
 * colours and writes them as PNGs using only Node's built-in zlib, so it runs
 * anywhere with no image toolchain and the icons can always be regenerated.
 *
 * Run with:  node tools/make-pwa-icons.js            (writes the PNGs)
 *            node tools/make-pwa-icons.js --preview  (also prints the glyph)
 *
 * To use the institution's own square crest instead, drop it in as
 * public/images/icon-192.png / icon-512.png / icon-maskable-512.png (same
 * sizes) and re-run nothing -- the manifest already points at those names.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'images');
const BRAND = [21, 122, 58]; // #157a3a, the manifest theme colour
const WHITE = [255, 255, 255];

// ------------------------------------------------------------------ PNG ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function writePng(file, width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // per-row filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---------------------------------------------------------------- shapes ----
/**
 * A notification bell, in normalised coordinates (|x| <= ~0.5, |y| <= ~0.6):
 * domed body, a small handle on top, a brim and a clapper.
 */
function bellAt(nx, ny) {
  const bodyTop = -0.40;
  const bodyBottom = 0.28;
  if (ny >= bodyTop && ny <= bodyBottom) {
    // A bell silhouette: a circular dome on top, then a skirt that flares out
    // to the rim.
    const t = (ny - bodyTop) / (bodyBottom - bodyTop);
    const domeShare = 0.45;
    let half;
    if (t <= domeShare) {
      const dt = (domeShare - t) / domeShare;
      half = 0.235 * Math.sqrt(Math.max(0, 1 - dt * dt));
    } else {
      half = 0.235 + 0.225 * Math.pow((t - domeShare) / (1 - domeShare), 1.6);
    }
    if (Math.abs(nx) <= half) return true;
  }
  if (nx * nx + (ny - (bodyTop - 0.05)) ** 2 <= 0.06 ** 2) return true;                 // handle
  if (ny > bodyBottom && ny <= bodyBottom + 0.06 && Math.abs(nx) <= 0.50) return true;   // rim
  if (nx * nx + (ny - (bodyBottom + 0.17)) ** 2 <= 0.075 ** 2) return true;              // clapper
  return false;
}

/** Rounded square that fills the canvas (radius is a fraction of the full size). */
function inRoundedSquare(px, py, radius) {
  const ax = Math.abs(px);
  const ay = Math.abs(py);
  if (ax > 1 || ay > 1) return false;
  const edge = 1 - radius;
  if (ax <= edge || ay <= edge) return true;
  return (ax - edge) ** 2 + (ay - edge) ** 2 <= radius ** 2;
}

/**
 * Renders one icon: an optional background plate with a bell on top, both
 * antialiased with 3x3 supersampling per pixel.
 */
function render({ size, background, cornerRadius = 0, bellScale = 0.62, fg = WHITE }) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = ((x + (sx + 0.5) / samples) / size) * 2 - 1;
          const py = ((y + (sy + 0.5) / samples) / size) * 2 - 1;
          if (background && inRoundedSquare(px, py, cornerRadius)) bgHits++;
          if (bellAt(px / bellScale, py / bellScale)) fgHits++;
        }
      }
      const total = samples * samples;
      const bgA = background ? bgHits / total : 0;
      const fgA = fgHits / total;
      const outA = fgA + bgA * (1 - fgA);
      const i = (y * size + x) * 4;
      if (outA <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const bg = background ? background[c] : 0;
        rgba[i + c] = Math.round((fgA * fg[c] + bgA * (1 - fgA) * bg) / outA);
      }
      rgba[i + 3] = Math.round(outA * 255);
    }
  }
  return rgba;
}

/** Prints the glyph as text so the shape can be eyeballed without an image viewer. */
function preview(rgba, size, cols = 44) {
  const rows = Math.round(cols / 2);
  let art = '';
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const x = Math.floor((c / cols) * size);
      const y = Math.floor((r / rows) * size);
      const i = (y * size + x) * 4;
      if (rgba[i + 3] / 255 < 0.35) line += ' ';
      else if (rgba[i] > 200 && rgba[i + 1] > 200 && rgba[i + 2] > 200) line += '#';
      else line += '.';
    }
    art += line + '\n';
  }
  return art;
}

// ------------------------------------------------------------------ main ----
const icons = [
  // bellScale is relative to the glyph's own coordinate space, where the bell
  // is about 1.0 units tall and 0.5 units wide -- so ~1.1 puts it at roughly
  // half the icon's width and 55% of its height, the usual app-icon proportion.
  { file: 'icon-192.png', size: 192, background: BRAND, cornerRadius: 0.44, bellScale: 1.10 },
  { file: 'icon-512.png', size: 512, background: BRAND, cornerRadius: 0.44, bellScale: 1.10 },
  // Maskable icons are cropped by the launcher to a circle: the plate must be
  // full-bleed (no transparency, no rounded corners) and the glyph has to sit
  // inside the inner 80% "safe zone", so it is drawn a little smaller.
  { file: 'icon-maskable-512.png', size: 512, background: BRAND, cornerRadius: 0, bellScale: 0.98 },
  // Android renders the status-bar badge as a mask, so it must be a small,
  // monochrome shape on a transparent background.
  { file: 'badge.png', size: 96, background: null, cornerRadius: 0, bellScale: 1.45 },
];

for (const icon of icons) {
  const rgba = render(icon);
  const target = path.join(OUT_DIR, icon.file);
  writePng(target, icon.size, icon.size, rgba);
  console.log(`wrote ${path.relative(process.cwd(), target)} (${icon.size}x${icon.size}, ${fs.statSync(target).size} bytes)`);
  if (process.argv.includes('--preview')) console.log(preview(rgba, icon.size));
}