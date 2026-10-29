// Symbology (Defani edition), ArcMap / QGIS style: a renderer list on the left
// (Single Symbol, Unique Values, Graduated Colors, Proportional Symbols, Heat
// Map, Clusters) and its page on the right — value tables with symbol, value,
// label and count, colour schemes (200+ palettes or random colours), class
// methods, and "all symbols" transparency / outline. Everything else (rules,
// expressions, 3D, diagrams, geometry generator…) stays in Advanced.

import {
  BLEND_MODES,
  createGraduatedClassBreaks,
  useAppStore,
  type GeoLibreLayer,
  type GraduatedClassificationScheme,
  type LayerStyle,
  type VectorStyleStop,
} from "@geolibre/core";
import { ArrowDownUp, ChevronDown, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PALETTES, PALETTE_GROUPS, paletteColors, randomColors, type Palette } from "../../lib/color-palettes";
import type { SymbolKind } from "../../lib/symbol-gallery";
import { ColorButton, NO_COLOR } from "./ColorPicker";
import { SymbolEditor, SymbolSelector, SymbolSwatch } from "./SymbolSelector";

type Renderer = "single" | "unique" | "graduated" | "proportional" | "heatmap" | "cluster";

const setStyle = (id: string, patch: Partial<LayerStyle>) => useAppStore.getState().setLayerStyle(id, patch);

export function geometryKindOf(layer: GeoLibreLayer): SymbolKind {
  const meta = String(layer.metadata?.geometryType ?? "").toLowerCase();
  const fromFeature = layer.geojson?.features.find((f) => f.geometry)?.geometry?.type.toLowerCase() ?? "";
  const t = meta || fromFeature;
  if (t.includes("point")) return "point";
  if (t.includes("line")) return "line";
  return "fill";
}

function rendererOf(style: LayerStyle): Renderer {
  if (style.pointRenderer === "heatmap") return "heatmap";
  if (style.pointRenderer === "cluster") return "cluster";
  if (style.vectorStyleMode === "categorized") return "unique";
  if (style.vectorStyleMode === "graduated") return "graduated";
  if (style.proportionalSizeEnabled) return "proportional";
  return "single";
}

function fieldsOf(layer: GeoLibreLayer): string[] {
  const meta = (layer.metadata?.fields as unknown[] | undefined)?.map((f) => (typeof f === "string" ? f : String((f as { name?: string }).name ?? ""))) ?? [];
  const set = new Set(meta.filter(Boolean));
  for (const f of layer.geojson?.features.slice(0, 200) ?? []) Object.keys(f.properties ?? {}).forEach((k) => set.add(k));
  return [...set].filter((k) => k !== "__fid");
}

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/** Unique values of a field with counts (local features, or the native tile cache). */
async function uniqueValues(layer: GeoLibreLayer, field: string): Promise<Array<{ value: string; count: number }>> {
  if (layer.geojson) {
    const counts = new Map<string, number>();
    for (const f of layer.geojson.features) {
      const v = f.properties?.[field];
      const key = v === null || v === undefined ? "" : String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
  }
  const id = layer.metadata?.tileCacheId;
  if (id) {
    const r = await tauriInvoke<{ values: Array<{ value: string | null; count: number }> }>("tiled_vector_field_stats", { id, field, numeric: false });
    return r.values.map((v) => ({ value: v.value ?? "", count: v.count }));
  }
  return [];
}

async function numericValues(layer: GeoLibreLayer, field: string): Promise<number[]> {
  if (layer.geojson) {
    return layer.geojson.features.map((f) => Number(f.properties?.[field])).filter((v) => Number.isFinite(v));
  }
  const id = layer.metadata?.tileCacheId;
  if (id) return (await tauriInvoke<{ values: number[] }>("tiled_vector_field_stats", { id, field, numeric: true })).values;
  return [];
}

// ---------------------------------------------------------------- palette dropdown
const gradient = (colors: string[]) => `linear-gradient(to right, ${colors.map((c, i) => `${c} ${(i / Math.max(1, colors.length - 1)) * 100}%`).join(", ")})`;
const stripes = (colors: string[]) => `linear-gradient(to right, ${colors.map((c, i) => `${c} ${(i / colors.length) * 100}% ${((i + 1) / colors.length) * 100}%`).join(", ")})`;

export function PaletteSelect({ value, onChange, random }: { value: string; onChange: (id: string) => void; random?: boolean }) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState("All");
  const current = PALETTES.find((p) => p.id === value);
  const list = PALETTES.filter((p) => group === "All" || p.group === group);
  return (
    <div className="pal-select">
      <button type="button" className="pal-current" onClick={() => setOpen((o) => !o)}>
        {value === "random" ? <span className="pal-bar" style={{ background: stripes(randomColors(8, 3)) }} /> : <span className="pal-bar" style={{ background: current ? (current.kind === "qualitative" || current.kind === "thematic" ? stripes(current.colors) : gradient(current.colors)) : "#ccc" }} />}
        <span className="pal-name">{value === "random" ? "Random colors" : current?.name ?? "Choose…"}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="pal-menu" onMouseLeave={() => setOpen(false)}>
          <div className="pal-groups">
            {["All", ...PALETTE_GROUPS].map((g) => <button key={g} type="button" className={group === g ? "on" : ""} onClick={() => setGroup(g)}>{g}</button>)}
          </div>
          <div className="pal-list">
            {random ? (
              <button type="button" onClick={() => { onChange("random"); setOpen(false); }}>
                <span className="pal-bar" style={{ background: stripes(randomColors(8, 3)) }} /><span>Random colors</span>
              </button>
            ) : null}
            {list.map((p: Palette) => (
              <button key={p.id} type="button" className={p.id === value ? "on" : ""} onClick={() => { onChange(p.id); setOpen(false); }}>
                <span className="pal-bar" style={{ background: p.kind === "qualitative" || p.kind === "thematic" ? stripes(p.colors) : gradient(p.colors) }} />
                <span>{p.name}</span>
                <em>{p.group}</em>
              </button>
            ))}
          </div>
          <div className="pal-count">{PALETTES.length} palettes</div>
        </div>
      ) : null}
    </div>
  );
}

function colorsFor(scheme: string, count: number, seed = 1): string[] {
  if (scheme === "random") return randomColors(count, seed);
  const p = PALETTES.find((x) => x.id === scheme) ?? PALETTES[0];
  return paletteColors(p, count);
}

// ---------------------------------------------------------------- "all symbols" bar (bulk transparency / outline)
function AllSymbolsBar({ layer }: { layer: GeoLibreLayer }) {
  const st = layer.style;
  return (
    <div className="symb-all">
      <span className="symb-all-title">All symbols</span>
      <label>Transparency
        <input type="range" min={0} max={100} value={Math.round((1 - st.fillOpacity) * 100)} onChange={(e) => setStyle(layer.id, { fillOpacity: 1 - Number(e.target.value) / 100 })} />
        <em>{Math.round((1 - st.fillOpacity) * 100)}%</em>
      </label>
      <label>Outline<ColorButton value={st.strokeWidth === 0 ? NO_COLOR : st.strokeColor} onChange={(c) => setStyle(layer.id, c === NO_COLOR ? { strokeWidth: 0 } : { strokeColor: c, strokeWidth: st.strokeWidth || 0.6 })} /></label>
      <label>Width<input type="number" min={0} max={20} step={0.1} value={st.strokeWidth} onChange={(e) => setStyle(layer.id, { strokeWidth: Number(e.target.value) })} /></label>
    </div>
  );
}

// ---------------------------------------------------------------- pages
function SinglePage({ layer, kind }: { layer: GeoLibreLayer; kind: SymbolKind }) {
  const [selector, setSelector] = useState(false);
  return (
    <div className="symb-single">
      <div className="symb-single-row">
        <button type="button" className="symb-bigswatch" title="Open the Symbol Selector" onClick={() => setSelector(true)}>
          <SymbolSwatch kind={kind} style={layer.style} size={92} />
          <span>Symbol…</span>
        </button>
        <div className="flex-1">
          <SymbolEditor kind={kind} style={layer.style} onChange={(p) => setStyle(layer.id, p)} />
        </div>
      </div>
      {selector ? <SymbolSelector kind={kind} initial={layer.style} onApply={(p) => setStyle(layer.id, { ...p, vectorStyleMode: "single" })} onClose={() => setSelector(false)} /> : null}
    </div>
  );
}

function UniquePage({ layer, kind }: { layer: GeoLibreLayer; kind: SymbolKind }) {
  const st = layer.style;
  const fields = useMemo(() => fieldsOf(layer), [layer]);
  const [field, setField] = useState(st.vectorStyleProperty || fields[0] || "");
  const [scheme, setScheme] = useState(st.vectorStyleColorRamp && PALETTES.some((p) => p.id === st.vectorStyleColorRamp) ? st.vectorStyleColorRamp : "random");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const stops = st.vectorStyleMode === "categorized" ? st.vectorStyleStops : [];
  const write = (next: VectorStyleStop[], extra: Partial<LayerStyle> = {}) =>
    setStyle(layer.id, { vectorStyleMode: "categorized", vectorStyleProperty: field, vectorStyleStops: next, vectorStyleColorRamp: scheme, ...extra });
  const addAll = async () => {
    if (!field) return;
    setBusy(true);
    try {
      const values = await uniqueValues(layer, field);
      const colors = colorsFor(scheme, values.length, values.length);
      setCounts(Object.fromEntries(values.map((v) => [v.value, v.count])));
      write(values.slice(0, 1000).map((v, i) => ({ value: v.value, color: colors[i], label: v.value || "<Null>" })));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!field || st.vectorStyleMode !== "categorized") return;
    void uniqueValues(layer, field).then((v) => setCounts(Object.fromEntries(v.map((x) => [x.value, x.count]))));
  }, [field]); // eslint-disable-line react-hooks/exhaustive-deps
  const recolor = (id: string) => {
    setScheme(id);
    if (!stops.length) return;
    const colors = colorsFor(id, stops.length, stops.length + 7);
    write(stops.map((s, i) => ({ ...s, color: colors[i] })), { vectorStyleColorRamp: id });
  };
  return (
    <div className="symb-page">
      <div className="symb-bar">
        <label>Value field
          <select value={field} onChange={(e) => setField(e.target.value)}>
            {fields.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label>Color scheme<PaletteSelect value={scheme} onChange={recolor} random /></label>
      </div>
      <div className="symb-table-wrap">
        <table className="symb-table">
          <thead><tr><th>Symbol</th><th>Value</th><th>Label</th><th className="text-right">Count</th><th /></tr></thead>
          <tbody>
            {stops.map((s, i) => (
              <tr key={`${s.value}-${i}`}>
                <td><ColorButton value={s.color} allowNone={false} onChange={(c) => write(stops.map((x, j) => (j === i ? { ...x, color: c } : x)))} /></td>
                <td className="font-mono">{String(s.value) || "<Null>"}</td>
                <td><input value={s.label ?? ""} onChange={(e) => write(stops.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></td>
                <td className="text-right tabular-nums">{counts[String(s.value)]?.toLocaleString() ?? ""}</td>
                <td><button type="button" title="Remove" onClick={() => write(stops.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
            {!stops.length ? <tr><td colSpan={5} className="symb-empty">Choose a field, then press <b>Add All Values</b>.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="symb-buttons">
        <button type="button" className="lp-btn primary" disabled={busy || !field} onClick={() => void addAll()}>{busy ? "Reading values…" : "Add All Values"}</button>
        <button type="button" className="lp-btn" onClick={() => { const v = window.prompt("Value to add"); if (v !== null) write([...stops, { value: v, color: colorsFor(scheme, stops.length + 1, stops.length + 3)[stops.length], label: v }]); }}><Plus className="me-1 inline h-3.5 w-3.5" />Add Value…</button>
        <button type="button" className="lp-btn" disabled={!stops.length} onClick={() => write([...stops].reverse().map((s, i) => ({ ...s, color: stops[i].color })))}><ArrowDownUp className="me-1 inline h-3.5 w-3.5" />Reverse colors</button>
        <button type="button" className="lp-btn" disabled={!stops.length} onClick={() => write(stops.map((s, i) => ({ ...s, color: colorsFor("random", stops.length, Date.now() % 997)[i] })), { vectorStyleColorRamp: "random" })}>New random colors</button>
        <button type="button" className="lp-btn" disabled={!stops.length} onClick={() => write([])}>Remove All</button>
        <span className="symb-note">{stops.length ? `${stops.length} classes` : ""}</span>
      </div>
      <AllSymbolsBar layer={layer} />
      {kind === "point" ? <p className="symb-note">Class colours fill the markers; marker shape and size come from Single Symbol.</p> : null}
    </div>
  );
}

const METHODS: Array<[GraduatedClassificationScheme | "manual", string]> = [
  ["natural-breaks", "Natural Breaks (Jenks)"],
  ["equal-interval", "Equal Interval"],
  ["quantile", "Quantile"],
  ["standard-deviation", "Standard Deviation"],
  ["geometric-interval", "Geometrical Interval"],
  ["manual", "Manual"],
];

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number(v.toPrecision(5)).toString());

function GraduatedPage({ layer }: { layer: GeoLibreLayer }) {
  const st = layer.style;
  const fields = useMemo(() => fieldsOf(layer), [layer]);
  const numericFields = useMemo(
    () => (layer.geojson ? fields.filter((f) => layer.geojson!.features.slice(0, 100).some((x) => Number.isFinite(Number(x.properties?.[f])) && x.properties?.[f] !== "" && x.properties?.[f] !== null)) : fields),
    [fields, layer.geojson],
  );
  const [field, setField] = useState(st.vectorStyleProperty || numericFields[0] || "");
  const [method, setMethod] = useState<string>(st.vectorStyleClassificationScheme || "natural-breaks");
  const [count, setCount] = useState(st.vectorStyleClassCount || 5);
  const [scheme, setScheme] = useState(PALETTES.some((p) => p.id === st.vectorStyleColorRamp) ? st.vectorStyleColorRamp : "colorbrewer-ylorrd");
  const [range, setRange] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const stops = st.vectorStyleMode === "graduated" ? st.vectorStyleStops : [];
  const classify = async (opts: { method?: string; count?: number; scheme?: string } = {}) => {
    const m = opts.method ?? method, n = opts.count ?? count, sc = opts.scheme ?? scheme;
    if (!field) return;
    setBusy(true);
    try {
      const values = await numericValues(layer, field);
      if (!values.length) return;
      const min = Math.min(...values), max = Math.max(...values);
      setRange([min, max]);
      const breaks = m === "manual" && stops.length ? stops.map((s) => Number(s.value)) : createGraduatedClassBreaks(values, n, (m === "manual" ? "equal-interval" : m) as GraduatedClassificationScheme);
      const colors = colorsFor(sc, breaks.length);
      const next = breaks.map((b, i) => ({ value: b, color: colors[i], label: `${fmt(b)} – ${fmt(i + 1 < breaks.length ? breaks[i + 1] : max)}` }));
      setStyle(layer.id, { vectorStyleMode: "graduated", vectorStyleProperty: field, vectorStyleStops: next, vectorStyleClassCount: n, vectorStyleClassificationScheme: m, vectorStyleColorRamp: sc });
    } finally {
      setBusy(false);
    }
  };
  const write = (next: VectorStyleStop[]) => setStyle(layer.id, { vectorStyleStops: next, vectorStyleClassificationScheme: "manual" });
  return (
    <div className="symb-page">
      <div className="symb-bar">
        <label>Field
          <select value={field} onChange={(e) => setField(e.target.value)}>
            {numericFields.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label>Method
          <select value={method} onChange={(e) => { setMethod(e.target.value); if (e.target.value !== "manual") void classify({ method: e.target.value }); }}>
            {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>Classes
          <select value={count} onChange={(e) => { const n = Number(e.target.value); setCount(n); void classify({ count: n }); }}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label>Color ramp<PaletteSelect value={scheme} onChange={(id) => { setScheme(id); void classify({ scheme: id }); }} /></label>
      </div>
      <div className="symb-table-wrap">
        <table className="symb-table">
          <thead><tr><th>Symbol</th><th>From</th><th>Label</th><th /></tr></thead>
          <tbody>
            {stops.map((s, i) => (
              <tr key={i}>
                <td><ColorButton value={s.color} allowNone={false} onChange={(c) => write(stops.map((x, j) => (j === i ? { ...x, color: c } : x)))} /></td>
                <td><input type="number" className="w-28" value={Number(s.value)} onChange={(e) => write(stops.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)))} /></td>
                <td><input value={s.label ?? ""} onChange={(e) => write(stops.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></td>
                <td><button type="button" title="Remove class" onClick={() => write(stops.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></button></td>
              </tr>
            ))}
            {!stops.length ? <tr><td colSpan={4} className="symb-empty">Choose a numeric field and press <b>Classify</b>.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="symb-buttons">
        <button type="button" className="lp-btn primary" disabled={busy || !field} onClick={() => void classify()}>{busy ? "Classifying…" : "Classify"}</button>
        <button type="button" className="lp-btn" disabled={!stops.length} onClick={() => write([...stops].map((s, i, a) => ({ ...s, color: a[a.length - 1 - i].color })))}><ArrowDownUp className="me-1 inline h-3.5 w-3.5" />Reverse colors</button>
        <span className="symb-note">{range ? `Range ${fmt(range[0])} – ${fmt(range[1])}` : ""}</span>
      </div>
      <AllSymbolsBar layer={layer} />
    </div>
  );
}

function ProportionalPage({ layer }: { layer: GeoLibreLayer }) {
  const st = layer.style;
  const fields = useMemo(() => fieldsOf(layer), [layer]);
  const set = (p: Partial<LayerStyle>) => setStyle(layer.id, { proportionalSizeEnabled: true, ...p });
  const autoRange = async (field: string) => {
    const v = await numericValues(layer, field);
    if (v.length) set({ proportionalSizeProperty: field, proportionalSizeMinValue: Math.min(...v), proportionalSizeMaxValue: Math.max(...v) });
  };
  return (
    <div className="symb-page">
      <div className="symb-bar">
        <label>Field<select value={st.proportionalSizeProperty} onChange={(e) => void autoRange(e.target.value)}><option value="">—</option>{fields.map((f) => <option key={f}>{f}</option>)}</select></label>
        <label>Min value<input type="number" value={st.proportionalSizeMinValue} onChange={(e) => set({ proportionalSizeMinValue: Number(e.target.value) })} /></label>
        <label>Max value<input type="number" value={st.proportionalSizeMaxValue} onChange={(e) => set({ proportionalSizeMaxValue: Number(e.target.value) })} /></label>
        <label>Min size<input type="number" min={1} value={st.proportionalSizeMinRadius} onChange={(e) => set({ proportionalSizeMinRadius: Number(e.target.value) })} /></label>
        <label>Max size<input type="number" min={1} value={st.proportionalSizeMaxRadius} onChange={(e) => set({ proportionalSizeMaxRadius: Number(e.target.value) })} /></label>
      </div>
      <label className="lp-check"><input type="checkbox" checked={st.proportionalSizeEnabled} onChange={(e) => setStyle(layer.id, { proportionalSizeEnabled: e.target.checked })} /> Size symbols by this field (circles for points, widths for lines)</label>
      <SinglePage layer={layer} kind={geometryKindOf(layer)} />
    </div>
  );
}

function HeatmapPage({ layer }: { layer: GeoLibreLayer }) {
  const st = layer.style;
  const fields = useMemo(() => fieldsOf(layer), [layer]);
  const set = (p: Partial<LayerStyle>) => setStyle(layer.id, { pointRenderer: "heatmap", ...p });
  return (
    <div className="symb-page">
      <div className="symb-bar">
        <label>Radius (px)<input type="number" min={1} max={200} value={st.heatmapRadius} onChange={(e) => set({ heatmapRadius: Number(e.target.value) })} /></label>
        <label>Intensity<input type="number" min={0.1} max={10} step={0.1} value={st.heatmapIntensity} onChange={(e) => set({ heatmapIntensity: Number(e.target.value) })} /></label>
        <label>Weight field<select value={st.heatmapWeightProperty} onChange={(e) => set({ heatmapWeightProperty: e.target.value })}><option value="">(each point = 1)</option>{fields.map((f) => <option key={f}>{f}</option>)}</select></label>
      </div>
      <p className="symb-note">A density surface of the points, like ArcGIS Pro's Heat Map symbology.</p>
    </div>
  );
}

function ClusterPage({ layer }: { layer: GeoLibreLayer }) {
  const st = layer.style;
  const set = (p: Partial<LayerStyle>) => setStyle(layer.id, { pointRenderer: "cluster", ...p });
  return (
    <div className="symb-page">
      <div className="symb-bar">
        <label>Cluster radius (px)<input type="number" min={5} max={200} value={st.clusterRadius} onChange={(e) => set({ clusterRadius: Number(e.target.value) })} /></label>
        <label>Stop clustering at zoom<input type="number" min={0} max={22} value={st.clusterMaxZoom} onChange={(e) => set({ clusterMaxZoom: Number(e.target.value) })} /></label>
      </div>
      <p className="symb-note">Nearby points merge into one circle labelled with their number; zoom in to see them separately.</p>
    </div>
  );
}

// ---------------------------------------------------------------- page

const RENDERERS: Array<[Renderer, string, string, SymbolKind[] | null]> = [
  ["single", "Single Symbol", "Every feature drawn with one symbol", null],
  ["unique", "Unique Values", "A symbol per category (random colours or a scheme)", null],
  ["graduated", "Graduated Colors", "Colour ramp by numeric classes", null],
  ["proportional", "Proportional Symbols", "Symbol size by a number", ["point", "line"]],
  ["heatmap", "Heat Map", "Point density surface", ["point"]],
  ["cluster", "Clusters", "Group nearby points", ["point"]],
];

export function SymbologyPage({ layer, onAdvanced }: { layer: GeoLibreLayer; onAdvanced: () => void }) {
  const kind = geometryKindOf(layer);
  const [renderer, setRenderer] = useState<Renderer>(() => rendererOf(layer.style));
  useEffect(() => setRenderer(rendererOf(layer.style)), [layer.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (r: Renderer) => {
    setRenderer(r);
    const patch: Partial<LayerStyle> = { pointRenderer: "single" };
    if (r === "single") Object.assign(patch, { vectorStyleMode: "single", proportionalSizeEnabled: false });
    if (r === "heatmap") Object.assign(patch, { pointRenderer: "heatmap" });
    if (r === "cluster") Object.assign(patch, { pointRenderer: "cluster" });
    if (r === "proportional") Object.assign(patch, { proportionalSizeEnabled: true, vectorStyleMode: "single" });
    setStyle(layer.id, patch);
  };
  return (
    <div className="symb">
      <nav className="symb-renderers">
        <div className="symb-cap">Show</div>
        {RENDERERS.filter(([, , , kinds]) => !kinds || kinds.includes(kind)).map(([id, label, hint]) => (
          <button key={id} type="button" className={renderer === id ? "on" : ""} onClick={() => choose(id)} title={hint}>
            <span>{label}</span>
            <em>{hint}</em>
          </button>
        ))}
        <button type="button" onClick={onAdvanced} title="Rule-based, expressions, 3D extrusion, diagrams, geometry generator, decorations…">
          <span>Advanced…</span>
          <em>Rules, expressions, 3D, diagrams and every other option</em>
        </button>
        <div className="symb-cap mt-3">Layer</div>
        <label className="symb-blend">Blend mode
          <select value={layer.style.blendMode ?? "normal"} onChange={(e) => setStyle(layer.id, { blendMode: e.target.value as LayerStyle["blendMode"] })}>
            {BLEND_MODES.map((m) => <option key={m} value={m}>{m[0].toUpperCase() + m.slice(1)}</option>)}
          </select>
        </label>
      </nav>
      <div className="symb-body">
        {renderer === "single" ? <SinglePage layer={layer} kind={kind} /> : null}
        {renderer === "unique" ? <UniquePage layer={layer} kind={kind} /> : null}
        {renderer === "graduated" ? <GraduatedPage layer={layer} /> : null}
        {renderer === "proportional" ? <ProportionalPage layer={layer} /> : null}
        {renderer === "heatmap" ? <HeatmapPage layer={layer} /> : null}
        {renderer === "cluster" ? <ClusterPage layer={layer} /> : null}
      </div>
    </div>
  );
}
