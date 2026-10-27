// Draws the app's icons (same mark as web/public/icon.svg) as PNGs, with no image libraries.
// Run: node scripts/make-icons.mjs
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

/**
 * full: indigo rounded square with the white mark. mark: white mark only on transparent,
 * scaled to `markScale` of the canvas (adaptive-icon foregrounds keep a safe margin).
 */
function png(size, mode, markScale = 1) {
  const px = Buffer.alloc((size * 4 + 1) * size);
  const inRounded = (x, y) => {
    const r = 112, w = 512;
    const cx = Math.min(Math.max(x, r), w - r), cy = Math.min(Math.max(y, r), w - r);
    return x >= 0 && y >= 0 && x <= w && y <= w && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const onMark = (x, y) => {
    const d = Math.abs(x - 256) + Math.abs(y - 256);
    return Math.abs(d - 160) <= 20 * Math.SQRT2 || (x - 256) ** 2 + (y - 256) ** 2 <= 52 * 52;
  };
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          // Canvas coordinates in the 512 design space.
          const X = ((x + (sx + 0.5) / 4) / size) * 512, Y = ((y + (sy + 0.5) / 4) / size) * 512;
          const MX = 256 + (X - 256) / markScale, MY = 256 + (Y - 256) / markScale;
          if (mode === "full" ? inRounded(X, Y) : true) bg++;
          if (onMark(MX, MY) && (mode !== "full" || inRounded(X, Y))) fg++;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (mode === "mark") {
        px.fill(255, o, o + 3);
        px[o + 3] = Math.round((fg / 16) * 255);
        continue;
      }
      const f = bg ? fg / bg : 0;
      px[o] = Math.round(0x4f + (255 - 0x4f) * f);
      px[o + 1] = Math.round(0x46 + (255 - 0x46) * f);
      px[o + 2] = Math.round(0xe5 + (255 - 0xe5) * f);
      px[o + 3] = Math.round((bg / 16) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]);
}

const out = (name, data) => writeFileSync(new URL(`../assets/${name}`, import.meta.url), data);
out("icon.png", png(1024, "full"));
// Android masks adaptive icons to a circle/squircle: keep the mark inside the middle ~60%.
out("android-icon-foreground.png", png(1024, "mark", 0.62));
out("android-icon-monochrome.png", png(1024, "mark", 0.62));
out("notification-icon.png", png(96, "mark"));
out("splash-icon.png", png(512, "full"));
console.log("wrote assets/*.png");
