// Raster grid helpers for the Defani edition's Analysis Toolkit: CRS
// conversion between WGS84 vectors and a raster's grid, cell areas and
// distances in metres, rasterising features, and small result builders.

import type { RasterData } from "@geolibre/processing";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { resolveEpsgProjection } from "../epsg-proj4";

export const NODATA = -9999;

export function isNoData(value: number, nodata: number | null): boolean {
  return !Number.isFinite(value) || (nodata !== null && value === nodata);
}

export function rasterEpsg(raster: RasterData): number {
  const keys = raster.geoKeys as Record<string, number | undefined>;
  return Number(keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? 4326);
}

/** Converters between WGS84 lon/lat and the raster's CRS, plus its units. */
export interface GridFrame {
  geographic: boolean;
  toGrid: (lonLat: Position) => Position;
  toLonLat: (xy: Position) => Position;
  /** Metres per CRS unit along x and y (1 for projected grids in metres). */
  metresX: number;
  metresY: number;
}

export async function gridFrame(raster: RasterData): Promise<GridFrame> {
  const epsg = rasterEpsg(raster);
  const midLat = () => {
    const y = raster.flipY ? raster.originY + (raster.height * raster.resY) / 2 : raster.originY - (raster.height * raster.resY) / 2;
    return y;
  };
  if (epsg === 4326 || epsg === 4269) {
    const lat = midLat();
    return {
      geographic: true,
      toGrid: (p) => p,
      toLonLat: (p) => p,
      metresX: 111_320 * Math.cos((lat * Math.PI) / 180),
      metresY: 110_574,
    };
  }
  const projection = await resolveEpsgProjection(epsg);
  if (!projection) throw new Error(`The raster's CRS (EPSG:${epsg}) is not supported.`);
  if (projection.geographic) {
    const lat = midLat();
    return { geographic: true, toGrid: (p) => p, toLonLat: (p) => p, metresX: 111_320 * Math.cos((lat * Math.PI) / 180), metresY: 110_574 };
  }
  const converter = projection.proj4("EPSG:4326", projection.definition);
  return {
    geographic: false,
    toGrid: (p) => converter.forward([p[0], p[1]]) as Position,
    toLonLat: (p) => converter.inverse([p[0], p[1]]) as Position,
    metresX: 1,
    metresY: 1,
  };
}

export function cellCentre(raster: RasterData, col: number, row: number): Position {
  const x = raster.originX + (col + 0.5) * raster.resX * (raster.flipX ? -1 : 1);
  const y = raster.flipY ? raster.originY + (row + 0.5) * raster.resY : raster.originY - (row + 0.5) * raster.resY;
  return [x, y];
}

export function gridToCell(raster: RasterData, xy: Position): [number, number] {
  const col = Math.floor(((xy[0] - raster.originX) / raster.resX) * (raster.flipX ? -1 : 1));
  const row = Math.floor(raster.flipY ? (xy[1] - raster.originY) / raster.resY : (raster.originY - xy[1]) / raster.resY);
  return [col, row];
}

/** Cell area in hectares and cell size in metres. */
export function cellMetrics(raster: RasterData, frame: GridFrame) {
  const sx = raster.resX * frame.metresX;
  const sy = raster.resY * frame.metresY;
  return { cellHa: (sx * sy) / 10_000, sizeX: sx, sizeY: sy, size: Math.sqrt(sx * sy) };
}

export function sameGrid(a: RasterData, b: RasterData, nameA: string, nameB: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`"${nameA}" is ${a.width}×${a.height} but "${nameB}" is ${b.width}×${b.height}: the rasters must share one grid.`);
  }
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

export function pointInPolygons(x: number, y: number, polygons: Position[][][]): boolean {
  for (const rings of polygons) {
    if (!rings.length || !pointInRing(x, y, rings[0])) continue;
    let hole = false;
    for (let h = 1; h < rings.length; h += 1) if (pointInRing(x, y, rings[h])) hole = true;
    if (!hole) return true;
  }
  return false;
}

/** A geometry's polygons, reprojected to the grid's CRS. */
export function polygonsInGrid(geometry: Geometry | null, frame: GridFrame): Position[][][] {
  if (!geometry) return [];
  const polys =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polys.map((rings) => rings.map((ring) => ring.map((p) => frame.toGrid(p))));
}

/** Visit every cell whose centre lies inside the polygons. */
export function forEachCellInPolygons(
  raster: RasterData,
  polygons: Position[][][],
  visit: (index: number, col: number, row: number) => void,
): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of polygons) for (const [x, y] of rings[0] ?? []) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return;
  const [c0, r0] = gridToCell(raster, [minX, maxY]);
  const [c1, r1] = gridToCell(raster, [maxX, minY]);
  const colA = Math.max(0, Math.min(c0, c1)), colB = Math.min(raster.width - 1, Math.max(c0, c1));
  const rowA = Math.max(0, Math.min(r0, r1)), rowB = Math.min(raster.height - 1, Math.max(r0, r1));
  for (let row = rowA; row <= rowB; row += 1) {
    for (let col = colA; col <= colB; col += 1) {
      const [cx, cy] = cellCentre(raster, col, row);
      if (pointInPolygons(cx, cy, polygons)) visit(row * raster.width + col, col, row);
    }
  }
}

/**
 * Burn features into a mask on the raster's grid: polygons by cell centre,
 * lines by sampling every half cell, points into their cell. Returns 1 where
 * a feature is.
 */
export function rasterizeFeatures(raster: RasterData, fc: FeatureCollection, frame: GridFrame): Uint8Array {
  const mask = new Uint8Array(raster.width * raster.height);
  const burn = (xy: Position) => {
    const [col, row] = gridToCell(raster, xy);
    if (col >= 0 && row >= 0 && col < raster.width && row < raster.height) mask[row * raster.width + col] = 1;
  };
  const step = Math.min(raster.resX, raster.resY) / 2;
  const line = (coords: Position[]) => {
    const pts = coords.map((p) => frame.toGrid(p));
    for (let i = 1; i < pts.length; i += 1) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let k = 0; k <= n; k += 1) burn([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    }
  };
  const visit = (g: Geometry | null) => {
    if (!g) return;
    switch (g.type) {
      case "Point": burn(frame.toGrid(g.coordinates)); break;
      case "MultiPoint": g.coordinates.forEach((p) => burn(frame.toGrid(p))); break;
      case "LineString": line(g.coordinates); break;
      case "MultiLineString": g.coordinates.forEach(line); break;
      case "Polygon":
      case "MultiPolygon":
        forEachCellInPolygons(raster, polygonsInGrid(g, frame), (i) => (mask[i] = 1));
        (g.type === "Polygon" ? [g.coordinates] : g.coordinates).forEach((rings) => rings.forEach(line));
        break;
      case "GeometryCollection": g.geometries.forEach(visit); break;
    }
  };
  fc.features.forEach((f) => visit(f.geometry));
  return mask;
}

export function singleBand(template: RasterData, data: Float32Array, nodata: number | null = NODATA): RasterData {
  return { ...template, bands: [data], nodata };
}

/** Great-circle distance in metres. */
export function haversine(a: Position, b: Position): number {
  const R = 6_371_008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pointFeature(lonLat: Position, properties: Record<string, unknown>): Feature {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: lonLat } };
}

export const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
