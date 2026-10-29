// Layer Properties (Defani edition): ArcGIS Pro's Layer Properties window —
// a floating, resizable dialog with a vertical tab bar (General, Source,
// Symbology, Labels, Definition Query, Fields, Joins). Symbology hosts the
// full style panel, so every renderer the app has is reachable from here.

import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  Database,
  FileText,
  Filter,
  Info,
  Link2,
  Maximize2,
  Minimize2,
  Paintbrush,
  SlidersHorizontal,
  Table2,
  Tag,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { runCommand } from "../../lib/command-registry";
import { parseDefinitionQuery } from "../layout/ProRibbon";
import { StylePanel } from "./StylePanel";
import { ZoomRangeControls } from "./style-panel/ZoomRangeControls";
import { SymbologyPage } from "../symbology/SymbologyPage";

type TabId = "general" | "source" | "symbology" | "advanced" | "labels" | "query" | "fields" | "joins";

const usePropertiesWindow = create<{ layerId: string | null; tab: TabId; open: (id: string, tab?: TabId) => void; close: () => void }>((set) => ({
  layerId: null,
  tab: "general",
  open: (layerId, tab = "general") => set({ layerId, tab }),
  close: () => set({ layerId: null }),
}));

/** Open Layer Properties for a layer (right-click › Properties). */
export function openLayerProperties(layerId: string, tab: TabId = "general"): void {
  useAppStore.getState().selectLayer(layerId);
  usePropertiesWindow.getState().open(layerId, tab);
}

const TABS: Array<[TabId, string, LucideIcon, string]> = [
  ["general", "General", Info, "#0079C1"],
  ["source", "Source", Database, "#D4A015"],
  ["symbology", "Symbology", Paintbrush, "#7E57C2"],
  ["advanced", "Advanced Symbology", SlidersHorizontal, "#7E57C2"],
  ["labels", "Labels", Tag, "#E8871E"],
  ["query", "Definition Query", Filter, "#11968A"],
  ["fields", "Fields", Table2, "#3A9E43"],
  ["joins", "Joins", Link2, "#D23C2F"],
];

function fieldStats(layer: GeoLibreLayer) {
  const features = layer.geojson?.features ?? [];
  const fromMeta = (layer.metadata?.fields as unknown[] | undefined)?.map((f) => (typeof f === "string" ? f : String((f as { name?: string }).name ?? ""))) ?? [];
  const names = new Set<string>(fromMeta.filter(Boolean));
  for (const f of features.slice(0, 200)) Object.keys(f.properties ?? {}).forEach((k) => names.add(k));
  return [...names].map((name) => {
    let type = "—";
    let filled = 0;
    let sample: unknown = undefined;
    for (const f of features) {
      const v = f.properties?.[name];
      if (v === null || v === undefined || v === "") continue;
      filled += 1;
      if (sample === undefined) sample = v;
      if (type === "—") type = typeof v === "number" ? (Number.isInteger(v) ? "Integer" : "Double") : typeof v === "boolean" ? "Boolean" : "Text";
    }
    return { name, type, filled, sample };
  });
}

function bboxOf(layer: GeoLibreLayer): string {
  const b = (layer.source as { bounds?: number[] }).bounds;
  if (Array.isArray(b) && b.length === 4) return b.map((v) => v.toFixed(5)).join(", ");
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [x, y] = c as number[];
      if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  for (const f of layer.geojson?.features ?? []) visit((f.geometry as { coordinates?: unknown } | null)?.coordinates);
  return Number.isFinite(w) ? [w, s, e, n].map((v) => v.toFixed(5)).join(", ") : "—";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="lp-row">
      <span className="lp-label">{label}</span>
      <div className="lp-value">{children}</div>
    </div>
  );
}

function GeneralTab({ layer }: { layer: GeoLibreLayer }) {
  const s = useAppStore.getState();
  return (
    <div className="lp-form">
      <Row label="Name">
        <input className="lp-input" value={layer.name} onChange={(e) => s.updateLayer(layer.id, { name: e.target.value })} />
      </Row>
      <Row label="Visible">
        <label className="lp-check"><input type="checkbox" checked={layer.visible} onChange={(e) => s.updateLayer(layer.id, { visible: e.target.checked })} /> Show this layer</label>
      </Row>
      <Row label="Transparency">
        <div className="flex items-center gap-2">
          <input type="range" min={0} max={100} className="w-48 accent-[#0079C1]" value={Math.round((1 - layer.opacity) * 100)} onChange={(e) => s.updateLayer(layer.id, { opacity: 1 - Number(e.target.value) / 100 })} />
          <span className="w-10 text-right tabular-nums">{Math.round((1 - layer.opacity) * 100)}%</span>
        </div>
      </Row>
      <Row label="Visibility range">
        <div className="lp-embed"><ZoomRangeControls layer={layer} /></div>
      </Row>
      <Row label="Description">
        <textarea
          className="lp-input min-h-[90px]"
          value={String(layer.metadata?.description ?? "")}
          placeholder="Notes about this layer (source, date, purpose)…"
          onChange={(e) => s.updateLayer(layer.id, { metadata: { ...layer.metadata, description: e.target.value } })}
        />
      </Row>
    </div>
  );
}

function SourceTab({ layer }: { layer: GeoLibreLayer }) {
  const count = layer.geojson?.features.length ?? (layer.metadata?.featureCount as number | undefined);
  const native = layer.metadata?.sourceKind === "native-tiles";
  return (
    <div className="lp-form">
      <Row label="Data type">{layer.type}{native ? " (native vector tiles, indexed cache)" : ""}</Row>
      <Row label="Location"><span className="break-all">{layer.sourcePath ?? String((layer.source as { url?: string }).url ?? "In memory")}</span></Row>
      <Row label="Geometry">{String(layer.metadata?.geometryType ?? layer.geojson?.features.find((f) => f.geometry)?.geometry?.type ?? "—")}</Row>
      <Row label="Features">{count !== undefined ? count.toLocaleString() : "—"}</Row>
      <Row label="Coordinate system">{String(layer.metadata?.crs ?? layer.metadata?.sourceCrs ?? "WGS 84 (EPSG:4326) on the map")}</Row>
      <Row label="Extent (W, S, E, N)">{bboxOf(layer)}</Row>
      {native ? <Row label="Tile cache">{String(layer.metadata?.tileCacheId ?? "")}</Row> : null}
    </div>
  );
}

function LabelsTab({ layer, onMore }: { layer: GeoLibreLayer; onMore: () => void }) {
  const labels = layer.style.labels;
  const fields = useMemo(() => fieldStats(layer).map((f) => f.name), [layer]);
  const set = (patch: Partial<typeof labels>) => useAppStore.getState().setLayerStyle(layer.id, { labels: { ...labels, ...patch } });
  return (
    <div className="lp-form">
      <Row label="Label features">
        <label className="lp-check"><input type="checkbox" checked={labels.enabled} onChange={(e) => set({ enabled: e.target.checked, field: labels.field || fields[0] || "" })} /> Show labels</label>
      </Row>
      <Row label="Field">
        <select className="lp-input" value={labels.field} onChange={(e) => set({ field: e.target.value, enabled: true })}>
          <option value="">—</option>
          {fields.map((f) => <option key={f}>{f}</option>)}
        </select>
      </Row>
      <Row label="Size">
        <input type="number" min={6} max={48} className="lp-input w-24" value={labels.size} onChange={(e) => set({ size: Number(e.target.value) })} />
      </Row>
      <Row label="Colour / halo">
        <div className="flex items-center gap-2">
          <input type="color" value={labels.color} onChange={(e) => set({ color: e.target.value })} />
          <input type="color" value={labels.haloColor} onChange={(e) => set({ haloColor: e.target.value })} />
          <input type="number" min={0} max={6} step={0.5} className="lp-input w-20" value={labels.haloWidth} onChange={(e) => set({ haloWidth: Number(e.target.value) })} title="Halo width" />
        </div>
      </Row>
      <Row label="Placement">
        <select className="lp-input" value={labels.placement} onChange={(e) => set({ placement: e.target.value as "point" | "line" })}>
          <option value="point">Point / centre</option>
          <option value="line">Along lines</option>
        </select>
      </Row>
      <Row label="Overlap">
        <label className="lp-check"><input type="checkbox" checked={labels.allowOverlap} onChange={(e) => set({ allowOverlap: e.target.checked })} /> Allow overlapping labels</label>
      </Row>
      <Row label="">
        <button type="button" className="lp-btn" onClick={onMore}>More label options (expressions, rules, fonts)…</button>
      </Row>
    </div>
  );
}

function QueryTab({ layer }: { layer: GeoLibreLayer }) {
  const [text, setText] = useState(String(layer.metadata?.definitionQuery ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState("");
  const fields = useMemo(() => fieldStats(layer), [layer]);
  const values = useMemo(() => {
    if (!field) return [];
    const set = new Set<string>();
    for (const f of layer.geojson?.features ?? []) {
      const v = f.properties?.[field];
      if (v !== null && v !== undefined) set.add(String(v));
      if (set.size >= 200) break;
    }
    return [...set].sort();
  }, [field, layer]);
  const insert = (snippet: string) => setText((t) => (t ? `${t} ${snippet}` : snippet));
  const apply = (q: string) => {
    try {
      const expr = parseDefinitionQuery(q);
      const metadata: Record<string, unknown> = { ...layer.metadata, definitionQuery: q };
      delete metadata.tocHiddenClasses;
      delete metadata.tocBaseFilter;
      useAppStore.getState().updateLayer(layer.id, { filterExpression: expr ?? undefined, metadata } as Partial<GeoLibreLayer>);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="lp-form">
      <p className="lp-help">Show only the features that match. Example: <code>FUNGSIKWS = 'HP' AND LUAS &gt; 10</code>. Operators: = &lt;&gt; &gt; &lt; &gt;= &lt;=, IN ('a','b'), LIKE 'Hutan%', AND, OR.</p>
      <textarea className={`lp-input min-h-[90px] font-mono ${error ? "border-red-500" : ""}`} value={text} onChange={(e) => setText(e.target.value)} />
      {error ? <div className="text-[11.5px] text-red-600">{error}</div> : null}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="lp-sub">Fields</div>
          <div className="lp-list">
            {fields.map((f) => (
              <button key={f.name} type="button" className={field === f.name ? "on" : ""} onClick={() => setField(f.name)} onDoubleClick={() => insert(f.name)}>{f.name}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="lp-sub">Values {field ? `of ${field}` : ""}</div>
          <div className="lp-list">
            {values.map((v) => (
              <button key={v} type="button" onDoubleClick={() => insert(/^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`)}>{v}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {["=", "<>", ">", "<", "IN ()", "LIKE ''", "AND", "OR"].map((op) => (
          <button key={op} type="button" className="lp-btn" onClick={() => insert(op)}>{op}</button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="lp-btn" onClick={() => { setText(""); apply(""); }}>Clear</button>
        <button type="button" className="lp-btn primary" onClick={() => apply(text)}>Apply</button>
      </div>
      <p className="lp-help">Double-click a field or a value to insert it.</p>
    </div>
  );
}

function FieldsTab({ layer }: { layer: GeoLibreLayer }) {
  const fields = useMemo(() => fieldStats(layer), [layer]);
  const total = layer.geojson?.features.length ?? 0;
  return (
    <div className="lp-form">
      <table className="lp-table">
        <thead><tr><th>Field</th><th>Type</th><th>Filled</th><th>Example</th></tr></thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name}>
              <td className="font-medium">{f.name}</td>
              <td>{f.type}</td>
              <td className="tabular-nums">{total ? `${f.filled.toLocaleString()} / ${total.toLocaleString()}` : "—"}</td>
              <td className="max-w-[220px] truncate">{f.sample === undefined ? "" : String(f.sample)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2">
        <button type="button" className="lp-btn" onClick={() => { useAppStore.getState().selectLayer(layer.id); useAppStore.getState().setAttributeTableOpen(true); }}>Open attribute table</button>
        <button type="button" className="lp-btn" onClick={() => runCommand("proc.vector.attribute-join")}>Add field from another table (Join)…</button>
      </div>
    </div>
  );
}

function JoinsTab() {
  return (
    <div className="lp-form">
      <p className="lp-help">Attach the attributes of another layer or table by a common field (like ArcGIS Add Join), or by location.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="lp-btn primary" onClick={() => runCommand("proc.vector.attribute-join")}>Add Join (by field)…</button>
        <button type="button" className="lp-btn" onClick={() => runCommand("proc.vector.spatial-join")}>Spatial Join (by location)…</button>
      </div>
    </div>
  );
}

export function LayerPropertiesWindow({ mapControllerRef, mapReadyGeneration }: { mapControllerRef: RefObject<MapEngine | null>; mapReadyGeneration?: number }) {
  const { layerId, tab, open, close } = usePropertiesWindow();
  const layer = useAppStore((s) => s.layers.find((l) => l.id === layerId) ?? null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [max, setMax] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => {
    if (!layerId) return;
    setPos({ x: Math.max(20, window.innerWidth / 2 - 420), y: Math.max(20, window.innerHeight / 2 - 300) });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layerId, close]);
  useEffect(() => {
    if (layerId && !layer) close();
  }, [layerId, layer, close]);
  if (!layerId || !layer) return null;
  const setTab = (t: TabId) => open(layer.id, t);
  return createPortal(
    <div
      role="dialog"
      aria-label={`Layer Properties: ${layer.name}`}
      className={`lp-win ${max ? "max" : ""}`}
      style={max ? undefined : { left: pos.x, top: pos.y }}
    >
      <div
        className="lp-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button") || max) return;
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => drag.current && setPos({ x: Math.max(0, e.clientX - drag.current.dx), y: Math.max(0, e.clientY - drag.current.dy) })}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => setMax((m) => !m)}
      >
        <FileText className="h-4 w-4 text-[#0079C1]" />
        <span className="truncate">Layer Properties: {layer.name}</span>
        <div className="flex-1" />
        <button type="button" title={max ? "Restore" : "Maximize"} onClick={() => setMax((m) => !m)}>{max ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
        <button type="button" title="Close (Esc)" onClick={close}><X className="h-4 w-4" /></button>
      </div>
      <div className="lp-main">
        <nav className="lp-tabs" aria-label="Property pages">
          {TABS.map(([id, label, Icon, color]) => (
            <button key={id} type="button" className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              <Icon className="h-4 w-4" style={{ color }} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className={`lp-body ${tab === "advanced" ? "lp-style" : tab === "symbology" ? "lp-symb" : ""}`}>
          {tab === "general" ? <GeneralTab layer={layer} /> : null}
          {tab === "source" ? <SourceTab layer={layer} /> : null}
          {tab === "symbology" ? <SymbologyPage layer={layer} onAdvanced={() => setTab("advanced")} /> : null}
          {tab === "advanced" ? (
            <StylePanel
              mapControllerRef={mapControllerRef}
              mapReadyGeneration={mapReadyGeneration}
              onResizeStart={() => undefined}
              collapsed={false}
              onCollapsedChange={() => undefined}
              hideOwnRail
            />
          ) : null}
          {tab === "labels" ? <LabelsTab layer={layer} onMore={() => setTab("advanced")} /> : null}
          {tab === "query" ? <QueryTab layer={layer} /> : null}
          {tab === "fields" ? <FieldsTab layer={layer} /> : null}
          {tab === "joins" ? <JoinsTab /> : null}
        </div>
      </div>
      <div className="lp-foot">
        <button type="button" className="lp-btn primary" onClick={close}>OK</button>
      </div>
    </div>,
    document.body,
  );
}
