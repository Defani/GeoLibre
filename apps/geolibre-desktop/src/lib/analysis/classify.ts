// Classification and sampling (Defani edition): a Random Forest trained from
// polygons drawn on the map, accuracy assessment against reference points,
// and sampling designs (random, stratified random, systematic grid).

import type { RasterData } from "@geolibre/processing";
import type { Feature, FeatureCollection, Position } from "geojson";
import {
  cellCentre,
  cellMetrics,
  forEachCellInPolygons,
  gridFrame,
  gridToCell,
  isNoData,
  pointFeature,
  pointInPolygons,
  polygonsInGrid,
  round,
  sameGrid,
  singleBand,
} from "./grid";
import type { Table } from "./forest";

// ---------------------------------------------------------------- Random Forest

type Node = { f: number; t: number; l: Node; r: Node } | { leaf: number };

function gini(counts: Map<number, number>, n: number): number {
  let g = 1;
  for (const c of counts.values()) g -= (c / n) ** 2;
  return g;
}

function majority(labels: number[], idx: number[]): number {
  const counts = new Map<number, number>();
  for (const i of idx) counts.set(labels[i], (counts.get(labels[i]) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function buildTree(X: Float32Array[], y: number[], idx: number[], depth: number, maxDepth: number, mtry: number, minLeaf: number, rand: () => number): Node {
  if (depth >= maxDepth || idx.length <= minLeaf || new Set(idx.map((i) => y[i])).size === 1) return { leaf: majority(y, idx) };
  const nf = X[0].length;
  const features = [...Array(nf).keys()].sort(() => rand() - 0.5).slice(0, mtry);
  let best = { gain: 0, f: -1, t: 0 };
  const parentCounts = new Map<number, number>();
  for (const i of idx) parentCounts.set(y[i], (parentCounts.get(y[i]) ?? 0) + 1);
  const parentG = gini(parentCounts, idx.length);
  for (const f of features) {
    const sorted = [...idx].sort((a, b) => X[a][f] - X[b][f]);
    const left = new Map<number, number>();
    const right = new Map(parentCounts);
    // Try up to 32 candidate thresholds (quantiles) per feature.
    const step = Math.max(1, Math.floor(sorted.length / 32));
    let k = 0;
    for (let s = step; s < sorted.length; s += step) {
      for (; k < s; k += 1) {
        const lab = y[sorted[k]];
        left.set(lab, (left.get(lab) ?? 0) + 1);
        right.set(lab, right.get(lab)! - 1);
      }
      const a = X[sorted[s - 1]][f], b = X[sorted[s]][f];
      if (a === b) continue;
      const g = parentG - (s / sorted.length) * gini(left, s) - ((sorted.length - s) / sorted.length) * gini(right, sorted.length - s);
      if (g > best.gain) best = { gain: g, f, t: (a + b) / 2 };
    }
  }
  if (best.f < 0) return { leaf: majority(y, idx) };
  const l: number[] = [], r: number[] = [];
  for (const i of idx) (X[i][best.f] <= best.t ? l : r).push(i);
  if (!l.length || !r.length) return { leaf: majority(y, idx) };
  return { f: best.f, t: best.t, l: buildTree(X, y, l, depth + 1, maxDepth, mtry, minLeaf, rand), r: buildTree(X, y, r, depth + 1, maxDepth, mtry, minLeaf, rand) };
}

function predictTree(node: Node, x: ArrayLike<number>): number {
  let n = node;
  while (!("leaf" in n)) n = x[n.f] <= n.t ? n.l : n.r;
  return n.leaf;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Train a Random Forest from training polygons (class codes in `classField`)
 * over the stacked bands, classify every cell, and report the out-of-bag
 * accuracy. Classes are numeric codes (text classes are numbered).
 */
export async function randomForestClassify(
  bands: RasterData[],
  training: FeatureCollection,
  classField: string,
  opts: { trees: number; maxDepth: number; samplesPerClass: number },
) {
  bands.forEach((b, i) => sameGrid(bands[0], b, "band 1", `band ${i + 1}`));
  const ref = bands[0];
  const frame = await gridFrame(ref);
  const codes = new Map<string, number>();
  const codeOf = (v: unknown) => {
    const s = String(v ?? "");
    const num = Number(s);
    if (s !== "" && Number.isFinite(num)) return Math.round(num);
    if (!codes.has(s)) codes.set(s, codes.size + 1);
    return codes.get(s)!;
  };
  const perClass = new Map<number, number[]>();
  for (const f of training.features) {
    const c = codeOf(f.properties?.[classField]);
    forEachCellInPolygons(ref, polygonsInGrid(f.geometry, frame), (i) => {
      if (bands.some((b) => isNoData(b.bands[0][i], b.nodata))) return;
      if (!perClass.has(c)) perClass.set(c, []);
      perClass.get(c)!.push(i);
    });
  }
  if (perClass.size < 2) throw new Error("Draw training polygons of at least two classes (class codes in the chosen field).");
  const rand = mulberry32(42);
  const X: Float32Array[] = [];
  const y: number[] = [];
  for (const [c, cells] of perClass) {
    const pick = cells.length > opts.samplesPerClass ? cells.sort(() => rand() - 0.5).slice(0, opts.samplesPerClass) : cells;
    for (const i of pick) {
      X.push(Float32Array.from(bands, (b) => b.bands[0][i]));
      y.push(c);
    }
  }
  const mtry = Math.max(1, Math.round(Math.sqrt(bands.length)));
  const trees: Node[] = [];
  const oobVotes = X.map(() => new Map<number, number>());
  for (let t = 0; t < opts.trees; t += 1) {
    const inBag = new Uint8Array(X.length);
    const idx = Array.from({ length: X.length }, () => {
      const k = Math.floor(rand() * X.length);
      inBag[k] = 1;
      return k;
    });
    const tree = buildTree(X, y, idx, 0, opts.maxDepth, mtry, 2, rand);
    trees.push(tree);
    for (let k = 0; k < X.length; k += 1) if (!inBag[k]) {
      const p = predictTree(tree, X[k]);
      oobVotes[k].set(p, (oobVotes[k].get(p) ?? 0) + 1);
    }
  }
  let oobN = 0, oobOk = 0;
  oobVotes.forEach((v, k) => {
    if (!v.size) return;
    oobN += 1;
    if ([...v.entries()].sort((a, b) => b[1] - a[1])[0][0] === y[k]) oobOk += 1;
  });
  const n = ref.width * ref.height;
  const out = new Float32Array(n);
  const x = new Float32Array(bands.length);
  const votes = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    let bad = false;
    for (let b = 0; b < bands.length; b += 1) {
      const v = bands[b].bands[0][i];
      if (isNoData(v, bands[b].nodata)) { bad = true; break; }
      x[b] = v;
    }
    if (bad) continue;
    votes.clear();
    for (const tree of trees) {
      const p = predictTree(tree, x);
      votes.set(p, (votes.get(p) ?? 0) + 1);
    }
    let best = 0, bestN = -1;
    for (const [c, v] of votes) if (v > bestN) { best = c; bestN = v; }
    out[i] = best;
  }
  const legend = [...codes.entries()].map(([name, code]) => `${code} = ${name}`).join(", ");
  return {
    classified: singleBand(ref, out, 0),
    oobAccuracy: oobN ? oobOk / oobN : null,
    samples: X.length,
    legend,
  };
}

// ---------------------------------------------------------------- accuracy assessment

export async function accuracyAssessment(points: FeatureCollection, refField: string, classified: RasterData) {
  const frame = await gridFrame(classified);
  const pairs: Array<[number, number]> = [];
  for (const f of points.features) {
    if (f.geometry?.type !== "Point") continue;
    const [col, row] = gridToCell(classified, frame.toGrid(f.geometry.coordinates));
    if (col < 0 || row < 0 || col >= classified.width || row >= classified.height) continue;
    const v = classified.bands[0][row * classified.width + col];
    const r = Number(f.properties?.[refField]);
    if (isNoData(v, classified.nodata) || !Number.isFinite(r)) continue;
    pairs.push([Math.round(r), Math.round(v)]);
  }
  if (!pairs.length) throw new Error("No reference points fall on the classified raster (check the field and the CRS).");
  const classes = [...new Set(pairs.flat())].sort((a, b) => a - b);
  const idx = new Map(classes.map((c, i) => [c, i]));
  const m = classes.map(() => classes.map(() => 0));
  for (const [r, p] of pairs) m[idx.get(p)!][idx.get(r)!] += 1; // rows: classified, columns: reference
  const n = pairs.length;
  const diag = classes.reduce((s, _, i) => s + m[i][i], 0);
  const rowSum = m.map((row) => row.reduce((a, b) => a + b, 0));
  const colSum = classes.map((_, j) => m.reduce((a, row) => a + row[j], 0));
  const pe = classes.reduce((s, _, i) => s + rowSum[i] * colSum[i], 0) / (n * n);
  const oa = diag / n;
  const kappa = (oa - pe) / (1 - pe || 1);
  const rows: Array<Array<string | number>> = classes.map((c, i) => [
    c,
    ...m[i],
    rowSum[i],
    rowSum[i] ? round((m[i][i] / rowSum[i]) * 100) : 0,
  ]);
  rows.push(["Total", ...colSum, n, ""]);
  rows.push(["Producer's acc. %", ...classes.map((_, j) => (colSum[j] ? round((m[j][j] / colSum[j]) * 100) : 0)), "", ""]);
  return {
    table: { columns: ["classified \\ reference", ...classes.map(String), "Total", "User's acc. %"], rows } as Table,
    summary: `Overall accuracy ${round(oa * 100)}% · Kappa ${round(kappa, 3)} · ${n} points`,
  };
}

// ---------------------------------------------------------------- sampling design

export function randomPointsInPolygons(fc: FeatureCollection, count: number, seed = 7): Feature[] {
  const rand = mulberry32(seed);
  const polys = fc.features.filter((f) => /Polygon/.test(f.geometry?.type ?? ""));
  if (!polys.length) throw new Error("The area layer has no polygons.");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const geoms = polys.map((f) => {
    const g = f.geometry as { type: string; coordinates: unknown };
    const p = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Position[][][];
    for (const rings of p) for (const [x, y] of rings[0]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return p;
  });
  const out: Feature[] = [];
  let tries = 0;
  while (out.length < count && tries < count * 2000) {
    tries += 1;
    const x = minX + rand() * (maxX - minX), y = minY + rand() * (maxY - minY);
    if (geoms.some((p) => pointInPolygons(x, y, p))) out.push(pointFeature([round(x, 7), round(y, 7)], { id: out.length + 1 }));
  }
  return out;
}

export function systematicGrid(fc: FeatureCollection, spacingM: number): Feature[] {
  const polys = fc.features.filter((f) => /Polygon/.test(f.geometry?.type ?? ""));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const geoms = polys.map((f) => {
    const g = f.geometry as { type: string; coordinates: unknown };
    const p = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Position[][][];
    for (const rings of p) for (const [x, y] of rings[0]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return p;
  });
  const lat = (minY + maxY) / 2;
  const dy = spacingM / 110_574, dx = spacingM / (111_320 * Math.cos((lat * Math.PI) / 180));
  if ((maxX - minX) / dx * ((maxY - minY) / dy) > 200_000) throw new Error("That spacing makes more than 200,000 points; use a larger spacing.");
  const out: Feature[] = [];
  for (let y = minY + dy / 2; y < maxY; y += dy) for (let x = minX + dx / 2; x < maxX; x += dx) {
    if (geoms.some((p) => pointInPolygons(x, y, p))) out.push(pointFeature([round(x, 7), round(y, 7)], { id: out.length + 1, plot: `P${out.length + 1}` }));
  }
  return out;
}

/** Stratified random: `perClass` points in every class of a class raster. */
export async function stratifiedRandom(classRaster: RasterData, perClass: number, seed = 11): Promise<Feature[]> {
  const frame = await gridFrame(classRaster);
  const rand = mulberry32(seed);
  const cells = new Map<number, number[]>();
  classRaster.bands[0].forEach((v, i) => {
    if (isNoData(v, classRaster.nodata)) return;
    const c = Math.round(v);
    if (!cells.has(c)) cells.set(c, []);
    cells.get(c)!.push(i);
  });
  const out: Feature[] = [];
  const { sizeX } = cellMetrics(classRaster, frame);
  void sizeX;
  for (const [c, list] of [...cells.entries()].sort((a, b) => a[0] - b[0])) {
    for (let k = 0; k < Math.min(perClass, list.length); k += 1) {
      const pick = list.splice(Math.floor(rand() * list.length), 1)[0];
      const col = pick % classRaster.width, row = (pick - col) / classRaster.width;
      const lonLat = frame.toLonLat(cellCentre(classRaster, col, row));
      out.push(pointFeature([round(lonLat[0], 7), round(lonLat[1], 7)], { id: out.length + 1, stratum: c }));
    }
  }
  return out;
}
