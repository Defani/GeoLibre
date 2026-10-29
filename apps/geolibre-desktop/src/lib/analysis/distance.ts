// Distance analysis (Defani edition): Euclidean distance raster (exact EDT),
// cost distance with least-cost path, and a near table between layers.

import type { RasterData } from "@geolibre/processing";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { cellCentre, cellMetrics, gridFrame, gridToCell, haversine, isNoData, NODATA, rasterizeFeatures, round, singleBand } from "./grid";

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array, w2: number) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const inter = (q: number, p: number) => (f[q] + w2 * q * q - (f[p] + w2 * p * p)) / (2 * w2 * (q - p));
  for (let q = 1; q < n; q += 1) {
    let s = inter(q, v[k]);
    while (s <= z[k]) {
      k -= 1;
      s = inter(q, v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    d[q] = w2 * (q - v[k]) ** 2 + f[v[k]];
  }
}

/** Distance in metres from every cell to the nearest feature, on `template`'s grid. */
export async function euclideanDistance(template: RasterData, features: FeatureCollection, maxM?: number) {
  const frame = await gridFrame(template);
  const { sizeX, sizeY } = cellMetrics(template, frame);
  const { width: w, height: h } = template;
  const mask = rasterizeFeatures(template, features, frame);
  if (!mask.some((v) => v)) throw new Error("No feature falls on the template raster.");
  const INF = 1e20;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i += 1) g[i] = mask[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z, sizeY * sizeY);
    for (let y = 0; y < h; y += 1) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z, sizeX * sizeX);
    for (let x = 0; x < w; x += 1) g[y * w + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const m = Math.sqrt(g[i]);
    out[i] = maxM && m > maxM ? NODATA : m;
  }
  return singleBand(template, out);
}

/** Accumulated cost from a source (8-neighbour Dijkstra) and the least-cost path to a destination. */
export async function costDistance(cost: RasterData, source: Position, destination?: Position) {
  const frame = await gridFrame(cost);
  const { sizeX, sizeY } = cellMetrics(cost, frame);
  const { width: w, height: h } = cost;
  const c = cost.bands[0];
  const toCell = (p: Position) => {
    const [x, y] = gridToCell(cost, frame.toGrid(p));
    if (x < 0 || y < 0 || x >= w || y >= h) throw new Error("A point is outside the cost raster.");
    return y * w + x;
  };
  const start = toCell(source);
  const acc = new Float64Array(w * h).fill(Infinity);
  const from = new Int32Array(w * h).fill(-1);
  acc[start] = 0;
  // Binary heap on accumulated cost.
  const heapI: number[] = [start], heapK: number[] = [0];
  const push = (i: number, k: number) => {
    heapI.push(i); heapK.push(k);
    let j = heapI.length - 1;
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (heapK[p] <= heapK[j]) break;
      [heapK[p], heapK[j]] = [heapK[j], heapK[p]]; [heapI[p], heapI[j]] = [heapI[j], heapI[p]];
      j = p;
    }
  };
  const pop = () => {
    const i = heapI[0], k = heapK[0];
    const li = heapI.pop()!, lk = heapK.pop()!;
    if (heapI.length) {
      heapI[0] = li; heapK[0] = lk;
      let j = 0;
      for (;;) {
        const l = 2 * j + 1, r = l + 1;
        let m = j;
        if (l < heapI.length && heapK[l] < heapK[m]) m = l;
        if (r < heapI.length && heapK[r] < heapK[m]) m = r;
        if (m === j) break;
        [heapK[m], heapK[j]] = [heapK[j], heapK[m]]; [heapI[m], heapI[j]] = [heapI[j], heapI[m]];
        j = m;
      }
    }
    return [i, k] as const;
  };
  while (heapI.length) {
    const [i, k] = pop();
    if (k > acc[i]) continue;
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      const cj = c[j], ci = c[i];
      if (isNoData(cj, cost.nodata) || cj < 0) continue;
      const step = Math.hypot(dx * sizeX, dy * sizeY) * ((ci + cj) / 2);
      const next = k + step;
      if (next < acc[j]) { acc[j] = next; from[j] = i; push(j, next); }
    }
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) out[i] = Number.isFinite(acc[i]) ? acc[i] : NODATA;
  let path: Feature | null = null;
  let pathCost: number | null = null;
  if (destination) {
    let i = toCell(destination);
    if (!Number.isFinite(acc[i])) throw new Error("The destination cannot be reached from the source.");
    pathCost = acc[i];
    const coords: Position[] = [];
    while (i >= 0) {
      const x = i % w, y = (i - x) / w;
      const ll = frame.toLonLat(cellCentre(cost, x, y));
      coords.push([round(ll[0], 7), round(ll[1], 7)]);
      i = from[i];
    }
    coords.reverse();
    let lengthM = 0;
    for (let k = 1; k < coords.length; k += 1) lengthM += haversine(coords[k - 1], coords[k]);
    path = { type: "Feature", properties: { cost: round(pathCost, 3), length_m: round(lengthM, 1) }, geometry: { type: "LineString", coordinates: coords } };
  }
  return { accumulated: singleBand(cost, out), path, pathCost };
}

function vertices(g: Geometry | null, out: Position[] = []): Position[] {
  if (!g) return out;
  switch (g.type) {
    case "Point": out.push(g.coordinates); break;
    case "MultiPoint": case "LineString": out.push(...g.coordinates); break;
    case "MultiLineString": case "Polygon": g.coordinates.forEach((r) => out.push(...r)); break;
    case "MultiPolygon": g.coordinates.forEach((p) => p.forEach((r) => out.push(...r))); break;
    case "GeometryCollection": g.geometries.forEach((x) => vertices(x, out)); break;
  }
  return out;
}

/** Distance from a point to a segment, metres, on a local equirectangular plane. */
function pointSegmentM(p: Position, a: Position, b: Position): number {
  const lat = (p[1] * Math.PI) / 180;
  const kx = 111_320 * Math.cos(lat), ky = 110_574;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function segments(g: Geometry | null): Array<[Position, Position]> {
  const out: Array<[Position, Position]> = [];
  const add = (line: Position[]) => { for (let i = 1; i < line.length; i += 1) out.push([line[i - 1], line[i]]); };
  if (!g) return out;
  if (g.type === "LineString") add(g.coordinates);
  else if (g.type === "MultiLineString" || g.type === "Polygon") g.coordinates.forEach(add);
  else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => p.forEach(add));
  return out;
}

/** For every input feature, the nearest feature of `near` (id + distance in metres) as new fields. */
export function nearTable(input: FeatureCollection, near: FeatureCollection, idField: string, prefix: string): FeatureCollection {
  const targets = near.features.map((f, k) => ({
    id: idField && f.properties?.[idField] !== undefined ? f.properties[idField] : k + 1,
    pts: vertices(f.geometry),
    segs: segments(f.geometry),
  }));
  const features = input.features.map((f): Feature => {
    const origin = vertices(f.geometry);
    const probe = origin.length === 1 ? origin : origin.filter((_, i) => i % Math.max(1, Math.floor(origin.length / 50)) === 0);
    let best = Infinity, bestId: unknown = null;
    for (const t of targets) {
      for (const p of probe) {
        for (const q of t.pts) { const d = haversine(p, q); if (d < best) { best = d; bestId = t.id; } }
        for (const [a, b] of t.segs) { const d = pointSegmentM(p, a, b); if (d < best) { best = d; bestId = t.id; } }
      }
    }
    return { ...f, properties: { ...(f.properties ?? {}), [`${prefix}id`]: bestId, [`${prefix}dist_m`]: Number.isFinite(best) ? round(best, 1) : null } };
  });
  return { ...input, features };
}
