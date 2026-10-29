import { useAppStore } from "@geolibre/core";
import { openRightPanel } from "@geolibre/plugins/right-panel-registry";
import { Clock3, Cpu, Database, FolderOpen, FolderTree, Layers, LayoutTemplate, Map as MapIcon, Plus, Sparkles, Trees, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BROWSER_PANEL_ID } from "../../hooks/useRegisterBrowserPanel";
import { runCommand } from "../../lib/command-registry";
import { setWorkspaceView } from "../../lib/layout-view";
import { DATA_INDONESIA_PANEL_ID, openNativePanel } from "../../lib/native-panels";

const SHOWN_KEY = "the-funny-gis:start-shown";
const STARTUP_KEY = "the-funny-gis:start-at-launch";

/** The animated Earth-with-eyes logo (same art as the splash). */
export function AnimatedLogo({ size = 132 }: { size?: number }) {
  const land =
    "M14 30c10-8 24-10 32-4 6 5 2 12 6 18 3 5 10 6 9 13-1 8-11 9-14 16-3 8 4 15 0 24-3 7-10 10-14 6-5-6-1-15-6-22-5-6-14-8-16-17-2-10 2-26 3-34ZM78 14c9-3 22 0 30 8 6 6 9 15 4 20-4 4-11 1-15 6-3 4 1 10-2 16-4 7-3 16-8 22-4 5-11 4-13-3-2-8 3-17 0-25-2-6-10-8-11-15-1-9 6-25 15-29ZM100 86c6-2 13 1 15 6 1 5-4 9-10 9s-11-3-11-8c0-3 2-6 6-7Z";
  return (
    <svg className="ss-logo" viewBox="0 0 128 128" width={size} height={size} aria-hidden="true">
      <defs>
        <clipPath id="ss-earth"><circle cx="64" cy="64" r="58" /></clipPath>
      </defs>
      <circle cx="64" cy="64" r="58" fill="#0079C1" />
      <g clipPath="url(#ss-earth)" fill="#4FB0EA">
        <g className="ss-land">
          <path d={land} />
          <path d={land} transform="translate(116 0)" />
        </g>
      </g>
      <g className="ss-eye"><ellipse cx="48" cy="56" rx="11" ry="13" fill="#fff" /><g className="ss-pupil"><circle cx="51" cy="59" r="5.5" fill="#0079C1" /><circle cx="53" cy="57" r="1.8" fill="#fff" /></g></g>
      <g className="ss-eye"><ellipse cx="80" cy="56" rx="11" ry="13" fill="#fff" /><g className="ss-pupil"><circle cx="83" cy="59" r="5.5" fill="#0079C1" /><circle cx="85" cy="57" r="1.8" fill="#fff" /></g></g>
      <path className="ss-smile" d="M52 84c7 7 17 7 24 0" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

function Card({ icon, color, bg, title, text, onClick, wide }: { icon: ReactNode; color: string; bg: string; title: string; text: string; onClick: () => void; wide?: boolean }) {
  return (
    <button type="button" className={`ss-card ${wide ? "wide" : ""}`} onClick={onClick}>
      <span className="ss-card-icon" style={{ color, background: bg }}>{icon}</span>
      <span className="min-w-0">
        <span className="ss-card-title">{title}</span>
        <span className="ss-card-text">{text}</span>
      </span>
    </button>
  );
}

const ago = (iso?: string) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(d) || d < 0) return "";
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
};

/**
 * The Funny GIS start screen (Defani edition): shown when the app opens —
 * animated logo, developer and version, start actions and recent projects.
 */
export function StartScreen({
  onOpenProject,
  onOpenRecent,
}: {
  onOpenProject: () => void;
  onOpenRecent: (path: string) => void;
}) {
  const recentProjects = useAppStore((s) => s.recentProjects);
  const [atLaunch, setAtLaunch] = useState(() => {
    try {
      return localStorage.getItem(STARTUP_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(SHOWN_KEY) !== "1" && localStorage.getItem(STARTUP_KEY) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (!open) return;
    try {
      sessionStorage.setItem(SHOWN_KEY, "1");
    } catch {
      // Private mode: the screen simply shows again next time.
    }
    // Capture phase + stopImmediatePropagation: Esc closes only this screen,
    // not the window underneath it as well.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;

  const close = () => setOpen(false);
  const go = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <div className="ss-backdrop" role="dialog" aria-label="Welcome to The Funny GIS" onMouseDown={close}>
      <div className="ss-window" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Close" className="ss-close" onClick={close}><X className="h-4 w-4" /></button>
        <aside className="ss-hero">
          <div className="ss-orbit" />
          <AnimatedLogo />
          <h1>The Funny GIS</h1>
          <p className="ss-tagline">Personal GIS tool</p>
          <div className="ss-dev">
            <span>Developed by</span>
            <strong>Defani Arman</strong>
          </div>
          <span className="ss-version">Version {__GEOLIBRE_VERSION__}</span>
          <ul className="ss-features">
            <li><Cpu className="h-3.5 w-3.5" /> GPU map engine</li>
            <li><Database className="h-3.5 w-3.5" /> Opens very large data natively</li>
            <li><Layers className="h-3.5 w-3.5" /> ArcGIS Pro-style workflow</li>
            <li><Trees className="h-3.5 w-3.5" /> Forestry, carbon and KLHK tools</li>
          </ul>
        </aside>
        <section className="ss-main">
          <div className="ss-heading">
            <Sparkles className="h-4 w-4 text-[#0079C1]" />
            <h2>Start</h2>
          </div>
          <div className="ss-cards">
            <Card icon={<MapIcon className="h-5 w-5" />} color="#0079C1" bg="#dcecf8" title="New map" text="Start in the Map view" onClick={close} />
            <Card icon={<FolderOpen className="h-5 w-5" />} color="#b07900" bg="#fdf0cc" title="Open project…" text="A saved project file" onClick={go(onOpenProject)} />
            <Card icon={<LayoutTemplate className="h-5 w-5" />} color="#c2185b" bg="#fde4ee" title="New layout" text="Compose a printable map" onClick={go(() => setWorkspaceView("layout"))} />
            <Card icon={<Plus className="h-5 w-5" />} color="#2e7d32" bg="#e3f3e4" title="Add data…" text="Shapefile, GeoTIFF, GeoPackage…" onClick={go(() => runCommand("add.vector"))} />
            <Card icon={<Database className="h-5 w-5" />} color="#d32f2f" bg="#fde6e6" title="Data Indonesia" text="Boundaries, imagery, Sentinel-2" onClick={go(() => openNativePanel(DATA_INDONESIA_PANEL_ID))} />
            <Card icon={<FolderTree className="h-5 w-5" />} color="#6a4fb3" bg="#ece6fa" title="Catalog" text="Browse folders and data" onClick={go(() => openRightPanel(BROWSER_PANEL_ID))} />
          </div>
          <div className="ss-heading mt-4">
            <Clock3 className="h-4 w-4 text-muted-foreground" />
            <h2>Recent projects</h2>
          </div>
          <div className="ss-recent">
            {recentProjects.length === 0 ? (
              <p className="ss-empty">No recent projects yet. Saved projects appear here.</p>
            ) : (
              recentProjects.slice(0, 7).map((project) => (
                <button key={project.path} type="button" title={project.path} className="ss-recent-row" onClick={go(() => onOpenRecent(project.path))}>
                  <FolderOpen className="h-4 w-4 shrink-0 text-[#d4a015]" />
                  <span className="min-w-0 flex-1">
                    <span className="ss-recent-name">{(project as { name?: string }).name || project.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "")}</span>
                    <span className="ss-recent-path">{project.path}</span>
                  </span>
                  <span className="ss-recent-when">{ago(project.openedAt)}</span>
                </button>
              ))
            )}
          </div>
          <footer className="ss-foot">
            <label>
              <input
                type="checkbox"
                checked={atLaunch}
                onChange={(e) => {
                  setAtLaunch(e.target.checked);
                  try {
                    localStorage.setItem(STARTUP_KEY, e.target.checked ? "1" : "0");
                  } catch {
                    // ignore
                  }
                }}
              />
              Show this screen at startup
            </label>
            <span>© {new Date().getFullYear()} Defani Arman · The Funny GIS {__GEOLIBRE_VERSION__}</span>
          </footer>
        </section>
      </div>
    </div>
  );
}
