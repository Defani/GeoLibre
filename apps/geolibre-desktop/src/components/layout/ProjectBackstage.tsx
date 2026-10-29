// Project tab helpers (Defani edition): the recent-project hook-up and the
// "About The Funny GIS" window that replaces GeoLibre's own About dialog.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { publishOpenRecent } from "../../lib/command-registry";
import { graphicsAdapter } from "../../lib/performance-settings";

const useAbout = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export const openAboutDialog = () => useAbout.getState().setOpen(true);

/** Hands the project loader's "open recent" to the ribbon. */
export function PublishOpenRecent({ open }: { open: (path: string) => void }) {
  useEffect(() => publishOpenRecent(open), [open]);
  return null;
}

const COMPONENTS: Array<[string, string]> = [
  ["Map engine", "MapLibre GL (GPU / WebGL)"],
  ["Data engine", "DuckDB native + GDAL"],
  ["Large files", "Native vector tiles with R-tree index"],
  ["Processing", "Toolbox, Python (GDAL, rasterio), Whitebox"],
  ["Layout", "Layout Composer"],
  ["Desktop shell", "Tauri (Rust)"],
];

export function AboutDialog() {
  const { open, setOpen } = useAbout();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/30" onMouseDown={() => setOpen(false)}>
      <div className="w-[440px] max-w-[94vw] overflow-hidden rounded-lg border bg-background shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-4 bg-[#0079C1] px-5 py-4 text-white">
          <img src="/branding/the-funny-gis.svg" alt="" className="h-14 w-14 rounded-full bg-white/10" />
          <div>
            <div className="text-lg font-semibold">The Funny GIS</div>
            <div className="text-[12px] opacity-90">Personal GIS tool by Defani Arman</div>
            <div className="text-[11px] opacity-75">Version {__GEOLIBRE_VERSION__}</div>
          </div>
        </div>
        <div className="space-y-3 px-5 py-4 text-[12.5px]">
          <p className="text-muted-foreground">
            A hybrid desktop GIS: a GPU map, a native data engine that opens very large files like QGIS,
            and an ArcGIS Pro-style workflow, with tools for forestry, carbon and land-cover work in Indonesia.
          </p>
          <table className="w-full">
            <tbody>
              {COMPONENTS.map(([k, v]) => (
                <tr key={k} className="border-t">
                  <td className="py-1 pr-3 text-muted-foreground">{k}</td>
                  <td className="py-1">{v}</td>
                </tr>
              ))}
              <tr className="border-t">
                <td className="py-1 pr-3 text-muted-foreground">Graphics</td>
                <td className="py-1">{graphicsAdapter()}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex justify-end border-t px-5 py-3">
          <button type="button" className="rounded bg-[#0079C1] px-4 py-1.5 text-[12.5px] text-white hover:bg-[#006aa8]" onClick={() => setOpen(false)}>
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
