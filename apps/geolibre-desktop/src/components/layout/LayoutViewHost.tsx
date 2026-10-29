import type { MapEngine } from "@geolibre/map";
import { cn } from "@geolibre/ui";
import { Loader2 } from "lucide-react";
import { ProGlobeIcon, ProLayoutIcon } from "./toolbar/ProIcons";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createAppAPI } from "../../hooks/usePlugins";
import { loadLayoutComposer, setWorkspaceView, useLayoutViewStore } from "../../lib/layout-view";
import { mountLayoutRibbon } from "./layout-ribbon";

/**
 * Layout View host (Defani edition): covers the map area with the built-in
 * Layout Composer while Layout View is active. The map stays mounted underneath
 * because the composer's live map frames read it.
 */
export function LayoutViewHost({ mapControllerRef }: { mapControllerRef: RefObject<MapEngine | null> }) {
  const view = useLayoutViewStore((s) => s.view);
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    if (view !== "layout" || !hostRef.current) return;
    let cancelled = false;
    let api: { unmount: () => void } | null = null;
    let unmountRibbon: (() => void) | null = null;
    setStatus("loading");
    loadLayoutComposer(createAppAPI(mapControllerRef))
      .then((composer) => {
        if (cancelled || !hostRef.current) return;
        composer.mount(hostRef.current);
        api = composer;
        // Defani edition: the composer's tools become an ArcGIS Pro-style
        // ribbon in GeoLibre's header, beside Project / Settings / Help.
        const root = hostRef.current.querySelector<HTMLElement>(".glc-root");
        const header = [...document.querySelectorAll<HTMLElement>("header")].find(
          (h) => !h.classList.contains("glc-top"),
        );
        if (root && header) unmountRibbon = mountLayoutRibbon(root, header);
        setStatus("idle");
      })
      .catch((error: unknown) => {
        console.error("[Layout View] could not load the Layout Composer", error);
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      unmountRibbon?.();
      api?.unmount();
    };
  }, [view, mapControllerRef]);

  if (view !== "layout") return null;
  return (
    <div ref={hostRef} data-testid="layout-view" className="absolute inset-0 z-40 bg-background">
      {status === "loading" ? (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading Layout View…
        </div>
      ) : status === "error" ? (
        <div className="flex h-full items-center justify-center text-sm text-destructive">
          Layout View could not be loaded.
        </div>
      ) : null}
    </div>
  );
}

/**
 * ArcMap-style view switch in the bottom-left corner of the workspace: Data View
 * (the map) and Layout View (the page layout).
 */
export function WorkspaceViewSwitch() {
  const view = useLayoutViewStore((s) => s.view);
  const item = (target: "data" | "layout", label: string, Icon: typeof ProGlobeIcon) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={view === target}
      onClick={() => setWorkspaceView(target)}
      className={cn(
        "flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium transition-colors",
        view === target ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
  return (
    <div className="pointer-events-auto absolute bottom-2 left-2 z-50 flex overflow-hidden rounded-md border bg-background/95 shadow-md backdrop-blur">
      {item("data", "Data View", ProGlobeIcon)}
      <span className="w-px bg-border" />
      {item("layout", "Layout View", ProLayoutIcon)}
    </div>
  );
}
