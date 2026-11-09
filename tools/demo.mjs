// 端到端演示：造 6 张"美术风格锚定图"（5 张同调 + 1 张跑偏），
// 然后跑完整个闭环，把每一步的判断依据打印出来。
//
//   node tools/demo.mjs
//
// 这个脚本的意义：让你在没有任何真实素材时，也能看懂"一组图 → 一场戏的色彩规范"是怎么推导的。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Canvas, decodePNG, encodeImage } from "./png.mjs";
import { hexToLab, labToRgb, labToHex, ciede2000 } from "./color.mjs";
import { extractPooled, extractVoted, anchorScene, verifyAgainstPalette } from "./engine.mjs";
import { renderStripPNG, renderContactHTML, renderPrompt, summarize } from "./render.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MASTER = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "catalog.json"), "utf8")).palettes["master"].colors;

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** 用一块主色板"摆"出一张伪关键帧：大色块拼贴 + 光照衰减 + 色温偏移 + 噪点
 *  —— 刻意让画面基本由主色板构成，只带少量明暗过渡，模拟"美术风格已经定好了"的参考图 */
function makeKeyframe(colorsHex, w, h, opts = {}) {
  const { seed = 1, exposure = 1, warmth = 0, tint = 0, jitter = 4, shade = 0.14 } = opts;
  const rnd = rng(seed);
  const labs = colorsHex.map((hx) => hexToLab(hx));

  // 递归切分成大色块，保证铺满画面
  const rects = [];
  const split = (x, y, ww, hh, depth) => {
    if (depth >= 4 || (ww < w * 0.28 && hh < h * 0.28)) {
      rects.push({ x, y, w: ww, h: hh, ci: Math.floor(rnd() * labs.length) });
      return;
    }
    const t = 0.32 + rnd() * 0.36;
    if (ww >= hh) {
      split(x, y, ww * t, hh, depth + 1);
      split(x + ww * t, y, ww * (1 - t), hh, depth + 1);
    } else {
      split(x, y, ww, hh * t, depth + 1);
      split(x, y + hh * t, ww, hh * (1 - t), depth + 1);
    }
  };
  split(0, 0, w, h, 0);

  const cv = new Canvas(w, h, [0, 0, 0, 255]);
  for (const r of rects) {
    const [L0, a0, b0] = labs[r.ci];
    const x0 = Math.round(r.x), x1 = Math.round(r.x + r.w);
    const y0 = Math.round(r.y), y1 = Math.round(r.y + r.h);
    for (let y = y0; y < y1 && y < h; y++) {
      // 顶亮底暗的柔和衰减，模拟一个方向光
      const t = (y - y0) / Math.max(1, y1 - y0);
      const lum = 1 + shade * (0.5 - t) * 2;
      for (let x = x0; x < x1 && x < w; x++) {
        const L = Math.max(0, Math.min(100, L0 * lum * exposure));
        const [rr, gg, bb] = labToRgb(L, a0 + tint, b0 + warmth);
        const j = () => Math.round((rnd() - 0.5) * jitter);
        const o = (y * w + x) * 4;
        cv.rgba[o] = Math.max(0, Math.min(255, rr + j()));
        cv.rgba[o + 1] = Math.max(0, Math.min(255, gg + j()));
        cv.rgba[o + 2] = Math.max(0, Math.min(255, bb + j()));
        cv.rgba[o + 3] = 255;
      }
    }
  }
  return { width: w, height: h, rgba: cv.rgba, path: `demo-${seed}.png` };
}

function banner(t) {
  console.log("\n" + "─".repeat(64));
  console.log(t);
  console.log("─".repeat(64));
}

export function run() {
  const demoDir = path.join(ROOT, "out", "_demo");
  const kfDir = path.join(demoDir, "keyframes");
  fs.mkdirSync(kfDir, { recursive: true });

  // ---------- Step 0：造 6 张风格锚定图 ----------
  banner("Step 0  造 6 张『美术风格锚定图』（模拟你在 Midjourney 里出的 6 张同场参考）");
  const specs = [
    { name: "kf-01-日景全景", seed: 3, exposure: 1.0, warmth: 0, tint: 0 },
    { name: "kf-02-日景中景", seed: 11, exposure: 1.04, warmth: 1.5, tint: 0.5 },
    { name: "kf-03-日景近景", seed: 19, exposure: 0.97, warmth: -1, tint: 0 },
    { name: "kf-04-黄昏侧光", seed: 27, exposure: 0.9, warmth: 5, tint: 1.5 },
    { name: "kf-05-夜内灯下", seed: 41, exposure: 0.72, warmth: 3, tint: -1 },
    { name: "kf-06-跑偏帧", seed: 55, exposure: 1.0, warmth: -22, tint: -8 }, // 故意冷调跑偏
  ];
  const images = specs.map((s) => {
    const img = makeKeyframe(MASTER, 480, 320, s);
    img.path = path.join(kfDir, s.name + ".png");
    fs.writeFileSync(img.path, encodeImage(img)); // 把真正画出来的像素写盘
    // 回读，模拟"从磁盘读图"的真实路径
    const back = decodePNG(fs.readFileSync(img.path));
    return { width: back.width, height: back.height, rgba: back.rgba, path: img.path, name: s.name };
  });
  console.log(`已生成 ${images.length} 张：${images.map((i) => path.basename(i.path)).join(", ")}`);
  console.log(`全部基于主色板 ${MASTER.length} 色；第 6 张刻意做了冷调偏移（warmth −22, tint −8）作为"离群帧"`);

  // ---------- Step 1：逐帧对账，找出离群帧 ----------
  banner("Step 1  逐帧与主色板对账 —— 先剔掉跑偏的参考图（这一步最关键，脏数据会污染整块色板）");
  const perFrame = images.map((img) => ({ img, v: verifyAgainstPalette([img], MASTER, { nearDE: 6, offDE: 12 }) }));
  console.log("  帧                        吻合分  在板%  离板%   判定");
  perFrame.forEach(({ img, v }) => {
    console.log(
      `  ${path.basename(img.path).padEnd(22)} ${String(v.score).padStart(6)}  ${String(v.distribution.inPalette).padStart(5)}  ${String(v.distribution.offPalette).padStart(5)}   ${v.verdict}`
    );
  });
  const KEEP = (v) => v.score >= 50 && v.distribution.offPalette <= 25;
  const good = perFrame.filter((p) => KEEP(p.v)).map((p) => p.img);
  const bad = perFrame.filter((p) => !KEEP(p.v)).map((p) => p.img);
  console.log(`\n  → 保留 ${good.length} 张，剔除 ${bad.length} 张：${bad.map((b) => path.basename(b.path)).join(", ") || "无"}`);
  console.log(`  判据：吻合分 < 50 或 离板像素 > 25% 的帧视为「美术跑偏」，不进色板推导。`);
  if (good.length < 2) throw new Error("可用锚定图不足 2 张，无法继续");

  // ---------- Step 2：池化提取 ----------
  banner("Step 2  池化提取（把 N 张当一场戏，等权混合后统一聚类）");
  const pooled = extractPooled(good, { kmax: 10, kmin: 5, minCoverage: 0.015, minSep: 6 });
  console.log(summarize(pooled));

  // ---------- Step 3：投票提取 ----------
  banner("Step 3  投票提取（每张各出一小板，只保留多数镜头都出现的色）");
  const voted = extractVoted(good, { kmax: 12, perKmax: 12, voteRatio: 0.4, perImageMinCoverage: 0.01, minSep: 6 });
  console.log(summarize(voted));
  console.log("\n  池化 vs 投票的差别：池化会被「面积最大的那张图」带偏；投票只认「多张图都在用」的骨架色，");
  console.log("  所以投票出来的色板更适合当约束，而池化出来的更适合当「这一场的实际配色」记录。");

  // ---------- Step 4：与主色板对账 ----------
  banner("Step 4  与剧集主色板对账 —— 看这一场用了主板的哪几个色，有没有冒出板外新色");
  const anchored = anchorScene(good, MASTER, { offBoardDE: 15 });
  console.log(`主色板 ${MASTER.length} 色，本场取样 ${anchored.meta.samples} 像素`);
  anchored.colors.forEach((c) => {
    console.log(`  ${c.hex}  占比 ${String(c.coverage.toFixed(1) + "%").padStart(6)}  平均ΔE00 ${String(c.meanDE ?? "-").padStart(4)}   ${c.status}`);
  });
  console.log(`\n  离板像素 ${anchored.offBoard.coverage}%（这些像素不属于任何一个主色的邻近范围）`);
  if (anchored.offBoard.colors.length) {
    console.log("  离板色聚类（这才是「该不该往主板上加色」的证据）：");
    anchored.offBoard.colors.forEach((c) => console.log(`    + ${c.hex}  ${c.coverage}%  ${c.label}`));
  }

  // ---------- Step 5：产出 ----------
  banner("Step 5  产出交付物");
  const outDir = path.join(demoDir, "deliverable");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [tag, r] of [["pooled", pooled], ["voted", voted]]) {
    fs.writeFileSync(path.join(outDir, `${tag}-palette.png`), renderStripPNG(r.colors, {}).buffer);
    fs.writeFileSync(path.join(outDir, `${tag}-palette.html`), renderContactHTML(r, { name: tag }), "utf8");
    fs.writeFileSync(path.join(outDir, `${tag}-prompt.txt`), renderPrompt(r, { name: tag }), "utf8");
    fs.writeFileSync(path.join(outDir, `${tag}-palette.json`), JSON.stringify(r, null, 2), "utf8");
  }
  fs.writeFileSync(path.join(outDir, "anchor-report.json"), JSON.stringify(anchored, null, 2), "utf8");
  fs.writeFileSync(path.join(outDir, "frame-scores.json"), JSON.stringify(perFrame.map((p) => ({ file: path.basename(p.img.path), ...p.v, perMaster: undefined, tone: undefined })), null, 2), "utf8");
  console.log("  " + outDir);
  fs.readdirSync(outDir).sort().forEach((f) => console.log("    + " + f));

  // ---------- Step 6：定稿提示词 ----------
  banner("Step 6  拿去约束视频生成的提示词（推荐用投票版，噪声最小）");
  console.log(renderPrompt(voted, { name: "第 12 场 · 破窑内景" }));

  console.log("\n演示完成。所有文件在：" + demoDir);
}

if (process.argv[1] && process.argv[1].endsWith("demo.mjs")) run();
