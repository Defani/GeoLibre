import { useAppStore } from "@geolibre/core";
import { readRasterData, writeRasterData, type RasterData } from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { ArrowDown, ArrowUp, Cog, Crosshair, Download, FolderOpen, Loader2, Play, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { COMPOSITES, getAnalysisTool, matchBand, type ToolContext, type ToolParam, type ToolResult } from "../../lib/analysis/tools";
import { loadDroppedRasterFiles } from "../../lib/file-io/raster-photo-files";
import { readLocalFileBytes } from "../../lib/file-io/local-fs";
import { useProcessNotifier } from "../../lib/process-notify";
import { getShellActions } from "../../lib/shell-actions";
import { isTauri } from "../../lib/tauri-io";
import { ParamHelpPane, useParamHelp } from "./ParamHelp";

/** Which Analysis Toolkit tool is open (Defani edition). */
export const useAnalysisToolkit = create<{ toolId: string | null; open: (id: string | null) => void }>((set) => ({
  toolId: null,
  open: (toolId) => set({ toolId }),
}));
export const openAnalysisTool = (id: string) => useAnalysisToolkit.getState().open(id);

interface RasterSource {
  name: string;
  load: () => Promise<ArrayBuffer>;
}

type MapLike = {
  getBounds: () => { toArray: () => number[][] };
  once: (type: string, fn: (e: { lngLat: { lng: number; lat: number } }) => void) => void;
  getCanvas: () => HTMLCanvasElement;
};
const getMap = () => (getShellActions()?.getAppApi() as { getMap?: () => MapLike | null } | undefined)?.getMap?.() ?? null;

function downloadCsv(name: string, columns: string[], rows: Array<Array<string | number>>) {
  const esc = (v: string | number) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
  const csv = [columns, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: `${name}.csv` }).click();
  URL.revokeObjectURL(url);
}

/** The Analysis Toolkit window: renders any registered tool's form and runs it. */
export function AnalysisToolkitWindow() {
  const { toolId, open } = useAnalysisToolkit();
  const tool = toolId ? getAnalysisTool(toolId) : undefined;
  const layers = useAppStore((s) => s.layers);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const addTileLayer = useAppStore((s) => s.addTileLayer);
  const paramHelp = useParamHelp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<RasterSource[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ToolResult | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [picking, setPicking] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 130, y: 70 });
  const fileRef = useRef<HTMLInputElement>(null);
  useProcessNotifier(tool?.title ?? "Analysis", running, !!error && !running, error);

  // Defaults when a tool opens.
  useEffect(() => {
    if (!tool) return;
    const init: Record<string, string> = {};
    for (const p of tool.params) {
      if (p.default !== undefined) init[p.id] = String(p.default);
      if (p.id === "key") {
        try { init.key = localStorage.getItem("the-funny-gis:firms-key") ?? ""; } catch { /* ignore */ }
      }
    }
    setValues(init);
    setResult(null);
    setError(null);
    setLog([]);
    paramHelp.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  const sources = useMemo<RasterSource[]>(() => {
    const fromMap = layers
      .filter((l) => l.sourcePath && /\.tiff?$/i.test(l.sourcePath))
      .map((l) => ({ name: l.name, load: async () => (await readLocalFileBytes(l.sourcePath!)).buffer as ArrayBuffer }));
    return [...fromMap, ...extra.filter((e) => !fromMap.some((m) => m.name === e.name))];
  }, [layers, extra]);

  if (!tool) return null;
  const set = (id: string, value: string) =>
    setValues((v) => {
      const next = { ...v, [id]: value };
      // Composite presets pick the bands whose names end in the band codes.
      if (tool.id === "composite" && id === "preset" && COMPOSITES[value]) {
        const names = sources.map((s) => s.name);
        const [r, g, b] = COMPOSITES[value].bands;
        next.red = matchBand(names, r) || next.red;
        next.green = matchBand(names, g) || next.green;
        next.blue = matchBand(names, b) || next.blue;
      }
      return next;
    });
  const visible = (p: ToolParam) => !p.when || (values[p.when[0]] ?? "") === p.when[1];
  const vectorLayers = (geometry: ToolParam["geometry"]) =>
    layers.filter((l) => {
      const f = l.geojson?.features;
      if (!f?.length) return false;
      if (!geometry || geometry === "any") return true;
      const re = geometry === "polygon" ? /Polygon/ : geometry === "point" ? /Point/ : /LineString/;
      return f.some((x) => re.test(x.geometry?.type ?? ""));
    });

  const addRasters = async () => {
    if (isTauri()) {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const picked = await pick({ multiple: true, filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(String);
      setExtra((c) => [...c, ...paths.map((p) => ({ name: p.split(/[\\/]/).pop()!.replace(/\.tiff?$/i, ""), load: async () => (await readLocalFileBytes(p)).buffer as ArrayBuffer }))]);
    } else fileRef.current?.click();
  };

  const pickPoint = (id: string) => {
    const map = getMap();
    if (!map) return;
    setPicking(id);
    map.getCanvas().style.cursor = "crosshair";
    map.once("click", (e) => {
      set(id, `${e.lngLat.lng.toFixed(6)}, ${e.lngLat.lat.toFixed(6)}`);
      map.getCanvas().style.cursor = "";
      setPicking(null);
    });
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setLog([]);
    const cache = new Map<string, RasterData>();
    const ctx: ToolContext = {
      raster: async (name) => {
        if (!name) throw new Error("Choose every required raster.");
        if (!cache.has(name)) {
          const source = sources.find((s) => s.name === name);
          if (!source) throw new Error(`Raster "${name}" is not available.`);
          setLog((l) => [...l, `Reading ${name}…`]);
          cache.set(name, await readRasterData(await source.load()));
        }
        return cache.get(name)!;
      },
      layer: (id) => {
        const l = layers.find((x) => x.id === id);
        if (!l?.geojson) throw new Error("Choose every required layer.");
        return { id: l.id, name: l.name, geojson: l.geojson };
      },
      addRaster: async (raster, name) => {
        const bytes = writeRasterData(raster);
        await getShellActions()?.addDroppedRasters(loadDroppedRasterFiles([new File([bytes], `${name}.tif`, { type: "image/tiff" })]));
        setLog((l) => [...l, `Added raster "${name}".`]);
      },
      addRasterBytes: async (bytes, name) => {
        await getShellActions()?.addDroppedRasters(loadDroppedRasterFiles([new File([bytes], `${name}.tif`, { type: "image/tiff" })]));
        setLog((l) => [...l, `Added raster "${name}".`]);
      },
      addVector: (fc, name) => {
        addGeoJsonLayer(name, fc);
        setLog((l) => [...l, `Added layer "${name}" (${fc.features.length} features).`]);
      },
      updateVector: (id, fc) => updateLayer(id, { geojson: fc }),
      addTiles: (name, url, attribution, bounds) => addTileLayer(name, { type: "xyz", tiles: [url], url, attribution, bounds, maxzoom: 16 }),
      mapBounds: () => {
        const map = getMap();
        if (!map) throw new Error("The map is not ready.");
        const [[w, s], [e, n]] = map.getBounds().toArray();
        return [w, s, e, n];
      },
      httpFetch: async (url) => {
        if (isTauri()) {
          const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
          return (await tauriFetch(url)).text();
        }
        return (await fetch(url)).text();
      },
      log: (line) => setLog((l) => [...l, line]),
    };
    try {
      for (const p of tool.params) {
        if (!visible(p) || p.optional || p.type === "checkbox") continue;
        if (!values[p.id]) throw new Error(`“${p.label}” is required.`);
      }
      setResult(await tool.run(values, ctx));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const fieldsOf = (paramId: string) => {
    const l = layers.find((x) => x.id === values[paramId]);
    const keys = new Set<string>();
    l?.geojson?.features.slice(0, 200).forEach((f) => Object.keys(f.properties ?? {}).forEach((k) => keys.add(k)));
    return [...keys];
  };

  const renderParam = (p: ToolParam) => {
    const common = { "data-help-label": p.label, "data-help": p.help };
    const label = (
      <Label className="text-xs">
        {p.label}
        {p.optional ? <span className="text-muted-foreground"> (optional)</span> : null}
      </Label>
    );
    if (p.type === "raster")
      return (
        <div key={p.id} className="space-y-1" {...common}>
          {label}
          <div className="flex gap-1">
            <Select className="h-8 flex-1 text-xs" value={values[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)}>
              <option value="">{p.optional ? "— none —" : "Choose a raster…"}</option>
              {sources.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </Select>
            <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={() => void addRasters()}>
              <FolderOpen className="h-3.5 w-3.5" /> Add…
            </Button>
          </div>
        </div>
      );
    if (p.type === "rasters") {
      const chosen = (values[p.id] ?? "").split("\n").filter(Boolean);
      const setList = (list: string[]) => set(p.id, list.join("\n"));
      return (
        <div key={p.id} className="space-y-1" {...common}>
          <div className="flex items-center justify-between">
            {label}
            <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => void addRasters()}>
              <FolderOpen className="h-3 w-3" /> Add…
            </Button>
          </div>
          <Select className="h-8 text-xs" value="" onChange={(e) => e.target.value && setList([...chosen, e.target.value])}>
            <option value="">+ Add a raster to the list…</option>
            {sources.filter((s) => !chosen.includes(s.name)).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          </Select>
          <ol className="divide-y rounded border">
            {chosen.map((name, i) => (
              <li key={name} className="flex items-center gap-1 px-2 py-1">
                <span className="w-5 text-[11px] text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => { const c = [...chosen]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; setList(c); }}><ArrowUp className="h-3 w-3" /></button>
                <button type="button" aria-label="Move down" disabled={i === chosen.length - 1} onClick={() => { const c = [...chosen]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; setList(c); }}><ArrowDown className="h-3 w-3" /></button>
                <button type="button" aria-label="Remove" onClick={() => setList(chosen.filter((n) => n !== name))}><X className="h-3 w-3" /></button>
              </li>
            ))}
            {!chosen.length ? <li className="px-2 py-1 text-[11px] text-muted-foreground">No rasters yet.</li> : null}
          </ol>
        </div>
      );
    }
    if (p.type === "vector")
      return (
        <div key={p.id} className="space-y-1" {...common}>
          {label}
          <Select className="h-8 text-xs" value={values[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)}>
            <option value="">{p.optional ? "— none —" : "Choose a layer…"}</option>
            {vectorLayers(p.geometry).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </div>
      );
    if (p.type === "field")
      return (
        <div key={p.id} className="space-y-1" {...common}>
          {label}
          <Select className="h-8 text-xs" value={values[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)}>
            <option value="">{p.optional ? "— none —" : "Choose a field…"}</option>
            {fieldsOf(p.of!).map((f) => <option key={f} value={f}>{f}</option>)}
          </Select>
        </div>
      );
    if (p.type === "select")
      return (
        <div key={p.id} className="space-y-1" {...common}>
          {label}
          <Select className="h-8 text-xs" value={values[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)}>
            {p.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </div>
      );
    if (p.type === "textarea")
      return (
        <div key={p.id} className="space-y-1" {...common}>
          {label}
          <textarea className="h-24 w-full rounded border bg-background p-2 font-mono text-xs" value={values[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)} />
        </div>
      );
    if (p.type === "checkbox")
      return (
        <label key={p.id} className="flex items-center gap-2 text-xs" {...common}>
          <input type="checkbox" checked={values[p.id] === "true"} onChange={(e) => set(p.id, e.target.checked ? "true" : "false")} />
          {p.label}
        </label>
      );
    if (p.type === "point")
      return (
        <div key={p.id} className="space-y-1" {...common}>
          {label}
          <div className="flex gap-1">
            <Input className="h-8 flex-1 text-xs" placeholder="lon, lat" value={values[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)} />
            <Button size="sm" variant={picking === p.id ? "default" : "outline"} className="h-8 gap-1 px-2 text-xs" onClick={() => pickPoint(p.id)}>
              <Crosshair className="h-3.5 w-3.5" /> {picking === p.id ? "Click the map…" : "Pick"}
            </Button>
          </div>
        </div>
      );
    return (
      <div key={p.id} className="space-y-1" {...common}>
        {label}
        <Input type={p.type === "number" ? "number" : "text"} className="h-8 text-xs" value={values[p.id] ?? ""} onChange={(e) => set(p.id, e.target.value)} />
      </div>
    );
  };

  return createPortal(
    <div role="dialog" aria-label={tool.title} className="qgis-alg fixed z-[45] flex max-h-[88vh] w-[800px] max-w-[96vw] flex-col overflow-hidden rounded-md border bg-background text-[12.5px] shadow-2xl" style={{ left: pos.x, top: pos.y }}>
      <div
        className="flex cursor-move select-none items-center gap-2 border-b bg-muted/70 px-3 py-1.5"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const start = { x: e.clientX - pos.x, y: e.clientY - pos.y };
          const move = (ev: PointerEvent) => setPos({ x: Math.max(0, ev.clientX - start.x), y: Math.max(0, ev.clientY - start.y) });
          const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <Cog className="h-4 w-4 text-[#4a8a3c]" />
        <span className="flex-1 font-semibold">{tool.title}</span>
        <button type="button" aria-label="Close" className="rounded p-0.5 hover:bg-accent" onClick={() => open(null)}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 space-y-3 overflow-auto p-3" {...paramHelp.handlers}>
          <input ref={fileRef} type="file" accept=".tif,.tiff" multiple hidden onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            setExtra((c) => [...c, ...files.map((f) => ({ name: f.name.replace(/\.tiff?$/i, ""), load: () => f.arrayBuffer() }))]);
            e.target.value = "";
          }} />
          {tool.params.filter(visible).map(renderParam)}
          {log.length ? <div className="max-h-24 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px]">{log.map((l, i) => <div key={i}>{l}</div>)}</div> : null}
          {error ? <p className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">{error}</p> : null}
          {result?.summary ? <p className="rounded border border-emerald-300 bg-emerald-50 p-2 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{result.summary}</p> : null}
          {result?.table ? (
            <div className="space-y-1">
              <div className="flex justify-end">
                <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => downloadCsv(tool.id, result.table!.columns, result.table!.rows)}>
                  <Download className="h-3 w-3" /> CSV
                </Button>
              </div>
              <div className="max-h-64 overflow-auto">
                <table className="arc-table">
                  <thead><tr>{result.table.columns.map((c) => <th key={c} className="text-start">{c}</th>)}</tr></thead>
                  <tbody>
                    {result.table.rows.map((r, i) => (
                      <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === "number" ? "text-end" : ""}>{typeof c === "number" ? c.toLocaleString("id-ID") : c}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
        <ParamHelpPane title={tool.title} description={tool.description} help={paramHelp.help} className="w-[250px] shrink-0 border-s" />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/40 px-3 py-2">
        <Button size="sm" className="gap-1.5" disabled={running} onClick={() => void run()}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run
        </Button>
        <Button size="sm" variant="outline" onClick={() => open(null)}>Close</Button>
      </div>
    </div>,
    document.body,
  );
}
