// Line dash and casing (Defani edition). Dash patterns (`strokeDasharray`) and
// cased lines (`strokeCasingColor`, a darker edge drawn under the line like
// ArcMap's cartographic road symbols) are applied straight to each layer's
// MapLibre line layers, whichever renderer drew them (core layer sync or the
// vector control), and re-applied after any restyle.

import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { useEffect } from "react";
import { getShellActions } from "./shell-actions";

interface MapLike {
  getStyle: () => { layers?: Array<{ id: string; type: string; source?: string; "source-layer"?: string; filter?: unknown; minzoom?: number; maxzoom?: number }> } | undefined;
  getLayer: (id: string) => unknown;
  addLayer: (layer: Record<string, unknown>, before?: string) => void;
  removeLayer: (id: string) => void;
  setPaintProperty: (id: string, name: string, value: unknown) => void;
  getPaintProperty: (id: string, name: string) => unknown;
  on: (type: string, cb: () => void) => void;
  off: (type: string, cb: () => void) => void;
}

const getMap = () => (getShellActions()?.getAppApi() as { getMap?: () => MapLike | null } | undefined)?.getMap?.() ?? null;
const CASING = "-tfg-casing";

function lineLayersOf(map: MapLike, layer: GeoLibreLayer) {
  return (map.getStyle()?.layers ?? []).filter(
    (l) => l.type === "line" && l.id.includes(layer.id) && !l.id.endsWith(CASING) && !l.id.includes("generator") && !l.id.includes("label"),
  );
}

function apply(map: MapLike) {
  const layers = useAppStore.getState().layers;
  for (const layer of layers) {
    const dash = layer.style.strokeDasharray;
    const casing = layer.style.strokeCasingColor;
    for (const line of lineLayersOf(map, layer)) {
      try {
        const want = dash && dash.length >= 2 ? dash : undefined;
        const have = map.getPaintProperty(line.id, "line-dasharray") as number[] | undefined;
        if (JSON.stringify(have ?? null) !== JSON.stringify(want ?? null)) map.setPaintProperty(line.id, "line-dasharray", want);
      } catch {
        // a layer removed mid-update
      }
      const casingId = `${line.id}${CASING}`;
      const hasCasing = !!map.getLayer(casingId);
      if (casing && layer.visible) {
        const width = Number(map.getPaintProperty(line.id, "line-width") ?? layer.style.strokeWidth) || layer.style.strokeWidth;
        if (!hasCasing && line.source) {
          map.addLayer(
            {
              id: casingId,
              type: "line",
              source: line.source,
              ...(line["source-layer"] ? { "source-layer": line["source-layer"] } : {}),
              ...(line.filter ? { filter: line.filter } : {}),
              ...(line.minzoom !== undefined ? { minzoom: line.minzoom } : {}),
              ...(line.maxzoom !== undefined ? { maxzoom: line.maxzoom } : {}),
              metadata: { "geolibre:internal": true },
              layout: { "line-cap": "round", "line-join": "round" },
              paint: { "line-color": casing, "line-width": width + 2, "line-opacity": layer.opacity },
            },
            line.id,
          );
        } else if (hasCasing) {
          // Only real changes: every setPaintProperty fires "styledata" again.
          const set = (name: string, value: unknown) => {
            if (JSON.stringify(map.getPaintProperty(casingId, name)) !== JSON.stringify(value)) map.setPaintProperty(casingId, name, value);
          };
          set("line-color", casing);
          set("line-width", width + 2);
          set("line-opacity", layer.opacity);
        }
      } else if (hasCasing) {
        map.removeLayer(casingId);
      }
    }
  }
}

/** Keep dash patterns and casings in sync with the layer styles. */
export function useLineStyleSync(): void {
  useEffect(() => {
    let timer = 0;
    let bound: MapLike | null = null;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const map = getMap();
        if (!map) return;
        if (bound !== map) {
          bound?.off("styledata", schedule);
          map.on("styledata", schedule);
          bound = map;
        }
        if (!useAppStore.getState().layers.some((l) => (l.style.strokeDasharray?.length ?? 0) > 0 || l.style.strokeCasingColor)) {
          // Nothing to do, but casings of a style that was just cleared must go.
          for (const id of (map.getStyle()?.layers ?? []).map((l) => l.id).filter((id) => id.endsWith(CASING))) map.removeLayer(id);
          return;
        }
        apply(map);
      }, 120);
    };
    const unsubscribe = useAppStore.subscribe((s, prev) => {
      if (s.layers !== prev.layers) schedule();
    });
    schedule();
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
      bound?.off("styledata", schedule);
    };
  }, []);
}
