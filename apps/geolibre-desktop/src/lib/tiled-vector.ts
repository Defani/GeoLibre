// Large vector files as native tiles (Defani edition).
//
// A vector file from TILED_THRESHOLD_BYTES up is not loaded into the webview.
// The Rust side (native_duckdb/tiles.rs) copies it once into an indexed DuckDB
// cache and serves vector tiles over the `tfgtile` protocol, so only what is on
// screen reaches the GPU, the way QGIS draws a big shapefile. The layer shows
// at once (extent from the header); tiles appear when the index is ready, and
// a re-open of the same file uses the cache immediately.
//
// Caches of layers that never reach a saved project are removed on the next
// start (cleanupTiledVectors), so they do not pile up.

import { useAppStore, type GeoLibreLayer, DEFAULT_LAYER_STYLE } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { useEffect } from "react";
import { localFileSizeBytes } from "./file-io/local-fs";
import { useProcessNotices } from "./process-notify";
import { isTauri } from "./tauri-io";

export const TILED_THRESHOLD_BYTES = 50 * 1024 * 1024;
const TILED_EXTENSIONS = new Set(["shp", "gpkg", "fgb", "geojson", "json", "parquet", "geoparquet", "gdb", "kml", "gml", "tab", "csv"]);
const SOURCE_KIND = "native-tiles";

interface TiledStatus {
  id: string;
  ready: boolean;
  stage: number;
  tiles: string;
  bbox?: [number, number, number, number] | null;
  count?: number;
  geometryType?: string;
  props?: string[];
  fields?: Array<{ name: string; type: string }>;
}

interface ProgressEvent {
  id: string;
  stage: "reading" | "indexing" | "ready" | "done" | "failed";
  message: string;
  progress?: number;
  info?: TiledStatus;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

const extOf = (path: string) => path.split(/[\\/]/).pop()!.split(".").pop()!.toLowerCase();
const baseName = (path: string) => path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");

/** Whether a path should open as native tiles (desktop, large enough). */
export async function shouldOpenTiled(path: string): Promise<boolean> {
  if (!isTauri() || !TILED_EXTENSIONS.has(extOf(path))) return false;
  let size = (await localFileSizeBytes(path)) ?? 0;
  if (extOf(path) === "shp") size += (await localFileSizeBytes(path.replace(/\.shp$/i, ".dbf"))) ?? 0;
  return size >= TILED_THRESHOLD_BYTES;
}

function geometryKind(type: string | undefined): "polygon" | "line" | "point" | undefined {
  const t = (type ?? "").toUpperCase();
  if (t.includes("POLYGON")) return "polygon";
  if (t.includes("LINE")) return "line";
  if (t.includes("POINT")) return "point";
  return undefined;
}

function tileSource(status: TiledStatus, revision: number) {
  return {
    type: "vector",
    // The revision forces MapLibre to drop tiles cached while the index was building.
    tiles: [`${status.tiles}?r=${revision}`],
    sourceLayer: "layer",
    sourceLayers: ["layer"],
    minzoom: 0,
    maxzoom: 22,
    ...(status.bbox ? { bounds: status.bbox } : {}),
  };
}

const notices = () => useProcessNotices.getState();

/** Open one large vector file as a native tile layer; returns the layer id. */
export async function openTiledVectorLayer(path: string, name = baseName(path)): Promise<string> {
  const status = await invoke<TiledStatus>("open_tiled_vector", { path });
  const id = crypto.randomUUID();
  const layer: GeoLibreLayer = {
    id,
    name,
    type: "vector-tiles",
    source: tileSource(status, status.stage),
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: SOURCE_KIND,
      tileCacheId: status.id,
      sourceLayers: ["layer"],
      fields: status.props ?? [],
      ...(geometryKind(status.geometryType) ? { geometryType: geometryKind(status.geometryType) } : {}),
      ...(status.count !== undefined ? { featureCount: status.count } : {}),
    },
    sourcePath: path,
  };
  useAppStore.getState().addLayer(layer);
  useAppStore.getState().selectLayer(id);
  if (status.bbox) fitTo(status.bbox);
  if (!status.ready) {
    notices().upsert({ id: `tiles-${status.id}`, title: `Indexing ${name}`, status: "running", message: "Reading the file…", startedAt: Date.now() });
  }
  return id;
}

function fitTo(bbox: [number, number, number, number]) {
  void import("./shell-actions").then(({ getShellActions }) => {
    const map = (getShellActions()?.getAppApi() as { getMap?: () => { fitBounds: (b: unknown, o?: unknown) => void } | null } | undefined)?.getMap?.();
    map?.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 600 });
  });
}

/**
 * Open the large files among `paths` as tile layers and return the rest for
 * the normal loader, plus how many were opened as tiles.
 */
export async function openLargeVectorsAsTiles(paths: string[]): Promise<{ remaining: string[]; tiled: number }> {
  const remaining: string[] = [];
  let tiled = 0;
  for (const path of paths) {
    if (await shouldOpenTiled(path)) {
      try {
        await openTiledVectorLayer(path);
        tiled += 1;
        continue;
      } catch (error) {
        console.warn("[GeoLibre] Native tiles failed; loading the file normally.", error);
      }
    }
    remaining.push(path);
  }
  // Sidecars (.dbf/.shx/.prj) of a shapefile opened as tiles must not load again.
  const tiledStems = new Set(paths.filter((p) => !remaining.includes(p)).map((p) => p.replace(/\.[^.\\/]+$/, "").toLowerCase()));
  return { remaining: remaining.filter((p) => !tiledStems.has(p.replace(/\.[^.\\/]+$/, "").toLowerCase())), tiled };
}

const tiledLayers = () => useAppStore.getState().layers.filter((l) => l.metadata?.sourceKind === SOURCE_KIND);

/** Re-attach tile layers restored from a project, and refresh tiles on progress. */
export function useTiledVectorRuntime(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    const registered = new Set<string>();

    // Layers that came back with a project: register them with the tile
    // server (instant when the cache exists, rebuilt when the file changed).
    const attach = async () => {
      for (const layer of tiledLayers()) {
        if (registered.has(layer.id) || !layer.sourcePath) continue;
        registered.add(layer.id);
        try {
          const status = await invoke<TiledStatus>("open_tiled_vector", { path: layer.sourcePath });
          useAppStore.getState().updateLayer(layer.id, {
            source: tileSource(status, status.stage),
            metadata: { ...layer.metadata, tileCacheId: status.id },
          });
          if (!status.ready) {
            notices().upsert({ id: `tiles-${status.id}`, title: `Indexing ${layer.name}`, status: "running", message: "The file changed — rebuilding its index…", startedAt: Date.now() });
          }
        } catch (error) {
          console.warn(`[GeoLibre] Could not reopen "${layer.sourcePath}" as tiles`, error);
        }
      }
    };
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.layers !== prev.layers) void attach();
      // Saved (or opened from a file): keep these caches from now on.
      if (prev.isDirty && !s.isDirty) markTiledVectorsSaved();
    });
    void attach();

    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      unlisten = await listen<ProgressEvent>("tiled-vector-progress", ({ payload }) => {
        const layers = tiledLayers().filter((l) => l.metadata?.tileCacheId === payload.id);
        const name = layers[0]?.name ?? "layer";
        const noticeId = `tiles-${payload.id}`;
        if (payload.stage === "failed") {
          notices().upsert({ id: noticeId, title: `Indexing ${name}`, status: "failed", message: payload.message, startedAt: Date.now() });
          return;
        }
        if (payload.stage === "ready" || payload.stage === "done") {
          for (const layer of layers) {
            const info = payload.info;
            const kind = geometryKind(info?.geometryType);
            const src = layer.source as { tiles?: string[]; bounds?: unknown };
            const base = String(src.tiles?.[0] ?? "").replace(/\?r=\d+$/, "");
            useAppStore.getState().updateLayer(layer.id, {
              source: {
                ...(layer.source as Record<string, unknown>),
                tiles: [`${base}?r=${payload.stage === "done" ? 2 : 1}`],
                ...(info?.bbox ? { bounds: info.bbox } : {}),
              },
              metadata: {
                ...layer.metadata,
                fields: info?.props ?? layer.metadata.fields,
                ...(kind ? { geometryType: kind } : {}),
                ...(info?.count !== undefined ? { featureCount: info.count } : {}),
              },
            });
            if (payload.stage === "ready" && info?.bbox && !(layer.source as { bounds?: unknown }).bounds) fitTo(info.bbox);
          }
        }
        const done = payload.stage === "done";
        notices().upsert({
          id: noticeId,
          title: `Indexing ${name}`,
          status: done ? "done" : "running",
          message: done ? `${payload.message}. Next time it opens instantly.` : `${payload.message} ${payload.progress ?? ""}%`,
          startedAt: Date.now(),
        });
        if (done) window.setTimeout(() => notices().dismiss(noticeId), 6000);
      });
    });

    // Startup cleanup: caches of layers never saved in a project go away.
    window.setTimeout(() => {
      const keep = tiledLayers().map((l) => String(l.metadata?.tileCacheId ?? "")).filter(Boolean);
      void invoke<number>("cleanup_tiled_vectors", { keep, maxGb: 30 }).then((freed) => {
        if (freed > 0) console.info(`[GeoLibre] Removed ${(freed / 1e6).toFixed(0)} MB of unused tile caches.`);
      }).catch(() => undefined);
    }, 8000);

    return () => {
      unsubscribe();
      unlisten?.();
    };
  }, []);
}

/** Call after a project is saved: its tile caches are kept from now on. */
export function markTiledVectorsSaved(): void {
  if (!isTauri()) return;
  const ids = tiledLayers().map((l) => String(l.metadata?.tileCacheId ?? "")).filter(Boolean);
  if (ids.length) void invoke("mark_tiled_vectors_saved", { ids }).catch(() => undefined);
}

/** Attribute rows of a tile layer (paged), for the attribute table and identify. */
export function queryTiledVector(cacheId: string, opts: { where?: string; fids?: number[]; limit?: number; offset?: number } = {}) {
  return invoke<{ total: number; rows: Array<Record<string, unknown>> }>("query_tiled_vector", {
    id: cacheId,
    whereClause: opts.where ?? null,
    fids: opts.fids ?? null,
    limit: opts.limit ?? 500,
    offset: opts.offset ?? 0,
  });
}

/** Features of a tile layer as GeoJSON (a subset for editing or analysis). */
export function tiledVectorGeoJson(cacheId: string, where?: string, limit?: number) {
  return invoke<FeatureCollection>("tiled_vector_geojson", { id: cacheId, whereClause: where ?? null, limit: limit ?? 50_000 });
}
