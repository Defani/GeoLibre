// ArcGIS Pro-style ribbon for the Data View (Defani edition): Map, Insert,
// Analysis, View, Edit, Imagery and Share tabs, plus contextual Feature Layer
// and Raster Layer tabs for the layer selected in Contents. Each button runs an
// existing GeoLibre handler (published commands, store actions or the native
// tool windows), so the ribbon adds no second implementation of a tool.

import { featureSelectionId, redo, undo, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { closeRightPanel, getActiveRightPanel, openRightPanel } from "@geolibre/plugins/right-panel-registry";
import { getGeometryEditTargetLayerId, subscribeGeometryEdit } from "@geolibre/plugins";
import { writeUint8Bands, type RasterData } from "@geolibre/processing";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import {
  BarChart3,
  Bookmark,
  BookOpen,
  Box,
  Boxes,
  Brain,
  Circle,
  ClipboardList,
  Combine,
  Compass,
  Copy,
  Crosshair,
  Database,
  Download,
  Eraser,
  FileImage,
  FilePlus2,
  FileUp,
  Filter,
  FolderOpen,
  FolderTree,
  Globe2,
  Grid2x2,
  Hand,
  History,
  Image,
  Layers,
  LayoutTemplate,
  Lasso,
  Link2,
  ListTree,
  Locate,
  Magnet,
  Map as MapIcon,
  Maximize,
  MousePointer2,
  Move,
  Package,
  PanelRight,
  Pencil,
  Pentagon,
  Plus,
  Redo2,
  RotateCw,
  Ruler,
  Save,
  Scaling,
  ScanSearch,
  Scissors,
  Search,
  SquareDashed,
  SquareFunction,
  Table2,
  Tag,
  Terminal,
  Trash2,
  Undo2,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
  Activity, Cpu, Languages, Power, ArrowLeftRight, Bird, MapPin, Bot, Calculator, Clock, Code2, Columns2, Dot, Eye, EyeOff, FileText, Flame, Hexagon, Info, Keyboard, LocateFixed, Merge, MessageSquare, Minus, Moon, Mountain, MoreHorizontal, Navigation, Network, Palette, Printer, RefreshCw, Route, Satellite, Server, Settings, Shapes, Share2, ShieldCheck, Shuffle, Sigma, Signal, SlidersHorizontal, Smartphone, Sparkles, Spline, Split, Stethoscope, Sun, Target, Timer, Trees, TrendingUp, Type, Video, Wand2, Waves, Wrench,
} from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useHeaderHost } from "../../lib/header-host";
import { openRecentProject, useCommandRegistry } from "../../lib/command-registry";
import { openAboutDialog } from "./ProjectBackstage";
import { EDIT_TOOLS, runEditTool, type EditTool } from "../../lib/edit-tools";
import { openClearCacheDialog } from "./ClearCacheDialog";
import { openSettingsSection } from "./SettingsDialog";
import { MapScaleBox } from "./ProViewTabs";
import { createPortal } from "react-dom";
import { openAnalysisTool } from "../processing/AnalysisToolkitWindow";
import { openChangeDetection, openZonalStatistics } from "../processing/AnalysisWindows";
import { openRasterCalculator } from "../processing/RasterCalculatorWindow";
import { BROWSER_PANEL_ID } from "../../hooks/useRegisterBrowserPanel";
import { openCommandSearch, runCommand } from "../../lib/command-registry";
import { getEditorActions } from "../../lib/editor-actions";
import { saveBinaryFileWithFallback } from "../../lib/file-io/file-dialogs";
import { readLocalFileBytes } from "../../lib/file-io/local-fs";
import { setWorkspaceView, useLayoutViewStore } from "../../lib/layout-view";
import { ASSISTANT_PANEL_ID, DATA_INDONESIA_PANEL_ID, EARTH_ENGINE_PANEL_ID, KOBO_PANEL_ID, openNativePanel, SDM_PANEL_ID } from "../../lib/native-panels";
import { notifyProcess } from "../../lib/process-notify";
import { openProcessingToolbox, PROCESSING_TOOLBOX_PANEL_ID, useProcessingToolboxStore } from "../../lib/processing-toolbox";
import { getShellActions } from "../../lib/shell-actions";
import { exportVectorLayer, type VectorExportFormat } from "../../lib/vector-export";
import { applyKlhkSymbologyToAll } from "../../lib/klhk-auto-style";

// --- map access ---------------------------------------------------------------

interface MapLike {
  getCanvas: () => HTMLCanvasElement;
  getContainer: () => HTMLElement;
  project: (p: [number, number]) => { x: number; y: number };
  unproject: (p: [number, number]) => { lng: number; lat: number };
  getBounds: () => { toArray: () => [[number, number], [number, number]] };
  getZoom: () => number;
  getPitch: () => number;
  zoomIn: () => void;
  zoomOut: () => void;
  fitBounds: (b: [[number, number], [number, number]], o?: Record<string, unknown>) => void;
  flyTo: (o: Record<string, unknown>) => void;
  easeTo: (o: Record<string, unknown>) => void;
  once: (type: string, cb: () => void) => void;
  triggerRepaint: () => void;
  getSource: (id: string) => { setData?: (d: unknown) => void } | undefined;
  addSource: (id: string, s: Record<string, unknown>) => void;
  getLayer: (id: string) => unknown;
  addLayer: (l: Record<string, unknown>) => void;
  setTerrain: (t: Record<string, unknown> | null) => void;
  getTerrain?: () => unknown;
  dragPan: { enable: () => void; disable: () => void };
  doubleClickZoom: { enable: () => void; disable: () => void };
}

const getMap = () => (getShellActions()?.getAppApi() as { getMap?: () => MapLike | null } | undefined)?.getMap?.() ?? null;
const store = () => useAppStore.getState();

const INDONESIA: [[number, number], [number, number]] = [[94.5, -11.5], [141.5, 6.5]];

function eachPosition(g: Geometry | null | undefined, cb: (p: Position) => void) {
  if (!g) return;
  switch (g.type) {
    case "Point": cb(g.coordinates); break;
    case "MultiPoint": case "LineString": g.coordinates.forEach(cb); break;
    case "MultiLineString": case "Polygon": g.coordinates.forEach((r) => r.forEach(cb)); break;
    case "MultiPolygon": g.coordinates.forEach((p) => p.forEach((r) => r.forEach(cb))); break;
    case "GeometryCollection": g.geometries.forEach((x) => eachPosition(x, cb)); break;
  }
}

function boundsOf(fcs: FeatureCollection[]): [[number, number], [number, number]] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const fc of fcs) for (const f of fc.features) eachPosition(f.geometry, ([x, y]) => {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  });
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

function layerBounds(layer: GeoLibreLayer): [[number, number], [number, number]] | null {
  if (layer.geojson) return boundsOf([layer.geojson]);
  const b = (layer.source as { bounds?: number[] }).bounds;
  return Array.isArray(b) && b.length === 4 ? [[b[0], b[1]], [b[2], b[3]]] : null;
}

function zoomToLayer(layer: GeoLibreLayer) {
  const b = layerBounds(layer);
  if (b) getMap()?.fitBounds(b, { padding: 40, duration: 600 });
}

function fullExtent() {
  const fcs = store().layers.filter((l) => l.visible && l.geojson?.features.length).map((l) => l.geojson!);
  getMap()?.fitBounds(boundsOf(fcs) ?? INDONESIA, { padding: 40, duration: 600 });
}

// --- Go To XY -------------------------------------------------------------------

/** Parse "106.8", "106°49'12\" E", "6 12 30 S" into decimal degrees. */
export function parseCoordinate(text: string): number {
  const t = text.trim().toUpperCase();
  const nums = t.match(/-?\d+(?:[.,]\d+)?/g)?.map((n) => Number(n.replace(",", "."))) ?? [];
  if (!nums.length) return NaN;
  const [d, m = 0, s = 0] = nums;
  let value = Math.abs(d) + m / 60 + s / 3600;
  if (d < 0 || /[SW]/.test(t)) value = -value;
  return value;
}

function goToXY(lon: number, lat: number) {
  const map = getMap();
  if (!map) return;
  const data = { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [lon, lat] } }] };
  const src = map.getSource("tfg-goto-xy");
  if (src?.setData) src.setData(data);
  else {
    map.addSource("tfg-goto-xy", { type: "geojson", data });
    map.addLayer({ id: "tfg-goto-xy", type: "circle", source: "tfg-goto-xy", paint: { "circle-radius": 7, "circle-color": "#0079C1", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 } });
  }
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 14), duration: 900 });
}

// --- interactive selection ------------------------------------------------------

type SelectMode = "rectangle" | "lasso" | "polygon" | "circle" | "zoomin" | "zoomout";

function pointInPolygon(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function featureContainsLonLat(g: Geometry | null, lon: number, lat: number): boolean {
  if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some((p) => pointInPolygon(lon, lat, p[0] as Array<[number, number]>) && !p.slice(1).some((h) => pointInPolygon(lon, lat, h as Array<[number, number]>)));
}

/** The layer selection tools act on: the one selected in Contents, else the top visible vector layer. */
function selectionTarget(): GeoLibreLayer | null {
  const s = store();
  const selected = s.layers.find((l) => l.id === s.selectedLayerId);
  if (selected?.geojson) return selected;
  return [...s.layers].reverse().find((l) => l.visible && l.geojson?.features.length) ?? null;
}

function selectInScreenShape(shape: Array<[number, number]>, add: boolean) {
  const map = getMap();
  const layer = selectionTarget();
  if (!map || !layer?.geojson) {
    notifyProcess({ kind: "error", title: "Select", message: "Select a vector layer in Contents first (large DuckDB-tiled layers are selected with Select By Attributes)." });
    return;
  }
  const xs = shape.map((p) => p[0]), ys = shape.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const centre = map.unproject([(minX + maxX) / 2, (minY + maxY) / 2]);
  const ids: string[] = [];
  layer.geojson.features.forEach((f: Feature, index) => {
    let hit = false;
    let count = 0;
    const stride = 1;
    eachPosition(f.geometry, (pos) => {
      count += 1;
      if (hit || count % stride) return;
      const p = map.project([pos[0], pos[1]]);
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY && pointInPolygon(p.x, p.y, shape)) hit = true;
    });
    if (!hit) hit = featureContainsLonLat(f.geometry, centre.lng, centre.lat);
    if (hit) ids.push(featureSelectionId(f, index));
  });
  const s = store();
  if (s.selectedLayerId !== layer.id) s.selectLayer(layer.id);
  const next = add ? Array.from(new Set([...useAppStore.getState().selectedFeatureIds, ...ids])) : ids;
  useAppStore.getState().selectFeatures(next, next[next.length - 1] ?? null);
  notifyProcess({ kind: "success", title: "Select", message: `${next.length} feature(s) selected in "${layer.name}".` });
}

function SelectionOverlay({ mode, onDone }: { mode: SelectMode; onDone: () => void }) {
  const map = getMap();
  const [pts, setPts] = useState<Array<[number, number]>>([]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const drag = useRef<{ start: [number, number]; shift: boolean } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onDone();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  if (!map) return null;
  const container = map.getContainer();
  const local = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = container.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const circlePoly = (c: [number, number], q: [number, number]) => {
    const r = Math.hypot(q[0] - c[0], q[1] - c[1]);
    return Array.from({ length: 48 }, (_, i) => [c[0] + r * Math.cos((i / 48) * 2 * Math.PI), c[1] + r * Math.sin((i / 48) * 2 * Math.PI)] as [number, number]);
  };
  const finish = (shape: Array<[number, number]>, shift: boolean) => {
    if (shape.length >= 3) selectInScreenShape(shape, shift);
    setPts([]);
  };
  const isBox = mode === "rectangle" || mode === "zoomin" || mode === "zoomout";
  const drawn: Array<[number, number]> =
    isBox && pts.length === 2
      ? [pts[0], [pts[1][0], pts[0][1]], pts[1], [pts[0][0], pts[1][1]]]
      : mode === "circle" && pts.length === 2
        ? circlePoly(pts[0], pts[1])
        : mode === "polygon" && hover
          ? [...pts, hover]
          : pts;
  return createPortal(
    <div
      className="tfg-select-overlay"
      onPointerDown={(e) => {
        if (e.button !== 0 || mode === "polygon") return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const p = local(e);
        drag.current = { start: p, shift: e.shiftKey };
        setPts(mode === "lasso" ? [p] : [p, p]);
      }}
      onPointerMove={(e) => {
        const p = local(e);
        if (mode === "polygon") { setHover(p); return; }
        if (!drag.current) return;
        setPts((c) => (mode === "lasso" ? [...c, p] : [drag.current!.start, p]));
      }}
      onPointerUp={(e) => {
        if (!drag.current || mode === "polygon") return;
        const shift = drag.current.shift;
        drag.current = null;
        const p = local(e);
        if (mode === "zoomin" || mode === "zoomout") {
          // ArcMap Zoom In / Zoom Out tools: drag a box, or click for one step.
          const [a] = pts;
          setPts([]);
          const click = Math.hypot(p[0] - a[0], p[1] - a[1]) < 6;
          const zoom = map.getZoom();
          if (click) {
            const at = map.unproject(p);
            map.easeTo({ center: [at.lng, at.lat], zoom: zoom + (mode === "zoomin" ? 1 : -1), duration: 350 });
          } else if (mode === "zoomin") {
            const sw = map.unproject([Math.min(a[0], p[0]), Math.max(a[1], p[1])]);
            const ne = map.unproject([Math.max(a[0], p[0]), Math.min(a[1], p[1])]);
            map.fitBounds([[sw.lng, sw.lat], [ne.lng, ne.lat]], { duration: 400, padding: 0 });
          } else {
            const cv = map.getCanvas();
            const ratio = Math.min(cv.clientWidth / Math.max(4, Math.abs(p[0] - a[0])), cv.clientHeight / Math.max(4, Math.abs(p[1] - a[1])));
            const mid = map.unproject([(a[0] + p[0]) / 2, (a[1] + p[1]) / 2]);
            map.easeTo({ center: [mid.lng, mid.lat], zoom: zoom - Math.log2(Math.max(1.2, ratio)), duration: 400 });
          }
          return;
        }
        if (mode === "rectangle") {
          const [a] = pts;
          // A plain click selects what is under the cursor (a 6 px box).
          const box: Array<[number, number]> = Math.hypot(p[0] - a[0], p[1] - a[1]) < 4
            ? [[p[0] - 3, p[1] - 3], [p[0] + 3, p[1] - 3], [p[0] + 3, p[1] + 3], [p[0] - 3, p[1] + 3]]
            : [a, [p[0], a[1]], p, [a[0], p[1]]];
          finish(box, shift);
        } else if (mode === "circle") finish(circlePoly(pts[0], p), shift);
        else finish([...pts, p], shift);
      }}
      onClick={(e) => {
        if (mode !== "polygon") return;
        setPts((c) => [...c, local(e)]);
      }}
      onDoubleClick={(e) => {
        if (mode !== "polygon") return;
        finish(pts, e.shiftKey);
        setHover(null);
      }}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        {drawn.length > 1 ? (
          <polygon points={drawn.map((p) => p.join(",")).join(" ")} fill="rgba(0,121,193,0.15)" stroke="#0079C1" strokeWidth="1.6" strokeDasharray="5 3" />
        ) : null}
      </svg>
      <div className="tfg-select-hint">
        {mode === "zoomin" ? "Zoom In: drag a box or click" : mode === "zoomout" ? "Zoom Out: drag a box or click" : mode === "polygon" ? "Click vertices, double-click to finish" : mode === "lasso" ? "Drag a freehand shape" : mode === "circle" ? "Drag from the centre" : "Drag a box or click a feature"}
        {mode === "zoomin" || mode === "zoomout" ? " · Esc ends" : " · Shift adds · Esc ends"}
      </div>
    </div>,
    container,
  );
}

// --- export map / package project ---------------------------------------------------

async function captureMap(): Promise<{ canvas: HTMLCanvasElement; bounds: [[number, number], [number, number]] }> {
  const map = getMap();
  if (!map) throw new Error("The map is not ready.");
  // Read the frame inside the render callback, while the drawing buffer is still valid.
  return new Promise((resolve) => {
    map.once("render", () => {
      const src = map.getCanvas();
      const copy = document.createElement("canvas");
      copy.width = src.width;
      copy.height = src.height;
      copy.getContext("2d")!.drawImage(src, 0, 0);
      resolve({ canvas: copy, bounds: map.getBounds().toArray() });
    });
    map.triggerRepaint();
  });
}

const MERC = 6378137;
const mercX = (lon: number) => (lon * Math.PI * MERC) / 180;
const mercY = (lat: number) => MERC * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

async function exportMap(format: "png" | "jpg" | "pdf" | "tif") {
  const name = (store().projectName || "map").replace(/[^\w-]+/g, "_");
  try {
    const { canvas, bounds } = await captureMap();
    let bytes: Uint8Array;
    let mime = "image/png";
    if (format === "png" || format === "jpg") {
      mime = format === "png" ? "image/png" : "image/jpeg";
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), mime, 0.92));
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else if (format === "pdf") {
      mime = "application/pdf";
      const { jsPDF } = await import("jspdf");
      const landscape = canvas.width >= canvas.height;
      const pdf = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "px", format: [canvas.width, canvas.height] });
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, canvas.width, canvas.height);
      bytes = new Uint8Array(pdf.output("arraybuffer"));
    } else {
      mime = "image/tiff";
      const { width, height } = canvas;
      const rgba = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
      const r = new Uint8Array(width * height), g = new Uint8Array(width * height), b = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i += 1) { r[i] = rgba[i * 4]; g[i] = rgba[i * 4 + 1]; b[i] = rgba[i * 4 + 2]; }
      const [[w, s], [e, n]] = bounds;
      const grid: RasterData = {
        bands: [], width, height,
        originX: mercX(w), originY: mercY(n),
        resX: (mercX(e) - mercX(w)) / width, resY: (mercY(n) - mercY(s)) / height,
        nodata: null,
        geoKeys: { GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857 },
      };
      bytes = new Uint8Array(writeUint8Bands(grid, [r, g, b], null));
    }
    const ext = format;
    const path = await saveBinaryFileWithFallback(bytes, {
      defaultName: `${name}.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
      browserTypes: [{ description: format.toUpperCase(), accept: { [mime]: [`.${ext}`] } }],
      mimeType: mime,
    });
    if (path) notifyProcess({ kind: "success", title: "Export Map", message: `Saved ${path}` });
  } catch (error) {
    notifyProcess({ kind: "error", title: "Export Map", message: error instanceof Error ? error.message : String(error) });
  }
}

const SIDECARS = ["shx", "dbf", "prj", "cpg", "qmd", "sbn", "sbx", "aux.xml", "tfw"];

async function packageProject() {
  try {
    const { zipSync, strToU8 } = await import("fflate");
    const { buildProjectSnapshot } = await import("../../lib/build-project-snapshot");
    const project = buildProjectSnapshot({ current: null });
    const files: Record<string, Uint8Array> = {};
    const layers = await Promise.all(
      project.layers.map(async (layer) => {
        const path = (layer as GeoLibreLayer & { sourcePath?: string }).sourcePath;
        if (!path) return layer;
        const base = path.split(/[\\/]/).pop()!;
        try {
          files[`data/${base}`] = new Uint8Array(await readLocalFileBytes(path));
          const stem = path.replace(/\.[^.\\/]+$/, "");
          for (const ext of SIDECARS) {
            try { files[`data/${base.replace(/\.[^.]+$/, "")}.${ext}`] = new Uint8Array(await readLocalFileBytes(`${stem}.${ext}`)); } catch { /* optional */ }
          }
          return { ...layer, sourcePath: `data/${base}` };
        } catch {
          return layer;
        }
      }),
    );
    files["project.geolibre"] = strToU8(JSON.stringify({ ...project, layers }, null, 1));
    const zip = zipSync(files, { level: 6 });
    const name = (store().projectName || "project").replace(/[^\w-]+/g, "_");
    const path = await saveBinaryFileWithFallback(zip, {
      defaultName: `${name}_package.zip`,
      filters: [{ name: "Project package", extensions: ["zip"] }],
      browserTypes: [{ description: "Project package", accept: { "application/zip": [".zip"] } }],
      mimeType: "application/zip",
    });
    if (path) notifyProcess({ kind: "success", title: "Package Project", message: `${Object.keys(files).length} files packed into ${path}` });
  } catch (error) {
    notifyProcess({ kind: "error", title: "Package Project", message: error instanceof Error ? error.message : String(error) });
  }
}

// --- editing helpers ---------------------------------------------------------------

/** Press a button of the digitizing toolbar (snapping, rotate, split…) by its title. */
function editorTool(pattern: RegExp): boolean {
  const button = Array.from(document.querySelectorAll<HTMLElement>(".geo-editor-control button, .geo-editor-control [role=button]"))
    .find((b) => pattern.test(`${b.title} ${b.getAttribute("aria-label") ?? ""} ${b.dataset.tool ?? ""}`));
  if (!button) {
    notifyProcess({ kind: "error", title: "Edit", message: "Start editing a layer first (Edit › Start)." });
    return false;
  }
  button.click();
  return true;
}

async function newSketchLayer(kind: string) {
  const s = store();
  const id = s.addGeoJsonLayer(`New ${kind}`, { type: "FeatureCollection", features: [] });
  s.selectLayer(id);
  await getEditorActions()?.toggle(id);
}

// --- 3D ------------------------------------------------------------------------------

function toggle3D() {
  const map = getMap();
  if (!map) return;
  const is3D = map.getPitch() > 5;
  if (is3D) {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    return;
  }
  if (!map.getSource("tfg-terrain")) {
    map.addSource("tfg-terrain", {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 14,
    });
  }
  map.setTerrain({ source: "tfg-terrain", exaggeration: 1.5 });
  map.easeTo({ pitch: 60, duration: 900 });
}

// --- definition query --------------------------------------------------------------------

/** `FIELD = 'x'`, `FIELD > 10`, `FIELD IN ('a','b')`, `FIELD LIKE 'Hutan%'`, joined by AND / OR. */
export function parseDefinitionQuery(text: string): unknown[] | null {
  const q = text.trim();
  if (!q) return null;
  const value = (raw: string): string | number => {
    const t = raw.trim();
    if (/^'.*'$|^".*"$/.test(t)) return t.slice(1, -1);
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  };
  const clause = (c: string): unknown[] => {
    const m = c.trim().match(/^"?([\w.]+)"?\s*(=|==|!=|<>|>=|<=|>|<|IN|NOT IN|LIKE)\s*(.+)$/i);
    if (!m) throw new Error(`Cannot read "${c.trim()}". Use FIELD = 'value', FIELD > 10, FIELD IN ('a','b') or FIELD LIKE 'a%'.`);
    const [, field, rawOp, rest] = m;
    const op = rawOp.toUpperCase();
    const get = ["get", field];
    if (op === "IN" || op === "NOT IN") {
      const list = rest.replace(/^\(|\)$/g, "").split(",").map(value);
      const numeric = list.every((v) => typeof v === "number");
      const inExpr = ["in", numeric ? ["to-number", get] : ["to-string", get], ["literal", numeric ? list : list.map(String)]];
      return op === "IN" ? inExpr : ["!", inExpr];
    }
    if (op === "LIKE") {
      const pattern = String(value(rest));
      const core = pattern.replace(/%/g, "");
      const s = ["downcase", ["to-string", get]];
      if (pattern.startsWith("%") && pattern.endsWith("%")) return ["in", core.toLowerCase(), s];
      if (pattern.endsWith("%")) return ["==", ["slice", s, 0, core.length], core.toLowerCase()];
      if (pattern.startsWith("%")) return ["in", core.toLowerCase(), s];
      return ["==", s, core.toLowerCase()];
    }
    const mlOp = op === "=" ? "==" : op === "<>" ? "!=" : op;
    const v = value(rest);
    return [mlOp, typeof v === "number" ? ["to-number", get] : ["to-string", get], v];
  };
  const ors = q.split(/\s+OR\s+/i).map((part) => {
    const ands = part.split(/\s+AND\s+/i).map(clause);
    return ands.length === 1 ? ands[0] : ["all", ...ands];
  });
  return ors.length === 1 ? ors[0] : ["any", ...ors];
}

// --- UI primitives ---------------------------------------------------------------------

function Big({ icon: Icon, label, color, onClick, active, title, disabled }: { icon: LucideIcon; label: string; color: string; onClick: () => void; active?: boolean; title?: string; disabled?: boolean }) {
  return (
    <button type="button" className={`pr-big${active ? " is-active" : ""}`} onClick={onClick} title={title ?? label} disabled={disabled}>
      <Icon style={{ color }} strokeWidth={1.7} />
      <span>{label}</span>
    </button>
  );
}

function Small({ icon: Icon, label, color, onClick, active, title, disabled }: { icon: LucideIcon; label: string; color: string; onClick: () => void; active?: boolean; title?: string; disabled?: boolean }) {
  return (
    <button type="button" className={`pr-small${active ? " is-active" : ""}`} onClick={onClick} title={title ?? label} disabled={disabled}>
      <Icon style={{ color }} strokeWidth={1.8} />
      <span>{label}</span>
    </button>
  );
}

/** Groups the ribbon folded into a single drop-down button because the tab did not fit. */
const FitContext = createContext<Set<string>>(new Set());

function Group({ label, children, collapsible, icon, color }: { label: string; children: ReactNode; collapsible?: boolean; icon?: LucideIcon; color?: string }) {
  const folded = useContext(FitContext);
  const [open, setOpen] = useState(false);
  if (collapsible && folded.has(label)) {
    return (
      <div className="pr-group" data-group={label}>
        <div className="pr-group-body">
          <Popover
            open={open}
            onClose={() => setOpen(false)}
            className="pr-group-pop"
            anchor={<Big icon={icon ?? Layers} label={label} color={color ?? C.blue} active={open} onClick={() => setOpen((o) => !o)} />}
          >
            <div className="pr-group-pop-title">{label}</div>
            <div className="pr-group-pop-body" onClick={(e) => (e.target as HTMLElement).closest("button") && setOpen(false)}>{children}</div>
          </Popover>
        </div>
        <div className="pr-group-label">{label} ▾</div>
      </div>
    );
  }
  return (
    <div className="pr-group" data-group={label} data-collapsible={collapsible || undefined}>
      <div className="pr-group-body">{children}</div>
      <div className="pr-group-label">{label}</div>
    </div>
  );
}

const Stack = ({ children }: { children: ReactNode }) => <div className="pr-stack">{children}</div>;

/** A ribbon drop-down: floats over the map (portal) so the ribbon's scroll box does not clip it. */
function Popover({ open, onClose, anchor, className, children }: { open: boolean; onClose: () => void; anchor: ReactNode; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 2 });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popRef.current?.contains(t)) closeRef.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref}>
      {anchor}
      {open && pos
        ? createPortal(
            <div ref={popRef} className={`pr-pop ${className ?? ""}`} style={{ position: "fixed", left: pos.left, top: pos.top }}>
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// Ribbon palette (ArcGIS Pro-like tints).
const C = { blue: "#0079C1", sky: "#4FB0EA", green: "#3A9E43", orange: "#E8871E", red: "#D23C2F", purple: "#7E57C2", teal: "#11968A", gray: "#5B6573", gold: "#D4A015" };

type TabId = "project" | "map" | "insert" | "analysis" | "view" | "edit" | "imagery" | "share" | "feature" | "raster";

function useSelectedLayer() {
  const layers = useAppStore((s) => s.layers);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  return layers.find((l) => l.id === selectedLayerId) ?? null;
}

const isRasterLayer = (l: GeoLibreLayer | null) => !!l && /raster|cog|geotiff|image|tile/i.test(l.type) && !l.geojson;
const isVectorLayer = (l: GeoLibreLayer | null) => !!l && !!l.geojson;

function fieldsOf(layer: GeoLibreLayer | null): string[] {
  const f = layer?.geojson?.features;
  if (!f?.length) return [];
  const keys = new Set<string>();
  for (const x of f.slice(0, 50)) Object.keys(x.properties ?? {}).forEach((k) => keys.add(k));
  return [...keys];
}

// --- tabs -------------------------------------------------------------------------------------

function GoToXY() {
  const [open, setOpen] = useState(false);
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const lon = parseCoordinate(x), lat = parseCoordinate(y);
  const ok = Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return (
    <Popover open={open} onClose={() => setOpen(false)} anchor={<Small icon={Crosshair} label="Go To XY" color={C.red} onClick={() => setOpen((o) => !o)} active={open} />}>
          <div className="pr-pop-title">Go To XY</div>
          <label>Longitude (X)<input value={x} onChange={(e) => setX(e.target.value)} placeholder="106.8456 or 106°50'44&quot; E" /></label>
          <label>Latitude (Y)<input value={y} onChange={(e) => setY(e.target.value)} placeholder="-6.2088 or 6°12'32&quot; S" /></label>
          <div className="pr-pop-note">{ok ? `${lon.toFixed(6)}, ${lat.toFixed(6)}` : "Decimal degrees or DMS (N/S/E/W)"}</div>
          <div className="pr-pop-actions">
            <button type="button" disabled={!ok} onClick={() => { goToXY(lon, lat); setOpen(false); }}>Pan &amp; Flash</button>
            <button type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
    </Popover>
  );
}

function MapTab({ mode, setMode }: { mode: SelectMode | null; setMode: (m: SelectMode | null) => void }) {
  const layer = useSelectedLayer();
  const [selectOpen, setSelectOpen] = useState(false);
  const pick = (m: SelectMode) => { setMode(m); setSelectOpen(false); };
  const SELECT_ICON: Record<"rectangle" | "lasso" | "polygon" | "circle", LucideIcon> = { rectangle: SquareDashed, lasso: Lasso, polygon: Pentagon, circle: Circle };
  return (
    <>
      <Group label="Clipboard">
        <Stack>
          <Small icon={Copy} label="Copy" color={C.gray} onClick={() => runCommand("edit.copy") || editorTool(/copy/i)} />
          <Small icon={Trash2} label="Delete" color={C.red} onClick={() => editorTool(/delete/i)} />
        </Stack>
      </Group>
      <Group label="Navigate">
        <Big icon={Hand} label="Explore" color={C.blue} active={!mode} onClick={() => setMode(null)} />
        <Stack>
          <Small icon={ZoomIn} label="Zoom In" color={C.green} active={mode === "zoomin"} title="Zoom In tool: drag a box or click on the map" onClick={() => setMode(mode === "zoomin" ? null : "zoomin")} />
          <Small icon={ZoomOut} label="Zoom Out" color={C.red} active={mode === "zoomout"} title="Zoom Out tool: drag a box or click on the map" onClick={() => setMode(mode === "zoomout" ? null : "zoomout")} />
        </Stack>
        <Big icon={Globe2} label="Full Extent" color={C.green} onClick={fullExtent} />
        <Stack>
          <Small icon={ZoomIn} label="Fixed Zoom In" color={C.blue} onClick={() => getMap()?.zoomIn()} />
          <Small icon={ZoomOut} label="Fixed Zoom Out" color={C.blue} onClick={() => getMap()?.zoomOut()} />
          <Small icon={Maximize} label="Zoom To Layer" color={C.teal} disabled={!layer} onClick={() => layer && zoomToLayer(layer)} />
        </Stack>
        <Stack>
          <Small icon={Undo2} label="Previous Extent" color={C.gray} onClick={() => runCommand("view.previous")} />
          <Small icon={Redo2} label="Next Extent" color={C.gray} onClick={() => runCommand("view.next")} />
          <Small icon={Bookmark} label="Bookmarks" color={C.gold} onClick={() => runCommand("control.bookmark")} />
        </Stack>
        <Stack>
          <GoToXY />
          <Small icon={Compass} label="North Up" color={C.red} onClick={() => runCommand("view.reset-north")} />
        </Stack>
      </Group>
      <Group label="Selection">
        <Popover open={selectOpen} onClose={() => setSelectOpen(false)} className="pr-menu" anchor={<Big icon={mode && mode in SELECT_ICON ? SELECT_ICON[mode as keyof typeof SELECT_ICON] : MousePointer2} label="Select" color={C.sky} active={!!mode && mode in SELECT_ICON} onClick={() => setSelectOpen((o) => !o)} />}>
              {(["rectangle", "polygon", "lasso", "circle"] as const).map((m) => {
                const Icon = SELECT_ICON[m];
                return (
                  <button key={m} type="button" onClick={() => pick(m)}>
                    <Icon style={{ color: C.sky }} /> {m[0].toUpperCase() + m.slice(1)}
                  </button>
                );
              })}
        </Popover>
        <Stack>
          <Small icon={Filter} label="Select By Attributes" color={C.blue} onClick={() => store().setSelectByExpressionOpen(true, layer?.id ?? null)} />
          <Small icon={ScanSearch} label="Select By Location" color={C.teal} onClick={() => store().setSelectByLocationOpen(true, layer?.id ?? null)} />
          <Small icon={Eraser} label="Clear" color={C.red} onClick={() => store().selectFeatures([], null)} />
        </Stack>
        <Stack>
          <Small icon={Table2} label="Attributes" color={C.green} onClick={() => store().setAttributeTableOpen(true)} />
          <Small icon={Maximize} label="Zoom To Selection" color={C.teal} onClick={() => zoomToSelection()} />
        </Stack>
      </Group>
      <Group label="Inquiry">
        <Stack>
          <Small icon={Ruler} label="Measure" color={C.orange} onClick={() => runCommand("control.measure")} />
          <Small icon={Locate} label="Locate" color={C.red} onClick={() => runCommand("control.search")} />
          <Small icon={Search} label="Command Search" color={C.gray} onClick={openCommandSearch} />
        </Stack>
      </Group>
      <Group label="Layer">
        <Big icon={Plus} label="Add Data" color={C.green} onClick={() => runCommand("add.vector")} />
        <Stack>
          <Small icon={Image} label="Add Raster" color={C.orange} onClick={() => runCommand("add.raster")} />
          <Small icon={MapIcon} label="Basemap" color={C.blue} onClick={() => openRightPanel(BROWSER_PANEL_ID)} />
          <Small icon={Database} label="Data Indonesia" color={C.red} onClick={() => openNativePanel(DATA_INDONESIA_PANEL_ID)} />
        </Stack>
      </Group>
      <Group label="Labeling">
        <QuickLabel layer={layer} />
      </Group>
    </>
  );
}

function zoomToSelection() {
  const s = store();
  const layer = s.layers.find((l) => l.id === s.selectedLayerId);
  if (!layer?.geojson || !s.selectedFeatureIds.length) return;
  const ids = new Set(s.selectedFeatureIds);
  const features = layer.geojson.features.filter((f, i) => ids.has(featureSelectionId(f, i)));
  const b = boundsOf([{ type: "FeatureCollection", features }]);
  if (b) getMap()?.fitBounds(b, { padding: 60, duration: 600, maxZoom: 17 });
}

function QuickLabel({ layer }: { layer: GeoLibreLayer | null }) {
  const fields = useMemo(() => fieldsOf(layer), [layer]);
  const labels = layer?.style.labels;
  if (!layer?.geojson) return <div className="pr-hint">Select a vector layer</div>;
  const set = (patch: Partial<NonNullable<typeof labels>>) => store().setLayerStyle(layer.id, { labels: { ...labels!, ...patch } });
  return (
    <div className="pr-form">
      <label className="pr-check"><input type="checkbox" checked={!!labels?.enabled} onChange={(e) => set({ enabled: e.target.checked, field: labels?.field || fields[0] || "" })} /> Label</label>
      <select value={labels?.field ?? ""} onChange={(e) => set({ field: e.target.value, enabled: true })}>
        <option value="">Field…</option>
        {fields.map((f) => <option key={f}>{f}</option>)}
      </select>
      <div className="flex items-center gap-1">
        <input type="number" min={6} max={40} value={labels?.size ?? 12} onChange={(e) => set({ size: Number(e.target.value) })} title="Size" />
        <input type="color" value={labels?.color ?? "#222222"} onChange={(e) => set({ color: e.target.value })} title="Colour" />
        <input type="color" value={labels?.haloColor ?? "#ffffff"} onChange={(e) => set({ haloColor: e.target.value, haloWidth: labels?.haloWidth || 1.2 })} title="Halo" />
      </div>
    </div>
  );
}

// --- dense command groups -----------------------------------------------------------------------

/** [label, icon, colour, command id or handler]. Command ids that are not available are left out. */
type Item = [label: string, icon: LucideIcon, color: string, action: string | (() => void)];

function useCommandIds(): Set<string> {
  const commands = useCommandRegistry((s) => s.commands);
  return useMemo(() => new Set(commands.map((c) => c.id)), [commands]);
}

/** Small buttons, three per column, like a dense ArcGIS Pro group. */
function Cmds({ items }: { items: Item[] }) {
  const ids = useCommandIds();
  const shown = items.filter(([, , , a]) => typeof a === "function" || ids.has(a));
  const cols: Item[][] = [];
  for (let i = 0; i < shown.length; i += 3) cols.push(shown.slice(i, i + 3));
  return (
    <>
      {cols.map((col, i) => (
        <Stack key={i}>
          {col.map(([label, icon, color, action]) => (
            <Small key={label} icon={icon} label={label} color={color} onClick={() => (typeof action === "function" ? action() : runCommand(action))} />
          ))}
        </Stack>
      ))}
    </>
  );
}

function CmdGroup({ label, items, big }: { label: string; items: Item[]; big?: Item[] }) {
  const ids = useCommandIds();
  const bigs = (big ?? []).filter(([, , , a]) => typeof a === "function" || ids.has(a));
  const any = bigs.length || items.some(([, , , a]) => typeof a === "function" || ids.has(a));
  if (!any) return null;
  const first = bigs[0] ?? items.find(([, , , a]) => typeof a === "function" || ids.has(a));
  return (
    <Group label={label} collapsible icon={first?.[1]} color={first?.[2]}>
      {bigs.map(([l, icon, color, action]) => (
        <Big key={l} icon={icon} label={l} color={color} onClick={() => (typeof action === "function" ? action() : runCommand(action))} />
      ))}
      <Cmds items={items} />
    </Group>
  );
}

/** Press a button of the (hidden) app menu bar, e.g. "Settings". */
function pressMenuButton(label: string) {
  document.querySelector<HTMLElement>(`.pr-home > button[aria-label="${label}"]`)?.click();
}

// --- tabs ---------------------------------------------------------------------------------------------

function ProjectTab() {
  return (
    <>
      <CmdGroup
        label="Project"
        big={[["New", FilePlus2, C.green, "project.new"], ["Open", FolderOpen, C.gold, "project.open-file"], ["Save", Save, C.blue, "project.save"]]}
        items={[
          ["Save As…", Save, C.teal, "project.save-as"],
          ["Open From URL", Link2, C.blue, "project.open-url"],
          ["Project Package", Package, C.gold, () => void packageProject()],
        ]}
      />
      <Group label="Recent">
        <RecentProjects />
      </Group>
      <CmdGroup
        label="Output"
        items={[
          ["Export Map", FileImage, C.blue, () => void exportMap("png")],
          ["Layout", LayoutTemplate, C.purple, () => setWorkspaceView("layout")],
          ["Print", Printer, C.gray, "project.print-layout"],
        ]}
      />
      <CmdGroup
        label="Options"
        big={[
          ["Options", Settings, C.gray, () => openSettingsSection("map")],
          ["Performance & GPU", Cpu, C.green, () => openSettingsSection("performance")],
        ]}
        items={[
          ["Appearance", Palette, C.purple, () => openSettingsSection("appearance")],
          ["Interface", SlidersHorizontal, C.blue, () => openSettingsSection("interface")],
          ["Language", Languages, C.teal, () => openSettingsSection("language")],
          ["Startup", Power, C.orange, () => openSettingsSection("startup")],
          ["AI", Brain, C.purple, () => openSettingsSection("ai")],
          ["Environment", Terminal, C.gray, () => openSettingsSection("environment")],
          ["Style Manager", Palette, C.red, "settings.style-manager"],
          ["Clear Cache", Trash2, C.red, openClearCacheDialog],
        ]}
      />
      <CmdGroup
        label="About"
        big={[["About", Info, C.blue, openAboutDialog]]}
        items={[
          ["Keyboard Shortcuts", Keyboard, C.gray, "help.shortcuts"],
          ["Diagnostics", Stethoscope, C.green, "help.diagnostics"],
        ]}
      />
    </>
  );
}

function RecentProjects() {
  const recent = useAppStore((s) => s.recentProjects);
  if (!recent.length) return <div className="pr-hint">No recent projects yet</div>;
  return (
    <div className="pr-recent">
      {recent.slice(0, 3).map((p) => (
        <button key={p.path} type="button" className="pr-small" title={p.path} onClick={() => openRecentProject(p.path)}>
          <FolderOpen style={{ color: C.gold }} strokeWidth={1.8} />
          <span>{p.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "")}</span>
        </button>
      ))}
    </div>
  );
}

function InsertTab() {
  return (
    <>
      <CmdGroup
        label="Project"
        big={[["New Map", FilePlus2, C.green, "project.new"], ["New Layout", LayoutTemplate, C.purple, () => setWorkspaceView("layout")]]}
        items={[
          ["Import Project", FileUp, C.blue, "project.open-file"],
          ["Notebook", BookOpen, C.orange, () => store().setNotebookOpen(true)],
          ["Data Indonesia", Database, C.red, () => openNativePanel(DATA_INDONESIA_PANEL_ID)],
        ]}
      />
      <CmdGroup
        label="Add Data — Files"
        big={[["Vector", Shapes, C.green, "add.vector"], ["Raster", Image, C.orange, "add.raster"]]}
        items={[
          ["Delimited Text", FileText, C.gray, "add.delimited-text"],
          ["CAD (DXF/DWG)", Ruler, C.blue, "add.cad"],
          ["GPX", Route, C.teal, "add.gpx"],
          ["LandXML", Mountain, C.gold, "add.landxml"],
          ["GeoParquet", Boxes, C.purple, "add.geoparquet"],
          ["FlatGeobuf", Layers, C.sky, "add.flatgeobuf"],
          ["PMTiles", Grid2x2, C.orange, "add.pmtiles"],
          ["MBTiles", Grid2x2, C.blue, "add.mbtiles"],
          ["OSM PBF", MapIcon, C.green, "add.osm-pbf"],
          ["Zarr", Box, C.red, "add.zarr"],
          ["NetCDF / HDF", Waves, C.teal, "add.netcdf"],
          ["Video", Video, C.purple, "add.video"],
        ]}
      />
      <CmdGroup
        label="Add Data — Services"
        items={[
          ["XYZ Tiles", Grid2x2, C.blue, "add.xyz"],
          ["WMS", Globe2, C.teal, "add.wms"],
          ["WFS", Shapes, C.green, "add.wfs"],
          ["WMTS", Layers, C.sky, "add.wmts"],
          ["ArcGIS Service", Server, C.blue, "add.arcgis"],
          ["STAC", Satellite, C.orange, "add.stac"],
          ["Planetary Computer", Globe2, C.sky, "proc.planetary-computer"],
          ["Earth Engine", Satellite, C.green, () => openNativePanel(EARTH_ENGINE_PANEL_ID)],
        ]}
      />
      <CmdGroup
        label="Add Data — Databases & 3D"
        items={[
          ["PostgreSQL", Database, C.blue, "add.postgres"],
          ["SQL Server", Database, C.red, "add.mssql"],
          ["DuckDB", Database, C.gold, "add.duckdb"],
          ["Apache Iceberg", Database, C.sky, "add.iceberg"],
          ["LiDAR", Mountain, C.green, "add.lidar"],
          ["ICESat-2 / GEDI", Satellite, C.purple, "add.spaceborne-lidar"],
          ["3D Tiles", Box, C.orange, "add.3d-tiles"],
          ["Gaussian Splatting", Sparkles, C.purple, "add.splatting"],
          ["Deck.gl Layer", Layers, C.teal, "add.deckgl-viz"],
        ]}
      />
      <CmdGroup
        label="Layer Templates"
        items={[
          ["Point Layer", Circle, C.red, () => void newSketchLayer("Point")],
          ["Line Layer", Workflow, C.blue, () => void newSketchLayer("Line")],
          ["Polygon Layer", Pentagon, C.green, () => void newSketchLayer("Polygon")],
          ["Review Comment", MessageSquare, C.orange, "add.comment"],
        ]}
      />
    </>
  );
}

function AnalysisTab() {
  return (
    <>
      <CmdGroup
        label="Geoprocessing"
        big={[["History", History, C.gray, () => store().setProcessingHistoryOpen(true)], ["Tools", Box, C.red, openProcessingToolbox]]}
        items={[
          ["ModelBuilder", Workflow, C.blue, "proc.modelBuilder"],
          ["Python", Terminal, C.gold, "proc.python"],
          ["Notebook", BookOpen, C.orange, () => store().setNotebookOpen(true)],
          ["Batch", Layers, C.teal, "proc.batchTools"],
          ["SQL", Database, C.purple, "proc.sql"],
          ["Geocode", MapPin, C.red, "proc.geocode"],
          ["KoboToolbox", ClipboardList, C.teal, () => openNativePanel(KOBO_PANEL_ID)],
        ]}
      />
      <CmdGroup
        label="Overlay"
        items={[
          ["Buffer", Circle, C.blue, "proc.vector.buffer"],
          ["Clip", Scissors, C.orange, "proc.vector.clip"],
          ["Intersect", Combine, C.purple, "proc.vector.intersection"],
          ["Union", Merge, C.green, "proc.vector.union"],
          ["Erase", Eraser, C.red, "proc.vector.difference"],
          ["Dissolve", Boxes, C.gold, "proc.vector.dissolve"],
          ["Merge Layers", Layers, C.teal, "proc.vector.merge-layers"],
          ["Spatial Join", Link2, C.sky, "proc.vector.spatial-join"],
          ["Attribute Join", Table2, C.green, "proc.vector.attribute-join"],
        ]}
      />
      <CmdGroup
        label="Geometry"
        items={[
          ["Centroids", Crosshair, C.red, "proc.vector.centroids"],
          ["Convex Hull", Pentagon, C.green, "proc.vector.convex-hull"],
          ["Bounding Box", SquareDashed, C.blue, "proc.vector.bounding-box"],
          ["Simplify", Spline, C.teal, "proc.vector.simplify"],
          ["Smooth", Spline, C.purple, "proc.vector.smooth"],
          ["Explode", Split, C.orange, "proc.vector.explode"],
          ["Extract Vertices", Dot, C.gray, "proc.vector.extract-vertices"],
          ["Points Along", MoreHorizontal, C.blue, "proc.vector.points-along-geometry"],
          ["Project", Globe2, C.sky, "proc.vector.reproject"],
        ]}
      />
      <CmdGroup
        label="Select & Generate"
        items={[
          ["Select By Value", Filter, C.blue, "proc.vector.select-by-value"],
          ["Select By Location", ScanSearch, C.teal, "proc.vector.select-by-location"],
          ["Random Extract", Shuffle, C.purple, "proc.vector.random-extract"],
          ["Aggregate", Sigma, C.gold, "proc.vector.aggregate"],
          ["Regular Grid", Grid2x2, C.green, "proc.vector.grid"],
          ["Voronoi", Hexagon, C.orange, "proc.vector.voronoi"],
          ["DGGS Grid", Hexagon, C.blue, "proc.vector.dggs-grid"],
          ["DGGS Binning", Hexagon, C.red, "proc.vector.dggs-bin"],
          ["DGGS Compact", Hexagon, C.teal, "proc.vector.dggs-compact"],
        ]}
      />
      <CmdGroup
        label="Spatial Statistics"
        items={[
          ["Hot Spots (Gi*)", Flame, C.red, "proc.statistics.getis-ord-gi"],
          ["Global Moran's I", Activity, C.blue, "proc.statistics.global-morans-i"],
          ["Local Moran's I", Activity, C.purple, "proc.statistics.local-morans-i"],
          ["Nearest Neighbor", Target, C.green, "proc.statistics.average-nearest-neighbor"],
          ["Kernel Density", Flame, C.orange, "proc.statistics.kernel-density"],
          ["Emerging Hot Spot", TrendingUp, C.red, "proc.statistics.emerging-hot-spot"],
          ["Composite Score", Sigma, C.teal, "proc.statistics.composite-score"],
          ["Zonal Statistics", BarChart3, C.green, openZonalStatistics],
          ["Tabulate Area", Table2, C.green, () => openAnalysisTool("tabulate-area")],
        ]}
      />
      <CmdGroup
        label="Network & Movement"
        items={[
          ["Service Area", Network, C.blue, "proc.network.isochrone"],
          ["OD Cost Matrix", Table2, C.purple, "proc.network.od-matrix"],
          ["Route", Route, C.green, "proc.network.sequential-route"],
          ["Trajectory Speed", Timer, C.orange, "proc.vector.trajectory-speed"],
          ["Detect Stops", MapPin, C.red, "proc.vector.detect-stops"],
          ["Space-Time Proximity", Clock, C.teal, "proc.vector.space-time-proximity"],
          ["Line Of Sight", Eye, C.sky, "proc.lineOfSight"],
          ["Cell Coverage", Signal, C.gold, "proc.vector.cell-sectors"],
          ["Near Table", Ruler, C.blue, () => openAnalysisTool("near-table")],
        ]}
      />
      <CmdGroup
        label="Forest & Terrain"
        items={[
          ["Change Detection", History, C.red, openChangeDetection],
          ["Fragmentation", Grid2x2, C.green, () => openAnalysisTool("fragmentation")],
          ["Carbon Stock", Trees, C.green, () => openAnalysisTool("carbon-stock")],
          ["Burn Severity", Flame, C.orange, () => openAnalysisTool("burn-severity")],
          ["Hotspots (FIRMS)", Crosshair, C.red, () => openAnalysisTool("firms")],
          ["Hydrology", Waves, C.sky, () => openAnalysisTool("hydrology")],
          ["Watershed", Waves, C.blue, () => openAnalysisTool("watershed")],
          ["Viewshed", Eye, C.purple, () => openAnalysisTool("viewshed")],
          ["Cost Distance", Route, C.gold, () => openAnalysisTool("cost-distance")],
        ]}
      />
      <CmdGroup
        label="KLHK"
        items={[
          ["Karbon KLHK", Trees, C.gray, () => openAnalysisTool("klhk-carbon")],
          ["Karbon InVEST", TrendingUp, C.gray, () => openAnalysisTool("invest-carbon")],
          ["Karbon Plot", Calculator, C.gray, () => openAnalysisTool("carbon-plot")],
          ["Simbologi KLHK", Palette, C.gray, applyKlhkSymbologyToAll],
        ]}
      />
      <CmdGroup
        label="AI"
        items={[
          ["AI Assistant", Brain, C.purple, () => openNativePanel(ASSISTANT_PANEL_ID)],
          ["Live MCP", Bot, C.green, () => openNativePanel(ASSISTANT_PANEL_ID)],
          ["Species Distribution", Bird, C.teal, () => openNativePanel(SDM_PANEL_ID)],
        ]}
      />
    </>
  );
}

function ViewTab() {
  const mapGrid = useAppStore((s) => (s as unknown as { mapGrid?: { rows: number; cols: number } }).mapGrid);
  const linked = !!mapGrid && mapGrid.rows * mapGrid.cols > 1;
  const resetPanes = () => {
    const s = store();
    s.setAttributeTableOpen(false);
    s.setProcessingHistoryOpen(false);
    const active = getActiveRightPanel();
    if (active) closeRightPanel(active);
    getMap()?.easeTo({ pitch: 0, bearing: 0, duration: 500 });
  };
  return (
    <>
      <CmdGroup
        label="View"
        big={[["Convert 2D / 3D", Layers, C.teal, toggle3D], ["Link Views", Link2, linked ? C.red : C.blue, () => store().setMapGrid(1, linked ? 1 : 2)], ["Swipe", Columns2, C.green, () => pressMenuButton("Swipe")]]}
        items={[
          ["Reset North / Tilt", RotateCw, C.gray, "view.reset-pitch-bearing"],
          ["Reset Pitch", RotateCw, C.blue, "view.reset-pitch"],
          ["Set View…", Move, C.blue, "view.set-view"],
          ["Layout View", LayoutTemplate, C.purple, () => setWorkspaceView("layout")],
          ["Light / Dark", Sun, C.gold, "view.theme"],
          ["Comments", MessageSquare, C.sky, "view.comments"],
        ]}
      />
      <CmdGroup
        label="Windows"
        items={[
          ["Contents", ListTree, C.blue, () => { const a = getActiveRightPanel(); if (a) closeRightPanel(a); }],
          ["Catalog", FolderTree, C.gold, () => openRightPanel(BROWSER_PANEL_ID)],
          ["Geoprocessing", Box, C.red, () => openRightPanel(PROCESSING_TOOLBOX_PANEL_ID)],
          ["Attributes", Table2, C.green, () => store().setAttributeTableOpen(true)],
          ["History", History, C.gray, () => store().setProcessingHistoryOpen(true)],
          ["Reset Panes", PanelRight, C.orange, resetPanes],
        ]}
      />
      <CmdGroup
        label="Map Controls"
        items={[
          ["Navigation", Compass, C.blue, "control.navigation"],
          ["Compass", Compass, C.red, "control.compass"],
          ["Scale Bar", Ruler, C.gray, "control.scale"],
          ["Fullscreen", Maximize, C.teal, "control.fullscreen"],
          ["Geolocate", Locate, C.blue, "control.geolocate"],
          ["Globe", Globe2, C.sky, "control.globe"],
          ["Terrain", Mountain, C.green, "control.terrain"],
          ["Attribution", Info, C.gray, "control.attribution"],
          ["MapLibre Logo", Tag, C.gray, "control.logo"],
        ]}
      />
      <CmdGroup
        label="Map Widgets"
        items={[
          ["Legend", ListTree, C.teal, "control.legend"],
          ["Colorbar", BarChart3, C.orange, "control.colorbar"],
          ["Minimap", Grid2x2, C.blue, "control.minimap"],
          ["Bookmarks", Bookmark, C.gold, "control.bookmark"],
          ["Measure", Ruler, C.orange, "control.measure"],
          ["Search", Search, C.gray, "control.search"],
          ["View State", Tag, C.gray, "control.view-state"],
          ["HTML Panel", FileText, C.purple, "control.html"],
          ["Image", Image, C.purple, "control.image"],
        ]}
      />
      <CmdGroup
        label="Effects & Field"
        items={[
          ["Atmosphere", Sun, C.sky, "control.effects"],
          ["Directions", Route, C.green, "control.directions"],
          ["Turn-by-Turn", Navigation, C.blue, "control.turn-by-turn"],
          ["Field Collection", Smartphone, C.orange, "control.field-collection"],
          ["GPS Tracking", LocateFixed, C.red, "control.gps-tracking"],
        ]}
      />
      <CmdGroup
        label="Color Vision"
        items={[
          ["Protanopia", Eye, C.red, "view.color-vision.protanopia"],
          ["Deuteranopia", Eye, C.green, "view.color-vision.deuteranopia"],
          ["Tritanopia", Eye, C.blue, "view.color-vision.tritanopia"],
          ["Achromatopsia", Eye, C.gray, "view.color-vision.achromatopsia"],
          ["Off", EyeOff, C.gray, "view.color-vision.off"],
        ]}
      />
    </>
  );
}

const EDIT_ICON: Record<string, [LucideIcon, string]> = {
  explode: [Split, C.orange], merge: [Merge, C.purple], buffer: [Circle, C.blue], generalize: [Spline, C.teal],
  smooth: [Spline, C.purple], densify: [MoreHorizontal, C.gray], reverse: [ArrowLeftRight, C.blue], "fill-holes": [Pentagon, C.green],
  repair: [Wrench, C.gold], move: [Move, C.blue], rotate: [RotateCw, C.teal], scale: [Scaling, C.teal],
  offset: [Columns2, C.sky], "line-to-polygon": [Pentagon, C.green], "polygon-to-line": [Workflow, C.blue], centroid: [Crosshair, C.red],
  vertices: [Dot, C.gray], "clip-by": [Scissors, C.orange], "erase-by": [Eraser, C.red], "calc-geometry": [Calculator, C.green],
  "create-xy": [MapPin, C.red], "copy-to-layer": [Copy, C.gray], delete: [Trash2, C.red],
};

/** One digitizing tool: runs at once, or asks its parameters in a drop-down first. */
function EditToolButton({ tool }: { tool: EditTool }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((tool.params ?? []).map((p) => [p.id, p.default])));
  const [icon, color] = EDIT_ICON[tool.id] ?? [Pencil, C.gray];
  const run = () => {
    try {
      notifyProcess({ kind: "success", title: tool.label, message: runEditTool(tool, values) });
      setOpen(false);
    } catch (error) {
      notifyProcess({ kind: "error", title: tool.label, message: error instanceof Error ? error.message : String(error) });
    }
  };
  if (!tool.params?.length) return <Small icon={icon} label={tool.label} color={color} title={tool.help} onClick={run} />;
  return (
    <Popover open={open} onClose={() => setOpen(false)} anchor={<Small icon={icon} label={`${tool.label}…`} color={color} title={tool.help} active={open} onClick={() => setOpen((o) => !o)} />}>
      <div className="pr-pop-title">{tool.label}</div>
      <div className="pr-pop-note">{tool.help}</div>
      {tool.params.map((p) => (
        <label key={p.id}>
          {p.label}
          {p.text ? (
            <textarea rows={4} value={values[p.id]} onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))} />
          ) : (
            <input value={values[p.id]} onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && run()} />
          )}
        </label>
      ))}
      <div className="pr-pop-actions">
        <button type="button" onClick={run}>Run</button>
        <button type="button" onClick={() => setOpen(false)}>Close</button>
      </div>
    </Popover>
  );
}

function EditToolGroup({ label, ids }: { label: string; ids: string[] }) {
  const tools = ids.map((id) => EDIT_TOOLS.find((t) => t.id === id)!).filter(Boolean);
  const cols: EditTool[][] = [];
  for (let i = 0; i < tools.length; i += 3) cols.push(tools.slice(i, i + 3));
  return (
    <Group label={label}>
      {cols.map((col, i) => (
        <Stack key={i}>
          {col.map((t) => <EditToolButton key={t.id} tool={t} />)}
        </Stack>
      ))}
    </Group>
  );
}

function EditTab() {
  const editingLayerId = useSyncExternalStore(subscribeGeometryEdit, getGeometryEditTargetLayerId);
  const layer = useSelectedLayer();
  const editing = !!editingLayerId;
  return (
    <>
      <Group label="Manage Edits">
        <Big icon={Pencil} label={editing ? "Editing" : "Start"} color={C.orange} active={editing} disabled={editing || !isVectorLayer(layer)} onClick={() => layer && void getEditorActions()?.toggle(layer.id)} />
        <Big icon={Save} label="Save" color={C.blue} disabled={!editing} onClick={() => editingLayerId && void getEditorActions()?.toggle(editingLayerId)} />
        <Big icon={X} label="Discard" color={C.red} disabled={!editing} onClick={() => getEditorActions()?.cancel()} />
        <Stack>
          <Small icon={Undo2} label="Undo" color={C.gray} onClick={() => undo()} />
          <Small icon={Redo2} label="Redo" color={C.gray} onClick={() => redo()} />
          <Small icon={Table2} label="Attributes" color={C.green} onClick={() => store().setAttributeTableOpen(true)} />
        </Stack>
      </Group>
      <Group label="Create" collapsible icon={Pentagon} color={C.green}>
        <Stack>
          <Small icon={Pentagon} label="Polygon" color={C.green} onClick={() => editorTool(/polygon/i)} />
          <Small icon={Workflow} label="Line" color={C.blue} onClick={() => editorTool(/line/i)} />
          <Small icon={MapPin} label="Point" color={C.red} onClick={() => editorTool(/marker|point/i)} />
        </Stack>
        <Stack>
          <Small icon={SquareDashed} label="Rectangle" color={C.teal} onClick={() => editorTool(/rectangle/i)} />
          <Small icon={Circle} label="Circle" color={C.sky} onClick={() => editorTool(/circle/i)} />
          <Small icon={Pencil} label="Freehand" color={C.orange} onClick={() => editorTool(/freehand/i)} />
        </Stack>
        <Stack>
          <Small icon={Type} label="Text" color={C.gray} onClick={() => editorTool(/text/i)} />
          <Small icon={Magnet} label="Snapping" color={C.purple} onClick={() => editorTool(/snap/i)} />
          <Small icon={Circle} label="Point Layer" color={C.red} onClick={() => void newSketchLayer("Point")} />
        </Stack>
        <Stack>
          <Small icon={Workflow} label="Line Layer" color={C.blue} onClick={() => void newSketchLayer("Line")} />
          <Small icon={Pentagon} label="Polygon Layer" color={C.green} onClick={() => void newSketchLayer("Polygon")} />
        </Stack>
      </Group>
      <Group label="Modify (interactive)" collapsible icon={Move} color={C.blue}>
        <Stack>
          <Small icon={MousePointer2} label="Select" color={C.sky} onClick={() => editorTool(/^select|select feature/i)} />
          <Small icon={Move} label="Move" color={C.blue} onClick={() => editorTool(/drag|move/i)} />
          <Small icon={Pencil} label="Edit Vertices" color={C.orange} onClick={() => editorTool(/change|vertex|edit/i)} />
        </Stack>
        <Stack>
          <Small icon={RotateCw} label="Rotate" color={C.teal} onClick={() => editorTool(/rotate/i)} />
          <Small icon={Scaling} label="Scale" color={C.teal} onClick={() => editorTool(/scale/i)} />
          <Small icon={Scissors} label="Split" color={C.orange} onClick={() => editorTool(/split/i)} />
        </Stack>
        <Stack>
          <Small icon={Eraser} label="Cut Hole" color={C.red} onClick={() => editorTool(/cut/i)} />
          <Small icon={Combine} label="Union" color={C.purple} onClick={() => editorTool(/union/i)} />
          <Small icon={Minus} label="Difference" color={C.red} onClick={() => editorTool(/difference/i)} />
        </Stack>
        <Stack>
          <Small icon={Spline} label="Simplify" color={C.teal} onClick={() => editorTool(/simplify/i)} />
          <Small icon={Lasso} label="Lasso" color={C.sky} onClick={() => editorTool(/lasso/i)} />
          <Small icon={Copy} label="Copy" color={C.gray} onClick={() => editorTool(/copy/i)} />
        </Stack>
      </Group>
      <EditToolGroup label="Modify Selected" ids={["explode", "merge", "buffer", "generalize", "smooth", "densify", "reverse", "fill-holes", "repair"]} />
      <EditToolGroup label="Transform & Overlay" ids={["move", "rotate", "scale", "offset", "clip-by", "erase-by"]} />
      <EditToolGroup label="Convert & Attributes" ids={["line-to-polygon", "polygon-to-line", "centroid", "vertices", "calc-geometry", "create-xy", "copy-to-layer", "delete"]} />
      <CmdGroup
        label="Data Quality"
        items={[
          ["Check Validity", ShieldCheck, C.green, "proc.vector.check-validity"],
          ["Fix Geometries", Wrench, C.gold, "proc.vector.fix-geometries"],
          ["Topology Rules", Network, C.blue, "proc.vector.check-topology-rules"],
          ["Fix Topology", Wrench, C.red, "proc.vector.fix-topology"],
        ]}
      />
    </>
  );
}

function ImageryTab() {
  return (
    <>
      <CmdGroup
        label="Rendering"
        big={[["Band Combination", Layers, C.red, () => openAnalysisTool("composite")], ["Indices", SquareFunction, C.green, () => openAnalysisTool("band-index")], ["Raster Calculator", Grid2x2, C.blue, openRasterCalculator]]}
        items={[["Spectral Index", SquareFunction, C.teal, "proc.raster.spectral-index"], ["Reclassify", ListTree, C.purple, "proc.raster.reclassify"], ["Focal Statistics", Grid2x2, C.orange, "proc.raster.focal"]]}
      />
      <CmdGroup
        label="Surface"
        items={[
          ["Hillshade", Mountain, C.gray, "proc.raster.hillshade"],
          ["Slope", TrendingUp, C.orange, "proc.raster.slope"],
          ["Aspect", Compass, C.blue, "proc.raster.aspect"],
          ["Contour", Spline, C.green, "proc.raster.contour"],
          ["Interpolate", Sparkles, C.purple, "proc.raster.interpolate"],
          ["Terrain Index", Mountain, C.teal, () => openAnalysisTool("terrain-index")],
          ["Cut / Fill", Mountain, C.red, () => openAnalysisTool("cut-fill")],
        ]}
      />
      <CmdGroup
        label="Raster Processing"
        items={[
          ["Clip By Extent", Scissors, C.orange, "proc.raster.clip-extent"],
          ["Extract By Mask", Scissors, C.red, "proc.raster.clip-mask"],
          ["Mosaic", Grid2x2, C.blue, "proc.raster.mosaic"],
          ["Resample", Scaling, C.teal, "proc.raster.resample"],
          ["Project Raster", Globe2, C.sky, "proc.raster.reproject"],
          ["Polygonize", Pentagon, C.green, "proc.raster.polygonize"],
          ["Zonal Statistics", BarChart3, C.green, "proc.raster.zonal"],
          ["Raster To COG", FileImage, C.purple, "proc.conversion.raster-to-cog"],
          ["Raster To PMTiles", Grid2x2, C.orange, "proc.conversion.raster-to-pmtiles"],
        ]}
      />
      <CmdGroup
        label="Classification"
        big={[["Classification Wizard", Brain, C.purple, () => openAnalysisTool("rf-classify")]]}
        items={[
          ["Training Samples", Pentagon, C.orange, () => void newSketchLayer("Training Polygon")],
          ["Sample Points", Crosshair, C.teal, () => openAnalysisTool("sampling")],
          ["Accuracy", Table2, C.green, () => openAnalysisTool("accuracy")],
          ["OBIA", Shapes, C.blue, "proc.obiaWorkbench"],
          ["AI Segmentation", Wand2, C.purple, "proc.segmentation"],
          ["Segment Everything", Wand2, C.red, "proc.segmentEverything"],
          ["Object Detection", ScanSearch, C.orange, "proc.objectDetection"],
        ]}
      />
      <CmdGroup
        label="Time & Change"
        items={[
          ["Change Detection", History, C.red, openChangeDetection],
          ["Burn Severity", Flame, C.orange, () => openAnalysisTool("burn-severity")],
          ["Trend", TrendingUp, C.blue, () => openAnalysisTool("trend")],
          ["Flood (Sentinel-1)", Waves, C.sky, () => openAnalysisTool("s1-flood")],
        ]}
      />
      <CmdGroup
        label="Sources"
        items={[
          ["Planetary Computer", Globe2, C.sky, "proc.planetary-computer"],
          ["Earth Engine", Satellite, C.green, () => openNativePanel(EARTH_ENGINE_PANEL_ID)],
          ["Data Indonesia", Database, C.red, () => openNativePanel(DATA_INDONESIA_PANEL_ID)],
          ["Georeference", Crosshair, C.gold, "proc.georeferencer"],
        ]}
      />
    </>
  );
}

function ShareTab() {
  return (
    <>
      <CmdGroup
        label="Output"
        big={[["Export Map", FileImage, C.blue, () => void exportMap("png")], ["Layout", LayoutTemplate, C.purple, () => setWorkspaceView("layout")]]}
        items={[
          ["JPG", Image, C.orange, () => void exportMap("jpg")],
          ["PDF", FileImage, C.red, () => void exportMap("pdf")],
          ["GeoTIFF", Globe2, C.green, () => void exportMap("tif")],
          ["Print Layout", Printer, C.gray, "project.print-layout"],
        ]}
      />
      <CmdGroup
        label="Package & Share"
        big={[["Project Package", Package, C.gold, () => void packageProject()]]}
        items={[
          ["Save Project", Save, C.blue, "project.save"],
          ["Save As…", Save, C.teal, "project.save-as"],
          ["Share Project", Share2, C.purple, "project.share"],
        ]}
      />
      <CmdGroup
        label="Convert Data"
        items={[
          ["To Shapefile", FileUp, C.green, "proc.conversion.vector-to-shapefile"],
          ["To GeoPackage", Database, C.blue, "proc.conversion.vector-to-geopackage"],
          ["To GeoParquet", Boxes, C.purple, "proc.conversion.vector-to-geoparquet"],
          ["To FlatGeobuf", Layers, C.sky, "proc.conversion.vector-to-flatgeobuf"],
          ["To PMTiles", Grid2x2, C.orange, "proc.conversion.vector-to-pmtiles"],
          ["CSV To GeoParquet", FileText, C.gray, "proc.conversion.csv-to-geoparquet"],
          ["Raster To COG", FileImage, C.red, "proc.conversion.raster-to-cog"],
          ["Raster To PMTiles", Grid2x2, C.teal, "proc.conversion.raster-to-pmtiles"],
        ]}
      />
    </>
  );
}

const VECTOR_EXPORTS: Array<[VectorExportFormat, string]> = [["shapefile", "Shapefile"], ["geojson", "GeoJSON"], ["geopackage", "GeoPackage"], ["kml", "KML"], ["csv", "CSV"], ["geoparquet", "GeoParquet"]];

function AppearanceGroup({ layer }: { layer: GeoLibreLayer }) {
  const st = layer.style;
  return (
    <Group label="Appearance">
      <Big icon={Maximize} label="Zoom To Layer" color={C.teal} onClick={() => zoomToLayer(layer)} />
      <div className="pr-form">
        <label className="pr-row">Transparency
          <input type="range" min={0} max={100} value={Math.round((1 - layer.opacity) * 100)} onChange={(e) => store().updateLayer(layer.id, { opacity: 1 - Number(e.target.value) / 100 })} />
          <span>{Math.round((1 - layer.opacity) * 100)}%</span>
        </label>
        <label className="pr-row">Visible zoom
          <input type="number" min={0} max={24} value={st.minZoom ?? 0} onChange={(e) => store().setLayerStyle(layer.id, { minZoom: Number(e.target.value) })} />
          <span>to</span>
          <input type="number" min={0} max={24} value={st.maxZoom ?? 24} onChange={(e) => store().setLayerStyle(layer.id, { maxZoom: Number(e.target.value) })} />
        </label>
        <label className="pr-check"><input type="checkbox" checked={layer.visible} onChange={(e) => store().updateLayer(layer.id, { visible: e.target.checked })} /> Visible</label>
      </div>
    </Group>
  );
}

function FeatureLayerTab({ layer }: { layer: GeoLibreLayer }) {
  const commands = useProcessingToolboxStore((s) => s.commands);
  const [format, setFormat] = useState<VectorExportFormat>("shapefile");
  const [query, setQuery] = useState(String(layer.metadata?.definitionQuery ?? ""));
  const [queryError, setQueryError] = useState<string | null>(null);
  useEffect(() => { setQuery(String(layer.metadata?.definitionQuery ?? "")); setQueryError(null); }, [layer.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const applyQuery = (text: string) => {
    try {
      const expr = parseDefinitionQuery(text);
      const metadata = { ...layer.metadata, definitionQuery: text };
      delete (metadata as Record<string, unknown>).tocHiddenClasses;
      delete (metadata as Record<string, unknown>).tocBaseFilter;
      store().updateLayer(layer.id, { filterExpression: expr ?? undefined, metadata } as Partial<GeoLibreLayer>);
      setQueryError(null);
    } catch (error) {
      setQueryError(error instanceof Error ? error.message : String(error));
    }
  };
  const doExport = async () => {
    try {
      const path = await exportVectorLayer(layer.geojson!, format, layer.name.replace(/[^\w-]+/g, "_"), layer.name);
      if (path) notifyProcess({ kind: "success", title: "Export Features", message: `Saved ${path}` });
    } catch (error) {
      notifyProcess({ kind: "error", title: "Export Features", message: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <>
      <AppearanceGroup layer={layer} />
      <Group label="Labeling">
        <QuickLabel layer={layer} />
      </Group>
      <Group label="Definition Query">
        <div className="pr-form pr-wide">
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyQuery(query)} placeholder="FUNGSIKWS = 'HP' AND LUAS > 10" title={queryError ?? "SQL-like WHERE clause: =, <>, >, <, IN (...), LIKE 'a%', AND / OR"} className={queryError ? "is-error" : ""} />
          <div className="flex gap-1">
            <button type="button" className="pr-btn" onClick={() => applyQuery(query)}>Apply</button>
            <button type="button" className="pr-btn" onClick={() => { setQuery(""); applyQuery(""); }}>Clear</button>
          </div>
          {queryError ? <div className="pr-error">{queryError}</div> : null}
        </div>
      </Group>
      <Group label="Data">
        <Big icon={Table2} label="Attribute Table" color={C.green} onClick={() => { store().selectLayer(layer.id); store().setAttributeTableOpen(true); }} />
        <Big icon={Link2} label="Joins" color={C.purple} disabled={!commands.some((c) => c.id === "proc.vector.attribute-join")} onClick={() => commands.find((c) => c.id === "proc.vector.attribute-join")?.run()} />
        <div className="pr-form">
          <select value={format} onChange={(e) => setFormat(e.target.value as VectorExportFormat)}>
            {VECTOR_EXPORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" className="pr-btn" onClick={() => void doExport()}><Download className="inline h-3.5 w-3.5" style={{ color: C.blue }} /> Export Features</button>
        </div>
      </Group>
    </>
  );
}

function RasterLayerTab({ layer }: { layer: GeoLibreLayer }) {
  return (
    <>
      <AppearanceGroup layer={layer} />
      <Group label="Rendering">
        <Big icon={Layers} label="Band Combination" color={C.red} onClick={() => openAnalysisTool("composite")} />
        <Big icon={SquareFunction} label="Indices" color={C.green} onClick={() => openAnalysisTool("band-index")} />
        <Big icon={Grid2x2} label="Raster Calculator" color={C.blue} onClick={openRasterCalculator} />
      </Group>
      <Group label="Analysis">
        <Stack>
          <Small icon={BarChart3} label="Zonal Statistics" color={C.green} onClick={openZonalStatistics} />
          <Small icon={Table2} label="Tabulate Area" color={C.teal} onClick={() => openAnalysisTool("tabulate-area")} />
          <Small icon={History} label="Change Detection" color={C.red} onClick={openChangeDetection} />
        </Stack>
      </Group>
    </>
  );
}

// --- ribbon -----------------------------------------------------------------------------------

/** The scale box only needs `getMap()` from the controller. */
const SCALE_REF = { current: { getMap: () => getMap() } } as unknown as Parameters<typeof MapScaleBox>[0]["mapControllerRef"];

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

const TABS: Array<[TabId, string]> = [["project", "Project"], ["map", "Map"], ["insert", "Insert"], ["analysis", "Analysis"], ["view", "View"], ["edit", "Edit"], ["imagery", "Imagery"], ["share", "Share"]];

export function ProRibbon() {
  const view = useLayoutViewStore((s) => s.view);
  const layer = useSelectedLayer();
  const [tab, setTab] = useState<TabId>("map");
  const setHomeHost = useHeaderHost((s) => s.setHost);
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<SelectMode | null>(null);
  const contextual: TabId | null = isVectorLayer(layer) ? "feature" : isRasterLayer(layer) ? "raster" : null;
  useEffect(() => {
    if ((tab === "feature" || tab === "raster") && tab !== contextual) setTab("map");
  }, [contextual, tab]);
  // Close any open ribbon popover on an outside click.
  const rootRef = useRef<HTMLDivElement>(null);
  const dark = useDarkMode();
  // Fold groups (right to left) into drop-down buttons until the tab fits the window.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [fitPass, setFitPass] = useState(0);
  useEffect(() => {
    const reset = () => { setFolded(new Set()); setFitPass((n) => n + 1); };
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);
  useLayoutEffect(() => { setFolded(new Set()); }, [tab, contextual, layer?.id]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || collapsed || body.scrollWidth <= body.clientWidth + 1) return;
    const next = [...body.querySelectorAll<HTMLElement>(".pr-group[data-collapsible]")].reverse()[0];
    if (next?.dataset.group) setFolded((f) => new Set(f).add(next.dataset.group!));
  });
  void fitPass;
  if (view !== "data") return null;
  const choose = (id: TabId) => {
    if (id === tab) setCollapsed((c) => !c);
    else { setTab(id); setCollapsed(false); }
  };
  return (
    <div ref={rootRef} className="tfg-ribbon" data-collapsed={collapsed || undefined}>
      <div className="pr-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`pr-tab${id === "project" ? " pr-tab-project" : ""}`} onClick={() => choose(id)}>{label}</button>
        ))}
        {contextual ? (
          <>
            <span className="pr-ctx-label">{contextual === "feature" ? "Feature Layer" : "Raster Layer"}</span>
            <button type="button" role="tab" aria-selected={tab === contextual} className="pr-tab pr-tab-ctx" onClick={() => choose(contextual)}>
              {contextual === "feature" ? "Data" : "Appearance"}
            </button>
          </>
        ) : null}
        <div className="flex-1" />
        <button type="button" className="pr-search" onClick={openCommandSearch} title="Command Search (Ctrl+K)">
          <Search className="h-3.5 w-3.5" /> <span>Command Search</span> <kbd>Ctrl K</kbd>
        </button>
        <div className="pr-scale"><MapScaleBox mapControllerRef={SCALE_REF} mapReadyGeneration={0} variant="header" /></div>
        <button type="button" className="pr-theme" title="Light / Dark" onClick={() => runCommand("view.theme")}>
          {dark ? <Sun className="h-4 w-4" style={{ color: C.gold }} /> : <Moon className="h-4 w-4" style={{ color: C.blue }} />}
        </button>
      </div>
      <FitContext.Provider value={folded}>
      <div ref={bodyRef} className="pr-body" hidden={collapsed}>
        {/* The app menu bar renders here, hidden: its dialogs keep working and only the
            digitizing toolbar inside it shows (at the end of the ribbon) while editing. */}
        <div ref={setHomeHost} className="pr-home" />
        <Fragment key={tab}>
          {tab === "project" ? <ProjectTab /> : null}
          {tab === "map" ? <MapTab mode={mode} setMode={setMode} /> : null}
          {tab === "insert" ? <InsertTab /> : null}
          {tab === "analysis" ? <AnalysisTab /> : null}
          {tab === "view" ? <ViewTab /> : null}
          {tab === "edit" ? <EditTab /> : null}
          {tab === "imagery" ? <ImageryTab /> : null}
          {tab === "share" ? <ShareTab /> : null}
          {tab === "feature" && layer ? <FeatureLayerTab layer={layer} /> : null}
          {tab === "raster" && layer ? <RasterLayerTab layer={layer} /> : null}
        </Fragment>
      </div>
      </FitContext.Provider>
      {mode ? <SelectionOverlay mode={mode} onDone={() => setMode(null)} /> : null}
    </div>
  );
}
