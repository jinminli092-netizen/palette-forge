// 色彩数学：sRGB ⇄ 线性 ⇄ XYZ(D65) ⇄ CIELAB ⇄ LCh，以及 CIEDE2000 色差
// 零依赖。所有"颜色像不像"的判断一律在 Lab/ΔE00 里做，不在 sRGB 里做。

const D65 = { Xn: 0.95047, Yn: 1.0, Zn: 1.08883 };
const EPS = 216 / 24389; // (6/29)^3
const KAPPA = 24389 / 27; // (29/3)^3

/** sRGB 8bit 通道 → 线性光 [0,1] */
export function srgbToLinear(c8) {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 线性光 [0,1] → sRGB 8bit 通道 */
export function linearToSrgb(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  const n = Math.round(c * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function labF(t) {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}
function labFInv(t) {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
}

/** 预计算的线性化查表，加速批量转换 */
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i);

/** RGB(0..255) → Lab。用查表加速。 */
export function rgbToLab(r, g, b) {
  const rl = LIN[r | 0], gl = LIN[g | 0], bl = LIN[b | 0];
  const X = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / D65.Xn;
  const Y = (0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl) / D65.Yn;
  const Z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / D65.Zn;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Lab → RGB(0..255)，越界自动夹到 sRGB 色域内 */
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const X = labFInv(fx) * D65.Xn;
  const Y = labFInv(fy) * D65.Yn;
  const Z = labFInv(fz) * D65.Zn;
  const rl = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const gl = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const bl = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}

/** Lab → LCh（h 用角度，0..360） */
export function labToLch(L, a, b) {
  const C = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

/** 判断某个 Lab 是否落在 sRGB 色域内（用于提示"这个平均色是硬凑出来的"） */
export function inGamut(L, a, b, tol = 0.6) {
  const rgb = labToRgb(L, a, b);
  const back = rgbToLab(rgb[0], rgb[1], rgb[2]);
  const d = Math.sqrt(
    (back[0] - L) ** 2 + (back[1] - a) ** 2 + (back[2] - b) ** 2
  );
  return d <= tol;
}

/* ---------------- hex ---------------- */

export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error("非法 hex: " + hex);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function rgbToHex(r, g, b) {
  const h = (n) => (n < 16 ? "0" : "") + n.toString(16);
  return ("#" + h(r | 0) + h(g | 0) + h(b | 0)).toUpperCase();
}

export function hexToLab(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

export function labToHex(L, a, b) {
  const rgb = labToRgb(L, a, b);
  return rgbToHex(rgb[0], rgb[1], rgb[2]);
}

/* ---------------- 色差 ---------------- */

const POW25_7 = 6103515625; // 25^7

/** CIEDE2000 色差。c1/c2 = [L,a,b]。返回值 0~100 量级，约 1 为刚可察觉阈值。 */
export function ciede2000(c1, c2) {
  const L1 = c1[0], a1 = c1[1], b1 = c1[2];
  const L2 = c2[0], a2 = c2[1], b2 = c2[2];

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);

  let h1p = 0, h2p = 0;
  if (C1p !== 0 || b1 !== 0) { h1p = (Math.atan2(b1, a1p) * 180) / Math.PI; if (h1p < 0) h1p += 360; }
  if (C2p !== 0 || b2 !== 0) { h2p = (Math.atan2(b2, a2p) * 180) / Math.PI; if (h2p < 0) h2p += 360; }

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const rad = Math.PI / 180;
  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;

  const tL = dLp / SL;
  const tC = dCp / SC;
  const tH = dHp / SH;
  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/** Lab 欧氏距离平方（快，用于 k-means 内部；最终判据仍用 ΔE00） */
export function labDist2(L1, a1, b1, L2, a2, b2) {
  const dl = L1 - L2, da = a1 - a2, db = b1 - b2;
  return dl * dl + da * da + db * db;
}

/* ---------------- 语义命名 ---------------- */

const HUE_BANDS = [
  { max: 15, name: "红" },
  { max: 45, name: "橙" },
  { max: 75, name: "棕黄" },
  { max: 100, name: "黄" },
  { max: 140, name: "黄绿" },
  { max: 175, name: "绿" },
  { max: 210, name: "青" },
  { max: 260, name: "青蓝" },
  { max: 310, name: "蓝" },
  { max: 340, name: "蓝紫" },
  { max: 360, name: "紫红" },
];

export function hueName(h, C) {
  if (C < 8) return "中性";
  for (const b of HUE_BANDS) if (h < b.max) return b.name;
  return "红";
}

/** 给一个 Lab 打上"这个人话里怎么说这个色"的标签 */
export function describeLab(L, a, b) {
  const { C, h } = labToLch(L, a, b);
  const tone =
    L < 18 ? "深暗" : L < 32 ? "暗部" : L < 48 ? "暗中间调" : L < 65 ? "中间调" : L < 82 ? "亮中间调" : L < 94 ? "亮部" : "高光";
  const sat = C < 8 ? "中性灰" : C < 15 ? "低饱和" : C < 28 ? "中饱和" : C < 45 ? "高饱和" : "极饱和";
  const hn = hueName(h, C);
  const label = C < 8 ? `${tone}${sat}` : `${tone}${hn}`;
  return { tone, sat, hue: hn, label, L, C, h };
}

/** 明度分区（用于"这一场是低键还是高键"的判断） */
export function toneZone(L) {
  if (L < 25) return "shadow";
  if (L > 70) return "highlight";
  return "midtone";
}

export const ZONE_CN = { shadow: "暗部", midtone: "中间调", highlight: "亮部" };
