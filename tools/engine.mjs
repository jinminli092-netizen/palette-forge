// 提取引擎：Lab 聚类 → ΔE00 去重 → 留舍判据 → 结构分数 → 明度阶梯
//
// 设计要点：
// 1) 所有聚类/去重都在 CIELAB 里做，最终判"两个色是不是一个色"用 CIEDE2000。
// 2) k-means 跑在 Lab 三维直方图的 bin 上而不是原始像素上 —— 快两个数量级，且完全确定（无随机种子）。
// 3) "哪些色该留"不是靠 K 值硬切，而是靠四条可解释的判据（见 decide 注释）。

import { rgbToLab, labToLch, ciede2000, labToHex, hexToLab, describeLab, toneZone, ZONE_CN } from "./color.mjs";

/* ===================== 采样 ===================== */

/**
 * 从一组图里等权采样像素并转 Lab。
 * 每张图采样量相同 => 每张图在色板里的话语权相同（避免一张大图垄断）。
 */
export function collectSamples(images, opts = {}) {
  if (!images.length) throw new Error("输入图为 0 张（全部读取失败或被过滤了）");
  const totalBudget = opts.totalBudget || 120000;
  const perImage = Math.max(2000, Math.min(opts.perImageSamples || 10000, Math.floor(totalBudget / Math.max(1, images.length))));
  const dropExtremes = !!opts.dropExtremes;
  const alphaMin = opts.alphaMin ?? 24;
  const roi = opts.roi || null;

  const Ls = [], As = [], Bs = [];
  let skipped = 0;

  for (const img of images) {
    const x0 = Math.floor((roi ? roi[0] : 0) * img.width);
    const y0 = Math.floor((roi ? roi[1] : 0) * img.height);
    const x1 = Math.max(x0 + 1, Math.floor(((roi ? roi[0] + roi[2] : 1)) * img.width));
    const y1 = Math.max(y0 + 1, Math.floor(((roi ? roi[1] + roi[3] : 1)) * img.height));
    const roiPixels = (x1 - x0) * (y1 - y0);
    const step = Math.max(1, Math.round(Math.sqrt(roiPixels / perImage)));
    for (let y = y0; y < y1; y += step) {
      let i = (y * img.width + x0) * 4;
      for (let x = x0; x < x1; x += step, i += step * 4) {
        if (img.rgba[i + 3] < alphaMin) { skipped++; continue; }
        const lab = rgbToLab(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]);
        if (dropExtremes) {
          const C = Math.hypot(lab[1], lab[2]);
          if ((lab[0] > 97 || lab[0] < 3) && C < 4) { skipped++; continue; }
        }
        Ls.push(lab[0]); As.push(lab[1]); Bs.push(lab[2]);
      }
    }
  }
  return {
    L: Float32Array.from(Ls),
    a: Float32Array.from(As),
    b: Float32Array.from(Bs),
    count: Ls.length,
    skipped,
    perImageSamples: perImage,
  };
}

/* ===================== Lab 直方图 + k-means ===================== */

const BINS = { L: 20, A: 24, B: 24 }; // L 每格 5，a/b 每格 8

function buildHistogram(samples) {
  const { L, a, b } = samples;
  const n = L.length;
  const size = BINS.L * BINS.A * BINS.B;
  const w = new Float64Array(size);
  const sL = new Float64Array(size);
  const sA = new Float64Array(size);
  const sB = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    const li = Math.min(BINS.L - 1, Math.max(0, Math.floor(L[i] / 5)));
    const ai = Math.min(BINS.A - 1, Math.max(0, Math.floor((a[i] + 96) / 8)));
    const bi = Math.min(BINS.B - 1, Math.max(0, Math.floor((b[i] + 96) / 8)));
    const k = (li * BINS.A + ai) * BINS.B + bi;
    w[k] += 1; sL[k] += L[i]; sA[k] += a[i]; sB[k] += b[i];
  }
  const pts = [];
  for (let k = 0; k < size; k++) {
    if (w[k] === 0) continue;
    pts.push({ w: w[k], L: sL[k] / w[k], a: sA[k] / w[k], b: sB[k] / w[k] });
  }
  pts.sort((p, q) => q.w - p.w);
  return { pts, total: n };
}

/** 确定性 k-means：用"高权重 bin 间隔取点"做初始中心，避免随机数导致结果不可复现 */
function kmeansOnHistogram(pts, k, iters = 30, minSeedSep = 9) {
  const cent = [];
  for (const p of pts) {
    if (cent.length >= k) break;
    let ok = true;
    for (const c of cent) {
      const d = Math.hypot(p.L - c[0], p.a - c[1], p.b - c[2]);
      if (d < minSeedSep) { ok = false; break; }
    }
    if (ok) cent.push([p.L, p.a, p.b]);
  }
  if (!cent.length) return [];
  while (cent.length < k) {
    const p = pts[cent.length % pts.length];
    cent.push([p.L, p.a, p.b]);
  }

  const K = cent.length;
  const assign = new Int32Array(pts.length);
  let shift = Infinity;
  for (let it = 0; it < iters && shift > 0.02; it++) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        const dl = p.L - cent[c][0], da = p.a - cent[c][1], db = p.b - cent[c][2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best;
    }
    const sw = new Float64Array(K), sl = new Float64Array(K), sa = new Float64Array(K), sb = new Float64Array(K);
    for (let i = 0; i < pts.length; i++) {
      const c = assign[i], p = pts[i];
      sw[c] += p.w; sl[c] += p.L * p.w; sa[c] += p.a * p.w; sb[c] += p.b * p.w;
    }
    shift = 0;
    for (let c = 0; c < K; c++) {
      if (sw[c] === 0) continue;
      const nL = sl[c] / sw[c], nA = sa[c] / sw[c], nB = sb[c] / sw[c];
      shift = Math.max(shift, Math.hypot(nL - cent[c][0], nA - cent[c][1], nB - cent[c][2]));
      cent[c] = [nL, nA, nB];
    }
  }

  const sw = new Float64Array(K);
  for (let i = 0; i < pts.length; i++) sw[assign[i]] += pts[i].w;

  const clusters = [];
  for (let c = 0; c < K; c++) {
    if (sw[c] <= 0) continue;
    clusters.push({ L: cent[c][0], a: cent[c][1], b: cent[c][2], w: sw[c] });
  }
  return clusters;
}

/* ===================== 合并 / 留舍 ===================== */

function mergeByDE(clusters, mergeDE) {
  let list = clusters.slice();
  for (;;) {
    let bestI = -1, bestJ = -1, bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = ciede2000([list[i].L, list[i].a, list[i].b], [list[j].L, list[j].a, list[j].b]);
        if (d < bestD) { bestD = d; bestI = i; bestJ = j; }
      }
    }
    if (bestI < 0 || bestD >= mergeDE) break;
    const A = list[bestI], B = list[bestJ];
    const w = A.w + B.w;
    const merged = {
      L: (A.L * A.w + B.L * B.w) / w,
      a: (A.a * A.w + B.a * B.w) / w,
      b: (A.b * A.w + B.b * B.w) / w,
      w,
    };
    list = list.filter((_, i) => i !== bestI && i !== bestJ);
    list.push(merged);
  }
  return list;
}

/**
 * 留舍判据（可解释，四条）：
 *   R1 覆盖面积  —— coverage < --min-coverage 的丢掉：那是边缘/JPEG 噪点/偶发高光，不是美术决定。
 *   R2 感知唯一性 —— 与已入选色的 ΔE00 < --min-sep 的丢掉：同一块颜色的重复采样，留着只会稀释提示词权重。
 *   R3 极值截断  —— 近纯黑(L*<4)/纯白(L*>97) 且近中性(C*<4) 的，默认归为"曝光/压缩产物"，除非 --keep-extremes。
 *   R4 结构分数  —— 空间上是否成大色块（连通域大、邻接同色率高）。低分说明它沿边缘高频分布，
 *                   是渲染/压缩伪影而不是实体色 → 标记 warn，由用户决定去留；--strict 直接丢。
 */
function decide(clusters, total, opts) {
  const minCoverage = opts.minCoverage ?? 0.012;
  const minSep = opts.minSep ?? 7;
  const kmax = opts.kmax ?? 12;
  const kmin = opts.kmin ?? 6;
  const mergeDE = opts.mergeDE ?? 3;
  const keepExtremes = !!opts.keepExtremes;
  const strict = !!opts.strict;

  const merged = mergeByDE(clusters, mergeDE)
    .map((c) => ({ ...c, coverage: c.w / total }))
    .sort((p, q) => q.coverage - p.coverage);

  const accepted = [];
  const dropped = [];

  const trySelect = (sep) => {
    accepted.length = 0; dropped.length = 0;
    for (const c of merged) {
      const lab = [c.L, c.a, c.b];
      const { C } = labToLch(c.L, c.a, c.b);
      if (!keepExtremes && C < 4 && (c.L < 4 || c.L > 97)) {
        dropped.push({ ...c, reason: "近纯黑/纯白，判为曝光或压缩产物", code: "R3" });
        continue;
      }
      if (c.coverage < minCoverage) {
        dropped.push({ ...c, reason: `覆盖 ${(c.coverage * 100).toFixed(2)}% < 阈值 ${(minCoverage * 100).toFixed(2)}%，判为噪点/偶发高光`, code: "R1" });
        continue;
      }
      if (accepted.length >= kmax) {
        dropped.push({ ...c, reason: `已达色数上限 ${kmax}`, code: "R5" });
        continue;
      }
      let nearest = null, nearestDE = Infinity;
      for (const a of accepted) {
        const d = ciede2000(lab, [a.L, a.a, a.b]);
        if (d < nearestDE) { nearestDE = d; nearest = a; }
      }
      if (nearest && nearestDE < sep) {
        dropped.push({ ...c, reason: `与 ${nearest.hex} 的 ΔE00=${nearestDE.toFixed(1)} < ${sep}，判为同色重复`, code: "R2", nearestHex: nearest.hex, nearestDE });
        continue;
      }
      accepted.push({ ...c, hex: labToHex(c.L, c.a, c.b), nearestDE: nearest ? nearestDE : null });
    }
  };

  let sep = minSep;
  trySelect(sep);
  let relax = 0;
  while (accepted.length < kmin && relax < 8) {
    sep = Math.max(2, sep * 0.85);
    relax++;
    trySelect(sep);
  }

  // 把最终的最小间距回填（用于报告：这条色板内部的最小感知间距）
  for (const a of accepted) {
    let nd = Infinity, nh = null;
    for (const b of accepted) {
      if (a === b) continue;
      const d = ciede2000([a.L, a.a, a.b], [b.L, b.a, b.b]);
      if (d < nd) { nd = d; nh = b.hex; }
    }
    a.nearestHex = nh;
    a.nearestDE = Number.isFinite(nd) ? nd : null;
  }

  return { accepted, dropped, effectiveMinSep: sep };
}

/* ===================== 结构分数 ===================== */

/**
 * 对每个入选色，判断它在画面里是"实体大色块"还是"沿边缘的高频噪声"。
 * 做法：把图降成 96 列的网格，每格标到最近的色板色，
 * 然后看 邻接同色率 + 最大连通域占比。色块→接近 1；噪点→接近 0。
 */
export function structureScores(images, colorsIn) {
  // 同时接受内部原始色 {L,a,b} 和对外导出的 {lab:[L,a,b]}，避免调用方踩坑
  const colors = colorsIn.map((c) => (c && Array.isArray(c.lab) ? { L: c.lab[0], a: c.lab[1], b: c.lab[2] } : c));
  const gw = 96;
  const agg = colors.map(() => ({ cells: 0, adjSum: 0, adjN: 0, blobSum: 0, imgN: 0 }));

  for (const img of images) {
    const gh = Math.max(1, Math.round((gw * img.height) / img.width));
    const cw = img.width / gw, ch = img.height / gh;
    const labels = new Int16Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const x0 = Math.floor(gx * cw), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cw));
        const y0 = Math.floor(gy * ch), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * ch));
        const s = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 3));
        let L = 0, A = 0, B = 0, n = 0;
        for (let y = y0; y < y1; y += s) {
          let i = (y * img.width + x0) * 4;
          for (let x = x0; x < x1; x += s, i += s * 4) {
            const lab = rgbToLab(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]);
            L += lab[0]; A += lab[1]; B += lab[2]; n++;
          }
        }
        L /= n; A /= n; B /= n;
        let best = 0, bd = Infinity;
        for (let c = 0; c < colors.length; c++) {
          const dl = L - colors[c].L, da = A - colors[c].a, db = B - colors[c].b;
          const d = dl * dl + da * da + db * db;
          if (d < bd) { bd = d; best = c; }
        }
        labels[gy * gw + gx] = best;
      }
    }

    for (let c = 0; c < colors.length; c++) {
      let cells = 0, same = 0, adj = 0;
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          if (labels[gy * gw + gx] !== c) continue;
          cells++;
          if (gx + 1 < gw) { adj++; if (labels[gy * gw + gx + 1] === c) same++; }
          if (gy + 1 < gh) { adj++; if (labels[(gy + 1) * gw + gx] === c) same++; }
        }
      }
      if (cells === 0) continue;
      // 最大连通域（4 邻接）
      const seen = new Uint8Array(gw * gh);
      let largest = 0;
      const stack = [];
      for (let start = 0; start < labels.length; start++) {
        if (labels[start] !== c || seen[start]) continue;
        let size = 0;
        stack.length = 0; stack.push(start); seen[start] = 1;
        while (stack.length) {
          const p = stack.pop(); size++;
          const px = p % gw, py = (p / gw) | 0;
          if (px > 0 && !seen[p - 1] && labels[p - 1] === c) { seen[p - 1] = 1; stack.push(p - 1); }
          if (px + 1 < gw && !seen[p + 1] && labels[p + 1] === c) { seen[p + 1] = 1; stack.push(p + 1); }
          if (py > 0 && !seen[p - gw] && labels[p - gw] === c) { seen[p - gw] = 1; stack.push(p - gw); }
          if (py + 1 < gh && !seen[p + gw] && labels[p + gw] === c) { seen[p + gw] = 1; stack.push(p + gw); }
        }
        if (size > largest) largest = size;
      }
      const a = agg[c];
      a.cells += cells;
      a.adjSum += adj ? same / adj : 0;
      a.adjN += 1;
      a.blobSum += largest / cells;
      a.imgN += 1;
    }
  }

  return agg.map((a) => {
    if (!a.adjN) return { structure: null, adjacency: null, blob: null };
    const adjacency = a.adjSum / a.adjN;
    const blob = a.blobSum / a.imgN;
    return {
      structure: Math.max(0, Math.min(1, 0.55 * adjacency + 0.45 * blob)),
      adjacency,
      blob,
      cells: a.cells,
    };
  });
}

/* ===================== 全局色调统计 ===================== */

/** 这一场总体是什么调子：明度分布 / 色相分布 / 暖冷 / 反差 */
export function toneStats(samples) {
  const { L, a, b } = samples;
  const n = L.length;
  const zones = { shadow: 0, midtone: 0, highlight: 0 };
  let sumL = 0, sumC = 0, sumB = 0, sumBmid = 0, nMid = 0;
  const hueBins = new Array(12).fill(0);
  const Ls = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Ls[i] = L[i];
    zones[toneZone(L[i])]++;
    sumL += L[i];
    const C = Math.hypot(a[i], b[i]);
    sumC += C;
    sumB += b[i];
    if (L[i] >= 30 && L[i] <= 85) { sumBmid += b[i]; nMid++; }
    let h = (Math.atan2(b[i], a[i]) * 180) / Math.PI;
    if (h < 0) h += 360;
    hueBins[Math.min(11, Math.floor(h / 30))] += C + 1;
  }
  Ls.sort();
  const pct = (p) => Ls[Math.min(n - 1, Math.max(0, Math.floor((p / 100) * n)))];
  const hueNames = ["红", "橙", "棕黄", "黄", "黄绿", "绿", "青", "青蓝", "蓝", "蓝紫", "紫", "洋红"];
  const hueOrder = hueBins.map((v, i) => ({ name: hueNames[i], v })).sort((p, q) => q.v - p.v);
  const hueSum = hueBins.reduce((s, v) => s + v, 0) || 1;

  const key = zones.shadow / n;
  const keyName =
    key > 0.45 ? "低键 / 重暗部（高反差夜景·煤窑·夜内）" :
    key > 0.28 ? "中低键（室内·阴天·黄昏）" :
    key > 0.15 ? "中键（日景常规）" : "高键（强日光·雪景·过曝风格）";

  return {
    samples: n,
    zones: { shadow: zones.shadow / n, midtone: zones.midtone / n, highlight: zones.highlight / n },
    meanL: sumL / n,
    meanC: sumC / n,
    Lp5: pct(5), Lp50: pct(50), Lp95: pct(95),
    tonalRange: pct(95) - pct(5),
    meanBstar: sumB / n,
    meanBstarMid: nMid ? sumBmid / nMid : sumB / n,
    warmth: nMid ? sumBmid / nMid : sumB / n,
    hueTop: hueOrder.slice(0, 4).map((h) => ({ hue: h.name, share: h.v / hueSum })),
    keyName,
  };
}

/* ===================== 对外的三个提取模式 ===================== */

function tidy(colors) {
  return colors.map((c, idx) => {
    const d = describeLab(c.L, c.a, c.b);
    return {
      index: idx + 1,
      hex: c.hex || labToHex(c.L, c.a, c.b),
      lab: [+c.L.toFixed(2), +c.a.toFixed(2), +c.b.toFixed(2)],
      lch: { L: +d.L.toFixed(1), C: +d.C.toFixed(1), h: +d.h.toFixed(1) },
      coverage: +(c.coverage * 100).toFixed(2),
      coverageRaw: c.coverage,
      label: d.label,
      tone: d.tone,
      sat: d.sat,
      hue: d.hue,
      nearestHex: c.nearestHex ?? null,
      nearestDE: c.nearestDE != null ? +c.nearestDE.toFixed(1) : null,
      structure: c.structure != null ? +c.structure.toFixed(3) : null,
      structureNote:
        c.structure == null ? null
          : c.structure > 0.6 ? "实体色块（美术决定，该留）"
          : c.structure > 0.35 ? "中等结构（过渡/材质混合）"
          : "低频碎块（疑似噪点/边缘/光照溢出，建议复核）",
    };
  });
}

function sortColors(colors, order) {
  const arr = colors.slice();
  if (order === "hue") {
    arr.sort((p, q) => {
      const hp = Math.atan2(p.b, p.a), hq = Math.atan2(q.b, q.a);
      return hp - hq || q.L - p.L;
    });
  } else if (order === "coverage") {
    arr.sort((p, q) => q.coverage - p.coverage);
  } else {
    arr.sort((p, q) => q.L - p.L); // value：亮 → 暗，就是参考图那样的明度阶梯
  }
  return arr;
}

/** 模式一：单图 / 多图池化（把图当"一场戏"，等权混合后统一聚类） */
export function extractPooled(images, opts = {}) {
  const samples = collectSamples(images, opts);
  if (!samples.count) throw new Error("没有可用像素（全部被 ROI / 透明度 / 极值过滤掉了）");
  const { pts, total } = buildHistogram(samples);
  const raw = kmeansOnHistogram(pts, opts.k || 24);
  let { accepted, dropped, effectiveMinSep } = decide(raw, total, opts);

  // 兜底：全被规则筛掉时（例如二维码、纯黑白版式），退回"放宽极值 + 更低覆盖阈值"再出一版
  let fallbackNote = null;
  if (!accepted.length) {
    const retry = decide(raw, total, {
      ...opts,
      keepExtremes: true,
      minCoverage: Math.min(opts.minCoverage ?? 0.012, 0.004),
      kmin: Math.min(opts.kmin ?? 6, 2),
    });
    if (retry.accepted.length) {
      accepted = retry.accepted;
      dropped = retry.dropped;
      effectiveMinSep = retry.effectiveMinSep;
      fallbackNote = "按默认规则一色不留（画面只有近纯黑/纯白），已自动放宽极值规则兜底。若这不是你要的结果，加 --min-coverage 0 --keep-extremes 复核。";
    }
  }

  const struct = structureScores(images, accepted);
  accepted.forEach((c, i) => Object.assign(c, struct[i] || {}));

  if (opts.strict) {
    for (let i = accepted.length - 1; i >= 0; i--) {
      if (accepted[i].structure != null && accepted[i].structure < 0.35) {
        dropped.push({ ...accepted[i], reason: `结构分数 ${accepted[i].structure.toFixed(2)} < 0.35，判为高频伪影`, code: "R4" });
        accepted.splice(i, 1);
      }
    }
  }

  const keptCoverage = accepted.reduce((s, c) => s + c.coverage, 0);
  return {
    mode: "pooled",
    colors: tidy(sortColors(accepted, opts.order)),
    dropped: tidyDropped(dropped, opts.order),
    tone: toneStats(samples),
    warning: fallbackNote,
    meta: {
      images: images.length,
      samples: samples.count,
      effectiveMinSep: +effectiveMinSep.toFixed(1),
      kOver: raw.length,
      keptCoverage: +(keptCoverage * 100).toFixed(1),
    },
  };
}

/** 模式二：多图投票（每张图各出一块小板，跨图聚类后按"出现在几张图里"投票） */
export function extractVoted(images, opts = {}) {
  const perKmax = opts.perKmax || 8;
  const voteRatio = opts.voteRatio ?? 0.4;
  const minSep = opts.minSep ?? 7;

  const perImage = [];
  for (const img of images) {
    try {
      const r = extractPooled([img], { ...opts, kmax: perKmax, kmin: 4, minCoverage: opts.perImageMinCoverage ?? 0.02, strict: false, order: "coverage" });
      perImage.push(r.colors);
    } catch { /* 单张失败就跳过 */ }
  }
  if (!perImage.length) throw new Error("没有一张图能出板");

  const n = perImage.length;
  const pooled = [];
  perImage.forEach((colors, imgIdx) => {
    for (const c of colors) pooled.push({ L: c.lab[0], a: c.lab[1], b: c.lab[2], w: c.coverageRaw / n, imgIdx });
  });

  pooled.sort((p, q) => q.w - p.w);
  const groups = [];
  for (const p of pooled) {
    let hit = null;
    for (const g of groups) {
      if (ciede2000([p.L, p.a, p.b], [g.L, g.a, g.b]) < minSep) { hit = g; break; }
    }
    if (!hit) {
      groups.push({ L: p.L, a: p.a, b: p.b, w: p.w, imgs: new Set([p.imgIdx]), hits: 1 });
    } else {
      hit.imgs.add(p.imgIdx);
      hit.hits++;
      hit.w += p.w;
      hit.L = (hit.L * (hit.hits - 1) + p.L) / hit.hits;
      hit.a = (hit.a * (hit.hits - 1) + p.a) / hit.hits;
      hit.b = (hit.b * (hit.hits - 1) + p.b) / hit.hits;
    }
  }

  const needVotes = Math.max(1, Math.ceil(n * voteRatio));
  const accepted = [];
  const dropped = [];
  for (const g of groups) {
    const votes = g.imgs.size;
    const rec = { ...g, coverage: g.w, hex: labToHex(g.L, g.a, g.b), votes, voteRatio: votes / n };
    if (votes < needVotes) {
      dropped.push({ ...rec, reason: `只出现在 ${votes}/${n} 张图里（< ${needVotes}），判为个别镜头特例`, code: "R6" });
    } else {
      accepted.push(rec);
    }
  }
  accepted.sort((p, q) => q.coverage - p.coverage);
  const kept = accepted.slice(0, opts.kmax ?? 12);

  const struct = structureScores(images, kept);
  kept.forEach((c, i) => Object.assign(c, struct[i] || {}));

  const samples = collectSamples(images, opts);
  const ordered = sortColors(kept, opts.order);
  return {
    mode: "voted",
    colors: tidy(ordered).map((c, i) => ({
      ...c,
      votes: ordered[i].votes,
      voteShare: ordered[i].voteRatio != null ? Math.round(ordered[i].voteRatio * 100) : undefined,
    })),
    dropped: tidyDropped(dropped, opts.order),
    tone: toneStats(samples),
    meta: { images: n, needVotes, perImageKmax: perKmax },
  };
}

function tidyDropped(dropped, order) {
  return dropped
    .slice()
    .sort((p, q) => q.coverage - p.coverage)
    .map((c) => {
      const d = describeLab(c.L, c.a, c.b);
      return {
        hex: c.hex || labToHex(c.L, c.a, c.b),
        coverage: +(c.coverage * 100).toFixed(2),
        label: d.label,
        code: c.code || "R?",
        reason: c.reason || "",
        structure: c.structure != null ? +c.structure.toFixed(3) : null,
      };
    });
}

/* ===================== 色板体检 ===================== */

/**
 * 体检一块"已经存在"的色板（不管是 AI 出的、美术给的、还是别处抄来的），
 * 判断它能不能拿来当视频生成的色彩约束。
 *
 * 六项检查：
 *   C1 数量      6~12 才好用；<5 约束太弱，>14 模型抓不住重点
 *   C2 冗余对    两色 ΔE00 < 5 就是同一块颜色的重复采样，多留只会稀释权重
 *   C3 明度阶梯  相邻色 L* 断层 > 25 说明中间调缺失，生成出来容易"死黑死白"
 *   C4 极端色    近纯黑/纯白在中段缺失时经常只是曝光产物
 *   C5 锚点      肤色锚 / 暗部锚 / 亮部锚 / 冷色锚 —— 少一个，生成的人或光就会飘
 *   C6 强调色    高饱和色（C* > 40）超过 2~3 个会互相打架
 */
export function paletteHealth(hexes, opts = {}) {
  const redundantDE = opts.redundantDE ?? 5;
  const colors = hexes.map((hex, i) => {
    const lab = hexToLab(hex);
    const d = describeLab(lab[0], lab[1], lab[2]);
    return { index: i + 1, hex, lab, lch: { L: +d.L.toFixed(1), C: +d.C.toFixed(1), h: +d.h.toFixed(1) }, label: d.label, hue: d.hue, tone: d.tone };
  });

  // C2 冗余对
  const redundant = [];
  let minPair = Infinity, minPairHex = null;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const de = ciede2000(colors[i].lab, colors[j].lab);
      if (de < minPair) { minPair = de; minPairHex = [colors[i].hex, colors[j].hex]; }
      if (de < redundantDE) redundant.push({ a: colors[i].hex, b: colors[j].hex, de: +de.toFixed(1) });
    }
  }

  // C3 明度阶梯
  const byL = [...colors].sort((p, q) => q.lch.L - p.lch.L);
  const gaps = [];
  for (let i = 1; i < byL.length; i++) {
    const g = byL[i - 1].lch.L - byL[i].lch.L;
    if (g > (opts.gapL ?? 25)) gaps.push({ from: byL[i - 1].hex, to: byL[i].hex, gapL: +g.toFixed(1) });
  }

  // C4 极端色
  const extremes = colors.filter((c) => c.lch.L < 3.5 || c.lch.L > 96.5).map((c) => c.hex);

  // C5 锚点
  const hasSkin = colors.some((c) => c.lch.L >= 52 && c.lch.L <= 82 && c.lch.C >= 10 && c.lch.C <= 45 && c.lch.h >= 35 && c.lch.h <= 80);
  const hasShadow = colors.some((c) => c.lch.L < 25);
  const hasHighlight = colors.some((c) => c.lch.L > 82);
  const hasCool = colors.some((c) => c.lab[2] < -6 || (c.lch.h > 200 && c.lch.h < 330));
  const hasWarm = colors.some((c) => c.lab[2] > 8);
  const anchors = {
    skin: { ok: hasSkin, note: "肤色锚（L*55~82 / C*10~45 / h 35~80）—— 没有它，生成的人物肤色会飘" },
    shadow: { ok: hasShadow, note: "暗部锚（L* < 25）—— 没有它，暗部只能靠模型自己瞎编" },
    highlight: { ok: hasHighlight, note: "亮部锚（L* > 82）—— 没有它，高光容易过曝出板外色" },
    cool: { ok: hasCool, note: "冷色锚（b* < −6 或 h 200~330）—— 没有它，画面没有冷暖对比，会显得平" },
    warm: { ok: hasWarm, note: "暖色锚（b* > 8）—— 没有它，暖调质感立不住" },
  };

  // C6 强调色
  const accents = colors.filter((c) => c.lch.C > 40).map((c) => c.hex);

  // ---- 结论 ----
  const issues = [];
  const oks = [];
  if (colors.length < 6) issues.push(`只有 ${colors.length} 色，约束太弱，模型会自己补色（建议 8~12）`);
  else if (colors.length > 14) issues.push(`${colors.length} 色偏多，提示词里塞不下也没法被模型抓住重点（建议精简到 8~12）`);
  else oks.push(`${colors.length} 色，数量合适`);

  if (redundant.length) issues.push(`${redundant.length} 组冗余色（ΔE00 < ${redundantDE}）：${redundant.map((r) => `${r.a}≈${r.b}(${r.de})`).join(", ")} —— 至少要砍掉一条`);
  else oks.push(`最小间距 ΔE00=${minPair.toFixed(1)}（${minPairHex?.join(" / ")}），没有重复色`);

  if (gaps.length) issues.push(`明度阶梯有 ${gaps.length} 处断层：${gaps.map((g) => `${g.from}→${g.to} 相差 L*${g.gapL}`).join(", ")} —— 中间调会缺失`);
  else oks.push("明度阶梯连续，没有大断层");

  if (extremes.length) issues.push(`含近纯黑/纯白：${extremes.join(", ")} —— 多半是曝光产物，除非刻意要，否则删掉`);

  for (const [k, v] of Object.entries(anchors)) if (!v.ok) issues.push("缺" + v.note);

  if (accents.length > 3) issues.push(`${accents.length} 个高饱和强调色（${accents.join(", ")}），会互相打架，建议留 1~2 个`);

  const score = Math.max(
    0,
    Math.min(100, 100 - redundant.length * 12 - gaps.length * 10 - extremes.length * 6
      - Object.values(anchors).filter((a) => !a.ok).length * 8
      - (colors.length < 6 || colors.length > 14 ? 15 : 0))
  );

  return {
    mode: "health",
    count: colors.length,
    score,
    verdict:
      score >= 85 ? "可以直接拿去约束生成" :
      score >= 65 ? "能用，按 issues 修一下更好" :
      score >= 40 ? "问题较多，建议重出一版" : "不适合直接当约束条件",
    colors,
    redundant,
    minPairDE: +minPair.toFixed(1),
    minPairHex,
    lumaGaps: gaps,
    extremes,
    anchors,
    accents,
    issues,
    oks,
  };
}

/** 用 ΔE00 找最近主色（更准，代价可接受：12 色 × 12 万像素约 0.2s） */
function nearestMasterDE00(L, a, b, masters) {
  let bi = 0, bd = Infinity;
  const lab = [L, a, b];
  for (let i = 0; i < masters.length; i++) {
    const d = ciede2000(lab, masters[i].lab);
    if (d < bd) { bd = d; bi = i; }
  }
  return { index: bi, de: bd };
}

/**
 * 模式三：对账（anchor）
 * 把这场戏的像素全部归到剧集主色板的锚点上，看：
 *   - 哪些主色真的被用到了、各占多少
 *   - 哪些主色这一场完全缺位
 *   - 有多少像素"离板"（不属于任何主色的邻近范围）→ 这些才是候选新增色
 */
export function anchorScene(images, masterHexes, opts = {}) {
  const masters = masterHexes.map((hex) => ({ hex, lab: hexToLab(hex) }));
  const samples = collectSamples(images, opts);
  const { L, a, b } = samples;
  const n = L.length;
  const offTol = opts.offBoardDE ?? 15;
  const counts = new Float64Array(masters.length);
  const deSum = new Float64Array(masters.length);
  const offBoard = [];

  for (let i = 0; i < n; i++) {
    const { index, de } = nearestMasterDE00(L[i], a[i], b[i], masters);
    counts[index]++;
    deSum[index] += de;
    if (de > offTol) offBoard.push([L[i], a[i], b[i]]);
  }

  const rows = masters.map((m, i) => {
    const d = describeLab(m.lab[0], m.lab[1], m.lab[2]);
    return {
      hex: m.hex,
      lab: [+m.lab[0].toFixed(2), +m.lab[1].toFixed(2), +m.lab[2].toFixed(2)],
      lch: { L: +d.L.toFixed(1), C: +d.C.toFixed(1), h: +d.h.toFixed(1) },
      coverage: +((counts[i] / n) * 100).toFixed(2),
      meanDE: counts[i] ? +(deSum[i] / counts[i]).toFixed(1) : null,
      label: d.label,
      tone: d.tone,
      sat: d.sat,
      hue: d.hue,
      structure: null,
      status:
        counts[i] === 0 ? "缺位（这一场完全没用到）" :
        counts[i] / n < 0.01 ? "几乎不用（<1%）" :
        counts[i] / n > 0.5 ? "主导色（占一半以上）" : "在场",
    };
  });

  // 离板像素单独聚一下，看是不是真的冒出了新色
  let offColors = [];
  if (offBoard.length > 60) {
    const sub = { L: Float32Array.from(offBoard.map((p) => p[0])), a: Float32Array.from(offBoard.map((p) => p[1])), b: Float32Array.from(offBoard.map((p) => p[2])), count: offBoard.length };
    const { pts, total } = buildHistogram(sub);
    const raw = kmeansOnHistogram(pts, 10);
    const { accepted } = decide(raw, total, { ...opts, kmax: 6, kmin: 2, minCoverage: 0.02, minSep: 8 });
    offColors = tidy(sortColors(accepted, "coverage"));
  }

  return {
    mode: "anchor",
    master: masters.map((m) => m.hex),
    colors: rows,
    offBoard: {
      coverage: +((offBoard.length / n) * 100).toFixed(2),
      thresholdDE: offTol,
      colors: offColors,
    },
    tone: toneStats(samples),
    meta: { images: images.length, samples: n },
  };
}

/**
 * 校验：一条已经生成好的镜头，跟色板吻合到什么程度。
 *
 * 评分不用"平均 ΔE00"当主轴 —— 真实画面里渐变、明暗过渡、材质混合必然产生大量中间色，
 * 用平均值打分会把正常镜头判成跑板。改用分布：
 *   in   (ΔE00 ≤ --near-de, 默认 6)   肉眼基本就在板上
 *   near (6 < ΔE00 ≤ --off-de, 默认 12) 过渡带，可接受
 *   off  (ΔE00 > --off-de)            明显离板
 *   score = 100 × (in 占比 + 0.5 × near 占比)
 */
export function verifyAgainstPalette(images, masterHexes, opts = {}) {
  const masters = masterHexes.map((hex) => ({ hex, lab: hexToLab(hex) }));
  const samples = collectSamples(images, opts);
  const { L, a, b } = samples;
  const n = L.length;
  const nearTol = opts.nearDE ?? 6;
  const offTol = opts.offDE ?? 12;

  let sumDE = 0, inCount = 0, nearCount = 0, offCount = 0;
  const bins = new Map();
  for (let i = 0; i < n; i++) {
    const { index, de } = nearestMasterDE00(L[i], a[i], b[i], masters);
    sumDE += de;
    if (de <= nearTol) inCount++;
    else if (de <= offTol) nearCount++;
    else offCount++;
    const key = masters[index].hex;
    const cur = bins.get(key) || { hex: key, count: 0, deSum: 0, inCount: 0 };
    cur.count++; cur.deSum += de;
    if (de <= nearTol) cur.inCount++;
    bins.set(key, cur);
  }
  const inShare = inCount / n;
  const nearShare = nearCount / n;
  const offShare = offCount / n;
  const score = Math.max(0, Math.min(100, Math.round(100 * (inShare + 0.5 * nearShare))));

  return {
    mode: "verify",
    score,
    meanDE: +(sumDE / n).toFixed(2),
    // 兼容旧字段名
    offBoardShare: +(offShare * 100).toFixed(2),
    distribution: {
      inPalette: +(inShare * 100).toFixed(1),
      transitional: +(nearShare * 100).toFixed(1),
      offPalette: +(offShare * 100).toFixed(1),
      nearDE: nearTol,
      offDE: offTol,
    },
    verdict:
      score >= 75 ? "吻合：可以直接进剪辑" :
      score >= 55 ? "基本吻合：加一点校色即可" :
      score >= 35 ? "偏了：需要一张 LUT 拉回色板" : "严重跑板：建议重生成",
    perMaster: [...bins.values()]
      .map((v) => ({
        hex: v.hex,
        coverage: +((v.count / n) * 100).toFixed(2),
        inPalette: +((v.inCount / v.count) * 100).toFixed(1),
        meanDE: +(v.deSum / v.count).toFixed(1),
      }))
      .sort((p, q) => q.coverage - p.coverage),
    tone: toneStats(samples),
    meta: { images: images.length, samples: n },
  };
}
