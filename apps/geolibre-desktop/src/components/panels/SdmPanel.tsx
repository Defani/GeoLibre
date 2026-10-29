import { useAppStore } from "@geolibre/core";
import {
  cancelSdmJob,
  fetchConversionJob,
  fetchSdmFile,
  fetchSdmStatus,
  startSdmJob,
  type ConversionJob,
  type SdmRunRequest,
  type SdmStatus,
} from "@geolibre/processing";
import { Button, cn, Input, Label, Select } from "@geolibre/ui";
import { open } from "@tauri-apps/plugin-dialog";
import type { FeatureCollection } from "geojson";
import { Bug, FolderOpen, Loader2, Play, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadDroppedRasterFiles } from "../../lib/file-io/raster-photo-files";
import { getShellActions } from "../../lib/shell-actions";
import { startGeoLibreSidecar } from "../../lib/sidecar";
import { isTauri } from "../../lib/tauri-io";
import { useProcessNotifier } from "../../lib/process-notify";
import { ParamHelpPane, useParamHelp } from "../processing/ParamHelp";

type FeatureType = NonNullable<SdmRunRequest["feature_types"]>[number];
const FEATURE_TYPES: FeatureType[] = ["linear", "quadratic", "hinge", "product", "threshold"];

interface SdmSummary {
  train_auc: number;
  test_auc: number | null;
  presences: number;
  background: number;
  covariates: string[];
  seconds: number;
  curves?: Record<string, { x: number[]; y: number[] }>;
}

/** A tiny response-curve sparkline: suitability (0..1) against one covariate. */
function ResponseCurve({ label, curve }: { label: string; curve: { x: number[]; y: number[] } }) {
  const w = 150;
  const h = 56;
  const xs = curve.x;
  const ys = curve.y;
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const path = xs
    .map((x, i) => {
      const px = ((x - x0) / (x1 - x0 || 1)) * (w - 4) + 2;
      const py = h - 2 - ys[i] * (h - 4);
      return `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
  return (
    <figure className="rounded border bg-background p-1.5">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" aria-hidden>
        <rect x="0" y="0" width={w} height={h} fill="none" />
        <path d={path} fill="none" stroke="#2f7fd6" strokeWidth="1.6" />
      </svg>
      <figcaption className="truncate text-[10.5px] text-muted-foreground" title={label}>
        {label}
      </figcaption>
    </figure>
  );
}

/**
 * Species Distribution Modeling dock (Defani edition). Fits a Maxent model with
 * the `elapid` Python package in GeoLibre's own Python sidecar — the app starts
 * it and installs elapid on first use, so no terminal is needed — and adds the
 * habitat-suitability map to the project.
 */
export function SdmPanel() {
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const desktop = isTauri();

  const [status, setStatus] = useState<SdmStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [source, setSource] = useState<"sample" | "own">("sample");
  const [occurrenceLayerId, setOccurrenceLayerId] = useState("");
  const [rasterPaths, setRasterPaths] = useState<string[]>([]);
  const [backgroundCount, setBackgroundCount] = useState(10000);
  const [beta, setBeta] = useState(2);
  const [transform, setTransform] = useState<NonNullable<SdmRunRequest["transform"]>>("cloglog");
  const [features, setFeatures] = useState<FeatureType[]>(["linear", "hinge", "product"]);
  const [testPercent, setTestPercent] = useState(25);
  const [job, setJob] = useState<ConversionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SdmSummary | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const paramHelp = useParamHelp();

  const pointLayers = useMemo(
    () =>
      layers.filter((layer) =>
        layer.geojson?.features?.some((f) => f.geometry?.type === "Point" || f.geometry?.type === "MultiPoint"),
      ),
    [layers],
  );
  const rasterLayerPaths = useMemo(
    () =>
      layers
        .map((layer) => layer.sourcePath)
        .filter((path): path is string => !!path && /\.tiff?$/i.test(path) && !/^[a-z]+:\/\//i.test(path)),
    [layers],
  );

  // Start the sidecar and ask for elapid; while it installs, ask again.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        await startGeoLibreSidecar().catch(() => undefined);
        const next = await fetchSdmStatus();
        if (cancelled) return;
        setStatus(next);
        setStatusError(null);
        if (!next.available && next.installing) timer = window.setTimeout(check, 5000);
      } catch (err) {
        if (!cancelled) setStatusError(err instanceof Error ? err.message : String(err));
      }
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [desktop]);

  const running = job?.status === "pending" || job?.status === "running";
  useProcessNotifier("Species Distribution Modeling (Maxent)", running, job?.status === "failed", job?.error ?? error);

  // Poll the running job.
  useEffect(() => {
    if (!job || !running) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await fetchConversionJob(job.id);
        setJob(next);
        if (next.status === "succeeded") void collectResults(next);
        if (next.status === "failed") setError(next.error ?? "The model run failed. See the log.");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, running]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [job?.messages.length]);

  const collectResults = async (done: ConversionJob) => {
    try {
      const summaryBlob = await fetchSdmFile(done.id, "summary.json");
      setSummary(JSON.parse(await summaryBlob.text()) as SdmSummary);
      const presence = JSON.parse(
        await (await fetchSdmFile(done.id, "presence.geojson")).text(),
      ) as FeatureCollection;
      if (source === "sample") addGeoJsonLayer("Occurrences (Ariolimax buttoni)", presence);
      const tif = await fetchSdmFile(done.id, "suitability.tif");
      const file = new File([tif], "Habitat suitability (Maxent).tif", { type: "image/tiff" });
      await getShellActions()?.addDroppedRasters(loadDroppedRasterFiles([file]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickRasters = async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
    });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    setRasterPaths((current) => [...new Set([...current, ...list.map(String)])]);
  };

  const run = async () => {
    setError(null);
    setSummary(null);
    const request: SdmRunRequest = {
      use_sample: source === "sample",
      background_count: backgroundCount,
      beta_multiplier: beta,
      transform,
      feature_types: features,
      test_fraction: testPercent / 100,
    };
    if (source === "own") {
      const layer = layers.find((l) => l.id === occurrenceLayerId);
      if (!layer?.geojson) return setError("Choose a point layer of occurrences.");
      if (!rasterPaths.length) return setError("Add at least one covariate GeoTIFF.");
      request.occurrence_geojson = layer.geojson;
      request.raster_paths = rasterPaths;
    }
    try {
      setJob(await startSdmJob(request));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const ready = status?.available === true;
  const canRun =
    desktop && ready && !running && (source === "sample" || (!!occurrenceLayerId && rasterPaths.length > 0));

  return (
    <section aria-label="Species Distribution Modeling" className="flex h-full min-h-0 flex-col bg-card text-[12.5px]">
      <header className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
        <Bug className="h-4 w-4 text-[#3ea044]" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">Species Distribution Modeling</h2>
          <p className="truncate text-[11px] text-muted-foreground">Maxent with elapid</p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3" {...paramHelp.handlers}>
        {!desktop ? (
          <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-800">
            Species Distribution Modeling runs on GeoLibre Desktop: its Python engine (elapid) is installed
            by the app on first use.
          </p>
        ) : statusError ? (
          <p className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">{statusError}</p>
        ) : !status ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting the Python engine…
          </p>
        ) : !ready ? (
          <div className="space-y-1.5 rounded border bg-muted/40 p-2">
            <p className="flex items-center gap-2">
              {status.installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {status.message}
            </p>
            {status.installing ? (
              <div className="relative h-1.5 overflow-hidden rounded bg-muted">
                <div className="absolute inset-y-0 w-1/3 animate-[qgis-progress_1.2s_linear_infinite] bg-[#4a9a3c]" />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] text-emerald-700">● Python engine ready (elapid installed)</p>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">1. Data</legend>
          <label className="flex items-start gap-2" data-help-label="elapid sample data" data-help="elapid's tutorial data: Ariolimax buttoni (banana slug) occurrences and six California covariates — cloud cover, leaf area index and land surface temperature, each as mean and standard deviation. Downloaded on the first run.">
            <input type="radio" checked={source === "sample"} onChange={() => setSource("sample")} className="mt-0.5" />
            <span>elapid sample data (Ariolimax buttoni)</span>
          </label>
          <label className="flex items-start gap-2" data-help-label="My data" data-help="Model your own species: a point layer of occurrences from Contents plus covariate GeoTIFFs (climate, terrain, vegetation...). All rasters should share one grid.">
            <input type="radio" checked={source === "own"} onChange={() => setSource("own")} className="mt-0.5" />
            <span>My data (occurrence points + covariate GeoTIFFs)</span>
          </label>
          {source === "own" ? (
            <div className="space-y-2 ps-5">
              <div className="space-y-1" data-help-label="Occurrence points" data-help="The presence records of the species. Only point geometries are used; they are reprojected to the covariates' CRS.">
                <Label className="text-xs">Occurrence points</Label>
                <Select value={occurrenceLayerId} onChange={(e) => setOccurrenceLayerId(e.target.value)} className="h-8 text-xs">
                  <option value="">Choose a point layer…</option>
                  {pointLayers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1" data-help-label="Covariate rasters" data-help="Environmental predictors. Values are read at every presence and background point (elapid.annotate) and the fitted model is applied to them to map suitability.">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Covariate rasters ({rasterPaths.length})</Label>
                  <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => void pickRasters()} disabled={!desktop}>
                    <FolderOpen className="h-3.5 w-3.5" /> Add GeoTIFF…
                  </Button>
                </div>
                {rasterLayerPaths.filter((p) => !rasterPaths.includes(p)).map((path) => (
                  <button
                    key={path}
                    type="button"
                    className="block w-full truncate rounded border border-dashed px-2 py-1 text-start text-[11px] text-muted-foreground hover:bg-accent"
                    title={path}
                    onClick={() => setRasterPaths((c) => [...c, path])}
                  >
                    + {path.split(/[\\/]/).pop()} (from the map)
                  </button>
                ))}
                {rasterPaths.map((path) => (
                  <div key={path} className="flex items-center gap-1 rounded border bg-background px-2 py-1 text-[11px]">
                    <span className="min-w-0 flex-1 truncate" title={path}>
                      {path.split(/[\\/]/).pop()}
                    </span>
                    <button type="button" aria-label="Remove" onClick={() => setRasterPaths((c) => c.filter((p) => p !== path))}>
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">2. Maxent settings</legend>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1" data-help-label="Background points" data-help="Random points drawn from the first covariate's valid area (elapid.sample_raster). They describe the available environment; 10,000 is Maxent's usual default.">
              <Label className="text-xs">Background points</Label>
              <Input type="number" min={100} step={1000} value={backgroundCount} onChange={(e) => setBackgroundCount(Number(e.target.value))} className="h-8 text-xs" />
            </div>
            <div className="space-y-1" data-help-label="Beta multiplier" data-help="Regularization strength. Higher values give a smoother, more general model; lower values fit the training data more closely (risk of overfitting).">
              <Label className="text-xs">Beta multiplier</Label>
              <Input type="number" min={0.1} step={0.5} value={beta} onChange={(e) => setBeta(Number(e.target.value))} className="h-8 text-xs" />
            </div>
            <div className="space-y-1" data-help-label="Output" data-help="How raw Maxent scores are scaled. cloglog (default) gives a 0–1 probability-like suitability; logistic is the older Maxent output; raw and exponential are unscaled.">
              <Label className="text-xs">Output</Label>
              <Select value={transform} onChange={(e) => setTransform(e.target.value as typeof transform)} className="h-8 text-xs">
                <option value="cloglog">cloglog (0–1)</option>
                <option value="logistic">logistic</option>
                <option value="raw">raw</option>
                <option value="exponential">exponential</option>
              </Select>
            </div>
            <div className="space-y-1" data-help-label="Test split" data-help="Share of points held out to compute an independent test AUC. 0 skips the test split.">
              <Label className="text-xs">Test split (%)</Label>
              <Input type="number" min={0} max={50} step={5} value={testPercent} onChange={(e) => setTestPercent(Number(e.target.value))} className="h-8 text-xs" />
            </div>
          </div>
          <div className="space-y-1" data-help-label="Feature types" data-help="Maxent feature classes built from each covariate: linear, quadratic, hinge (piecewise), product (interactions) and threshold (step). More classes allow more complex responses.">
            <Label className="text-xs">Feature types</Label>
            <div className="flex flex-wrap gap-1">
              {FEATURE_TYPES.map((type) => {
                const on = features.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setFeatures((c) => (on ? c.filter((t) => t !== type) : [...c, type]))}
                    className={cn("rounded-full border px-2 py-0.5 text-[11px]", on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground")}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
          </div>
        </fieldset>

        {job ? (
          <div className="space-y-1.5">
            <div className="relative h-4 overflow-hidden rounded-sm border bg-background">
              <div
                className={cn(
                  "absolute inset-y-0 left-0 bg-[#4a9a3c]",
                  running ? "w-1/3 animate-[qgis-progress_1.2s_linear_infinite]" : "w-full",
                  job.status === "failed" && "bg-destructive",
                )}
              />
              <span className="absolute inset-0 text-center text-[10px] leading-4">
                {running ? job.messages[job.messages.length - 1] ?? "Running…" : job.status === "failed" ? "Failed" : "Done"}
              </span>
            </div>
            <div className="max-h-32 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px]">
              {job.messages.map((line, index) => (
                <div key={index} className="whitespace-pre-wrap">
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        ) : null}

        {error ? <p className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">{error}</p> : null}

        {summary ? (
          <div className="space-y-2">
            <h3 className="font-semibold">3. Results</h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded border bg-background p-2">
                <div className="text-[11px] text-muted-foreground">Test AUC</div>
                <div className="text-lg font-semibold">{summary.test_auc ?? "–"}</div>
              </div>
              <div className="rounded border bg-background p-2">
                <div className="text-[11px] text-muted-foreground">Training AUC</div>
                <div className="text-lg font-semibold">{summary.train_auc}</div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {summary.presences} presences, {summary.background} background points, {summary.seconds} s. The
              habitat-suitability map was added to Contents.
            </p>
            {summary.curves ? (
              <>
                <h4 className="text-xs font-semibold">Response curves</h4>
                <div className="grid grid-cols-2 gap-1.5">
                  {Object.entries(summary.curves).map(([label, curve]) => (
                    <ResponseCurve key={label} label={label} curve={curve} />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <ParamHelpPane
        title="Maxent (elapid)"
        description="Fits a presence–background Maxent model and maps relative habitat suitability (0–1)."
        help={paramHelp.help}
        className="max-h-36 shrink-0 border-t"
      />
      <footer className="flex items-center gap-2 border-t bg-muted/40 px-3 py-2">
        {running ? (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => job && void cancelSdmJob(job.id)}>
            <Square className="h-3.5 w-3.5" /> Cancel
          </Button>
        ) : null}
        <Button size="sm" className="ms-auto gap-1.5" disabled={!canRun} onClick={() => void run()}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run Maxent
        </Button>
      </footer>
    </section>
  );
}
