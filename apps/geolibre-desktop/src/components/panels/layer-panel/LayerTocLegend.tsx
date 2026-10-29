import { DEFAULT_LEGEND_CONFIG, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { colormapColors } from "@geolibre/plugins";
import { useMemo, useState } from "react";
import { buildAutoLegend } from "../../../lib/auto-legend";
import { GeometrySwatch, GradientBar, MarkerSwatch } from "../../legend/LegendSwatch";

const EMPTY_LEGEND = DEFAULT_LEGEND_CONFIG as Parameters<typeof buildAutoLegend>[1];

type ClassStyle = {
  vectorStyleMode?: string;
  vectorStyleProperty?: string;
  vectorStyleStops?: Array<{ value?: unknown }>;
};

/**
 * Builds the filter that hides the unchecked classes of a categorized or
 * graduated layer, combined with the filter the layer had before the TOC
 * touched it (kept in `metadata.tocBaseFilter`).
 */
function classFilter(style: ClassStyle, hidden: number[], base: unknown[] | undefined): unknown[] | undefined {
  const prop = style.vectorStyleProperty;
  const stops = style.vectorStyleStops ?? [];
  if (!prop || hidden.length === 0) return base;
  let own: unknown[];
  if (style.vectorStyleMode === "categorized") {
    own = ["!", ["in", ["to-string", ["get", prop]], ["literal", hidden.map((i) => String(stops[i]?.value ?? ""))]]];
  } else {
    const n = ["to-number", ["get", prop]];
    own = [
      "all",
      ...hidden.map((i) => {
        const lo = Number(stops[i]?.value);
        const hi = i + 1 < stops.length ? Number(stops[i + 1]?.value) : undefined;
        const inside = hi === undefined ? [">=", n, lo] : ["all", [">=", n, lo], ["<", n, hi]];
        return ["!", inside];
      }),
    ];
  }
  return base ? ["all", base, own] : own;
}

/** ArcMap TOC visibility checkbox (drawn, so it matches at every zoom). */
export function TocCheckbox({ checked, dim = false }: { checked: boolean; dim?: boolean }) {
  return (
    <svg viewBox="0 0 14 14" className={`h-3.5 w-3.5 ${dim ? "opacity-50" : ""}`} aria-hidden>
      <rect x="0.5" y="0.5" width="13" height="13" rx="2" fill={checked ? "#0078d4" : "#fff"} stroke={checked ? "#0078d4" : "#8a96a3"} />
      {checked ? <path d="M3.3 7.2 5.9 9.7 10.8 4.6" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

/**
 * ArcMap-style Table of Contents symbology (Defani edition): every class of a
 * categorized / graduated layer under the layer row, each with a checkbox that
 * shows or hides that class on the map; a single-symbol layer shows its one
 * symbol patch; a raster shows its colour ramp. The +/- box collapses it.
 */
export function LayerTocLegend({ layer }: { layer: GeoLibreLayer }) {
  const [open, setOpen] = useState(true);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const entry = useMemo(() => {
    try {
      return buildAutoLegend([{ ...layer, visible: true }], EMPTY_LEGEND, {
        resolveColormapColors: colormapColors,
      })[0];
    } catch {
      return undefined;
    }
  }, [layer]);
  if (!entry) return null;
  const style = (layer.style ?? {}) as ClassStyle;
  const classMode = style.vectorStyleMode === "categorized" || style.vectorStyleMode === "graduated";
  const classCount = classMode ? (style.vectorStyleStops?.length ?? 0) : 0;
  const metadata0 = (layer.metadata ?? {}) as Record<string, unknown>;
  const hidden = (metadata0.tocHiddenClasses as number[] | undefined) ?? [];
  const rows = entry.rows.filter((row) => !row.hidden);
  const maxSize = Math.max(0, ...rows.map((row) => row.size ?? 0)) || undefined;

  const applyHidden = (next: number[]) => {
    const metadata = { ...metadata0 };
    // Remember the layer's own filter the first time a class is hidden.
    if (!("tocBaseFilter" in metadata)) metadata.tocBaseFilter = layer.filterExpression ?? null;
    const base = (metadata.tocBaseFilter as unknown[] | null) ?? undefined;
    metadata.tocHiddenClasses = next;
    if (next.length === 0) delete metadata.tocBaseFilter;
    updateLayer(layer.id, {
      metadata: metadata as GeoLibreLayer["metadata"],
      filterExpression: classFilter(style, next, base),
    });
  };
  const toggleClass = (index: number) =>
    applyHidden(hidden.includes(index) ? hidden.filter((i) => i !== index) : [...hidden, index]);

  // Single symbol: just the symbol patch under the layer name, like ArcMap.
  if (!rows.length && !entry.gradient) {
    if (!entry.headerSwatch) return null;
    return (
      <div className="ms-[46px] flex items-center py-px" onClick={(e) => e.stopPropagation()}>
        {entry.headerSwatch.marker ? (
          <MarkerSwatch marker={entry.headerSwatch.marker} opacity={entry.opacity} />
        ) : (
          <GeometrySwatch shape={entry.shape} color={entry.headerSwatch.color} opacity={entry.opacity} />
        )}
      </div>
    );
  }

  return (
    <div className="ms-[22px]" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="flex items-center gap-1 py-px text-[11.5px] text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Collapse" : "Expand"}
      >
        <span
          aria-hidden
          className="inline-flex h-[9px] w-[9px] items-center justify-center border border-[#8a96a3] bg-white font-mono text-[9px] leading-none text-neutral-800"
        >
          {open ? "−" : "+"}
        </span>
        <span className="truncate">{entry.fieldLabel || (entry.gradient ? "Value" : "Classes")}</span>
      </button>
      {open ? (
        <div className="ms-[4px] border-s border-dotted border-[#9aa3ad] ps-2">
          {entry.gradient ? (
            <div className="w-40 py-0.5 text-[10px]">
              <GradientBar
                colors={entry.gradient.colors}
                minLabel={entry.gradient.minLabel ?? "Low"}
                maxLabel={entry.gradient.maxLabel ?? "High"}
                opacity={entry.opacity}
              />
            </div>
          ) : null}
          {rows.map((row, index) => {
            const toggleable = index < classCount;
            const shown = !hidden.includes(index);
            return (
              <label
                key={row.key}
                className={`flex min-w-0 items-center gap-1.5 py-px text-[11.5px] ${toggleable ? "cursor-pointer" : ""} ${shown ? "" : "opacity-50"}`}
              >
                {toggleable ? (
                  <input
                    type="checkbox"
                    className="h-3 w-3 shrink-0 accent-[#0078d4]"
                    checked={shown}
                    onChange={() => toggleClass(index)}
                    aria-label={`Show ${row.label}`}
                  />
                ) : null}
                {row.marker ? (
                  <MarkerSwatch marker={row.marker} size={row.size} maxSize={maxSize} opacity={entry.opacity} />
                ) : (
                  <GeometrySwatch shape={row.shape} color={row.color} size={row.size} maxSize={maxSize} opacity={entry.opacity} />
                )}
                <span className="truncate" title={row.label}>
                  {row.label}
                </span>
              </label>
            );
          })}
          {classCount > 1 ? (
            <div className="flex gap-2 py-px text-[10.5px] text-primary">
              <button type="button" className="hover:underline" onClick={() => applyHidden([])}>
                Show all
              </button>
              <button
                type="button"
                className="hover:underline"
                onClick={() => applyHidden(Array.from({ length: classCount }, (_, i) => i))}
              >
                Hide all
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
