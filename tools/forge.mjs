#!/usr/bin/env node
// 色板工坊 CLI
//
//   node tools/forge.mjs extract ./refs/            # 一组图 → 一块色板（默认池化）
//   node tools/forge.mjs extract a.png              # 单图 → 色板
//   node tools/forge.mjs extract ./refs/ --mode voted
//   node tools/forge.mjs extract ./scene/ --anchor data/catalog.json --palette master
//   node tools/forge.mjs anchor ./scene/ --master master.json
//   node tools/forge.mjs verify ./shot.mp4 --master master.json
//   node tools/forge.mjs selftest

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractPooled, extractVoted, anchorScene, verifyAgainstPalette, collectSamples, toneStats, paletteHealth } from "./engine.mjs";
import { loadInputs } from "./decode.mjs";
import { renderStripPNG, renderStripSVG, renderContactHTML, renderCubeLUT, renderPrompt, summarize } from "./render.mjs";
import { hexToLab } from "./color.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");

const BOOL_FLAGS = new Set(["keep-extremes", "strict", "json", "reverse", "no-structure", "stamp", "quiet", "drop-extremes", "no-coverage-label"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        const v = argv[i + 1];
        if (v === undefined || (v.startsWith("--") && !/^--?\d/.test(v))) {
          flags[key] = true;
        } else {
          flags[key] = v;
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function num(v, dflt) {
  if (v === undefined || v === true) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function readPaletteFile(file, paletteKey) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  let colors = null;
  let title = null;
  if (Array.isArray(raw)) {
    colors = raw;
  } else if (Array.isArray(raw.colors)) {
    colors = raw.colors;
    title = raw.title || raw.name;
  } else if (raw.palettes) {
    const key = paletteKey || Object.keys(raw.palettes)[0];
    const p = raw.palettes[key];
    if (!p) throw new Error(`色板目录里没有 "${key}"，可选：${Object.keys(raw.palettes).join(", ")}`);
    colors = p.colors;
    title = p.note || key;
  }
  if (!colors?.length) throw new Error(`从 ${file} 里没读到色值数组`);
  const hexes = colors.map((c) => {
    if (typeof c === "string") return c.toUpperCase();
    if (c && typeof c.hex === "string") return c.hex.toUpperCase();
    if (c && typeof c.value === "string") return c.value.toUpperCase();
    return String(c);
  });
  return { colors: hexes, title: title || path.basename(file, ".json") };
}

function buildOptions(flags, images) {
  const roiStr = flags.roi;
  let roi = null;
  if (typeof roiStr === "string") {
    const p = roiStr.split(",").map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) roi = p;
  }
  return {
    roi,
    k: num(flags.k, 24),
    kmax: num(flags.kmax ?? flags.colors, 12),
    kmin: num(flags.kmin, 6),
    minCoverage: num(flags["min-coverage"], 1.2) / 100,
    minSep: num(flags["min-sep"], 7),
    mergeDE: num(flags["merge-de"], 3),
    keepExtremes: !!flags["keep-extremes"],
    strict: !!flags.strict,
    dropExtremes: !!flags["drop-extremes"],
    order: (flags.order || "value") + "",
    mode: (flags.mode || "pooled") + "",
    voteRatio: num(flags["vote-ratio"], 40) / 100,
    perKmax: num(flags["per-kmax"], 8),
    perImageMinCoverage: num(flags["per-image-min-coverage"], 2) / 100,
    totalBudget: num(flags.budget, 120000),
    toolRoot: TOOL_ROOT,
    maxWidth: num(flags.width, 512),
    fps: num(flags.fps, 1),
    maxFrames: num(flags.frames, 24),
    offBoardDE: num(flags["off-board-de"], 15),
  };
}

function outDirFor(flags, fallbackName) {
  const name = (flags.name || fallbackName) + "";
  const base = flags.out ? path.resolve(flags.out) : path.join(TOOL_ROOT, "out");
  const dir = flags.out && !flags.name ? base : path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeOutputs(result, flags, defName, extras = {}) {
  const dir = outDirFor(flags, defName);
  const name = flags.name || defName;
  const formats = String(flags.formats || "png,svg,html,json,prompt").split(",").map((s) => s.trim());
  const written = [];

  const stripOpts = {
    title: name,
    showCoverage: !flags["no-coverage-label"],
    showLabel: !!flags["show-label"],
  };

  if (formats.includes("png") && result.colors?.length) {
    const { buffer } = renderStripPNG(result.colors, stripOpts);
    const f = path.join(dir, "palette.png");
    fs.writeFileSync(f, buffer);
    written.push(f);
  }
  if (formats.includes("svg") && result.colors?.length) {
    const f = path.join(dir, "palette.svg");
    fs.writeFileSync(f, renderStripSVG(result.colors, stripOpts), "utf8");
    written.push(f);
  }
  if (formats.includes("html")) {
    const f = path.join(dir, "palette.html");
    fs.writeFileSync(f, renderContactHTML(result, { name }), "utf8");
    written.push(f);
  }
  if (formats.includes("json")) {
    const f = path.join(dir, "palette.json");
    fs.writeFileSync(f, JSON.stringify({ name, generatedAt: new Date().toISOString(), ...extras, ...result }, null, 2), "utf8");
    written.push(f);
  }
  if (formats.includes("prompt") && result.colors?.length) {
    const f = path.join(dir, "prompt.txt");
    fs.writeFileSync(f, renderPrompt(result, { name }), "utf8");
    written.push(f);
  }
  if (formats.includes("cube") && result.colors?.length) {
    const lut = renderCubeLUT(result.colors, {
      strength: num(flags["lut-strength"], 0.8),
      tolerance: num(flags["lut-tolerance"], 14),
      size: num(flags["lut-size"], 33),
      title: name,
    });
    const f = path.join(dir, `${name}.cube`);
    fs.writeFileSync(f, lut, "utf8");
    written.push(f);
  }
  if (formats.includes("hex")) {
    const f = path.join(dir, "palette.hex.txt");
    fs.writeFileSync(f, result.colors.map((c) => c.hex).join(" "), "utf8");
    written.push(f);
  }
  return { dir, written };
}

/* ===================== 子命令 ===================== */

function cmdExtract(positional, flags) {
  if (!positional.length) throw new Error("请给出输入图片/文件夹/视频路径");
  const opts = buildOptions(flags);
  const { images, report } = loadInputs(positional, opts);
  const failed = report.filter((r) => !r.ok);
  if (!images.length) {
    throw new Error("没有读到任何可用图片：\n" + failed.map((f) => `  ${f.path}: ${f.error}`).join("\n"));
  }
  if (failed.length && !flags.quiet) {
    console.error(`跳过 ${failed.length} 个读不了的文件：`);
    failed.forEach((f) => console.error(`  ${f.path}: ${f.error}`));
  }

  let result;
  const mode = opts.mode;
  if (mode === "voted" || mode === "vote") {
    result = extractVoted(images, opts);
  } else if (flags.anchor || flags.master) {
    const { colors: master, title } = readPaletteFile(flags.anchor || flags.master, flags.palette);
    result = anchorScene(images, master, opts);
    result.masterTitle = title;
    const scene = extractPooled(images, opts);
    result.scenePalette = scene.colors;
  } else {
    result = extractPooled(images, { ...opts, mode: mode === "single" ? "single" : "pooled" });
  }

  result.sourceFiles = images.map((i) => i.path);
  const defName = flags.name ? String(flags.name) : `${mode || "pooled"}-${Date.now().toString(36).slice(-4)}`;

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(summarize(result, opts));
  const { dir, written } = writeOutputs(result, flags, defName, { mode: result.mode, masterTitle: result.masterTitle });
  console.log("");
  console.log("输出目录:", dir);
  written.forEach((w) => console.log("  +", path.basename(w)));
  if (result.mode === "anchor" && result.scenePalette) {
    console.log("");
    console.log("这场戏自己的提取结果：");
    result.scenePalette.forEach((c) => console.log(`  ${c.hex}  ${c.coverage.toFixed(1)}%  ${c.label}`));
  }
}

function cmdAnalyze(positional, flags) {
  if (!positional.length) throw new Error("请给出输入路径");
  const opts = buildOptions(flags);
  const { images } = loadInputs(positional, opts);
  if (!images.length) throw new Error("没有读到任何图片");
  const samples = collectSamples(images, opts);
  const tone = toneStats(samples);
  const result = extractPooled(images, { ...opts, minCoverage: 0, kmax: num(flags.kmax, 18), minSep: num(flags["min-sep"], 4) });
  if (flags.json) return console.log(JSON.stringify({ tone, palette: result.colors }, null, 2));
  console.log(summarize({ ...result, tone }, opts));
  const { dir, written } = writeOutputs(result, flags, flags.name || "analyze", { tone });
  console.log("\n输出目录:", dir);
  written.forEach((w) => console.log("  +", path.basename(w)));
}

function cmdAnchor(positional, flags) {
  if (!positional.length) throw new Error("请给出输入路径");
  if (!flags.master && !flags.anchor) throw new Error("anchor 模式需要 --master <色板文件>");
  const opts = buildOptions(flags);
  const { colors: master, title } = readPaletteFile(flags.master || flags.anchor, flags.palette);
  const { images } = loadInputs(positional, opts);
  if (!images.length) throw new Error("没有读到任何图片");
  const result = anchorScene(images, master, opts);
  result.masterTitle = title;
  result.scenePalette = extractPooled(images, opts).colors;
  result.sourceFiles = images.map((i) => i.path);
  if (flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(summarize(result, opts));
  const { dir, written } = writeOutputs(result, flags, flags.name || "anchor");
  console.log("\n这场戏自己的候选色板：");
  result.scenePalette.forEach((c) => console.log(`  ${c.hex}  ${c.coverage.toFixed(1)}%  ${c.label}`));
  console.log("\n输出目录:", dir);
  written.forEach((w) => console.log("  +", path.basename(w)));
}

function cmdVerify(positional, flags) {
  if (!positional.length) throw new Error("请给出待校验的镜头/图片路径");
  if (!flags.master && !flags.anchor) throw new Error("verify 需要 --master <色板文件>");
  const opts = buildOptions(flags);
  const { colors: master, title } = readPaletteFile(flags.master || flags.anchor, flags.palette);
  const { images } = loadInputs(positional, opts);
  if (!images.length) throw new Error("没有读到任何图片");
  const result = verifyAgainstPalette(images, master, opts);
  result.masterTitle = title;
  if (flags.json) return console.log(JSON.stringify(result, null, 2));
  console.log(`对齐 ${title}（${master.length} 色）`);
  console.log(`吻合度得分: ${result.score}/100 — ${result.verdict}`);
  const d = result.distribution;
  console.log(`像素分布: 在板上(ΔE00≤${d.nearDE}) ${d.inPalette}%  /  过渡带 ${d.transitional}%  /  离板(>${d.offDE}) ${d.offPalette}%`);
  console.log(`平均偏离 ΔE00: ${result.meanDE}`);
  console.log("");
  console.log("  色值      本镜头占比   该色在板占比   平均ΔE00");
  result.perMaster.forEach((m) =>
    console.log(`  ${m.hex}   ${String(m.coverage.toFixed(1) + "%").padStart(7)}      ${String(m.inPalette.toFixed(0) + "%").padStart(7)}      ${String(m.meanDE).padStart(5)}`)
  );
  console.log("");
  console.log(`影调: ${result.tone.keyName}`);
  console.log(`      暗部 ${(result.tone.zones.shadow * 100).toFixed(0)}% / 中间调 ${(result.tone.zones.midtone * 100).toFixed(0)}% / 亮部 ${(result.tone.zones.highlight * 100).toFixed(0)}%`);
  if (flags.json === false && flags.out) {
    const dir = outDirFor(flags, flags.name || "verify");
    fs.writeFileSync(path.join(dir, "verify.json"), JSON.stringify(result, null, 2), "utf8");
    console.log("\n输出:", dir);
  }
}

function cmdCheck(positional, flags) {
  let hexes = [];
  let title = "";
  if (positional.length) {
    const { colors, title: t } = readPaletteFile(positional[0], flags.palette);
    hexes = colors;
    title = t;
  } else if (typeof flags.hex === "string") {
    hexes = flags.hex.split(/[\s,]+/).filter(Boolean).map((s) => (s.startsWith("#") ? s : "#" + s).toUpperCase());
    title = "命令行传入";
  }
  if (!hexes.length) throw new Error("请给出色板文件，或用 --hex \"#112233 #445566 ...\"");
  const r = paletteHealth(hexes, { redundantDE: num(flags["redundant-de"], 5), gapL: num(flags["gap-l"], 25) });
  if (flags.json) return console.log(JSON.stringify(r, null, 2));

  console.log(`色板体检: ${title || positional[0] || ""}  共 ${r.count} 色`);
  console.log(`评分 ${r.score}/100 — ${r.verdict}`);
  console.log("");
  console.log("  序号  色值       L*    C*    h°    描述");
  r.colors.forEach((c) => console.log(
    `  ${String(c.index).padStart(3)}   ${c.hex}  ${String(c.lch.L.toFixed(0)).padStart(4)}  ${String(c.lch.C.toFixed(0)).padStart(4)}  ${String(c.lch.h.toFixed(0)).padStart(4)}   ${c.label}`
  ));
  console.log("");
  if (r.issues.length) {
    console.log("需要处理：");
    r.issues.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  } else {
    console.log("没有发现结构性问题。");
  }
  if (r.oks.length) {
    console.log("");
    console.log("没问题：");
    r.oks.forEach((s) => console.log("  · " + s));
  }
  console.log("");
  console.log(`锚点完备度：${Object.entries(r.anchors).filter(([, v]) => v.ok).length}/5  ` +
    Object.entries(r.anchors).map(([k, v]) => `${k}${v.ok ? "✓" : "✗"}`).join(" "));
}

const HELP = `色板工坊 (palette-forge) v1.0

用法:
  node tools/forge.mjs extract <图片|文件夹|视频...> [选项]    一组图/单图 → 色板
  node tools/forge.mjs analyze <输入...>                       只出影调分析 + 全量候选色
  node tools/forge.mjs anchor  <输入...> --master <色板>       与剧集主色板对账
  node tools/forge.mjs verify  <输入...> --master <色板>       校验成片/镜头是否跑板
  node tools/forge.mjs check   <色板文件>                      色板体检（判断能不能拿来当约束）
  node tools/forge.mjs check   --hex "#112233 #445566 ..."     直接体检一串 hex
  node tools/forge.mjs demo                                    端到端演示
  node tools/forge.mjs selftest                                离线自测

提取选项:
  --mode pooled|voted|single   池化(默认) / 跨图投票 / 单图
  --k <n>                      过分割簇数（默认 24，仅影响精度不影响最终色数）
  --kmax <n>                   最终最多几色（默认 12）
  --kmin <n>                   至少几色（不足会自动放宽间距，默认 6）
  --min-coverage <百分比>      覆盖率低于此值判为噪点丢弃（默认 1.2）
  --min-sep <ΔE00>             色板内部最小感知间距（默认 7）
  --merge-de <ΔE00>            低于此值直接并成同色（默认 3）
  --order value|hue|coverage   排序：明度阶梯(默认) / 色相 / 占比
  --keep-extremes              保留近纯黑纯白
  --drop-extremes              采样阶段就剔掉近纯黑纯白
  --strict                     结构分数 < 0.35 的（疑似噪点）直接丢
  --roi x,y,w,h                只用画面某个区域采样（0~1 比例，躲开人脸/字幕/天空）
  --width <px>                 解码宽度（默认 512）
  --fps <n> --frames <n>       视频抽帧频率与上限
  --vote-ratio <百分比>        voted 模式：至少出现在几张图的百分比里（默认 40）
  --name <名字>                输出子目录名

输出选项:
  --out <目录>                 输出根目录（默认 palette-forge/out）
  --formats png,svg,html,json,prompt,cube,hex
  --lut-strength <0~1>         生成 .cube 时的强度（默认 0.8，跑偏严重可上 1.0）
  --lut-tolerance <ΔE>         LUT 吸附容差（默认 14，越大拉得越狠但越平）
  --lut-size <33>              3D LUT 网格边长
  --json                       只打印 JSON
  --show-label                 色板条上额外打印中文描述
`;

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "extract";
  const { positional, flags } = parseArgs(argv[0] && !argv[0].startsWith("--") ? argv.slice(1) : argv);
  if (flags.help || cmd === "help" || cmd === "-h") return console.log(HELP);

  try {
    if (cmd === "selftest") {
      return import("./selftest.mjs").then((m) => m.run(TOOL_ROOT));
    }
    if (cmd === "extract") return cmdExtract(positional, flags);
    if (cmd === "analyze") return cmdAnalyze(positional, flags);
    if (cmd === "anchor") return cmdAnchor(positional, flags);
    if (cmd === "verify") return cmdVerify(positional, flags);
    if (cmd === "check" || cmd === "health") return cmdCheck(positional, flags);
    if (cmd === "demo") return import("./demo.mjs").then((m) => m.run());
    console.error(`未知子命令: ${cmd}\n`);
    console.log(HELP);
    process.exitCode = 2;
  } catch (e) {
    console.error("✗ " + e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  }
}

main();
