// 离线自测：色彩数学 / PNG 编解码 / 提取精度 / 结构分数 / 对账 / 校验
// 不联网、不依赖外部图片：全部用合成图验证。

import fs from "node:fs";
import path from "node:path";
import { Canvas, decodePNG, textWidth } from "./png.mjs";
import { hexToLab, labToHex, ciede2000, rgbToLab, labToRgb } from "./color.mjs";
import { extractPooled, extractVoted, anchorScene, verifyAgainstPalette, structureScores } from "./engine.mjs";
import { renderStripPNG, renderStripSVG, renderContactHTML, renderCubeLUT, renderPrompt } from "./render.mjs";

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name + (extra ? " — " + extra : "")); console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function near(name, actual, expected, tol) {
  const d = Math.abs(actual - expected);
  ok(name, d <= tol, `实际 ${actual.toFixed(4)} 期望 ${expected} ±${tol}`);
}

/* ---------------- 1. 色彩数学 ---------------- */
function testColor() {
  console.log("\n[1] 色彩数学");
  const cases = [
    ["#FFFFFF", 100, 0, 0], ["#000000", 0, 0, 0],
  ];
  for (const [hex, L, a, b] of cases) {
    const lab = hexToLab(hex);
    near(`${hex} L*`, lab[0], L, 0.05);
    near(`${hex} a*`, lab[1], a, 0.05);
    near(`${hex} b*`, lab[2], b, 0.05);
  }
  const mid = hexToLab("#808080");
  near("#808080 L*", mid[0], 53.585, 0.3);

  // hex → Lab → hex 往返
  const hexes = ["#E8E8DC", "#F0EBE0", "#B8C4D4", "#D4884A", "#E8A878", "#6E4A28", "#8E6B3A", "#4A4438", "#4A5258", "#2A2A2A", "#C9A050", "#1F2840"];
  let maxRound = 0;
  for (const h of hexes) {
    const lab = hexToLab(h);
    const back = labToHex(lab[0], lab[1], lab[2]);
    maxRound = Math.max(maxRound, ciede2000(lab, hexToLab(back)));
  }
  ok("hex→Lab→hex 往返 ΔE00 < 0.3", maxRound < 0.3, `max ΔE00=${maxRound.toFixed(3)}`);

  // CIEDE2000 官方测试数据（Sharma, Wu & Dalal 2005）
  const de = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  ];
  let worst = 0;
  for (const [c1, c2, exp] of de) worst = Math.max(worst, Math.abs(ciede2000(c1, c2) - exp));
  ok("CIEDE2000 与 Sharma 标准数据一致 (13 组)", worst < 0.0002, `最大误差 ${worst.toExponential(2)}`);

  // 对称性
  let sym = 0;
  for (const [c1, c2] of de) sym = Math.max(sym, Math.abs(ciede2000(c1, c2) - ciede2000(c2, c1)));
  ok("CIEDE2000 对称", sym < 1e-9);
}

/* ---------------- 2. PNG 编解码 ---------------- */
function testPng() {
  console.log("\n[2] PNG 编解码 + 点阵字");
  const cv = new Canvas(64, 32, [10, 20, 30, 255]);
  cv.fillRect(4, 4, 20, 10, [200, 100, 50, 255]);
  cv.drawText("#E8E8DC", 2, 20, [255, 255, 255, 255], 2);
  const png = cv.toPNG();
  ok("编码出合法 PNG", png.length > 100 && png.readUInt32BE(0) === 0x89504e47);
  const back = decodePNG(png);
  ok("往返尺寸一致", back.width === 64 && back.height === 32);
  const i = (6 * 64 + 6) * 4;
  ok("往返像素一致", back.rgba[i] === 200 && back.rgba[i + 1] === 100 && back.rgba[i + 2] === 50);
  ok("文字真的画上了（非全背景色）", (() => {
    let n = 0;
    for (let p = 20 * 64 * 4; p < 30 * 64 * 4; p += 4) if (back.rgba[p] > 200) n++;
    return n > 40;
  })());
  near("textWidth 计算", textWidth("ABCDEFG", 2), 7 * 6 * 2, 0);
}

/* ---------------- 3. 合成图 + 提取精度 ---------------- */
function makeTestScene(colors, w, h, seed = 1) {
  // 确定性伪随机，保证自测可复现
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const cv = new Canvas(w, h, [0, 0, 0, 255]);
  const rows = Math.ceil(Math.sqrt(colors.length));
  const cw = Math.floor(w / rows);
  const ch = Math.floor(h / rows);
  const cells = rows * rows;
  for (let idx = 0; idx < cells; idx++) {
    const hex = colors[idx % colors.length]; // 空格子循环填满，保证覆盖率合计 100%
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const x = (idx % rows) * cw, y = Math.floor(idx / rows) * ch;
    for (let yy = y; yy < Math.min(h, y + ch); yy++) {
      for (let xx = x; xx < Math.min(w, x + cw); xx++) {
        const j = Math.round((rnd() - 0.5) * 5);
        const o = (yy * w + xx) * 4;
        cv.rgba[o] = Math.max(0, Math.min(255, r + j));
        cv.rgba[o + 1] = Math.max(0, Math.min(255, g + j));
        cv.rgba[o + 2] = Math.max(0, Math.min(255, b + j));
        cv.rgba[o + 3] = 255;
      }
    }
  }
  return { width: w, height: h, rgba: cv.rgba, path: "synthetic" };
}

function testExtract(outDir) {
  console.log("\n[3] 提取精度");
  // 刻意挑 8 个互相拉得开的色，验证"能不能准确召回"
  const truth = ["#F0EBE0", "#B8C4D4", "#D4884A", "#8E6B3A", "#6E4A28", "#4A5258", "#2A2A2A", "#1F2840"];
  const img = makeTestScene(truth, 480, 480, 7);
  fs.mkdirSync(outDir, { recursive: true });
  const cv = new Canvas(img.width, img.height, [0, 0, 0, 255]);
  img.rgba.copy(cv.rgba);
  fs.writeFileSync(path.join(outDir, "synthetic-scene.png"), cv.toPNG());

  const r = extractPooled([img], { kmax: 12, kmin: 6, minCoverage: 0.01, minSep: 6 });
  ok("提取色数在 8~12", r.colors.length >= 8 && r.colors.length <= 12, `实际 ${r.colors.length}`);

  let hit = 0;
  const deList = [];
  for (const t of truth) {
    const tl = hexToLab(t);
    let best = Infinity;
    for (const c of r.colors) best = Math.min(best, ciede2000(tl, c.lab));
    if (best < 3) hit++;
    deList.push(+best.toFixed(2));
  }
  ok(`8 个已知色全部被召回（ΔE00<3）`, hit === truth.length, `命中 ${hit}/${truth.length}，各色偏差 ${JSON.stringify(deList)}`);
  ok("明度阶梯排序（亮→暗）", r.colors.every((c, i) => i === 0 || r.colors[i - 1].lab[0] >= c.lab[0] - 0.01));

  const struct = structureScores([img], r.colors);
  const avgStruct = struct.reduce((s, x) => s + (x.structure || 0), 0) / struct.length;
  ok("大色块的结构分数偏高 (>0.7)", avgStruct > 0.7, `平均 ${avgStruct.toFixed(2)}`);

  const minInternal = Math.min(...r.colors.map((c) => c.nearestDE ?? 99));
  ok("色板内部无重复色（最小 ΔE00 >= 5）", minInternal >= 5, `最小 ${minInternal}`);

  const covSum = r.colors.reduce((s, c) => s + c.coverage, 0);
  ok("色板覆盖率合计接近 100%", covSum > 95 && covSum < 105, `合计 ${covSum.toFixed(1)}%`);

  // 近重复色应该被并成一色：两块几乎一样的奶油白
  const twin = makeTestScene(["#F0EBE0", "#E8E8DC"], 320, 320, 13);
  const rt = extractPooled([twin], { kmax: 12, kmin: 1, minCoverage: 0.01, minSep: 7 });
  const twinDE = ciede2000(hexToLab("#F0EBE0"), hexToLab("#E8E8DC"));
  ok(
    `ΔE00=${twinDE.toFixed(1)} 的两个奶油白被合并成 1 色`,
    rt.colors.length === 1,
    `实际出了 ${rt.colors.length} 色：${rt.colors.map((c) => c.hex).join(" ")}`
  );

  // 投票模式
  const imgs = [makeTestScene(truth, 320, 320, 3), makeTestScene(truth, 320, 320, 11), makeTestScene(truth.slice(0, 5), 320, 320, 19)];
  const v = extractVoted(imgs, { kmax: 10, voteRatio: 0.4, minSep: 6 });
  ok("投票模式能出板", v.colors.length >= 5, `实际 ${v.colors.length}`);
  ok("投票模式保留高票色", v.colors.some((c) => (c.voteShare ?? 0) >= 60), JSON.stringify(v.colors.map((c) => c.voteShare)));

  return r;
}

/* ---------------- 4. 对账 / 校验 ---------------- */
function testAnchorAndVerify() {
  console.log("\n[4] 主色板对账 + 跑板校验");
  const master = ["#F0EBE0", "#E8E8DC", "#B8C4D4", "#D4884A", "#8E6B3A", "#6E4A28", "#4A5258", "#2A2A2A"];
  // 场景 A：完全在板内
  const inBoard = makeTestScene(["#E8E8DC", "#D4884A", "#4A5258", "#2A2A2A"], 320, 320, 5);
  const a1 = anchorScene([inBoard], master, { offBoardDE: 15 });
  ok("板内场景：离板像素 < 2%", a1.offBoard.coverage < 2, `实际 ${a1.offBoard.coverage}%`);
  ok("板内场景：至少 4 个主色在场", a1.colors.filter((c) => c.coverage > 1).length >= 4);

  // 场景 B：混进一个霓虹色
  const offBoard = makeTestScene(["#E8E8DC", "#D4884A", "#00FF66", "#2A2A2A"], 320, 320, 9);
  const a2 = anchorScene([offBoard], master, { offBoardDE: 15 });
  ok("离板场景：能抓出离板像素", a2.offBoard.coverage > 10, `实际 ${a2.offBoard.coverage}%`);
  ok("离板场景：离板色里有绿色系", a2.offBoard.colors.some((c) => c.hue === "绿" || c.hue === "黄绿"), JSON.stringify(a2.offBoard.colors.map((c) => c.hex)));

  const good = verifyAgainstPalette([inBoard], master, { offBoardDE: 15 });
  const bad = verifyAgainstPalette([offBoard], master, { offBoardDE: 15 });
  ok("校验能区分好坏镜头", good.score > bad.score + 10, `好 ${good.score} vs 坏 ${bad.score}`);
  ok("完全在板的镜头得分 >= 80", good.score >= 80, `实际 ${good.score}`);
}

/* ---------------- 5. 输出层 ---------------- */
function testRender(outDir) {
  console.log("\n[5] 输出层");
  const colors = ["#F0EBE0", "#B8C4D4", "#D4884A", "#8E6B3A", "#4A5258", "#1F2840"].map((hex, i) => {
    const lab = hexToLab(hex);
    return { hex, lab, lch: { L: lab[0], C: Math.hypot(lab[1], lab[2]), h: 0 }, coverage: 20 - i * 2, label: "测试色" };
  });
  const result = { mode: "selftest", colors, dropped: [], tone: null, meta: { images: 1 } };

  const { buffer, width } = renderStripPNG(colors, {});
  ok("色板条 PNG 生成", buffer.length > 500);
  const parsed = decodePNG(buffer);
  ok("色板条尺寸正确", parsed.width === width && parsed.height > 100);

  const svg = renderStripSVG(colors, { title: "自测" });
  ok("SVG 生成且含全部 hex", colors.every((c) => svg.includes(c.hex)));

  const html = renderContactHTML(result, { name: "自测" });
  ok("HTML 生成且含全部 hex", colors.every((c) => html.includes(c.hex)));

  const cube = renderCubeLUT(colors, { size: 9 });
  const lines = cube.trim().split("\n");
  ok("LUT 头正确", lines[0].includes("TITLE") && lines[1] === "LUT_3D_SIZE 9");
  ok("LUT 数据行数 = 9^3", lines.length === 4 + 729, `实际 ${lines.length}`);

  const prompt = renderPrompt(result, { name: "自测" });
  ok("提示词含全部 hex", colors.every((c) => prompt.includes(c.hex)));
  ok("提示词含中英双语约束", prompt.includes("限定色域") && prompt.includes("Limited"));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "selftest-strip.png"), buffer);
  fs.writeFileSync(path.join(outDir, "selftest-strip.svg"), svg, "utf8");
}

/* ---------------- 6. 边界 ---------------- */
function testEdge() {
  console.log("\n[6] 边界条件");
  const flat = makeTestScene(["#808080"], 200, 200, 1);
  const r = extractPooled([flat], { kmax: 12, kmin: 1, minCoverage: 0.01 });
  ok("纯色图只出 1 色", r.colors.length === 1, `实际 ${r.colors.length}`);

  const bw = makeTestScene(["#000000", "#FFFFFF"], 200, 200, 2);
  const r2 = extractPooled([bw], { kmax: 12, kmin: 1, minCoverage: 0.01 });
  ok("默认剔除近纯黑纯白", r2.colors.length <= 2);
  const r3 = extractPooled([bw], { kmax: 12, kmin: 1, minCoverage: 0.01, keepExtremes: true });
  ok("--keep-extremes 能保留黑白", r3.colors.length === 2, `实际 ${r3.colors.length}`);

  const few = makeTestScene(["#D4884A", "#6E4A28", "#E8E8DC"], 200, 200, 4);
  const r4 = extractPooled([few], { kmax: 12, kmin: 6, minCoverage: 0.01, minSep: 7 });
  ok("kmin 达不到时会放宽间距而不是造色", r4.colors.length === 3, `实际 ${r4.colors.length}`);
}

export function run(toolRoot) {
  console.log("色板工坊 · 自测\n" + "=".repeat(50));
  const outDir = path.join(toolRoot, "out", "_selftest");
  try {
    testColor();
    testPng();
    testExtract(outDir);
    testAnchorAndVerify();
    testRender(outDir);
    testEdge();
  } catch (e) {
    fail++;
    fails.push("未捕获异常: " + e.message);
    console.error("\n✗ 抛异常:", e.message);
    if (process.env.DEBUG) console.error(e.stack);
  }
  console.log("\n" + "=".repeat(50));
  console.log(`通过 ${pass}  失败 ${fail}`);
  if (fail) {
    console.log("\n失败项：");
    fails.forEach((f) => console.log("  - " + f));
    process.exitCode = 1;
  } else {
    console.log("全部通过 ✓  样例见 " + outDir);
  }
}
