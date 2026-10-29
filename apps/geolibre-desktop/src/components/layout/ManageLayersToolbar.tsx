import { cn } from "@geolibre/ui";
import type { ReactNode } from "react";
import { runAddDataAction } from "../../lib/add-data-actions";

// QGIS-style "Manage Layers" toolbar (Defani edition): a vertical row of
// one-click Add Layer buttons along the left edge of the workspace. Each
// button runs the same handler as the matching Add Data menu item.

const BLUE = "#2f7fd6";
const GREEN = "#3ea044";
const YELLOW = "#f2b630";
const ORANGE = "#ef7d22";
const RED = "#d64545";
const PURPLE = "#8a5cc7";
const TEAL = "#1f9e9a";

/** A small green "+" badge in the bottom-right, like QGIS's add icons. */
const Plus = () => (
  <g>
    <circle cx="18" cy="18" r="4.6" fill={GREEN} stroke="#fff" strokeWidth="1" />
    <path d="M18 15.6v4.8M15.6 18h4.8" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
  </g>
);

const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
    {children}
    <Plus />
  </svg>
);

const ICONS: Record<string, ReactNode> = {
  vector: (
    <Svg>
      <path d="M3 13l4-8 8 2 2 6-6 4Z" fill="#b9dca0" stroke={GREEN} />
      <circle cx="7" cy="5" r="1.4" fill="#fff" stroke={GREEN} />
      <circle cx="3" cy="13" r="1.4" fill="#fff" stroke={GREEN} />
      <circle cx="15" cy="7" r="1.4" fill="#fff" stroke={GREEN} />
    </Svg>
  ),
  raster: (
    <Svg>
      <rect x="2.5" y="3" width="14" height="13" fill="#fff" stroke="#5f6b7a" />
      <path d="M2.5 7.3h14M2.5 11.6h14M7.2 3v13M11.8 3v13" stroke="#5f6b7a" strokeWidth="0.8" />
      <rect x="2.5" y="3" width="4.7" height="4.3" fill={BLUE} />
      <rect x="7.2" y="7.3" width="4.6" height="4.3" fill={YELLOW} />
      <rect x="11.8" y="3" width="4.7" height="4.3" fill={GREEN} />
      <rect x="2.5" y="11.6" width="4.7" height="4.4" fill={ORANGE} />
    </Svg>
  ),
  "delimited-text": (
    <Svg>
      <path d="M4 2.5h8l4 4V17H4Z" fill="#fff" stroke="#5f6b7a" />
      <path d="M12 2.5v4h4" stroke="#5f6b7a" />
      <path d="M6.5 9h7M6.5 11.5h7M6.5 14h4" stroke={BLUE} strokeWidth="1.1" />
      <path d="M9.5 8v7" stroke="#5f6b7a" strokeWidth="0.8" />
    </Svg>
  ),
  geoparquet: (
    <Svg>
      <path d="M3 5.5l7-3 7 3-7 3Z" fill={TEAL} stroke={TEAL} />
      <path d="M3 9.5l7 3 7-3M3 13.5l7 3 7-3" stroke={TEAL} strokeWidth="1.4" />
    </Svg>
  ),
  duckdb: (
    <Svg>
      <circle cx="9.5" cy="9.5" r="7" fill={YELLOW} stroke="#2b2b2b" />
      <circle cx="8" cy="9.5" r="2.6" fill="#2b2b2b" stroke="none" />
      <path d="M11.5 8.3h3.4a1.2 1.2 0 0 1 0 2.4h-3.4Z" fill={ORANGE} stroke="none" />
    </Svg>
  ),
  postgres: (
    <Svg>
      <ellipse cx="9.5" cy="4.5" rx="6.5" ry="2.2" fill="#c7dcf3" stroke={BLUE} />
      <path d="M3 4.5v10c0 1.2 2.9 2.2 6.5 2.2s6.5-1 6.5-2.2v-10" fill="#e7f0fb" stroke={BLUE} />
      <path d="M3 9.5c0 1.2 2.9 2.2 6.5 2.2S16 10.7 16 9.5" stroke={BLUE} />
    </Svg>
  ),
  wms: (
    <Svg>
      <circle cx="9.5" cy="9.5" r="7" fill="#d9ebfb" stroke={BLUE} />
      <path d="M2.5 9.5h14M9.5 2.5c-2.6 2.5-2.6 11.5 0 14M9.5 2.5c2.6 2.5 2.6 11.5 0 14" stroke={BLUE} strokeWidth="1" />
      <rect x="6.5" y="6.5" width="6" height="6" fill="none" stroke={ORANGE} strokeWidth="1.3" />
    </Svg>
  ),
  wmts: (
    <Svg>
      <circle cx="9.5" cy="9.5" r="7" fill="#d9ebfb" stroke={BLUE} />
      <path d="M2.5 9.5h14M9.5 2.5v14" stroke={BLUE} strokeWidth="1" />
      <path d="M5.5 5.5h4v4h-4ZM9.5 9.5h4v4h-4Z" fill={ORANGE} stroke="none" opacity="0.85" />
    </Svg>
  ),
  wfs: (
    <Svg>
      <circle cx="9.5" cy="9.5" r="7" fill="#d9ebfb" stroke={BLUE} />
      <path d="M2.5 9.5h14M9.5 2.5c-2.6 2.5-2.6 11.5 0 14M9.5 2.5c2.6 2.5 2.6 11.5 0 14" stroke={BLUE} strokeWidth="1" />
      <path d="M5.5 12l2.5-5 4.5 1.5-1 4.5Z" fill="#b9dca0" stroke={GREEN} />
    </Svg>
  ),
  xyz: (
    <Svg>
      <rect x="2.5" y="2.5" width="14" height="14" rx="1" fill="#fff" stroke="#5f6b7a" />
      <path d="M2.5 9.5h14M9.5 2.5v14" stroke="#5f6b7a" strokeWidth="0.9" />
      <rect x="2.5" y="2.5" width="7" height="7" fill="#b9dca0" />
      <rect x="9.5" y="9.5" width="7" height="7" fill="#c7dcf3" />
    </Svg>
  ),
  arcgis: (
    <Svg>
      <circle cx="9.5" cy="9.5" r="7" fill="#fff" stroke={BLUE} />
      <path d="M4 12c2-4 4-6 11-6M5 15c3-3 6-4 10.5-3.5" stroke={BLUE} strokeWidth="1.5" strokeLinecap="round" />
    </Svg>
  ),
  pmtiles: (
    <Svg>
      <path d="M3 6l6.5-3.5L16 6v8l-6.5 3.5L3 14Z" fill="#efe3fb" stroke={PURPLE} />
      <path d="M3 6l6.5 3.5L16 6M9.5 9.5v8" stroke={PURPLE} />
    </Svg>
  ),
  stac: (
    <Svg>
      <path d="M9.5 2.5l6.5 3.7-6.5 3.7L3 6.2Z" fill="#c7dcf3" stroke={BLUE} />
      <path d="M3 9.6l6.5 3.7 6.5-3.7M3 13l6.5 3.7L16 13" stroke={BLUE} />
      <circle cx="15.5" cy="3.5" r="1.6" fill={RED} stroke="none" />
    </Svg>
  ),
  kml: (
    <Svg>
      <path d="M9.5 2.5a5 5 0 0 0-5 5c0 3.8 5 9.5 5 9.5s5-5.7 5-9.5a5 5 0 0 0-5-5Z" fill={RED} stroke="#9c2b2b" />
      <circle cx="9.5" cy="7.5" r="1.8" fill="#fff" stroke="none" />
    </Svg>
  ),
};

/** Buttons in QGIS order; separators group them like the QGIS toolbar. */
const ITEMS: Array<{ id: string; title: string } | "sep"> = [
  { id: "vector", title: "Add Vector Layer (Shapefile, GeoPackage, GeoJSON…)" },
  { id: "raster", title: "Add Raster Layer (GeoTIFF, COG…)" },
  { id: "delimited-text", title: "Add Delimited Text Layer (CSV)" },
  { id: "geoparquet", title: "Add GeoParquet Layer" },
  { id: "kml", title: "Add KML / KMZ Layer" },
  "sep",
  { id: "postgres", title: "Add PostGIS Layer" },
  { id: "duckdb", title: "Add DuckDB Layer" },
  "sep",
  { id: "wms", title: "Add WMS Layer" },
  { id: "wmts", title: "Add WMTS Layer" },
  { id: "wfs", title: "Add WFS / OGC API - Features Layer" },
  { id: "xyz", title: "Add XYZ Tile Layer" },
  { id: "arcgis", title: "Add ArcGIS REST Server Layer" },
  "sep",
  { id: "pmtiles", title: "Add PMTiles Layer" },
  { id: "stac", title: "Add STAC Layer" },
];

export function ManageLayersToolbar() {
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Manage Layers"
      data-testid="manage-layers-toolbar"
      className="hidden w-9 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-e bg-muted/60 py-1.5 md:flex"
    >
      {/* QGIS toolbar grip */}
      <div aria-hidden className="mb-1 h-1 w-5 border-y border-dotted border-muted-foreground/50" />
      {ITEMS.map((item, i) =>
        item === "sep" ? (
          <div key={`sep-${i}`} aria-hidden className="my-1 h-px w-6 bg-border" />
        ) : (
          <button
            key={item.id}
            type="button"
            title={item.title}
            aria-label={item.title}
            onClick={() => runAddDataAction(item.id)}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-sm border border-transparent text-foreground",
              "hover:border-primary/40 hover:bg-accent active:bg-primary/15",
            )}
          >
            {ICONS[item.id]}
          </button>
        ),
      )}
    </div>
  );
}
