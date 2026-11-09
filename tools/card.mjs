// 一次性出图脚本：把色板目录里的一块板渲成横条色卡
// 用法: node tools/card.mjs [--palette master] [--coverage]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderStripPNG } from "./render.mjs";
import { hexToLab, describeLab } from "./color.mjs";

// This file lives in tools/, so the project root is one level up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "catalog.json"), "utf8"));

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const key = get("palette", "master");
const withCov = args.includes("--coverage");
const p = catalog.palettes[key];
if (!p) { console.error("没有这个色板:", key, "可选:", Object.keys(catalog.palettes).join(", ")); process.exit(1); }

const colors = p.colors.map((hex) => {
  const lab = hexToLab(hex);
  const d = describeLab(lab[0], lab[1], lab[2]);
  return { hex, lch: { L: d.L, C: d.C, h: d.h }, coverage: withCov ? 0 : null, label: d.label };
});

const { buffer } = renderStripPNG(colors, {
  showCoverage: withCov,
  swatchH: 200,
  gap: 12,
  pad: 24,
});

const out = path.join(ROOT, "out", `${key}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buffer);
console.log(out);
console.log(colors.map((c) => c.hex).join(" "));
