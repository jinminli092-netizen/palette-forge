// 图像/视频 → 像素。PNG 直接纯 JS 解，其余格式统一交给 ffmpeg 落盘成 PNG 再解。
// 注意：本环境沙箱禁止子进程管道(stdout 捕获会 EPERM)，所以 ffmpeg 一律写文件、不读 stdout。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { decodePNG } from "./png.mjs";

const FFMPEG = process.env.PALETTE_FFMPEG || "ffmpeg";

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".gif", ".mxf", ".flv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic"]);

export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  return "unknown";
}

function runFfmpeg(args, label) {
  const r = spawnSync(FFMPEG, args, { stdio: "ignore", windowsHide: true });
  if (r.error) throw new Error(`调用 ffmpeg 失败（${label}）：${r.error.message}\n请确认 ffmpeg 在 PATH 里，或设置 PALETTE_FFMPEG`);
  if (r.status !== 0) throw new Error(`ffmpeg 退出码 ${r.status}（${label}）`);
}

/** 在项目内建临时目录，避免沙箱对系统临时目录的限制 */
export function makeTempDir(toolRoot) {
  const base = path.join(toolRoot, ".tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "run-"));
}

/** 面积平均下采样（box filter），比最近邻更接近人眼对"整体色调"的感知 */
export function downscale(img, maxWidth) {
  if (img.width <= maxWidth) return img;
  const scale = img.width / maxWidth;
  const dw = Math.max(1, Math.round(maxWidth));
  const dh = Math.max(1, Math.round(img.height / scale));
  const out = Buffer.alloc(dw * dh * 4);
  const sx = img.width / dw;
  const sy = img.height / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        let i = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1 && xx < img.width; xx++, i += 4) {
          r += img.rgba[i]; g += img.rgba[i + 1]; b += img.rgba[i + 2]; a += img.rgba[i + 3]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: dw, height: dh, rgba: out };
}

/** 读单张图片 */
export function loadImage(file, opts = {}) {
  const maxWidth = opts.maxWidth || 512;
  const ext = path.extname(file).toLowerCase();
  let img;
  if (ext === ".png") {
    try {
      img = decodePNG(fs.readFileSync(file));
    } catch (e) {
      img = ffmpegToPng(file, opts);
      if (!img) throw new Error(`PNG 解码失败且 ffmpeg 也没救回来：${file}\n${e.message}`);
    }
  } else {
    img = ffmpegToPng(file, opts);
  }
  img = downscale(img, maxWidth);
  return { ...img, path: file, kind: "image" };
}

function ffmpegToPng(file, opts = {}) {
  const tmp = makeTempDir(opts.toolRoot || process.cwd());
  const out = path.join(tmp, "frame.png");
  runFfmpeg(["-y", "-v", "error", "-i", file, "-frames:v", "1", "-vf", "scale=512:-2:flags=area", out], file);
  if (!fs.existsSync(out)) return null;
  const img = decodePNG(fs.readFileSync(out));
  fs.rmSync(tmp, { recursive: true, force: true });
  return img;
}

/**
 * 视频抽帧。返回均匀分布的若干帧。
 * fps 默认按"总时长里抽 maxFrames 帧"由 ffmpeg 的 fps 滤镜近似控制。
 */
export function loadVideoFrames(file, opts = {}) {
  const fps = opts.fps || 1;
  const maxFrames = opts.maxFrames || 24;
  const maxWidth = opts.maxWidth || 512;
  const tmp = makeTempDir(opts.toolRoot || process.cwd());
  const pattern = path.join(tmp, "f%04d.png");
  runFfmpeg(
    ["-y", "-v", "error", "-i", file, "-vf", `fps=${fps},scale=512:-2:flags=area`, "-frames:v", String(maxFrames), pattern],
    file
  );
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".png")).sort();
  const frames = files.map((f, i) => {
    const img = downscale(decodePNG(fs.readFileSync(path.join(tmp, f))), maxWidth);
    return { ...img, path: `${file}#frame${i + 1}`, kind: "frame" };
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!frames.length) throw new Error(`没能从视频里抽到帧：${file}`);
  return frames;
}

/** 批量加载：把文件/目录都摊平成图片帧集合 */
export function loadInputs(inputs, opts = {}) {
  const images = [];
  const report = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f));
      return;
    }
    const k = kindOf(p);
    if (k === "image") {
      try {
        images.push(loadImage(p, opts));
        report.push({ path: p, ok: true });
      } catch (e) {
        report.push({ path: p, ok: false, error: e.message });
      }
    } else if (k === "video") {
      try {
        const frames = loadVideoFrames(p, opts);
        images.push(...frames);
        report.push({ path: p, ok: true, frames: frames.length });
      } catch (e) {
        report.push({ path: p, ok: false, error: e.message });
      }
    }
  };
  for (const p of inputs) {
    if (!fs.existsSync(p)) {
      report.push({ path: p, ok: false, error: "文件不存在" });
      continue;
    }
    walk(p);
  }
  return { images, report };
}
