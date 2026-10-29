// Add Data (Defani edition), ArcGIS Pro style: a navigation pane (Computer,
// Favorites, Recent folders), an address bar with Back / Up / Refresh, a
// details list with type icons, size and date, a type filter, and OK / Cancel.
// Shapefile sidecars are hidden; a shapefile shows as one item.

import { ArrowLeft, ArrowUp, Database, FileText, Folder, FolderOpen, Globe2, HardDrive, Image, Layers, Map as MapIcon, RefreshCw, Search, Star, StarOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { openRecentProject, runCommand } from "../../lib/command-registry";
import { DATA_INDONESIA_PANEL_ID, openNativePanel } from "../../lib/native-panels";
import { getShellActions } from "../../lib/shell-actions";
import { isTauri } from "../../lib/tauri-io";

type Filter = "all" | "vector" | "raster" | "table" | "project";

const useAddData = create<{ open: boolean; filter: Filter; setOpen: (open: boolean, filter?: Filter) => void }>((set) => ({
  open: false,
  filter: "all",
  setOpen: (open, filter = "all") => set({ open, filter }),
}));

/** Open the Add Data dialog (falls back to the old flow outside the desktop app). */
export function openAddData(filter: Filter = "all"): void {
  if (!isTauri()) {
    runCommand(filter === "raster" ? "add.raster" : "add.vector");
    return;
  }
  useAddData.getState().setOpen(true, filter);
}

interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: number;
}

const VECTOR = ["shp", "gpkg", "geojson", "json", "kml", "kmz", "gpx", "fgb", "parquet", "geoparquet", "gml", "tab", "mif", "dxf", "dwg", "sqlite", "topojson", "osm", "pbf", "zip"];
const RASTER = ["tif", "tiff", "img", "jp2", "vrt", "asc", "nc", "hdf", "h5", "png", "jpg", "jpeg", "dem", "bil", "ecw", "sid", "mbtiles", "pmtiles", "zarr"];
const TABLE = ["csv", "tsv", "txt", "xlsx", "xls", "dbf"];
const PROJECT = ["geolibre", "qgz", "qgs", "mxd", "aprx"];
const SIDECARS = ["shx", "dbf", "prj", "cpg", "sbn", "sbx", "qix", "qmd", "xml", "ovr", "aux", "tfw", "tifw", "jgw", "pgw", "lock", "fix", "atx", "ain", "aih", "ixs", "mxs"];

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

function kindOf(e: Entry, siblings: Set<string>): { label: string; group: Filter | "other"; icon: ReactElement } {
  if (e.dir) {
    if (/\.gdb$/i.test(e.name)) return { label: "File Geodatabase", group: "vector", icon: <Database className="h-4 w-4 text-[#7E57C2]" /> };
    return { label: "Folder", group: "other", icon: <Folder className="h-4 w-4 text-[#d4a015]" fill="#fde9a6" /> };
  }
  const x = ext(e.name);
  if (x === "shp") return { label: "Shapefile", group: "vector", icon: <Layers className="h-4 w-4 text-[#2e7d32]" /> };
  if (x === "dbf" && !siblings.has(e.name.replace(/\.dbf$/i, ".shp").toLowerCase())) return { label: "dBASE table", group: "table", icon: <FileText className="h-4 w-4 text-[#5b6573]" /> };
  if (VECTOR.includes(x)) return { label: `${x.toUpperCase()} vector`, group: "vector", icon: <MapIcon className="h-4 w-4 text-[#0079C1]" /> };
  if (RASTER.includes(x)) return { label: x === "tif" || x === "tiff" ? "Raster (GeoTIFF)" : `${x.toUpperCase()} raster`, group: "raster", icon: <Image className="h-4 w-4 text-[#e8871e]" /> };
  if (TABLE.includes(x)) return { label: `${x.toUpperCase()} table`, group: "table", icon: <FileText className="h-4 w-4 text-[#11968a]" /> };
  if (PROJECT.includes(x)) return { label: "Project", group: "project", icon: <FolderOpen className="h-4 w-4 text-[#d23c2f]" /> };
  return { label: x ? `${x.toUpperCase()} file` : "File", group: "other", icon: <FileText className="h-4 w-4 text-muted-foreground" /> };
}

const fmtSize = (n: number) => (n === 0 ? "" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const fmtDate = (s: number) => (s ? new Date(s * 1000).toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const parent = (p: string) => {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  if (i < 0) return null;
  const up = t.slice(0, i);
  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up || "/";
};

const FAV_KEY = "the-funny-gis:add-data-favorites";
const RECENT_KEY = "the-funny-gis:add-data-recent";
const LAST_KEY = "the-funny-gis:add-data-last";
const readList = (k: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "[]") as string[];
  } catch {
    return [];
  }
};
const writeList = (k: string, v: string[]) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // ignore
  }
};

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export function AddDataDialog() {
  const { open, filter: initialFilter, setOpen } = useAddData();
  const [path, setPath] = useState("");
  const [address, setAddress] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [drives, setDrives] = useState<string[]>([]);
  const [known, setKnown] = useState<Record<string, string>>({});
  const [favorites, setFavorites] = useState<string[]>(() => readList(FAV_KEY));
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: string, push = true) => {
    setError(null);
    try {
      const list = await invoke<Entry[]>("tfg_list_dir", { path: p });
      setEntries(list);
      if (push && path && path !== p) setHistory((h) => [...h, path]);
      setPath(p);
      setAddress(p);
      setSelected([]);
      try {
        localStorage.setItem(LAST_KEY, p);
      } catch {
        // ignore
      }
    } catch (e) {
      setError(String(e));
    }
  }, [path]);

  useEffect(() => {
    if (!open) return;
    setFilter(initialFilter);
    void invoke<string[]>("tfg_list_drives").then(setDrives).catch(() => undefined);
    void invoke<Record<string, string>>("tfg_known_folders").then(setKnown).catch(() => undefined);
    let last = "";
    try {
      last = localStorage.getItem(LAST_KEY) ?? "";
    } catch {
      // ignore
    }
    void load(last || "D:\\", false).catch(() => load("C:\\", false));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = useMemo(() => new Set(entries.map((e) => e.name.toLowerCase())), [entries]);
  const rows = useMemo(() => {
    return entries
      .filter((e) => {
        if (e.dir) return true;
        const x = ext(e.name);
        if (SIDECARS.includes(x) && !(x === "dbf" && !names.has(e.name.replace(/\.dbf$/i, ".shp").toLowerCase()))) return false;
        if (/\.(aux\.xml|tif\.ovr)$/i.test(e.name)) return false;
        return true;
      })
      .map((e) => ({ e, k: kindOf(e, names) }))
      .filter(({ e, k }) => (e.dir && k.group === "other") || (filter === "all" ? k.group !== "other" : k.group === filter))
      .filter(({ e }) => !search || e.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (a.e.dir === b.e.dir ? a.e.name.localeCompare(b.e.name, undefined, { numeric: true }) : a.e.dir ? -1 : 1));
  }, [entries, names, filter, search]);

  if (!open) return null;

  const close = () => setOpen(false);
  const addSelected = async (paths = selected) => {
    const files = paths.filter((p) => !entries.find((e) => e.path === p)?.dir || /\.gdb$/i.test(p));
    if (!files.length) return;
    setBusy(true);
    const recent = [path, ...readList(RECENT_KEY).filter((r) => r !== path)].slice(0, 8);
    writeList(RECENT_KEY, recent);
    close();
    for (const f of files) {
      if (PROJECT.includes(ext(f))) {
        openRecentProject(f);
        continue;
      }
      const err = await getShellActions()?.addFilePath(f);
      if (err) console.warn(`[Add Data] ${f}: ${err}`);
    }
    setBusy(false);
  };
  const toggleFavorite = () => {
    const next = favorites.includes(path) ? favorites.filter((f) => f !== path) : [...favorites, path];
    setFavorites(next);
    writeList(FAV_KEY, next);
  };

  const nav = (label: string, p: string, icon: ReactElement) => (
    <button key={p} type="button" className={`ad-nav-item ${path === p ? "on" : ""}`} title={p} onClick={() => void load(p)}>
      {icon}
      <span>{label}</span>
    </button>
  );

  return createPortal(
    <div className="ad-overlay" onMouseDown={close}>
      <div className="ad-dialog" role="dialog" aria-label="Add Data" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ad-head">
          <Layers className="h-4 w-4 text-[#3A9E43]" />
          <span>Add Data</span>
          <div className="flex-1" />
          <button type="button" title="Close (Esc)" onClick={close}><X className="h-4 w-4" /></button>
        </div>
        <div className="ad-bar">
          <button type="button" title="Back" disabled={!history.length} onClick={() => { const prev = history[history.length - 1]; setHistory((h) => h.slice(0, -1)); if (prev) void load(prev, false); }}><ArrowLeft className="h-4 w-4" /></button>
          <button type="button" title="Up one level" disabled={!parent(path)} onClick={() => { const up = parent(path); if (up) void load(up); }}><ArrowUp className="h-4 w-4" /></button>
          <input className="ad-address" value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load(address.trim())} spellCheck={false} />
          <button type="button" title="Refresh" onClick={() => void load(path, false)}><RefreshCw className="h-4 w-4" /></button>
          <button type="button" title={favorites.includes(path) ? "Remove from Favorites" : "Add to Favorites"} onClick={toggleFavorite}>
            {favorites.includes(path) ? <StarOff className="h-4 w-4 text-[#d4a015]" /> : <Star className="h-4 w-4 text-[#d4a015]" />}
          </button>
          <div className="ad-search"><Search className="h-3.5 w-3.5" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this folder" /></div>
        </div>
        <div className="ad-main">
          <nav className="ad-nav">
            <div className="ad-nav-cap">Computer</div>
            {drives.map((d) => nav(`Local Disk (${d.replace(/\\$/, "")})`, d, <HardDrive className="h-4 w-4 text-[#5b6573]" />))}
            <div className="ad-nav-cap">Folders</div>
            {known.desktop ? nav("Desktop", known.desktop, <Folder className="h-4 w-4 text-[#0079C1]" />) : null}
            {known.documents ? nav("Documents", known.documents, <Folder className="h-4 w-4 text-[#0079C1]" />) : null}
            {known.downloads ? nav("Downloads", known.downloads, <Folder className="h-4 w-4 text-[#0079C1]" />) : null}
            {favorites.length ? <div className="ad-nav-cap">Favorites</div> : null}
            {favorites.map((f) => nav(f.split(/[\\/]/).filter(Boolean).pop() ?? f, f, <Star className="h-4 w-4 text-[#d4a015]" />))}
            {readList(RECENT_KEY).length ? <div className="ad-nav-cap">Recent folders</div> : null}
            {readList(RECENT_KEY).map((f) => nav(f.split(/[\\/]/).filter(Boolean).pop() ?? f, f, <FolderOpen className="h-4 w-4 text-[#e8871e]" />))}
            <div className="ad-nav-cap">Other sources</div>
            <button type="button" className="ad-nav-item" onClick={() => { close(); openNativePanel(DATA_INDONESIA_PANEL_ID); }}><Database className="h-4 w-4 text-[#d23c2f]" /><span>Data Indonesia</span></button>
            <button type="button" className="ad-nav-item" onClick={() => { close(); runCommand("add.wms"); }}><Globe2 className="h-4 w-4 text-[#11968a]" /><span>Web service (WMS / WMTS)</span></button>
            <button type="button" className="ad-nav-item" onClick={() => { close(); runCommand("add.xyz"); }}><Globe2 className="h-4 w-4 text-[#0079C1]" /><span>Tile URL (XYZ)</span></button>
            <button type="button" className="ad-nav-item" onClick={() => { close(); runCommand("add.stac"); }}><Globe2 className="h-4 w-4 text-[#e8871e]" /><span>STAC catalog</span></button>
          </nav>
          <div className="ad-list">
            <table>
              <thead><tr><th>Name</th><th>Type</th><th className="text-right">Size</th><th>Date modified</th></tr></thead>
              <tbody>
                {rows.map(({ e, k }) => (
                  <tr
                    key={e.path}
                    className={selected.includes(e.path) ? "on" : ""}
                    onClick={(ev) => {
                      if (ev.ctrlKey) setSelected((s) => (s.includes(e.path) ? s.filter((x) => x !== e.path) : [...s, e.path]));
                      else if (ev.shiftKey && selected.length) {
                        const all = rows.map((r) => r.e.path);
                        const a = all.indexOf(selected[selected.length - 1]), b = all.indexOf(e.path);
                        setSelected(all.slice(Math.min(a, b), Math.max(a, b) + 1));
                      } else setSelected([e.path]);
                    }}
                    onDoubleClick={() => (e.dir && !/\.gdb$/i.test(e.name) ? void load(e.path) : void addSelected([e.path]))}
                  >
                    <td><span className="ad-name">{k.icon}<span>{e.name}</span></span></td>
                    <td>{k.label}</td>
                    <td className="text-right tabular-nums">{fmtSize(e.size + (ext(e.name) === "shp" ? entries.find((x) => x.name.toLowerCase() === e.name.toLowerCase().replace(/\.shp$/, ".dbf"))?.size ?? 0 : 0))}</td>
                    <td className="tabular-nums">{fmtDate(e.modified)}</td>
                  </tr>
                ))}
                {!rows.length && !error ? <tr><td colSpan={4} className="ad-empty">This folder has no supported data.</td></tr> : null}
                {error ? <tr><td colSpan={4} className="ad-empty text-red-600">{error}</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
        <div className="ad-foot">
          <label className="ad-namefield">Name<input readOnly value={selected.map((s) => s.split(/[\\/]/).pop()).join("; ")} /></label>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">All supported types</option>
            <option value="vector">Feature classes (vector)</option>
            <option value="raster">Rasters</option>
            <option value="table">Tables</option>
            <option value="project">Projects</option>
          </select>
          <button type="button" className="lp-btn primary" disabled={!selected.length || busy} onClick={() => void addSelected()}>OK</button>
          <button type="button" className="lp-btn" onClick={close}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
