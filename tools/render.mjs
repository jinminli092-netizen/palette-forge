// 输出层：色板条 PNG / SVG / HTML 联络表 / .cube LUT / 提示词片段

import { Canvas, textWidth, GLYPH_H } from "./png.mjs";
import { hexToRgb, hexToLab, rgbToLab, labToRgb, ciede2000, describeLab, ZONE_CN } from "./color.mjs";

const FONT_PX = GLYPH_H; // 单行字高

/* ---------------- 色板条 PNG（和参考图一样的横条 + hex 标注） ---------------- */

export function renderStripPNG(colors, opts = {}) {
  const labelScale = opts.labelScale || 2;
  const showCoverage = opts.showCoverage !== false;
  const swatchH = opts.swatchH || 190;
  const gap = opts.gap ?? 12;
  const pad = opts.pad ?? 24;
  const hexW = textWidth("#FFFFFF", labelScale);
  const swatchW = opts.swatchW || Math.max(84, hexW + 10);

  const labelLines = showCoverage ? 2 : 1;
  const labelH = labelLines * (FONT_PX * labelScale + 8) + 8;
  const width = pad * 2 + colors.length * swatchW + (colors.length - 1) * gap;
  const height = pad * 2 + swatchH + labelH;

  const bg = opts.bg || [255, 255, 255, 255];
  const fg = opts.fg || [26, 26, 26, 255];
  const subtle = [120, 120, 120, 255];
  const cv = new Canvas(width, height, bg);

  colors.forEach((c, i) => {
    const x = pad + i * (swatchW + gap);
    const [r, g, b] = hexToRgb(c.hex);
    cv.fillRect(x, pad, swatchW, swatchH, [r, g, b, 255]);
    // 极浅色给个描边，避免和背景糊在一起
    const lab = hexToLab(c.hex);
    if (lab[0] > 92) cv.strokeRect(x, pad, swatchW, swatchH, [216, 216, 216, 255], 1);
    cv.drawTextCentered(c.hex, x + swatchW / 2, pad + swatchH + 14, fg, labelScale);
    if (showCoverage) {
      const pct = `${(c.coverage ?? 0).toFixed(1)}%`;
      cv.drawTextCentered(pct, x + swatchW / 2, pad + swatchH + 14 + FONT_PX * labelScale + 8, subtle, labelScale);
    }
  });

  return { buffer: cv.toPNG(), width, height };
}

/* ---------------- 色板条 SVG（可无级缩放、可放中文名） ---------------- */

export function renderStripSVG(colors, opts = {}) {
  const swatchH = opts.swatchH || 190;
  const gap = opts.gap ?? 12;
  const pad = opts.pad ?? 24;
  const swatchW = opts.swatchW || 96;
  const showCoverage = opts.showCoverage !== false;
  const width = pad * 2 + colors.length * swatchW + (colors.length - 1) * gap;
  const height = pad * 2 + swatchH + (showCoverage ? 62 : 34);
  const title = opts.title ? `<text x="${pad}" y="${pad - 6}" font-family="ui-sans-serif,system-ui,'Noto Sans SC',sans-serif" font-size="13" fill="#666">${escapeXml(opts.title)}</text>` : "";

  const rects = colors
    .map((c, i) => {
      const x = pad + i * (swatchW + gap);
      const lab = hexToLab(c.hex);
      const stroke = lab[0] > 92 ? ' stroke="#d8d8d8"' : "";
      const cov = showCoverage
        ? `<text x="${x + swatchW / 2}" y="${pad + swatchH + 34}" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="11" fill="#8a8a8a">${(c.coverage ?? 0).toFixed(1)}%</text>`
        : "";
      const name = opts.showLabel && c.label
        ? `<text x="${x + swatchW / 2}" y="${pad + swatchH + (showCoverage ? 50 : 34)}" text-anchor="middle" font-family="'Noto Sans SC',sans-serif" font-size="10" fill="#aaa">${escapeXml(c.label)}</text>`
        : "";
      return `<rect x="${x}" y="${pad}" width="${swatchW}" height="${swatchH}" fill="${c.hex}"${stroke}/>
    <text x="${x + swatchW / 2}" y="${pad + swatchH + 18}" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="12" fill="#1a1a1a">${c.hex}</text>${cov}${name}`;
    })
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + (opts.title ? 16 : 0)}" viewBox="0 0 ${width} ${height + (opts.title ? 16 : 0)}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${title}
  <g transform="translate(0,${opts.title ? 16 : 0})">
  ${rects}
  </g>
</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m]));
}

/* ---------------- HTML 联络表 ---------------- */

export function renderContactHTML(result, opts = {}) {
  const c = result.colors;
  const tone = result.tone;
  const name = opts.name || "未命名色板";
  const zoneBar = (v, cls) => `<div class="zone ${cls}" style="flex:${Math.max(Number(v) || 0, 0.001)}"></div>`;
  const swatches = c
    .map((x) => {
      const light = hexToLab(x.hex)[0] > 88;
      return `<div class="sw">
      <div class="chip" style="background:${x.hex}${light ? ";border:1px solid #333" : ""}">
        <span class="hex">${x.hex}</span>
      </div>
      <div class="meta"><b>${(x.coverage ?? 0).toFixed(1)}%</b> · ${x.label ?? ""}</div>
      <div class="bar"><i style="width:${Math.min(100, (x.coverage ?? 0) * 3)}%"></i></div>
      ${x.structure != null ? `<div class="note">结构 ${x.structure.toFixed(2)} — ${x.structureNote}</div>` : ""}
      ${x.voteShare != null ? `<div class="note">出现在 ${x.voteShare}% 的图里</div>` : ""}
    </div>`;
    })
    .join("\n");

  const dropped = (result.dropped || [])
    .map(
      (d) => `<tr>
      <td><span class="dot" style="background:${d.hex}"></span>${d.hex}</td>
      <td>${d.coverage.toFixed(2)}%</td>
      <td>${escapeXml(d.label || "")}</td>
      <td>${escapeXml(d.reason)}</td>
    </tr>`
    )
    .join("\n");

  const hueChips = (tone?.hueTop || [])
    .map((h) => `<span class="tag">${h.hue} ${(h.share * 100).toFixed(0)}%</span>`)
    .join("");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeXml(name)} · 色板</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:32px;background:#0e1013;color:#e8e8ea;font:14px/1.6 ui-sans-serif,system-ui,'Noto Sans SC',sans-serif}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8b9199;margin-bottom:24px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;margin-bottom:28px}
.sw{background:#15181d;border:1px solid #232830;border-radius:10px;padding:10px;overflow:hidden}
.chip{height:88px;border-radius:6px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:6px;box-sizing:border-box}
.hex{font:600 11px ui-monospace,Menlo,Consolas,monospace;background:#0009;color:#fff;padding:2px 6px;border-radius:4px;letter-spacing:.4px}
.meta{font-size:12px;color:#a9b0b8;margin-top:8px}
.bar{height:3px;background:#232830;border-radius:2px;margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%;background:#4a7cf7}
.note{font-size:11px;color:#6f7680;margin-top:6px;line-height:1.45}
h2{font-size:14px;color:#a9b0b8;margin:28px 0 10px;font-weight:600}
.zones{display:flex;height:26px;border-radius:6px;overflow:hidden;margin-bottom:10px}
.zone.shadow{background:#2a2f38}.zone.midtone{background:#6f7680}.zone.highlight{background:#c9cfd6}
.tag{display:inline-block;background:#1b2028;border:1px solid #262c36;color:#a9b0b8;border-radius:99px;padding:2px 10px;margin:0 6px 6px 0;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #1e232b;vertical-align:top}
th{color:#6f7680;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px;vertical-align:-1px;border:1px solid #0006}
code{background:#1b2028;padding:1px 5px;border-radius:4px;font-size:12px}
.kv{color:#a9b0b8;font-size:12px}
</style></head><body>
<h1>${escapeXml(name)}</h1>
<div class="sub">模式 <code>${result.mode}</code> · ${result.meta?.images ?? 1} 张输入 · 取样 ${tone?.samples ?? 0} 像素 · 色数 ${c.length}</div>

<div class="zones">${zoneBar(tone?.zones.shadow, "shadow")}${zoneBar(tone?.zones.midtone, "midtone")}${zoneBar(tone?.zones.highlight, "highlight")}</div>
<div class="kv">影调：<b>${escapeXml(tone?.keyName ?? "")}</b> ｜ 暗部 ${((tone?.zones.shadow ?? 0) * 100).toFixed(0)}% / 中间调 ${((tone?.zones.midtone ?? 0) * 100).toFixed(0)}% / 亮部 ${((tone?.zones.highlight ?? 0) * 100).toFixed(0)}% ｜ 平均 L* ${(tone?.meanL ?? 0).toFixed(0)} ｜ 反差 P95−P5 ${(tone?.tonalRange ?? 0).toFixed(0)} ｜ 平均饱和度 C* ${(tone?.meanC ?? 0).toFixed(0)}</div>
<div style="margin-top:10px">${hueChips}</div>

<h2>色板（${c.length} 色）</h2>
<div class="grid">
${swatches}
</div>

<h2>被剔除的候选色（${(result.dropped || []).length}）</h2>
<table><thead><tr><th>色</th><th>覆盖</th><th>描述</th><th>剔除理由</th></tr></thead>
<tbody>${dropped || '<tr><td colspan="4" style="color:#6f7680">无</td></tr>'}</tbody></table>
</body></html>`;
}

/* ---------------- .cube 3D LUT：把镜头拉回色板 ---------------- */

export function renderCubeLUT(colors, opts = {}) {
  const size = opts.size || 33;
  const strength = opts.strength ?? 0.7;
  const tol = opts.tolerance ?? 10;
  const title = (opts.title || "palette-lock").replace(/"/g, "");
  const targets = colors.map((c) => hexToLab(c.hex));

  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const r8 = Math.round((ri / (size - 1)) * 255);
        const g8 = Math.round((gi / (size - 1)) * 255);
        const b8 = Math.round((bi / (size - 1)) * 255);
        const lab = rgbToLab(r8, g8, b8);
        let bi2 = 0, bd = Infinity;
        for (let i = 0; i < targets.length; i++) {
          const dl = lab[0] - targets[i][0], da = lab[1] - targets[i][1], db = lab[2] - targets[i][2];
          const d = dl * dl + da * da + db * db;
          if (d < bd) { bd = d; bi2 = i; }
        }
        const dist = Math.sqrt(bd);
        const w = strength * (tol / (tol + dist));
        const out = labToRgb(
          lab[0] + (targets[bi2][0] - lab[0]) * w,
          lab[1] + (targets[bi2][1] - lab[1]) * w,
          lab[2] + (targets[bi2][2] - lab[2]) * w
        );
        const f = (v) => (v / 255).toFixed(6);
        lines.push(`${f(out[0])} ${f(out[1])} ${f(out[2])}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/* ---------------- 提示词片段 ---------------- */

export function renderPrompt(result, opts = {}) {
  const c = result.colors;
  const tone = result.tone;
  const name = opts.name || "本场色板";
  const list = c.map((x) => `${x.hex} ${x.label} (${(x.coverage ?? 0).toFixed(0)}%)`).join(", ");
  const hues = (tone?.hueTop || []).slice(0, 3).map((h) => `${h.hue} ${(h.share * 100).toFixed(0)}%`).join(" / ");
  const keyEn =
    tone && tone.zones.shadow > 0.4 ? "low-key lighting, deep shadows" :
    tone && tone.zones.shadow > 0.25 ? "medium-low key, soft directional light" :
    tone && tone.zones.highlight > 0.3 ? "high-key lighting, bright airy" : "balanced natural key";

  return `【色彩约束 · ${name}】

一、限定色域（只用这些色，共 ${c.length} 色）
${list}

二、影调结构
暗部 ${((tone?.zones.shadow ?? 0) * 100).toFixed(0)}% / 中间调 ${((tone?.zones.midtone ?? 0) * 100).toFixed(0)}% / 亮部 ${((tone?.zones.highlight ?? 0) * 100).toFixed(0)}%
${tone?.keyName ?? ""}；主色系：${hues}

三、英文提示词（直接接在镜头描述后面）
Shot color palette: ${c.map((x) => x.hex).slice(0, 12).join(", ")}. Limited ${c.length}-color palette, harmonious ${hues} tones, ${keyEn}, cohesive cinematic color grading, muted desaturated tones, no saturated primaries, no neon, no pure white background.

四、中文提示词
画面限定为上述 ${c.length} 色；以 ${hues} 为基调，${tone?.keyName ?? ""}；整体低饱和、色相统一，不使用高饱和原色与霓虹色，不出现纯黑纯白大面积。

五、反向词
oversaturated, neon colors, rainbow, high-chroma primaries, color cast mismatch, inconsistent white balance, HDR halos, oversharpened
`;
}

/* ---------------- 控制台摘要 ---------------- */

export function summarize(result, opts = {}) {
  const c = result.colors;
  const t = result.tone;
  const lines = [];
  lines.push(`模式: ${result.mode}  输入图: ${result.meta?.images ?? 1}  取样: ${t?.samples ?? 0}px  输出色数: ${c.length}`);
  if (result.warning) lines.push(`⚠ ${result.warning}`);
  if (result.meta?.keptCoverage != null) {
    lines.push(`色板覆盖画面 ${result.meta.keptCoverage}%（其余被极值/重复/上限规则剔除，见下方清单）`);
  }
  if (t) {
    lines.push(
      `影调: ${t.keyName}`
    );
    lines.push(
      `      暗部 ${(t.zones.shadow * 100).toFixed(0)}% / 中间调 ${(t.zones.midtone * 100).toFixed(0)}% / 亮部 ${(t.zones.highlight * 100).toFixed(0)}%` +
      `  |  平均L* ${t.meanL.toFixed(0)}  反差 ${t.tonalRange.toFixed(0)}  平均C* ${t.meanC.toFixed(0)}  b*(暖+) ${t.warmth.toFixed(1)}`
    );
    lines.push(`主色系: ${t.hueTop.slice(0, 3).map((h) => `${h.hue} ${(h.share * 100).toFixed(0)}%`).join("  ")}`);
  }
  lines.push("");
  lines.push("  序号  色值      覆盖    L*    C*    h°    描述            结构");
  c.forEach((x, i) => {
    const L = x.lch?.L ?? x.lab?.[0] ?? 0;
    const C = x.lch?.C ?? 0;
    const h = x.lch?.h ?? 0;
    lines.push(
      `  ${String(i + 1).padStart(3)}   ${x.hex}  ${String((x.coverage ?? 0).toFixed(1) + "%").padStart(6)}` +
      `  ${String(L.toFixed(0)).padStart(4)}  ${String(C.toFixed(0)).padStart(4)}  ${String(h.toFixed(0)).padStart(4)}` +
      `   ${(x.label || "").padEnd(14)} ${x.structure != null ? x.structure.toFixed(2) : "-"}` +
      (x.status ? `  ${x.status}` : "")
    );
  });
  if (result.offBoard) {
    lines.push("");
    lines.push(`离板像素: ${result.offBoard.coverage}%（占全画面，ΔE00 > ${result.offBoard.thresholdDE}）`);
    result.offBoard.colors.forEach((x) => lines.push(`  + ${x.hex}  ${x.coverage}%（占离板部分）  ${x.label}`));
  }
  if (result.dropped?.length) {
    lines.push("");
    lines.push(`剔除 ${result.dropped.length} 个候选色：`);
    result.dropped.slice(0, 10).forEach((d) => lines.push(`  - ${d.hex}  ${d.coverage}%  ${d.reason}`));
    if (result.dropped.length > 10) lines.push(`  ...还有 ${result.dropped.length - 10} 个`);
  }
  return lines.join("\n");
}
