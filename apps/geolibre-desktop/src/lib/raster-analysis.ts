// Raster analysis for the Defani edition: zonal statistics written into a
// polygon layer's attribute table, and change detection between two dates
// (continuous difference with thresholds, or a categorical transition matrix).

import type { RasterData } from "@geolibre/processing";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { resolveEpsgProjection } from "./epsg-proj4";

/** EPSG code of a raster from its GeoKeys (4326 when unknown). */
export function rasterEpsg(raster: RasterData): number {
  const keys = raster.geoKeys as Record<string, number | undefined>;
  return Number(keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? 4326);
}

function isNoData(value: number, nodata: number | null): boolean {
  return !Number.isFinite(value) || (nodata !== null && value === nodata);
}

/** Area of one cell in hectares (approximate for geographic rasters, at `lat`). */
function cellAreaHa(raster: RasterData, geographic: boolean, lat: number): number {
  if (!geographic) return (raster.resX * raster.resY) / 10_000;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  return (raster.resX * mPerDegLon * raster.resY * mPerDegLat) / 10_000;
}

function pointInRing(x: number, y: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygons(x: number, y: number, polygons: Position[][][]): boolean {
  for (const rings of polygons) {
    if (!rings.length || !pointInRing(x, y, rings[0])) continue;
    let hole = false;
    for (let h = 1; h < rings.length; h += 1) if (pointInRing(x, y, rings[h])) hole = true;
    if (!hole) return true;
  }
  return false;
}

export type ZonalStat = "mean" | "min" | "max" | "sum" | "std" | "count" | "majority" | "area_ha";

/**
 * Add zonal statistics of `raster` (band 1) for every polygon of `fc` as new
 * attributes `<prefix><stat>`. Polygons are reprojected to the raster's CRS;
 * a cell counts when its centre lies inside the polygon.
 */
export async function zonalStatistics(
  raster: RasterData,
  fc: FeatureCollection,
  stats: ZonalStat[],
  prefix: string,
): Promise<{ collection: FeatureCollection; processed: number }> {
  const epsg = rasterEpsg(raster);
  const projection = epsg === 4326 ? null : await resolveEpsgProjection(epsg);
  if (epsg !== 4326 && !projection) throw new Error(`The raster's CRS (EPSG:${epsg}) is not supported.`);
  const geographic = !projection || projection.geographic;
  const toRaster = projection && !projection.geographic ? projection.proj4("EPSG:4326", projection.definition) : null;
  const band = raster.bands[0];
  const { width, height, originX, originY, resX, resY, nodata } = raster;
  const flipY = raster.flipY === true;
  let processed = 0;

  const features = fc.features.map((feature): Feature => {
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) return feature;
    const polygonsLonLat = geometry.type === "Polygon" ? [(geometry as Polygon).coordinates] : (geometry as MultiPolygon).coordinates;
    const polygons = polygonsLonLat.map((rings) =>
      rings.map((ring) => ring.map((p) => (toRaster ? (toRaster.forward([p[0], p[1]]) as Position) : p))),
    );
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rings of polygons) for (const [x, y] of rings[0] ?? []) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const col0 = Math.max(0, Math.floor((minX - originX) / resX));
    const col1 = Math.min(width - 1, Math.ceil((maxX - originX) / resX));
    const rowFor = (y: number) => (flipY ? (y - originY) / resY : (originY - y) / resY);
    const rowA = rowFor(maxY);
    const rowB = rowFor(minY);
    const row0 = Math.max(0, Math.floor(Math.min(rowA, rowB)));
    const row1 = Math.min(height - 1, Math.ceil(Math.max(rowA, rowB)));
    const values: number[] = [];
    for (let row = row0; row <= row1; row += 1) {
      const cy = flipY ? originY + (row + 0.5) * resY : originY - (row + 0.5) * resY;
      for (let col = col0; col <= col1; col += 1) {
        const cx = originX + (col + 0.5) * resX;
        if (!pointInPolygons(cx, cy, polygons)) continue;
        const v = band[row * width + col];
        if (!isNoData(v, nodata)) values.push(v);
      }
    }
    processed += 1;
    const props: Record<string, unknown> = { ...(feature.properties ?? {}) };
    const n = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = n ? sum / n : null;
    const centreLat = (polygonsLonLat[0]?.[0]?.reduce((a, p) => a + p[1], 0) ?? 0) / Math.max(1, polygonsLonLat[0]?.[0]?.length ?? 1);
    for (const stat of stats) {
      let value: number | null = null;
      if (stat === "count") value = n;
      else if (!n) value = null;
      else if (stat === "mean") value = mean;
      else if (stat === "sum") value = sum;
      else if (stat === "min") value = Math.min(...values);
      else if (stat === "max") value = Math.max(...values);
      else if (stat === "std") value = Math.sqrt(values.reduce((a, v) => a + (v - mean!) ** 2, 0) / n);
      else if (stat === "majority") {
        const counts = new Map<number, number>();
        for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
        value = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      } else if (stat === "area_ha") value = n * cellAreaHa(raster, geographic, centreLat);
      props[`${prefix}${stat}`] = value === null ? null : Math.round(value * 1e6) / 1e6;
    }
    return { ...feature, properties: props };
  });
  return { collection: { ...fc, features }, processed };
}

export interface ChangeSummaryRow {
  label: string;
  cells: number;
  hectares: number;
  percent: number;
}

/**
 * Continuous change (after − before) classified with a threshold:
 * 1 = decrease (loss), 2 = no change, 3 = increase (gain).
 */
export function continuousChange(
  before: RasterData,
  after: RasterData,
  threshold: number,
): { diff: RasterData; classes: RasterData; summary: ChangeSummaryRow[] } {
  const n = before.width * before.height;
  const diff = new Float32Array(n);
  const cls = new Float32Array(n);
  const NODATA = -9999;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    const a = before.bands[0][i];
    const b = after.bands[0][i];
    if (isNoData(a, before.nodata) || isNoData(b, after.nodata)) {
      diff[i] = NODATA;
      cls[i] = 0;
      continue;
    }
    const d = b - a;
    diff[i] = d;
    const c = d < -threshold ? 1 : d > threshold ? 3 : 2;
    cls[i] = c;
    counts[c] += 1;
  }
  const epsg = rasterEpsg(before);
  const area = cellAreaHa(before, epsg === 4326 || epsg === 4269, before.originY - (before.height * before.resY) / 2);
  const total = counts[1] + counts[2] + counts[3] || 1;
  const labels = ["", "Decrease (loss)", "No change", "Increase (gain)"];
  return {
    diff: { ...before, bands: [diff], nodata: NODATA },
    classes: { ...before, bands: [cls], nodata: 0 },
    summary: [1, 2, 3].map((c) => ({
      label: labels[c],
      cells: counts[c],
      hectares: Math.round(counts[c] * area * 100) / 100,
      percent: Math.round((counts[c] / total) * 10_000) / 100,
    })),
  };
}

/** Categorical transitions: from-class × to-class areas, plus a transition raster (from*1000 + to). */
export function transitionMatrix(
  before: RasterData,
  after: RasterData,
): { raster: RasterData; classes: number[]; matrixHa: number[][]; cellHa: number } {
  const n = before.width * before.height;
  const out = new Float32Array(n);
  const counts = new Map<string, number>();
  const classSet = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    const a = before.bands[0][i];
    const b = after.bands[0][i];
    if (isNoData(a, before.nodata) || isNoData(b, after.nodata)) continue;
    const from = Math.round(a);
    const to = Math.round(b);
    classSet.add(from);
    classSet.add(to);
    out[i] = from * 1000 + to;
    const key = `${from}|${to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (classSet.size > 40) throw new Error(`Found ${classSet.size} distinct values: the rasters look continuous. Use “Continuous difference” instead.`);
  const classes = [...classSet].sort((x, y) => x - y);
  const epsg = rasterEpsg(before);
  const cellHa = cellAreaHa(before, epsg === 4326 || epsg === 4269, before.originY - (before.height * before.resY) / 2);
  const matrixHa = classes.map((from) =>
    classes.map((to) => Math.round((counts.get(`${from}|${to}`) ?? 0) * cellHa * 100) / 100),
  );
  return { raster: { ...before, bands: [out], nodata: 0 }, classes, matrixHa, cellHa };
}
