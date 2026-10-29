import { useAppStore } from "@geolibre/core";
import { Button, cn, Input, Label, Select } from "@geolibre/ui";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useProcessNotifier } from "../../lib/process-notify";
import { getShellActions } from "../../lib/shell-actions";
import { isTauri } from "../../lib/tauri-io";
import { ParamHelpPane, useParamHelp } from "../processing/ParamHelp";

const FOLDER_KEY = "the-funny-gis:indonesia-boundaries-folder";
const DEFAULT_FOLDER = "D:\\SPATIAL DATA\\VEKTOR\\PETA DASAR NASIONAL";

/** The national base-map boundaries, light (simplified GeoJSON) and detailed (SHP). */
const BOUNDARIES: Array<{ label: string; dir: string; light: string; detail: string }> = [
  { label: "Provinsi", dir: "BATAS PROVINSI", light: "BATAS_PROVINSI_ringan.geojson", detail: "BATAS_PROVINSI.shp" },
  { label: "Kabupaten / Kota", dir: "BATAS KABUPATEN", light: "BATAS_KABUPATEN_ringan.geojson", detail: "BATAS_KABUPATEN.shp" },
  { label: "Kecamatan", dir: "BATAS KECAMATAN", light: "Batas_kec_BIG_ringan.geojson", detail: "Batas_kec_BIG.shp" },
  {
    label: "Kelurahan / Desa",
    dir: "BATAS WILAYAH KELURAHAN-DESA 10K",
    light: "Batas_Wilayah_KelurahanDesa_10K_AR_ringan.geojson",
    detail: "Batas_Wilayah_KelurahanDesa_10K_AR.shp",
  },
  { label: "Pulau", dir: "batas_pulau", light: "batas_pulau_ringan.geojson", detail: "batas_pulau.shp" },
];

/** Online imagery and forest overlays (tile URLs checked to answer). */
const OVERLAYS: Array<{ name: string; url: string; attribution: string; maxzoom?: number; help: string }> = [
  {
    name: "Sentinel-2 cloudless 2023",
    url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg",
    attribution: "Sentinel-2 cloudless 2023 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2023)",
    maxzoom: 14,
    help: "A seamless, cloud-free Sentinel-2 mosaic of 2023 at 10 m (EOX). Good as a recent true-colour backdrop.",
  },
  {
    name: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxzoom: 19,
    help: "Very high-resolution satellite and aerial imagery (Esri). Date varies by place.",
  },
  {
    name: "Hutan hilang 2001–2023 (Hansen GFC)",
    url: "https://storage.googleapis.com/earthenginepartners-hansen/tiles/gfc_v1.11/loss_alpha/{z}/{x}/{y}.png",
    attribution: "Hansen/UMD/Google/USGS/NASA Global Forest Change 2000–2023 v1.11",
    maxzoom: 12,
    help: "Forest cover loss 2001–2023 at 30 m from the Hansen Global Forest Change dataset (v1.11). Useful for EUDR and deforestation screening.",
  },
  {
    name: "OpenTopoMap",
    url: "https://tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "Map data © OpenStreetMap contributors, SRTM | Map style © OpenTopoMap (CC-BY-SA)",
    maxzoom: 17,
    help: "Topographic map with contour lines and hillshading from OpenStreetMap and SRTM.",
  },
];

type S2Render = "truecolor" | "falsecolor" | "ndvi";
const S2_RENDER: Record<S2Render, { label: string; query: string; help: string }> = {
  truecolor: { label: "True colour (RGB)", query: "assets=visual&nodata=0", help: "Natural colour, as the eye sees it." },
  falsecolor: {
    label: "False colour (NIR-R-G)",
    query: "assets=B08&assets=B04&assets=B03&rescale=0,4000&nodata=0",
    help: "Vegetation appears red; bright red is dense, healthy canopy. Good for separating forest from plantations.",
  },
  ndvi: {
    label: "NDVI",
    query: "expression=(B08-B04)/(B08%2BB04)&asset_as_band=true&rescale=-0.2,0.9&colormap_name=rdylgn&nodata=0",
    help: "Normalized Difference Vegetation Index, red (bare) to green (dense vegetation).",
  },
};

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-2 text-start font-semibold hover:bg-accent/50" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {title}
      </button>
      {open ? <div className="space-y-2 px-3 pb-3">{children}</div> : null}
    </section>
  );
}

/**
 * Data Indonesia dock (Defani edition): Indonesian administrative boundaries
 * from the local national base map, online imagery and forest overlays, and a
 * cloud-free Sentinel-2 composite of the current view from Microsoft Planetary
 * Computer.
 */
export function DataIndonesiaPanel() {
  const addTileLayer = useAppStore((s) => s.addTileLayer);
  const paramHelp = useParamHelp();
  const [folder, setFolder] = useState(() => {
    try {
      return localStorage.getItem(FOLDER_KEY) || DEFAULT_FOLDER;
    } catch {
      return DEFAULT_FOLDER;
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(() => `${new Date().getFullYear() - 1}-06-01`);
  const [to, setTo] = useState(() => `${new Date().getFullYear() - 1}-09-30`);
  const [cloud, setCloud] = useState(15);
  const [render, setRender] = useState<S2Render>("truecolor");
  useProcessNotifier(busy ?? "Data Indonesia", busy !== null, !!error && busy === null, error);

  const saveFolder = (value: string) => {
    setFolder(value);
    try {
      localStorage.setItem(FOLDER_KEY, value);
    } catch {
      // Private mode: the folder lasts for this session.
    }
  };

  const addBoundary = async (label: string, path: string) => {
    setError(null);
    setMessage(null);
    setBusy(`Loading ${label}`);
    try {
      const failure = await getShellActions()?.addFilePath(path);
      if (failure) throw new Error(failure);
      setMessage(`${label} added to Contents.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const addOverlay = (overlay: (typeof OVERLAYS)[number]) => {
    addTileLayer(overlay.name, { type: "xyz", tiles: [overlay.url], url: overlay.url, attribution: overlay.attribution, maxzoom: overlay.maxzoom });
    setMessage(`${overlay.name} added to Contents.`);
  };

  const buildComposite = async () => {
    setError(null);
    setMessage(null);
    const map = (getShellActions()?.getAppApi() as { getMap?: () => { getBounds: () => { toArray: () => number[][] } } | null })?.getMap?.();
    if (!map) {
      setError("The map is not ready yet.");
      return;
    }
    const [[west, south], [east, north]] = map.getBounds().toArray();
    setBusy("Sentinel-2 composite");
    try {
      const body = {
        "filter-lang": "cql2-json",
        filter: {
          op: "and",
          args: [
            { op: "=", args: [{ property: "collection" }, "sentinel-2-l2a"] },
            { op: "anyinteracts", args: [{ property: "datetime" }, { interval: [`${from}T00:00:00Z`, `${to}T23:59:59Z`] }] },
            { op: "<=", args: [{ property: "eo:cloud_cover" }, cloud] },
            {
              op: "s_intersects",
              args: [
                { property: "geometry" },
                { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
              ],
            },
          ],
        },
        // Least cloudy scenes on top: each pixel comes from the clearest image.
        sortby: [{ field: "eo:cloud_cover", direction: "asc" }],
      };
      const response = await fetch("https://planetarycomputer.microsoft.com/api/data/v1/mosaic/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Planetary Computer answered ${response.status}`);
      const { searchid } = (await response.json()) as { searchid: string };
      const tiles = `https://planetarycomputer.microsoft.com/api/data/v1/mosaic/${searchid}/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?collection=sentinel-2-l2a&${S2_RENDER[render].query}`;
      addTileLayer(`Sentinel-2 ${S2_RENDER[render].label} ${from} – ${to} (≤${cloud}% cloud)`, {
        type: "xyz",
        tiles: [tiles],
        url: tiles,
        attribution: "Contains modified Copernicus Sentinel data, Microsoft Planetary Computer",
        bounds: [west, south, east, north],
        minzoom: 8,
        maxzoom: 15,
      });
      setMessage("Composite added. Zoom to level 8 or closer to see it.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const sep = folder.includes("/") && !folder.includes("\\") ? "/" : "\\";
  return (
    <section aria-label="Data Indonesia" className="flex h-full min-h-0 flex-col bg-card text-[12.5px]">
      <header className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
          <rect x="2" y="5" width="20" height="7" rx="1" fill="#d64545" />
          <rect x="2" y="12" width="20" height="7" rx="1" fill="#ffffff" stroke="#c9ced6" />
        </svg>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">Data Indonesia</h2>
          <p className="truncate text-[11px] text-muted-foreground">Boundaries, imagery, forest and Sentinel-2</p>
        </div>
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto" {...paramHelp.handlers}>
        <Section title="Batas wilayah (Peta Dasar Nasional)">
          <div className="space-y-1" data-help-label="Folder" data-help="Your national base-map folder. Each level is read from its sub-folder: “ringan” is the simplified GeoJSON (fast), “detail” the full shapefile (precise; large files are simplified while loading, see Settings › Performance).">
            <Label className="text-xs">Folder</Label>
            <Input className="h-7 text-xs" value={folder} onChange={(e) => saveFolder(e.target.value)} />
          </div>
          {!isTauri() ? <p className="text-[11px] text-amber-700">Reading local folders needs the desktop app.</p> : null}
          <div className="divide-y rounded border">
            {BOUNDARIES.map((level) => (
              <div key={level.label} className="flex items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-medium">{level.label}</span>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={!!busy || !isTauri()}
                  data-help-label={`${level.label} — ringan`} data-help="Simplified boundaries: opens in a second or two, fine for overview maps and layouts."
                  onClick={() => void addBoundary(level.label, `${folder}${sep}${level.dir}${sep}${level.light}`)}>
                  Ringan
                </Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={!!busy || !isTauri()}
                  data-help-label={`${level.label} — detail`} data-help="The full shapefile, for analysis. Heavy files are simplified while loading unless Settings › Performance is set to Full detail."
                  onClick={() => void addBoundary(level.label, `${folder}${sep}${level.dir}${sep}${level.detail}`)}>
                  Detail
                </Button>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Citra & hutan (online)">
          <div className="divide-y rounded border">
            {OVERLAYS.map((overlay) => (
              <div key={overlay.name} className="flex items-center gap-2 px-2 py-1.5" data-help-label={overlay.name} data-help={overlay.help}>
                <span className="min-w-0 flex-1 truncate">{overlay.name}</span>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => addOverlay(overlay)}>
                  Add
                </Button>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Sentinel-2 bebas awan (view saat ini)">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1" data-help-label="From / To" data-help="The season to draw scenes from. A dry-season window (June–September) gives the clearest images over most of Indonesia.">
              <Label className="text-xs">From</Label>
              <Input type="date" className="h-7 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1" data-help-label="From / To" data-help="The season to draw scenes from. A dry-season window (June–September) gives the clearest images over most of Indonesia.">
              <Label className="text-xs">To</Label>
              <Input type="date" className="h-7 text-xs" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1" data-help-label="Max cloud" data-help="Scenes cloudier than this are skipped; the clearest scene is drawn on top at every place.">
            <Label className="text-xs">Max cloud: {cloud}%</Label>
            <input type="range" min={0} max={60} step={5} value={cloud} onChange={(e) => setCloud(Number(e.target.value))} className="w-full accent-[#0078d4]" />
          </div>
          <div className="space-y-1" data-help-label="Render" data-help={S2_RENDER[render].help}>
            <Label className="text-xs">Render</Label>
            <Select className="h-7 text-xs" value={render} onChange={(e) => setRender(e.target.value as S2Render)}>
              {Object.entries(S2_RENDER).map(([id, r]) => (
                <option key={id} value={id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" className="w-full" disabled={!!busy} onClick={() => void buildComposite()}
            data-help-label="Create composite" data-help="Searches Microsoft Planetary Computer for Sentinel-2 L2A scenes over the current map view and adds a cloud-free mosaic as a tile layer (no download needed).">
            {busy === "Sentinel-2 composite" ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Create composite for this view
          </Button>
        </Section>

        {message ? <p className="m-3 rounded border border-emerald-300 bg-emerald-50 p-2 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{message}</p> : null}
        {error ? <p className={cn("m-3 rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive")}>{error}</p> : null}
      </div>
      <ParamHelpPane
        title="Data Indonesia"
        description="Indonesian boundaries, imagery and forest data ready to add."
        help={paramHelp.help}
        className="max-h-32 shrink-0 border-t"
      />
    </section>
  );
}
