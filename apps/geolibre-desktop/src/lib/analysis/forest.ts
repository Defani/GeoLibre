// Forest and carbon analysis (Defani edition): tabulate area / intersection,
// landscape fragmentation, burn severity (dNBR), carbon stock and emissions,
// and per-pixel trend (Sen's slope + Mann-Kendall).

import type { RasterData } from "@geolibre/processing";
import turfArea from "@turf/area";
import turfIntersect from "@turf/intersect";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import {
  cellMetrics,
  forEachCellInPolygons,
  gridFrame,
  isNoData,
  NODATA,
  polygonsInGrid,
  round,
  sameGrid,
  singleBand,
} from "./grid";

export type Table = { columns: string[]; rows: Array<Array<string | number>> };

/** Area of each class of `classRaster` inside every polygon, as new fields `<prefix><class>_ha`. */
export async function tabulateArea(zones: FeatureCollection, classRaster: RasterData, prefix: string) {
  const frame = await gridFrame(classRaster);
  const { cellHa } = cellMetrics(classRaster, frame);
  const band = classRaster.bands[0];
  const classes = new Set<number>();
  const perFeature = zones.features.map((feature) => {
    const counts = new Map<number, number>();
    forEachCellInPolygons(classRaster, polygonsInGrid(feature.geometry, frame), (i) => {
      const v = band[i];
      if (isNoData(v, classRaster.nodata)) return;
      const c = Math.round(v);
      classes.add(c);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    });
    return counts;
  });
  const sorted = [...classes].sort((a, b) => a - b);
  const features = zones.features.map((feature, i): Feature => {
    const props: Record<string, unknown> = { ...(feature.properties ?? {}) };
    let total = 0;
    for (const c of sorted) {
      const ha = round((perFeature[i].get(c) ?? 0) * cellHa, 4);
      props[`${prefix}${c}_ha`] = ha;
      total += ha;
    }
    props[`${prefix}total_ha`] = round(total, 4);
    return { ...feature, properties: props };
  });
  const table: Table = {
    columns: ["class", "hectares"],
    rows: sorted.map((c) => [c, round(perFeature.reduce((s, m) => s + (m.get(c) ?? 0), 0) * cellHa)]),
  };
  return { collection: { ...zones, features }, table };
}

/** Overlap area (ha and %) of every class of `classes` (by a field) inside every zone polygon. */
export function tabulateIntersection(zones: FeatureCollection, classes: FeatureCollection, classField: string, prefix: string) {
  const classNames = [...new Set(classes.features.map((f) => String(f.properties?.[classField] ?? "")))].sort();
  const totals = new Map<string, number>();
  const features = zones.features.map((zone): Feature => {
    const props: Record<string, unknown> = { ...(zone.properties ?? {}) };
    const zoneHa = zone.geometry ? turfArea(zone as Feature<Polygon | MultiPolygon>) / 10_000 : 0;
    const perClass = new Map<string, number>();
    for (const cls of classes.features) {
      if (!zone.geometry || !cls.geometry) continue;
      if (!/Polygon/.test(cls.geometry.type) || !/Polygon/.test(zone.geometry.type)) continue;
      let overlap: Feature | null = null;
      try {
        overlap = turfIntersect({
          type: "FeatureCollection",
          features: [zone as Feature<Polygon | MultiPolygon>, cls as Feature<Polygon | MultiPolygon>],
        });
      } catch {
        overlap = null;
      }
      if (!overlap) continue;
      const key = String(cls.properties?.[classField] ?? "");
      perClass.set(key, (perClass.get(key) ?? 0) + turfArea(overlap) / 10_000);
    }
    for (const name of classNames) {
      const ha = perClass.get(name) ?? 0;
      const safe = name.replace(/[^\w]+/g, "_").slice(0, 24) || "class";
      props[`${prefix}${safe}_ha`] = round(ha, 4);
      props[`${prefix}${safe}_pct`] = zoneHa ? round((ha / zoneHa) * 100, 2) : 0;
      totals.set(name, (totals.get(name) ?? 0) + ha);
    }
    props[`${prefix}zone_ha`] = round(zoneHa, 4);
    return { ...zone, properties: props };
  });
  const table: Table = { columns: [classField, "hectares"], rows: classNames.map((n) => [n, round(totals.get(n) ?? 0)]) };
  return { collection: { ...zones, features }, table };
}

/** Landscape metrics per class (8-connected patches), FRAGSTATS-style. */
export async function fragmentation(classRaster: RasterData, edgeDepthCells: number, focusClass: number | null) {
  const frame = await gridFrame(classRaster);
  const { cellHa, size } = cellMetrics(classRaster, frame);
  const { width: w, height: h } = classRaster;
  const band = classRaster.bands[0];
  const value = (i: number) => (isNoData(band[i], classRaster.nodata) ? NaN : Math.round(band[i]));
  const labels = new Int32Array(w * h).fill(-1);
  const patchClass: number[] = [];
  const patchCells: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start += 1) {
    const c = value(start);
    if (Number.isNaN(c) || labels[start] >= 0) continue;
    const id = patchClass.length;
    patchClass.push(c);
    let n = 0;
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      n += 1;
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (labels[j] < 0 && value(j) === c) {
          labels[j] = id;
          stack.push(j);
        }
      }
    }
    patchCells.push(n);
  }
  // Edges (4-neighbour class boundaries) and core cells (no other class within edge depth).
  const edgeCells = new Map<number, number>();
  const coreCells = new Map<number, number>();
  const totalCells = new Map<number, number>();
  for (let i = 0; i < w * h; i += 1) {
    const c = value(i);
    if (Number.isNaN(c)) continue;
    totalCells.set(c, (totalCells.get(c) ?? 0) + 1);
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < w && ny < h && value(ny * w + nx) !== c) {
        edgeCells.set(c, (edgeCells.get(c) ?? 0) + 1);
        const o = value(ny * w + nx);
        if (!Number.isNaN(o)) edgeCells.set(o, (edgeCells.get(o) ?? 0) + 1);
      }
    }
    let core = true;
    for (let dy = -edgeDepthCells; dy <= edgeDepthCells && core; dy += 1) {
      for (let dx = -edgeDepthCells; dx <= edgeDepthCells; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || value(ny * w + nx) !== c) {
          core = false;
          break;
        }
      }
    }
    if (core) coreCells.set(c, (coreCells.get(c) ?? 0) + 1);
  }
  const landscapeCells = [...totalCells.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = [...totalCells.keys()].sort((a, b) => a - b).map((c) => {
    const sizes = patchCells.filter((_, p) => patchClass[p] === c);
    const area = (totalCells.get(c) ?? 0) * cellHa;
    const edgeKm = ((edgeCells.get(c) ?? 0) * size) / 1000;
    return [
      c,
      sizes.length,
      round(area),
      round((area / landscapeCells / cellHa) * 100),
      round(area / Math.max(1, sizes.length), 3),
      round(((Math.max(0, ...sizes) * cellHa) / (landscapeCells * cellHa)) * 100, 3),
      round(edgeKm, 2),
      round((edgeKm * 1000) / (landscapeCells * cellHa), 2),
      round((coreCells.get(c) ?? 0) * cellHa),
    ];
  });
  const patchRaster = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const p = labels[i];
    patchRaster[i] = p < 0 || (focusClass !== null && patchClass[p] !== focusClass) ? 0 : (patchCells[p] * cellHa);
  }
  return {
    table: {
      columns: ["class", "patches", "area_ha", "PLAND_%", "mean_patch_ha", "LPI_%", "edge_km", "ED_m_per_ha", "core_ha"],
      rows,
    } as Table,
    patchAreaRaster: singleBand(classRaster, patchRaster, 0),
  };
}

const DNBR_CLASSES: Array<[number, number, string]> = [
  [-Infinity, -0.25, "High post-fire regrowth"],
  [-0.25, -0.1, "Low post-fire regrowth"],
  [-0.1, 0.1, "Unburned"],
  [0.1, 0.27, "Low severity"],
  [0.27, 0.44, "Moderate-low severity"],
  [0.44, 0.66, "Moderate-high severity"],
  [0.66, Infinity, "High severity"],
];

/** dNBR = NBRpre − NBRpost, classified with the USGS (Key & Benson) severity table. */
export async function burnSeverity(
  pre: { nir: RasterData; swir: RasterData } | { nbr: RasterData },
  post: { nir: RasterData; swir: RasterData } | { nbr: RasterData },
) {
  const nbrOf = (s: { nir: RasterData; swir: RasterData } | { nbr: RasterData }) => {
    if ("nbr" in s) return s.nbr;
    sameGrid(s.nir, s.swir, "NIR", "SWIR");
    const out = new Float32Array(s.nir.width * s.nir.height);
    for (let i = 0; i < out.length; i += 1) {
      const a = s.nir.bands[0][i], b = s.swir.bands[0][i];
      out[i] = isNoData(a, s.nir.nodata) || isNoData(b, s.swir.nodata) || a + b === 0 ? NODATA : (a - b) / (a + b);
    }
    return singleBand(s.nir, out);
  };
  const preNbr = nbrOf(pre), postNbr = nbrOf(post);
  sameGrid(preNbr, postNbr, "pre-fire", "post-fire");
  const frame = await gridFrame(preNbr);
  const { cellHa } = cellMetrics(preNbr, frame);
  const n = preNbr.width * preNbr.height;
  const dnbr = new Float32Array(n), cls = new Float32Array(n);
  const counts = new Array(DNBR_CLASSES.length + 1).fill(0);
  for (let i = 0; i < n; i += 1) {
    const a = preNbr.bands[0][i], b = postNbr.bands[0][i];
    if (isNoData(a, preNbr.nodata) || isNoData(b, postNbr.nodata)) {
      dnbr[i] = NODATA;
      continue;
    }
    const d = a - b;
    dnbr[i] = d;
    const k = DNBR_CLASSES.findIndex(([lo, hi]) => d >= lo && d < hi) + 1;
    cls[i] = k;
    counts[k] += 1;
  }
  const total = counts.reduce((s, c) => s + c, 0) || 1;
  return {
    dnbr: singleBand(preNbr, dnbr),
    classes: singleBand(preNbr, cls, 0),
    table: {
      columns: ["code", "severity", "hectares", "percent"],
      rows: DNBR_CLASSES.map(([, , label], k) => [k + 1, label, round(counts[k + 1] * cellHa), round((counts[k + 1] / total) * 100)]),
    } as Table,
  };
}

/** Parse "code: value" lines (or "code,value"). */
export function parseLookup(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(-?\d+(?:\.\d+)?)\s*[:=,;\t]\s*(-?\d+(?:\.\d+)?)/);
    if (m) map.set(Math.round(Number(m[1])), Number(m[2]));
  }
  if (!map.size) throw new Error("Write one “class code: tC/ha” per line, e.g. 1: 180.");
  return map;
}

/** Carbon stock per class (tC/ha × area), and emissions between two dates (tCO2e = ΔC × 44/12). */
export async function carbonStock(before: RasterData, factors: Map<number, number>, after?: RasterData) {
  const frame = await gridFrame(before);
  const { cellHa } = cellMetrics(before, frame);
  const tally = (r: RasterData) => {
    const counts = new Map<number, number>();
    for (const v of r.bands[0]) {
      if (isNoData(v, r.nodata)) continue;
      const c = Math.round(v);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return counts;
  };
  const a = tally(before);
  const b = after ? (sameGrid(before, after, "year 1", "year 2"), tally(after)) : null;
  const classes = [...new Set([...a.keys(), ...(b?.keys() ?? [])])].sort((x, y) => x - y);
  let stockA = 0, stockB = 0;
  const rows = classes.map((c) => {
    const f = factors.get(c) ?? 0;
    const haA = (a.get(c) ?? 0) * cellHa, haB = b ? (b.get(c) ?? 0) * cellHa : 0;
    stockA += haA * f;
    stockB += haB * f;
    return b ? [c, f, round(haA), round(haA * f), round(haB), round(haB * f)] : [c, f, round(haA), round(haA * f)];
  });
  const map = new Float32Array(before.width * before.height);
  before.bands[0].forEach((v, i) => (map[i] = isNoData(v, before.nodata) ? NODATA : (factors.get(Math.round(v)) ?? 0)));
  const summary = b
    ? `Stock year 1: ${round(stockA).toLocaleString("id-ID")} tC · year 2: ${round(stockB).toLocaleString("id-ID")} tC · change ${round(stockB - stockA).toLocaleString("id-ID")} tC = ${round(((stockA - stockB) * 44) / 12).toLocaleString("id-ID")} tCO2e emitted (negative = removal).`
    : `Total stock: ${round(stockA).toLocaleString("id-ID")} tC (${round((stockA * 44) / 12).toLocaleString("id-ID")} tCO2e).`;
  return {
    table: {
      columns: b ? ["class", "tC_per_ha", "ha_year1", "tC_year1", "ha_year2", "tC_year2"] : ["class", "tC_per_ha", "hectares", "tC"],
      rows,
    } as Table,
    densityRaster: singleBand(before, map),
    summary,
  };
}

/** Per-pixel Sen's slope (units per step) and Mann-Kendall Z across a time series. */
export function trendAnalysis(series: RasterData[]) {
  const t = series.length;
  if (t < 4) throw new Error("Add at least 4 rasters (dates), oldest first.");
  series.forEach((r, i) => sameGrid(series[0], r, "date 1", `date ${i + 1}`));
  const n = series[0].width * series[0].height;
  const slope = new Float32Array(n), zmap = new Float32Array(n), sig = new Float32Array(n);
  const vals: number[] = new Array(t);
  const varS = (t * (t - 1) * (2 * t + 5)) / 18;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    let ok = true;
    for (let k = 0; k < t; k += 1) {
      const v = series[k].bands[0][i];
      if (isNoData(v, series[k].nodata)) { ok = false; break; }
      vals[k] = v;
    }
    if (!ok) { slope[i] = NODATA; zmap[i] = NODATA; continue; }
    let s = 0;
    const slopes: number[] = [];
    for (let a = 0; a < t - 1; a += 1) for (let b = a + 1; b < t; b += 1) {
      s += Math.sign(vals[b] - vals[a]);
      slopes.push((vals[b] - vals[a]) / (b - a));
    }
    slopes.sort((x, y) => x - y);
    const m = slopes.length;
    slope[i] = m % 2 ? slopes[(m - 1) / 2] : (slopes[m / 2 - 1] + slopes[m / 2]) / 2;
    const z = s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0;
    zmap[i] = z;
    const c = z <= -1.96 ? 1 : z >= 1.96 ? 3 : 2;
    sig[i] = c;
    counts[c] += 1;
  }
  const total = counts[1] + counts[2] + counts[3] || 1;
  return {
    slope: singleBand(series[0], slope),
    z: singleBand(series[0], zmap),
    significance: singleBand(series[0], sig, 0),
    table: {
      columns: ["trend (95%)", "cells", "percent"],
      rows: [["Significant decrease", counts[1], round((counts[1] / total) * 100)], ["No significant trend", counts[2], round((counts[2] / total) * 100)], ["Significant increase", counts[3], round((counts[3] / total) * 100)]],
    } as Table,
  };
}
