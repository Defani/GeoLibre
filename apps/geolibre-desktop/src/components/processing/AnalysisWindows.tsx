import { useAppStore } from "@geolibre/core";
import { readRasterData, writeRasterData, type RasterData } from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Cog, Download, FolderOpen, Loader2, Play, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { loadDroppedRasterFiles } from "../../lib/file-io/raster-photo-files";
import { readLocalFileBytes } from "../../lib/file-io/local-fs";
import { useProcessNotifier } from "../../lib/process-notify";
import {
  continuousChange,
  transitionMatrix,
  zonalStatistics,
  type ChangeSummaryRow,
  type ZonalStat,
} from "../../lib/raster-analysis";
import { getShellActions } from "../../lib/shell-actions";
import { isTauri } from "../../lib/tauri-io";
import { ParamHelpPane, useParamHelp } from "./ParamHelp";

type WindowId = "zonal" | "change" | null;
export const useAnalysisWindow = create<{ open: WindowId; setOpen: (id: WindowId) => void }>((set) => ({
  open: null,
  setOpen: (open) => set({ open }),
}));
export const openZonalStatistics = () => useAnalysisWindow.getState().setOpen("zonal");
export const openChangeDetection = () => useAnalysisWindow.getState().setOpen("change");

interface RasterSource {
  name: string;
  load: () => Promise<ArrayBuffer>;
}

/** Rasters on the map (with a local file) plus any added with “Add…”. */
function useRasterSources() {
  const layers = useAppStore((s) => s.layers);
  const [extra, setExtra] = useState<RasterSource[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const sources = useMemo<RasterSource[]>(() => {
    const fromMap = layers
      .filter((l) => l.sourcePath && /\.tiff?$/i.test(l.sourcePath))
      .map((l) => ({ name: l.name, load: async () => (await readLocalFileBytes(l.sourcePath!)).buffer as ArrayBuffer }));
    return [...fromMap, ...extra.filter((e) => !fromMap.some((m) => m.name === e.name))];
  }, [layers, extra]);
  const add = async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: true, filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(String);
      setExtra((c) => [
        ...c,
        ...paths.map((p) => ({ name: p.split(/[\\/]/).pop()!.replace(/\.tiff?$/i, ""), load: async () => (await readLocalFileBytes(p)).buffer as ArrayBuffer })),
      ]);
    } else fileRef.current?.click();
  };
  const input = (
    <input
      ref={fileRef}
      type="file"
      accept=".tif,.tiff"
      multiple
      hidden
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        setExtra((c) => [...c, ...files.map((f) => ({ name: f.name.replace(/\.tiff?$/i, ""), load: () => f.arrayBuffer() }))]);
        e.target.value = "";
      }}
    />
  );
  return { sources, add, input };
}

async function addRasterResult(raster: RasterData, name: string) {
  const bytes = writeRasterData(raster);
  await getShellActions()?.addDroppedRasters(loadDroppedRasterFiles([new File([bytes], `${name}.tif`, { type: "image/tiff" })]));
}

function downloadCsv(name: string, rows: Array<Array<string | number>>) {
  const csv = rows.map((r) => r.map((v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${name}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

/** Shared QGIS-style floating shell for the analysis tools. */
function ToolWindow({
  title,
  description,
  help,
  running,
  failed,
  onRun,
  runDisabled,
  children,
  handlers,
}: {
  title: string;
  description: string;
  help: ReturnType<typeof useParamHelp>["help"];
  running: boolean;
  failed: boolean;
  onRun: () => void;
  runDisabled: boolean;
  children: ReactNode;
  handlers: ReturnType<typeof useParamHelp>["handlers"];
}) {
  const setOpen = useAnalysisWindow((s) => s.setOpen);
  const [pos, setPos] = useState({ x: 140, y: 80 });
  useProcessNotifier(title, running, failed);
  return createPortal(
    <div role="dialog" aria-label={title} className="qgis-alg fixed z-[45] flex max-h-[88vh] w-[760px] max-w-[96vw] flex-col overflow-hidden rounded-md border bg-background text-[12.5px] shadow-2xl" style={{ left: pos.x, top: pos.y }}>
      <div
        className="flex cursor-move select-none items-center gap-2 border-b bg-muted/70 px-3 py-1.5"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const start = { x: e.clientX - pos.x, y: e.clientY - pos.y };
          const move = (ev: PointerEvent) => setPos({ x: Math.max(0, ev.clientX - start.x), y: Math.max(0, ev.clientY - start.y) });
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <Cog className="h-4 w-4 text-[#4a8a3c]" />
        <span className="flex-1 font-semibold">{title}</span>
        <button type="button" aria-label="Close" className="rounded p-0.5 hover:bg-accent" onClick={() => setOpen(null)}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 space-y-3 overflow-auto p-3" {...handlers}>
          {children}
        </div>
        <ParamHelpPane title={title} description={description} help={help} className="w-[240px] shrink-0 border-s" />
      </div>
      <div className="flex justify-end gap-2 border-t bg-muted/40 px-3 py-2">
        <Button size="sm" className="gap-1.5" disabled={running || runDisabled} onClick={onRun}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(null)}>
          Close
        </Button>
      </div>
    </div>,
    document.body,
  );
}

function RasterPick({ label, value, onChange, sources, onAdd, help }: { label: string; value: string; onChange: (v: string) => void; sources: RasterSource[]; onAdd: () => void; help: string }) {
  return (
    <div className="space-y-1" data-help-label={label} data-help={help}>
      <Label className="text-xs">{label}</Label>
      <div className="flex gap-1">
        <Select className="h-8 flex-1 text-xs" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a raster…</option>
          {sources.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="outline" className="h-8 gap-1 px-2 text-xs" onClick={onAdd}>
          <FolderOpen className="h-3.5 w-3.5" /> Add…
        </Button>
      </div>
    </div>
  );
}

const ALL_STATS: Array<[ZonalStat, string]> = [
  ["mean", "Mean"], ["min", "Minimum"], ["max", "Maximum"], ["sum", "Sum"], ["std", "Std. deviation"],
  ["count", "Cell count"], ["majority", "Majority (class)"], ["area_ha", "Area (ha)"],
];

/** Zonal Statistics as Table → written straight into the polygon layer's attributes. */
function ZonalStatisticsWindow() {
  const layers = useAppStore((s) => s.layers);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const { sources, add, input } = useRasterSources();
  const paramHelp = useParamHelp();
  const polygonLayers = layers.filter((l) => l.geojson?.features?.some((f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon"));
  const [layerId, setLayerId] = useState("");
  const [rasterName, setRasterName] = useState("");
  const [prefix, setPrefix] = useState("z_");
  const [stats, setStats] = useState<ZonalStat[]>(["mean", "min", "max", "area_ha"]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setDone(null);
    setRunning(true);
    try {
      const layer = layers.find((l) => l.id === layerId);
      const source = sources.find((s) => s.name === rasterName);
      if (!layer?.geojson || !source) throw new Error("Choose a polygon layer and a raster.");
      const raster = await readRasterData(await source.load());
      const { collection, processed } = await zonalStatistics(raster, layer.geojson, stats, prefix);
      updateLayer(layer.id, { geojson: collection });
      setDone(`${processed} polygons updated: ${stats.map((s) => prefix + s).join(", ")} added to the attribute table.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <ToolWindow
      title="Zonal Statistics"
      description="Summarises a raster inside each polygon and writes the results as new fields of the polygon layer, like ArcGIS Zonal Statistics as Table joined back."
      help={paramHelp.help}
      handlers={paramHelp.handlers}
      running={running}
      failed={!!error}
      runDisabled={!layerId || !rasterName || stats.length === 0}
      onRun={() => void run()}
    >
      {input}
      <div className="space-y-1" data-help-label="Zones (polygon layer)" data-help="The polygons to summarise in: plots, villages, concessions... Their attribute table receives the new fields.">
        <Label className="text-xs">Zones (polygon layer)</Label>
        <Select className="h-8 text-xs" value={layerId} onChange={(e) => setLayerId(e.target.value)}>
          <option value="">Choose a polygon layer…</option>
          {polygonLayers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </div>
      <RasterPick label="Value raster" value={rasterName} onChange={setRasterName} sources={sources} onAdd={() => void add()}
        help="The raster to summarise (band 1): NDVI, elevation, carbon density, land cover... Polygons are reprojected to its CRS." />
      <div className="space-y-1" data-help-label="Statistics" data-help="Which statistics to compute. Majority suits class rasters (land cover); Area (ha) is the area of the cells inside each polygon.">
        <Label className="text-xs">Statistics</Label>
        <div className="grid grid-cols-2 gap-1">
          {ALL_STATS.map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 rounded border px-2 py-1">
              <input type="checkbox" checked={stats.includes(id)} onChange={(e) => setStats((c) => (e.target.checked ? [...c, id] : c.filter((s) => s !== id)))} />
              {label}
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-1" data-help-label="Field prefix" data-help="Put in front of each new field name, e.g. ndvi_ gives ndvi_mean, ndvi_max.">
        <Label className="text-xs">Field prefix</Label>
        <Input className="h-8 w-40 text-xs" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
      </div>
      {done ? <p className="rounded border border-emerald-300 bg-emerald-50 p-2 text-emerald-800">{done}</p> : null}
      {error ? <p className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">{error}</p> : null}
    </ToolWindow>
  );
}

/** Change Detection between two dates. */
function ChangeDetectionWindow() {
  const { sources, add, input } = useRasterSources();
  const paramHelp = useParamHelp();
  const [beforeName, setBeforeName] = useState("");
  const [afterName, setAfterName] = useState("");
  const [mode, setMode] = useState<"continuous" | "categorical">("continuous");
  const [threshold, setThreshold] = useState(0.1);
  const [outName, setOutName] = useState("change");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ChangeSummaryRow[] | null>(null);
  const [matrix, setMatrix] = useState<{ classes: number[]; matrixHa: number[][] } | null>(null);

  const run = async () => {
    setError(null);
    setSummary(null);
    setMatrix(null);
    setRunning(true);
    try {
      const b = sources.find((s) => s.name === beforeName);
      const a = sources.find((s) => s.name === afterName);
      if (!b || !a) throw new Error("Choose the before and after rasters.");
      const before = await readRasterData(await b.load());
      const after = await readRasterData(await a.load());
      if (before.width !== after.width || before.height !== after.height) {
        throw new Error(`The rasters differ in size (${before.width}×${before.height} vs ${after.width}×${after.height}). Resample one to the other's grid first.`);
      }
      if (mode === "continuous") {
        const result = continuousChange(before, after, threshold);
        await addRasterResult(result.diff, `${outName}_difference`);
        await addRasterResult(result.classes, `${outName}_classes`);
        setSummary(result.summary);
      } else {
        const result = transitionMatrix(before, after);
        await addRasterResult(result.raster, `${outName}_transitions`);
        setMatrix({ classes: result.classes, matrixHa: result.matrixHa });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <ToolWindow
      title="Change Detection"
      description="Compares two rasters of the same area and grid: a difference map classified into decrease / no change / increase (NDVI, NBR...), or a from–to transition matrix for land-cover maps."
      help={paramHelp.help}
      handlers={paramHelp.handlers}
      running={running}
      failed={!!error}
      runDisabled={!beforeName || !afterName}
      onRun={() => void run()}
    >
      {input}
      <div className="grid grid-cols-2 gap-2">
        <RasterPick label="Before (earlier date)" value={beforeName} onChange={setBeforeName} sources={sources} onAdd={() => void add()} help="The earlier raster, e.g. NDVI or land cover of the first year." />
        <RasterPick label="After (later date)" value={afterName} onChange={setAfterName} sources={sources} onAdd={() => void add()} help="The later raster on the same grid as Before." />
      </div>
      <div className="space-y-1" data-help-label="Method" data-help="Continuous: index values (NDVI, NBR, biomass). Categorical: class codes (land cover) — gives a from–to area matrix.">
        <Label className="text-xs">Method</Label>
        <Select className="h-8 text-xs" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="continuous">Continuous difference (index)</option>
          <option value="categorical">Categorical transition (land cover)</option>
        </Select>
      </div>
      {mode === "continuous" ? (
        <div className="space-y-1" data-help-label="Change threshold" data-help="Differences smaller than this count as no change. For NDVI, 0.1–0.2 separates real change from noise; for dNBR, 0.1 is the usual unburned limit.">
          <Label className="text-xs">Change threshold (±)</Label>
          <Input type="number" step={0.05} className="h-8 w-32 text-xs" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </div>
      ) : null}
      <div className="space-y-1" data-help-label="Output name" data-help="Base name of the result rasters added to Contents.">
        <Label className="text-xs">Output name</Label>
        <Input className="h-8 w-48 text-xs" value={outName} onChange={(e) => setOutName(e.target.value)} />
      </div>
      {summary ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Change summary</span>
            <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => downloadCsv(`${outName}_summary`, [["class", "cells", "hectares", "percent"], ...summary.map((r) => [r.label, r.cells, r.hectares, r.percent])])}>
              <Download className="h-3 w-3" /> CSV
            </Button>
          </div>
          <table className="arc-table w-full">
            <thead><tr><th className="text-start">Class</th><th className="text-end">Hectares</th><th className="text-end">%</th></tr></thead>
            <tbody>
              {summary.map((r) => (
                <tr key={r.label}><td>{r.label}</td><td className="text-end">{r.hectares.toLocaleString("id-ID")}</td><td className="text-end">{r.percent}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {matrix ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Transition matrix (ha) — rows: before, columns: after</span>
            <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={() => downloadCsv(`${outName}_matrix`, [["from\\to", ...matrix.classes], ...matrix.classes.map((c, i) => [c, ...matrix.matrixHa[i]])])}>
              <Download className="h-3 w-3" /> CSV
            </Button>
          </div>
          <div className="max-h-60 overflow-auto">
            <table className="arc-table">
              <thead><tr><th>from \ to</th>{matrix.classes.map((c) => <th key={c} className="text-end">{c}</th>)}</tr></thead>
              <tbody>
                {matrix.classes.map((c, i) => (
                  <tr key={c}><th className="text-start">{c}</th>{matrix.matrixHa[i].map((v, j) => <td key={j} className={`text-end ${i === j ? "font-semibold" : ""}`}>{v.toLocaleString("id-ID")}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {error ? <p className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">{error}</p> : null}
    </ToolWindow>
  );
}

/** Mount point for the analysis windows (one open at a time). */
export function AnalysisWindows() {
  const open = useAnalysisWindow((s) => s.open);
  if (open === "zonal") return <ZonalStatisticsWindow />;
  if (open === "change") return <ChangeDetectionWindow />;
  return null;
}
