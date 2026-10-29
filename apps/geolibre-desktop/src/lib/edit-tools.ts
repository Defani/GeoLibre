// Digitizing tools (Defani edition): ArcGIS Pro "Modify Features" style
// operations on the features selected in the selected vector layer. Every tool
// is one store update, so Edit › Undo reverts it.

import { featureSelectionId, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { getGeometryEditTargetLayerId } from "@geolibre/plugins";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Geometry, LineString, MultiPolygon, Polygon, Position } from "geojson";

export interface EditParam {
  id: string;
  label: string;
  default: string;
  /** Free text instead of a number. */
  text?: boolean;
  options?: Array<[value: string, label: string]>;
}

export interface EditResult {
  /** Replace the selected features with these. */
  replace?: Feature[];
  /** Append to the layer. */
  add?: Feature[];
  /** Write to a new layer instead (geometry type changes). */
  newLayer?: { name: string; features: Feature[] };
  message?: string;
}

export interface EditTool {
  id: string;
  label: string;
  help: string;
  /** "selection" needs selected features; "layer" works on the layer itself. */
  needs: "selection" | "layer";
  params?: EditParam[];
  run: (selected: Feature[], p: Record<string, string>, layer: GeoLibreLayer) => EditResult;
}

const num = (v: string | undefined, d: number) => (v === undefined || v.trim() === "" || !Number.isFinite(Number(v)) ? d : Number(v));
const isPoly = (g: Geometry | null) => g?.type === "Polygon" || g?.type === "MultiPolygon";
const isLine = (g: Geometry | null) => g?.type === "LineString" || g?.type === "MultiLineString";
const keep = (f: Feature, geometry: Geometry): Feature => ({ type: "Feature", id: f.id, properties: { ...(f.properties ?? {}) }, geometry });
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Every single part of a geometry. */
function parts(g: Geometry): Geometry[] {
  switch (g.type) {
    case "MultiPoint": return g.coordinates.map((c) => ({ type: "Point", coordinates: c }));
    case "MultiLineString": return g.coordinates.map((c) => ({ type: "LineString", coordinates: c }));
    case "MultiPolygon": return g.coordinates.map((c) => ({ type: "Polygon", coordinates: c }));
    case "GeometryCollection": return g.geometries.flatMap(parts);
    default: return [g];
  }
}

/** Parse "lon lat, lon lat, …" or one pair per line (decimal degrees). */
function parseCoords(text: string): Position[] {
  return text
    .split(/[\n;]+|,(?=\s*-?\d+(?:\.\d+)?\s+-?\d)/)
    .map((pair) => pair.trim().split(/[\s,]+/).map(Number))
    .filter((p) => p.length >= 2 && p.every(Number.isFinite))
    .map(([x, y]) => [x, y]);
}

export const EDIT_TOOLS: EditTool[] = [
  {
    id: "explode", label: "Explode", needs: "selection",
    help: "Split multipart features into single-part features (attributes copied).",
    run: (sel) => ({ replace: sel.flatMap((f) => (f.geometry ? parts(f.geometry).map((g) => keep({ ...f, id: undefined }, g)) : [f])) }),
  },
  {
    id: "merge", label: "Merge", needs: "selection",
    help: "Merge the selected polygons into one feature (keeps the first feature's attributes).",
    run: (sel) => {
      const polys = sel.filter((f) => isPoly(f.geometry)) as Feature<Polygon | MultiPolygon>[];
      if (polys.length < 2) throw new Error("Select at least two polygons to merge.");
      const merged = turf.union(turf.featureCollection(polys));
      if (!merged) throw new Error("The polygons could not be merged.");
      return { replace: [keep(polys[0], merged.geometry)] };
    },
  },
  {
    id: "buffer", label: "Buffer", needs: "selection",
    help: "Buffer the selected features by a distance. Results go to a new polygon layer.",
    params: [{ id: "d", label: "Distance (m)", default: "100" }],
    run: (sel, p, layer) => ({
      newLayer: {
        name: `${layer.name}_buffer`,
        features: sel.map((f) => turf.buffer(f, num(p.d, 100), { units: "meters" })).filter(Boolean).map((b, i) => keep(sel[i], b!.geometry)),
      },
    }),
  },
  {
    id: "generalize", label: "Generalize", needs: "selection",
    help: "Remove vertices within a tolerance (Douglas-Peucker), like ArcGIS Generalize.",
    params: [{ id: "t", label: "Tolerance (m)", default: "10" }],
    run: (sel, p) => ({ replace: sel.map((f) => turf.simplify(f, { tolerance: num(p.t, 10) / 111_320, highQuality: true })) }),
  },
  {
    id: "smooth", label: "Smooth", needs: "selection",
    help: "Round corners of polygons (Chaikin) or lines (Bezier curve).",
    params: [{ id: "n", label: "Iterations", default: "2" }],
    run: (sel, p) => ({
      replace: sel.map((f) => {
        if (isPoly(f.geometry)) return keep(f, turf.polygonSmooth(f as Feature<Polygon>, { iterations: num(p.n, 2) }).features[0].geometry);
        if (f.geometry?.type === "LineString") return keep(f, turf.bezierSpline(f as Feature<LineString>, { resolution: 10000 }).geometry);
        return f;
      }),
    }),
  },
  {
    id: "densify", label: "Densify", needs: "selection",
    help: "Add vertices so no segment is longer than the distance.",
    params: [{ id: "d", label: "Max segment (m)", default: "50" }],
    run: (sel, p) => {
      const step = num(p.d, 50) / 1000;
      const dens = (line: Position[]): Position[] => {
        const out: Position[] = [line[0]];
        for (let i = 1; i < line.length; i += 1) {
          const a = line[i - 1], b = line[i];
          const len = turf.distance(a, b);
          const n = Math.floor(len / step);
          for (let k = 1; k < n; k += 1) out.push(turf.along(turf.lineString([a, b]), (len * k) / n).geometry.coordinates);
          out.push(b);
        }
        return out;
      };
      const g = (geom: Geometry): Geometry => {
        switch (geom.type) {
          case "LineString": return { ...geom, coordinates: dens(geom.coordinates) };
          case "MultiLineString": case "Polygon": return { ...geom, coordinates: geom.coordinates.map(dens) } as Geometry;
          case "MultiPolygon": return { ...geom, coordinates: geom.coordinates.map((poly) => poly.map(dens)) };
          default: return geom;
        }
      };
      return { replace: sel.map((f) => (f.geometry ? keep(f, g(f.geometry)) : f)) };
    },
  },
  {
    id: "reverse", label: "Flip Line", needs: "selection",
    help: "Reverse the direction of the selected lines.",
    run: (sel) => ({
      replace: sel.map((f) => {
        const g = f.geometry;
        if (g?.type === "LineString") return keep(f, { ...g, coordinates: [...g.coordinates].reverse() });
        if (g?.type === "MultiLineString") return keep(f, { ...g, coordinates: g.coordinates.map((c) => [...c].reverse()).reverse() });
        return f;
      }),
    }),
  },
  {
    id: "fill-holes", label: "Remove Holes", needs: "selection",
    help: "Delete the inner rings (holes) of the selected polygons.",
    run: (sel) => ({
      replace: sel.map((f) => {
        const g = f.geometry;
        if (g?.type === "Polygon") return keep(f, { ...g, coordinates: [g.coordinates[0]] });
        if (g?.type === "MultiPolygon") return keep(f, { ...g, coordinates: g.coordinates.map((poly) => [poly[0]]) });
        return f;
      }),
    }),
  },
  {
    id: "repair", label: "Repair Geometry", needs: "selection",
    help: "Remove duplicate vertices, fix ring orientation and split self-intersecting polygons.",
    run: (sel) => ({
      replace: sel.flatMap((f) => {
        if (!f.geometry) return [f];
        let g = turf.cleanCoords(f).geometry as Geometry;
        if (g.type === "Polygon" && turf.kinks(g as Polygon).features.length) {
          return turf.unkinkPolygon(g as Polygon).features.map((x) => keep(f, x.geometry));
        }
        g = turf.rewind(g as Polygon, { reverse: false }) as Geometry;
        return [keep(f, g)];
      }),
    }),
  },
  {
    id: "move", label: "Move By", needs: "selection",
    help: "Shift the selected features east/north by a distance in metres (negative = west/south).",
    params: [{ id: "dx", label: "East (m)", default: "0" }, { id: "dy", label: "North (m)", default: "0" }],
    run: (sel, p) => {
      const dx = num(p.dx, 0), dy = num(p.dy, 0);
      const dist = Math.hypot(dx, dy);
      if (!dist) return { replace: sel };
      const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
      return { replace: sel.map((f) => turf.transformTranslate(f, dist, bearing, { units: "meters" })) };
    },
  },
  {
    id: "rotate", label: "Rotate By", needs: "selection",
    help: "Rotate the selected features around their centre by an angle (clockwise degrees).",
    params: [{ id: "a", label: "Angle (°)", default: "90" }],
    run: (sel, p) => ({ replace: sel.map((f) => turf.transformRotate(f, num(p.a, 90))) }),
  },
  {
    id: "scale", label: "Scale By", needs: "selection",
    help: "Resize the selected features around their centre (2 = twice as large).",
    params: [{ id: "s", label: "Factor", default: "2" }],
    run: (sel, p) => ({ replace: sel.map((f) => turf.transformScale(f, num(p.s, 2))) }),
  },
  {
    id: "offset", label: "Parallel Copy", needs: "selection",
    help: "Copy the selected lines at an offset distance (positive = right side).",
    params: [{ id: "d", label: "Offset (m)", default: "20" }],
    run: (sel, p) => ({
      add: sel.filter((f) => isLine(f.geometry)).map((f) => keep(f, turf.lineOffset(f as Feature<LineString>, num(p.d, 20), { units: "meters" }).geometry)),
    }),
  },
  {
    id: "line-to-polygon", label: "Line To Polygon", needs: "selection",
    help: "Close the selected lines into polygons (new layer).",
    run: (sel, _p, layer) => ({
      newLayer: { name: `${layer.name}_polygon`, features: sel.filter((f) => isLine(f.geometry)).map((f) => keep(f, turf.lineToPolygon(f as Feature<LineString>).geometry as Geometry)) },
    }),
  },
  {
    id: "polygon-to-line", label: "Polygon To Line", needs: "selection",
    help: "Convert the selected polygon outlines to lines (new layer).",
    run: (sel, _p, layer) => ({
      newLayer: {
        name: `${layer.name}_line`,
        features: sel.filter((f) => isPoly(f.geometry)).flatMap((f) => {
          const out = turf.polygonToLine(f as Feature<Polygon>);
          return ("features" in out ? out.features : [out]).map((x) => keep(f, x.geometry as Geometry));
        }),
      },
    }),
  },
  {
    id: "centroid", label: "Feature To Point", needs: "selection",
    help: "A point inside each selected feature (new point layer).",
    run: (sel, _p, layer) => ({ newLayer: { name: `${layer.name}_point`, features: sel.map((f) => keep(f, turf.pointOnFeature(f).geometry)) } }),
  },
  {
    id: "vertices", label: "Vertices To Points", needs: "selection",
    help: "Every vertex of the selected features as a point with its x, y (new layer).",
    run: (sel, _p, layer) => ({
      newLayer: {
        name: `${layer.name}_vertices`,
        features: sel.flatMap((f) => turf.explode(f).features.map((v, i) => ({ type: "Feature" as const, properties: { ...(f.properties ?? {}), vertex: i + 1, x: round(v.geometry.coordinates[0], 7), y: round(v.geometry.coordinates[1], 7) }, geometry: v.geometry }))),
      },
    }),
  },
  {
    id: "clip-by", label: "Clip Selected", needs: "selection",
    help: "Cut every other selected polygon by the first selected polygon (keeps the inside).",
    run: (sel) => {
      const polys = sel.filter((f) => isPoly(f.geometry)) as Feature<Polygon | MultiPolygon>[];
      if (polys.length < 2) throw new Error("Select the clipping polygon first, then the polygons to clip.");
      const [clip, ...rest] = polys;
      return {
        replace: [clip, ...rest.map((f) => {
          const r = turf.intersect(turf.featureCollection([f, clip]));
          return r ? keep(f, r.geometry) : null;
        }).filter((f): f is Feature => !!f)],
      };
    },
  },
  {
    id: "erase-by", label: "Erase Selected", needs: "selection",
    help: "Remove the first selected polygon's area from the other selected polygons.",
    run: (sel) => {
      const polys = sel.filter((f) => isPoly(f.geometry)) as Feature<Polygon | MultiPolygon>[];
      if (polys.length < 2) throw new Error("Select the erasing polygon first, then the polygons to cut.");
      const [eraser, ...rest] = polys;
      return {
        replace: [eraser, ...rest.map((f) => {
          const r = turf.difference(turf.featureCollection([f, eraser]));
          return r ? keep(f, r.geometry) : null;
        }).filter((f): f is Feature => !!f)],
      };
    },
  },
  {
    id: "calc-geometry", label: "Calculate Geometry", needs: "layer",
    help: "Write area (ha), perimeter / length (m) and centroid x, y to the attributes of the selected features (or all features when none is selected).",
    run: () => ({ replace: [] }),
  },
  {
    id: "create-xy", label: "Create From XY", needs: "layer",
    help: "Add a feature from typed coordinates: one 'lon lat' pair per line (decimal degrees). One pair makes a point, two or more a line, three or more a polygon when the layer holds polygons.",
    params: [{ id: "c", label: "Coordinates", default: "106.8272 -6.1754", text: true }],
    run: (_sel, p, layer) => {
      const coords = parseCoords(p.c ?? "");
      if (!coords.length) throw new Error("Type at least one 'lon lat' pair.");
      const sample = layer.geojson?.features.find((f) => f.geometry)?.geometry;
      let geometry: Geometry;
      if (coords.length === 1) geometry = { type: "Point", coordinates: coords[0] };
      else if (coords.length >= 3 && (!sample || isPoly(sample))) geometry = { type: "Polygon", coordinates: [[...coords, coords[0]]] };
      else geometry = { type: "LineString", coordinates: coords };
      return { add: [{ type: "Feature", properties: {}, geometry }] };
    },
  },
  {
    id: "copy-to-layer", label: "Copy To New Layer", needs: "selection",
    help: "Copy the selected features into a new layer.",
    run: (sel, _p, layer) => ({ newLayer: { name: `${layer.name}_selection`, features: sel.map((f) => keep(f, f.geometry!)) } }),
  },
  {
    id: "delete", label: "Delete Selected", needs: "selection",
    help: "Delete the selected features (Undo brings them back).",
    run: () => ({ replace: [] }),
  },
];

/** Run a tool on the selected layer; returns a status line. */
export function runEditTool(tool: EditTool, params: Record<string, string>): string {
  const s = useAppStore.getState();
  const layer = s.layers.find((l) => l.id === s.selectedLayerId);
  if (!layer?.geojson) throw new Error("Select a vector layer in Contents first.");
  if (getGeometryEditTargetLayerId() === layer.id) throw new Error("Save or discard the open edit session on this layer first (Edit › Save).");
  const all = layer.geojson.features;
  const ids = new Set(s.selectedFeatureIds);
  const selectedIdx = all.map((f, i) => (ids.has(featureSelectionId(f, i)) ? i : -1)).filter((i) => i >= 0);
  if (tool.needs === "selection" && !selectedIdx.length) throw new Error("Select one or more features first (Map › Select).");
  const selected = selectedIdx.map((i) => all[i]);

  if (tool.id === "calc-geometry") {
    const targets = new Set(selectedIdx.length ? selectedIdx : all.map((_, i) => i));
    const features = all.map((f, i) => {
      if (!targets.has(i) || !f.geometry) return f;
      const props: Record<string, unknown> = { ...(f.properties ?? {}) };
      const c = turf.centroid(f).geometry.coordinates;
      if (isPoly(f.geometry)) {
        props.area_ha = round(turf.area(f) / 10_000, 4);
        props.perim_m = round(turf.length(turf.polygonToLine(f as Feature<Polygon>) as never, { units: "meters" }), 2);
      } else if (isLine(f.geometry)) props.length_m = round(turf.length(f, { units: "meters" }), 2);
      props.x = round(c[0], 7);
      props.y = round(c[1], 7);
      return { ...f, properties: props };
    });
    s.updateLayer(layer.id, { geojson: { ...layer.geojson, features } });
    return `Geometry attributes written to ${targets.size} feature(s).`;
  }

  const result = tool.run(selected, params, layer);
  if (result.newLayer) {
    if (!result.newLayer.features.length) throw new Error("Nothing to write: the selection has no suitable features.");
    const fc: FeatureCollection = { type: "FeatureCollection", features: result.newLayer.features };
    const keepSelection = s.selectedFeatureIds;
    s.addGeoJsonLayer(result.newLayer.name, fc);
    // The edited layer stays the target, with its selection, like ArcGIS.
    useAppStore.getState().selectLayer(layer.id);
    useAppStore.getState().selectFeatures(keepSelection, keepSelection[keepSelection.length - 1] ?? null);
    return `New layer "${result.newLayer.name}" (${fc.features.length} features).`;
  }
  let features = all;
  let resultStart = all.length;
  if (result.replace) {
    const drop = new Set(selectedIdx);
    const first = selectedIdx[0] ?? all.length;
    const before = all.slice(0, first).filter((_, i) => !drop.has(i));
    resultStart = before.length;
    features = [...before, ...result.replace, ...all.slice(first).filter((_, i) => !drop.has(i + first))];
  }
  const replaced = result.replace?.length ?? 0;
  const addedAt = features.length;
  if (result.add) features = [...features, ...result.add];
  s.updateLayer(layer.id, { geojson: { ...layer.geojson, features } });
  // Keep the result selected so tools can be chained.
  const resultIdx = [
    ...Array.from({ length: replaced }, (_, k) => resultStart + k),
    ...Array.from({ length: result.add?.length ?? 0 }, (_, k) => addedAt + k),
  ];
  const nextIds = resultIdx.map((i) => featureSelectionId(features[i], i));
  s.selectFeatures(nextIds, nextIds[nextIds.length - 1] ?? null);
  const changed = (result.replace?.length ?? 0) + (result.add?.length ?? 0);
  return result.message ?? (tool.id === "delete" ? `${selected.length} feature(s) deleted.` : `${tool.label}: ${changed} feature(s) written.`);
}
