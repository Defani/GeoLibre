// Terrain and hydrology (Defani edition): fill sinks, D8 flow direction and
// accumulation, streams, watershed from a pour point, viewshed, cut / fill,
// and terrain indices (TPI, TRI, curvature, TWI).

import type { RasterData } from "@geolibre/processing";
import type { Position } from "geojson";
import { cellMetrics, gridFrame, gridToCell, isNoData, NODATA, round, sameGrid, singleBand } from "./grid";
import type { Table } from "./forest";

const D8 = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
] as const;
// ESRI D8 codes for the directions above (E, SE, S, SW, W, NW, N, NE).
const ESRI_CODE = [1, 2, 4, 8, 16, 32, 64, 128];

/** Min-heap of cell indices keyed by a Float64 priority. */
class Heap {
  private keys: number[] = [];
  private items: number[] = [];
  get size() { return this.items.length; }
  push(item: number, key: number) {
    const k = this.keys, it = this.items;
    k.push(key); it.push(item);
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [it[p], it[i]] = [it[i], it[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.keys, it = this.items;
    const top: [number, number] = [it[0], k[0]];
    const lastK = k.pop()!, lastI = it.pop()!;
    if (it.length) {
      k[0] = lastK; it[0] = lastI;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < it.length && k[l] < k[m]) m = l;
        if (r < it.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [it[m], it[i]] = [it[i], it[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Priority-flood depression filling (Barnes et al.) with a tiny gradient so flats drain. */
export function fillSinks(dem: RasterData): RasterData {
  const { width: w, height: h } = dem;
  const z = Float32Array.from(dem.bands[0]);
  const done = new Uint8Array(w * h);
  const heap = new Heap();
  for (let i = 0; i < w * h; i += 1) {
    const x = i % w, y = (i - x) / w;
    if (isNoData(z[i], dem.nodata)) { done[i] = 1; continue; }
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { heap.push(i, z[i]); done[i] = 1; }
  }
  while (heap.size) {
    const [i, zi] = heap.pop();
    const x = i % w, y = (i - x) / w;
    for (const [dx, dy] of D8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (done[j]) continue;
      done[j] = 1;
      if (z[j] <= zi) z[j] = zi + 1e-5;
      heap.push(j, z[j]);
    }
  }
  return { ...dem, bands: [z] };
}

/** D8 flow direction (index into D8, -1 = none) and the ESRI-coded raster. */
export async function flowDirection(filled: RasterData) {
  const frame = await gridFrame(filled);
  const { sizeX, sizeY } = cellMetrics(filled, frame);
  const { width: w, height: h } = filled;
  const z = filled.bands[0];
  const dir = new Int8Array(w * h).fill(-1);
  const esri = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    if (isNoData(z[i], filled.nodata)) continue;
    const x = i % w, y = (i - x) / w;
    let best = 0, bestK = -1;
    D8.forEach(([dx, dy], k) => {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const j = ny * w + nx;
      if (isNoData(z[j], filled.nodata)) return;
      const drop = (z[i] - z[j]) / Math.hypot(dx * sizeX, dy * sizeY);
      if (drop > best) { best = drop; bestK = k; }
    });
    dir[i] = bestK;
    esri[i] = bestK >= 0 ? ESRI_CODE[bestK] : 0;
  }
  return { dir, esri: singleBand(filled, esri, 0) };
}

/** Flow accumulation (upstream cell count), processing cells from highest to lowest. */
export function flowAccumulation(filled: RasterData, dir: Int8Array): RasterData {
  const { width: w, height: h } = filled;
  const z = filled.bands[0];
  const order = Array.from({ length: w * h }, (_, i) => i).filter((i) => !isNoData(z[i], filled.nodata));
  order.sort((a, b) => z[b] - z[a]);
  const acc = new Float32Array(w * h);
  for (const i of order) {
    acc[i] += 1;
    const k = dir[i];
    if (k < 0) continue;
    const x = i % w, y = (i - x) / w;
    const j = (y + D8[k][1]) * w + (x + D8[k][0]);
    acc[j] += acc[i];
  }
  for (let i = 0; i < w * h; i += 1) if (isNoData(z[i], filled.nodata)) acc[i] = NODATA;
  return singleBand(filled, acc);
}

/** All cells draining to the pour point (snapped to the highest accumulation within `snap` cells). */
export async function watershed(dir: Int8Array, acc: RasterData, pour: Position, snap = 5) {
  const frame = await gridFrame(acc);
  const { width: w, height: h } = acc;
  let [col, row] = gridToCell(acc, frame.toGrid(pour));
  if (col < 0 || row < 0 || col >= w || row >= h) throw new Error("The pour point is outside the DEM.");
  let best = acc.bands[0][row * w + col];
  for (let dy = -snap; dy <= snap; dy += 1) for (let dx = -snap; dx <= snap; dx += 1) {
    const x = col + dx, y = row + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const v = acc.bands[0][y * w + x];
    if (v > best) { best = v; col = x; row = y; }
  }
  const mask = new Float32Array(w * h);
  const outlet = row * w + col;
  mask[outlet] = 1;
  const stack = [outlet];
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    D8.forEach(([dx, dy]) => {
      const nx = x - dx, ny = y - dy; // neighbour that may flow into i
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const j = ny * w + nx;
      const k = dir[j];
      if (k >= 0 && !mask[j] && nx + D8[k][0] === x && ny + D8[k][1] === y) {
        mask[j] = 1;
        stack.push(j);
      }
    });
  }
  const { cellHa } = cellMetrics(acc, frame);
  const cells = mask.reduce((s, v) => s + v, 0);
  return { mask: singleBand(acc, mask, 0), areaHa: cells * cellHa };
}

/** Line-of-sight viewshed from an observer (height above ground, metres). */
export async function viewshed(dem: RasterData, observer: Position, observerHeight: number, radiusM: number) {
  const frame = await gridFrame(dem);
  const { sizeX, sizeY, cellHa } = cellMetrics(dem, frame);
  const { width: w, height: h } = dem;
  const z = dem.bands[0];
  const [ox, oy] = gridToCell(dem, frame.toGrid(observer));
  if (ox < 0 || oy < 0 || ox >= w || oy >= h) throw new Error("The observer is outside the DEM.");
  const z0 = z[oy * w + ox] + observerHeight;
  const rx = Math.ceil(radiusM / sizeX), ry = Math.ceil(radiusM / sizeY);
  const out = new Float32Array(w * h);
  let visible = 0;
  for (let y = Math.max(0, oy - ry); y <= Math.min(h - 1, oy + ry); y += 1) {
    for (let x = Math.max(0, ox - rx); x <= Math.min(w - 1, ox + rx); x += 1) {
      const dxm = (x - ox) * sizeX, dym = (y - oy) * sizeY;
      const dist = Math.hypot(dxm, dym);
      if (dist > radiusM) continue;
      const target = z[y * w + x];
      if (isNoData(target, dem.nodata)) continue;
      const steps = Math.max(Math.abs(x - ox), Math.abs(y - oy));
      const targetSlope = (target - z0) / Math.max(dist, 1e-6);
      let seen = true;
      for (let s = 1; s < steps; s += 1) {
        const sx = Math.round(ox + ((x - ox) * s) / steps), sy = Math.round(oy + ((y - oy) * s) / steps);
        const zs = z[sy * w + sx];
        const d = Math.hypot((sx - ox) * sizeX, (sy - oy) * sizeY);
        if ((zs - z0) / Math.max(d, 1e-6) > targetSlope) { seen = false; break; }
      }
      if (seen) { out[y * w + x] = 1; visible += 1; }
    }
  }
  return { raster: singleBand(dem, out, 0), visibleHa: visible * cellHa };
}

/** Cut and fill between two surfaces (or a surface and a flat level). */
export async function cutFill(before: RasterData, after: RasterData | number) {
  const frame = await gridFrame(before);
  const { sizeX, sizeY } = cellMetrics(before, frame);
  if (typeof after !== "number") sameGrid(before, after, "before", "after");
  const n = before.width * before.height;
  const diff = new Float32Array(n);
  let cut = 0, fill = 0;
  for (let i = 0; i < n; i += 1) {
    const a = before.bands[0][i];
    const b = typeof after === "number" ? after : after.bands[0][i];
    if (isNoData(a, before.nodata) || (typeof after !== "number" && isNoData(b, after.nodata))) { diff[i] = NODATA; continue; }
    const d = b - a;
    diff[i] = d;
    const v = Math.abs(d) * sizeX * sizeY;
    if (d < 0) cut += v; else fill += v;
  }
  return {
    raster: singleBand(before, diff),
    table: { columns: ["", "m³"], rows: [["Cut (removed)", round(cut)], ["Fill (added)", round(fill)], ["Net (fill − cut)", round(fill - cut)]] } as Table,
  };
}

/** TPI (focal mean difference), TRI (Riley), curvature (Zevenbergen-Thorne), TWI. */
export async function terrainIndex(dem: RasterData, index: "tpi" | "tri" | "curvature" | "twi", radius = 3) {
  const frame = await gridFrame(dem);
  const { sizeX, sizeY, size } = cellMetrics(dem, frame);
  const { width: w, height: h } = dem;
  const z = dem.bands[0];
  const at = (x: number, y: number) => z[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const out = new Float32Array(w * h);
  if (index === "twi") {
    const filled = fillSinks(dem);
    const { dir } = await flowDirection(filled);
    const acc = flowAccumulation(filled, dir);
    for (let i = 0; i < w * h; i += 1) {
      const x = i % w, y = (i - x) / w;
      if (isNoData(z[i], dem.nodata)) { out[i] = NODATA; continue; }
      const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * sizeX);
      const dzdy = (at(x, y + 1) - at(x, y - 1)) / (2 * sizeY);
      const tanB = Math.max(Math.hypot(dzdx, dzdy), 0.001);
      out[i] = Math.log(((acc.bands[0][i] + 1) * size) / tanB);
    }
    return singleBand(dem, out);
  }
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    if (isNoData(z[i], dem.nodata)) { out[i] = NODATA; continue; }
    if (index === "tpi") {
      let s = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
        if (!dx && !dy) continue;
        const v = at(x + dx, y + dy);
        if (!isNoData(v, dem.nodata)) { s += v; n += 1; }
      }
      out[i] = n ? z[i] - s / n : 0;
    } else if (index === "tri") {
      let s = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) s += (at(x + dx, y + dy) - z[i]) ** 2;
      out[i] = Math.sqrt(s);
    } else {
      const D = ((at(x - 1, y) + at(x + 1, y)) / 2 - z[i]) / (sizeX * sizeX);
      const E = ((at(x, y - 1) + at(x, y + 1)) / 2 - z[i]) / (sizeY * sizeY);
      out[i] = -2 * (D + E) * 100;
    }
  }
  return singleBand(dem, out);
}
