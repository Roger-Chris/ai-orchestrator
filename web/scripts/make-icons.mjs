// Draws the app icon (same design as public/icon.svg) as PNGs, with no image libraries.
// Run: node web/scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

/** badge: just the white mark on transparent, for Android's one-colour status-bar icon. */
function icon(size, badge = false) {
  const s = size / 512;
  const px = Buffer.alloc((size * 4 + 1) * size);
  // Coverage of each shape, 4x4 supersampled for smooth edges.
  const inRounded = (x, y) => {
    const r = 112, w = 512;
    const cx = Math.min(Math.max(x, r), w - r), cy = Math.min(Math.max(y, r), w - r);
    return x >= 0 && y >= 0 && x <= w && y <= w && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const onDiamond = (x, y) => {
    const d = Math.abs(x - 256) + Math.abs(y - 256);
    return Math.abs(d - 160) <= 20 * Math.SQRT2;
  };
  const inDot = (x, y) => (x - 256) ** 2 + (y - 256) ** 2 <= 52 * 52;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const X = (x + (sx + 0.5) / 4) / s, Y = (y + (sy + 0.5) / 4) / s;
          if (inRounded(X, Y)) {
            bg++;
            if (onDiamond(X, Y) || inDot(X, Y)) fg++;
          }
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (badge) {
        px.fill(255, o, o + 3);
        px[o + 3] = Math.round((fg / 16) * 255);
        continue;
      }
      const a = bg / 16, f = bg ? fg / bg : 0;
      px[o] = Math.round(0x4f + (255 - 0x4f) * f);
      px[o + 1] = Math.round(0x46 + (255 - 0x46) * f);
      px[o + 2] = Math.round(0xe5 + (255 - 0xe5) * f);
      px[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]);
}

const dir = new URL("../public/", import.meta.url);
for (const size of [192, 512]) writeFileSync(new URL(`icon-${size}.png`, dir), icon(size));
writeFileSync(new URL("badge-96.png", dir), icon(96, true));
console.log("wrote icon-192.png, icon-512.png and badge-96.png");
