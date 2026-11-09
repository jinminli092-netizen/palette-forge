// 纯 JS 的 PNG 编解码 + 5x7 点阵字库 + 极简画布
// 目的：在没有 numpy / PIL / canvas / sharp 的机器上，既能读图，也能把色板条直接画成 PNG。

import zlib from "node:zlib";

/* ============================ CRC32 ============================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* ============================ 编码 ============================ */

/** (width, height, rgba Buffer) → PNG Buffer */
export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 把一个已有的 {width,height,rgba} 图像对象直接编码成 PNG（不复制数据，避免写盘写成空画布） */
export function encodeImage(img) {
  return encodePNG(img.width, img.height, img.rgba);
}

/* ============================ 解码 ============================ */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** PNG Buffer → { width, height, rgba(Buffer) }。支持 8/16bit、非隔行、灰/真彩/索引/带 alpha。 */
export function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (interlace !== 0) throw new Error("暂不支持隔行(interlaced) PNG");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error("不支持的 PNG colorType=" + colorType);
  if (colorType === 3 && bitDepth !== 8) throw new Error("暂不支持索引色位深 < 8");
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error("不支持的位深 " + bitDepth);

  const sampleBytes = bitDepth / 8;
  const bpp = channels * sampleBytes;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  if (inflated.length < (stride + 1) * height) throw new Error("PNG 数据不完整");

  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = inflated[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prevDst = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = inflated[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[prevDst + i] : 0;
      const c = y > 0 && i >= bpp ? out[prevDst + i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error("PNG 滤波类型异常 " + ft);
      }
      out[dst + i] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  const pick = (o) => (sampleBytes === 2 ? out[o] : out[o]);
  for (let p = 0, q = 0; p < width * height; p++, q += bpp) {
    let r = 0, g = 0, b = 0, al = 255;
    if (colorType === 0) {
      r = g = b = pick(q);
    } else if (colorType === 2) {
      r = pick(q); g = pick(q + sampleBytes); b = pick(q + 2 * sampleBytes);
    } else if (colorType === 3) {
      const idx = out[q] * 3;
      r = palette[idx]; g = palette[idx + 1]; b = palette[idx + 2];
    } else if (colorType === 4) {
      r = g = b = pick(q); al = pick(q + sampleBytes);
    } else {
      r = pick(q); g = pick(q + sampleBytes); b = pick(q + 2 * sampleBytes);
      al = pick(q + 3 * sampleBytes);
    }
    rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = al;
  }
  return { width, height, rgba };
}

/* ============================ 5x7 点阵字库 ============================ */

const GLYPHS = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
  "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  ",": ["00000", "00000", "00000", "00000", "01100", "01100", "01000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

export const GLYPH_W = 6; // 5 列字形 + 1 列字距
export const GLYPH_H = 7;

/** 量出一个字符串渲染后的像素宽度 */
export function textWidth(str, scale = 1) {
  return str.length * GLYPH_W * scale;
}

/* ============================ 极简画布 ============================ */

export class Canvas {
  constructor(width, height, bg = [255, 255, 255, 255]) {
    this.width = width;
    this.height = height;
    this.rgba = Buffer.alloc(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  fillRect(x, y, w, h, color) {
    const [r, g, b, a = 255] = color;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    if (a >= 255) {
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * this.width * 4;
        for (let xx = x0; xx < x1; xx++) {
          const i = row + xx * 4;
          this.rgba[i] = r; this.rgba[i + 1] = g; this.rgba[i + 2] = b; this.rgba[i + 3] = 255;
        }
      }
    } else {
      const al = a / 255;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * this.width * 4;
        for (let xx = x0; xx < x1; xx++) {
          const i = row + xx * 4;
          this.rgba[i] = Math.round(this.rgba[i] * (1 - al) + r * al);
          this.rgba[i + 1] = Math.round(this.rgba[i + 1] * (1 - al) + g * al);
          this.rgba[i + 2] = Math.round(this.rgba[i + 2] * (1 - al) + b * al);
          this.rgba[i + 3] = 255;
        }
      }
    }
  }

  strokeRect(x, y, w, h, color, t = 1) {
    this.fillRect(x, y, w, t, color);
    this.fillRect(x, y + h - t, w, t, color);
    this.fillRect(x, y, t, h, color);
    this.fillRect(x + w - t, y, t, h, color);
  }

  /** 画点阵文字。返回实际绘制宽度。 */
  drawText(str, x, y, color, scale = 1) {
    const [r, g, b, a = 255] = color;
    let cx = Math.round(x);
    const s = Math.max(1, Math.round(scale));
    for (const raw of String(str)) {
      const ch = raw.toUpperCase();
      const glyph = GLYPHS[ch] || GLYPHS[" "];
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const line = glyph[gy];
        for (let gx = 0; gx < 5; gx++) {
          if (line[gx] !== "1") continue;
          const px = cx + gx * s;
          const py = Math.round(y) + gy * s;
          if (px + s <= 0 || py + s <= 0 || px >= this.width || py >= this.height) continue;
          this.fillRect(px, py, s, s, [r, g, b, a]);
        }
      }
      cx += GLYPH_W * s;
    }
    return cx - Math.round(x);
  }

  drawTextCentered(str, centerX, y, color, scale = 1) {
    const w = textWidth(str, scale);
    return this.drawText(str, Math.round(centerX - w / 2), y, color, scale);
  }

  toPNG() {
    return encodePNG(this.width, this.height, this.rgba);
  }
}
