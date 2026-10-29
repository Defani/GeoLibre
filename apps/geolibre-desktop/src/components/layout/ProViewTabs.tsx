import type { MapEngine } from "@geolibre/map";
import { cn } from "@geolibre/ui";
import { ChevronDown } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { setWorkspaceView, useLayoutViewStore } from "../../lib/layout-view";
import { ProGlobeIcon, ProLayoutIcon } from "./toolbar/ProIcons";

/**
 * ArcGIS Pro-style view tabs (Defani edition) across the top of the workspace:
 * "Map" (Data View) and "Layout" (Layout View). The active tab is white with a
 * blue top edge and joins the view below it, like Pro's document tabs.
 */
export function ProViewTabs() {
  const view = useLayoutViewStore((s) => s.view);
  const tab = (target: "data" | "layout", label: string, Icon: typeof ProGlobeIcon) => {
    const active = view === target;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => setWorkspaceView(target)}
        className={cn(
          "relative -mb-px flex h-8 items-center gap-1.5 border border-b-0 px-3 text-xs transition-colors",
          active
            ? "border-border bg-background font-semibold text-foreground before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-primary"
            : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
        {label}
      </button>
    );
  };
  return (
    <div role="tablist" aria-label="Views" className="flex h-8 shrink-0 items-end gap-0.5 border-b bg-muted/70 px-2">
      {tab("data", "Map", ProGlobeIcon)}
      {tab("layout", "Layout", ProLayoutIcon)}
    </div>
  );
}

/** Standard map scales offered by the scale box, like ArcGIS Pro's list. */
const SCALES = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000];
const METERS_PER_PIXEL_96DPI = 0.0254 / 96;
const EARTH_CIRCUMFERENCE = 40075016.686;

function scaleOf(zoom: number, lat: number): number {
  const resolution = (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
  return resolution / METERS_PER_PIXEL_96DPI;
}
function zoomFor(scale: number, lat: number): number {
  const resolution = scale * METERS_PER_PIXEL_96DPI;
  return Math.log2((EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (512 * resolution));
}

/**
 * ArcGIS Pro-style scale box at the bottom-left of the map: shows the current
 * scale 1:n (96 dpi, like ArcGIS) and sets it from a typed value or the list.
 */
export function MapScaleBox({
  mapControllerRef,
  mapReadyGeneration,
  variant = "map",
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
  /** "header": inline in the top toolbar like ArcMap's Standard toolbar. */
  variant?: "map" | "header";
}) {
  const view = useLayoutViewStore((s) => s.view);
  const [scale, setScale] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [listPos, setListPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    type LiveMap = NonNullable<ReturnType<MapEngine["getMap"]>>;
    let map: LiveMap | null = null;
    const update = () => {
      if (!map) return;
      const s = scaleOf(map.getZoom(), map.getCenter().lat);
      setScale(s);
      setText(Math.round(s).toLocaleString("id-ID"));
    };
    // The engine can publish its map after the toolbar mounts: wait for it.
    const attach = () => {
      map = mapControllerRef.current?.getMap?.() ?? null;
      if (!map) return false;
      update();
      map.on("zoomend", update);
      map.on("moveend", update);
      return true;
    };
    let timer: number | null = null;
    if (!attach()) {
      timer = window.setInterval(() => {
        if (attach() && timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
      }, 500);
    }
    return () => {
      if (timer !== null) window.clearInterval(timer);
      map?.off("zoomend", update);
      map?.off("moveend", update);
    };
  }, [mapControllerRef, mapReadyGeneration]);

  const apply = (value: number) => {
    const map = mapControllerRef.current?.getMap?.();
    if (!map || !(value > 0)) return;
    map.easeTo({ zoom: zoomFor(value, map.getCenter().lat), duration: 400 });
    setOpen(false);
  };

  if (scale === null || (variant === "map" && view !== "data")) return null;
  return (
    <div
      title="Map scale"
      className={
        variant === "header"
          ? "relative ms-2 flex shrink-0 items-center border-s ps-2"
          : "pointer-events-auto absolute bottom-2 left-2 z-50"
      }
    >
      <div className="flex h-7 items-center rounded-sm border bg-background/95 text-xs shadow-sm backdrop-blur">
        <span className="ps-2 text-muted-foreground">1 :</span>
        <input
          aria-label="Map scale"
          className={`${variant === "header" ? "w-[4.5rem]" : "w-24"} bg-transparent px-1 font-mono tabular-nums outline-none`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply(Number(text.replace(/[^\d]/g, "")));
          }}
          onBlur={() => setText(Math.round(scale).toLocaleString("id-ID"))}
        />
        <button
          type="button"
          aria-label="Choose a scale"
          className="flex h-full items-center border-s px-1 hover:bg-accent"
          onClick={(e) => {
            const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
            setListPos({ left: r.left, top: r.bottom + 2 });
            setOpen((v) => !v);
          }}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {open ? (
        <ul
          // The header scrolls sideways, so its list is fixed under the box.
          style={variant === "header" ? listPos : undefined}
          className={`max-h-64 w-36 overflow-auto rounded-sm border bg-popover py-1 text-xs shadow-md ${
            variant === "header" ? "fixed z-[60]" : "absolute bottom-8 left-0"
          }`}
        >
          {SCALES.map((s) => (
            <li key={s}>
              <button type="button" className="w-full px-3 py-1 text-start font-mono hover:bg-accent" onClick={() => apply(s)}>
                1:{s.toLocaleString("id-ID")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
