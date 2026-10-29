import { useAppStore } from "@geolibre/core";
import { Input } from "@geolibre/ui";
import { Search } from "lucide-react";
import { DATA_INDONESIA_PANEL_ID, EARTH_ENGINE_PANEL_ID, KOBO_PANEL_ID, openNativePanel, SDM_PANEL_ID } from "../../lib/native-panels";
import { openINaturalist } from "../../lib/native-inaturalist";
import { openRasterCalculator } from "../processing/RasterCalculatorWindow";
import { openChangeDetection, openZonalStatistics } from "../processing/AnalysisWindows";
import { openAnalysisTool } from "../processing/AnalysisToolkitWindow";
import { ANALYSIS_TOOLS } from "../../lib/analysis/tools";
import { useMemo, useState, type ReactNode } from "react";
import type { Command } from "../../lib/commands";
import {
  TOOLBOX_CATEGORIES,
  toolboxPlacement,
  toolboxToolName,
  useProcessingToolboxStore,
  type ToolboxCategoryId,
} from "../../lib/processing-toolbox";

type Tree = Map<ToolboxCategoryId, Map<string, Command[]>>;

/** Earth Engine runs in its own dock rather than as a floating map control. */
function runTool(tool: Command): void {
  if (tool.id === "proc.earth-engine") openNativePanel(EARTH_ENGINE_PANEL_ID);
  // ArcMap-style Map Algebra window across several rasters.
  else if (tool.id === "proc.raster.raster-calc") openRasterCalculator();
  else tool.run();
}

function buildTree(commands: Command[], query: string): Tree {
  const q = query.trim().toLowerCase();
  const tree: Tree = new Map();
  for (const command of commands) {
    if (q) {
      const hay = `${toolboxToolName(command)} ${command.title} ${command.keywords ?? ""} ${toolboxPlacement(command).subgroup}`.toLowerCase();
      if (!q.split(/\s+/).every((word) => hay.includes(word))) continue;
    }
    const { category, subgroup } = toolboxPlacement(command);
    if (!tree.has(category)) tree.set(category, new Map());
    const groups = tree.get(category)!;
    if (!groups.has(subgroup)) groups.set(subgroup, []);
    groups.get(subgroup)!.push(command);
  }
  for (const groups of tree.values())
    for (const list of groups.values()) list.sort((a, b) => toolboxToolName(a).localeCompare(toolboxToolName(b)));
  return tree;
}

/**
 * ArcMap-style ArcToolbox (Defani edition) for the right sidebar: a search box over a tree
 * of every processing tool (Vector, Raster, Network, Statistics, Conversion,
 * AI, Workspaces, Data catalogs). Double-clicking a tool runs the same command the
 * Processing menu runs. While searching, every matching folder is expanded.
 */
export function ProcessingToolboxPanel() {
  const published = useProcessingToolboxStore((s) => s.commands);
  // Workspaces the Processing menu opens directly (no palette command).
  const setNotebookOpen = useAppStore((s) => s.setNotebookOpen);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  const setProcessingHistoryOpen = useAppStore((s) => s.setProcessingHistoryOpen);
  const setProcessingInitialTool = useAppStore((s) => s.setProcessingInitialTool);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const commands = useMemo<Command[]>(() => {
    const ids = new Set(published.map((c) => c.id));
    const extra: Command[] = [
      { id: "proc.notebook", title: "Jupyter Notebook", group: "Processing", run: () => setNotebookOpen(true) },
      { id: "proc.dashboard", title: "Dashboard", group: "Processing", run: () => setDashboardOpen(true) },
      { id: "proc.history", title: "Processing History", group: "Processing", run: () => setProcessingHistoryOpen(true) },
      { id: "proc.sdm", title: "Species Distribution Modeling", group: "Processing", run: () => openNativePanel(SDM_PANEL_ID) },
      { id: "proc.inaturalist", title: "iNaturalist Extractor", group: "Processing", run: () => openINaturalist() },
      { id: "proc.kobo", title: "KoboToolbox", group: "Processing", run: () => openNativePanel(KOBO_PANEL_ID) },
      { id: "proc.data-indonesia", title: "Data Indonesia", group: "Processing", run: () => openNativePanel(DATA_INDONESIA_PANEL_ID) },
      { id: "proc.zonal-table", title: "Zonal Statistics to Attributes", group: "Processing", run: () => openZonalStatistics() },
      { id: "proc.change-detection", title: "Change Detection", group: "Processing", run: () => openChangeDetection() },
      // Defani edition: the Analysis Toolkit tools.
      ...ANALYSIS_TOOLS.map((tool) => ({
        id: `proc.ax.${tool.id}`,
        title: tool.title,
        group: "Processing",
        keywords: tool.description,
        run: () => openAnalysisTool(tool.id),
      })),
      {
        id: "proc.raster.download-global-dem",
        title: "Download Global DEM",
        group: "Processing",
        run: () => {
          setProcessingInitialTool("download_global_dem");
          setProcessingOpen(true);
        },
      },
    ].filter((c) => !ids.has(c.id));
    return published.length ? [...published, ...extra] : [];
  }, [published, setNotebookOpen, setDashboardOpen, setProcessingHistoryOpen, setProcessingInitialTool, setProcessingOpen]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ vector: true });
  const tree = useMemo(() => buildTree(commands, query), [commands, query]);
  const searching = query.trim().length > 0;
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const total = useMemo(() => [...tree.values()].reduce((n, g) => n + [...g.values()].reduce((m, l) => m + l.length, 0), 0), [tree]);

  return (
    <section aria-label="Toolbox" className="arctoolbox flex h-full min-h-0 flex-col bg-white text-[12px] text-neutral-900 dark:bg-card dark:text-foreground">
      <div className="flex items-center gap-1.5 border-b bg-gradient-to-b from-[#f4f7fb] to-[#dfe7f1] px-2 py-1 dark:from-muted dark:to-muted">
        <ToolboxIcon className="h-4 w-4" />
        <span className="font-semibold">Toolbox</span>
        <span className="ms-auto text-[11px] text-muted-foreground">{total} tools</span>
      </div>
      <div className="relative border-b px-2 py-1.5">
        <Search className="pointer-events-none absolute start-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search tools"
          className="h-7 rounded-none ps-7 text-[12px]"
          placeholder="Search tools…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1" style={{ fontFamily: "Tahoma, 'Segoe UI', sans-serif" }} role="tree">
        {commands.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">Loading tools…</p>
        ) : tree.size === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">No tool matches “{query}”.</p>
        ) : (
          <div role="treeitem" aria-expanded>
            <div className="flex items-center gap-1 px-1 py-[1px]">
              <ToolboxIcon className="h-4 w-4" />
              <span>Toolbox</span>
            </div>
            <ul className="atb-branch">
              {TOOLBOX_CATEGORIES.filter((c) => tree.has(c.id)).map((category) => {
                const groups = tree.get(category.id)!;
                const catOpen = searching || !!open[category.id];
                const label = category.label;
                const toolItems = (list: Command[]) =>
                  list.map((tool) => (
                    <li key={tool.id}>
                      <button
                        type="button"
                        role="treeitem"
                        title={tool.disabledReason ?? `${toolboxToolName(tool)} (double-click to open)`}
                        disabled={!!tool.disabledReason}
                        className="atb-row atb-tool disabled:opacity-50"
                        onDoubleClick={() => runTool(tool)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") runTool(tool);
                        }}
                      >
                        <HammerIcon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{toolboxToolName(tool)}</span>
                      </button>
                    </li>
                  ));
                return (
                  <li key={category.id} role="treeitem" aria-expanded={catOpen}>
                    <TreeRow open={catOpen} onToggle={() => toggle(category.id)}>
                      <ToolboxIcon className="h-4 w-4" />
                      <span>{label}</span>
                    </TreeRow>
                    {catOpen ? (
                      <ul className="atb-branch">
                        {[...groups.entries()]
                          .sort((a, b) => a[0].localeCompare(b[0]))
                          .flatMap(([subgroup, tools]) => {
                            if (groups.size === 1) return toolItems(tools);
                            const key = `${category.id}/${subgroup}`;
                            const subOpen = searching || !!open[key];
                            return [
                              <li key={key} role="treeitem" aria-expanded={subOpen}>
                                <TreeRow open={subOpen} onToggle={() => toggle(key)}>
                                  <ToolsetIcon className="h-4 w-4" />
                                  <span>{subgroup}</span>
                                </TreeRow>
                                {subOpen ? <ul className="atb-branch">{toolItems(tools)}</ul> : null}
                              </li>,
                            ];
                          })}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** ArcMap tree row: a boxed +/- expander followed by the icon and label. */
function TreeRow({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" className="atb-row" onClick={onToggle}>
      <span aria-hidden className="atb-expander">{open ? "−" : "+"}</span>
      {children}
    </button>
  );
}

type IconProps = { className?: string };

/** ArcToolbox toolbox: a red tool chest with a handle. */
function ToolboxIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path d="M5.5 4.5V3.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7v1.3" fill="none" stroke="#7a1f1f" strokeWidth="1.1" />
      <rect x="1.5" y="4.5" width="13" height="9" rx="1" fill="#d23c2f" stroke="#7a1f1f" />
      <rect x="1.5" y="4.5" width="13" height="3" fill="#e8665a" stroke="#7a1f1f" />
      <rect x="7" y="6.6" width="2" height="1.8" fill="#f3d36b" stroke="#7a5a10" strokeWidth=".6" />
    </svg>
  );
}

/** ArcToolbox toolset: a small toolbox with a hammer laid over it. */
function ToolsetIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <rect x="1.5" y="6" width="10" height="7.5" rx=".8" fill="#e15b4e" stroke="#7a1f1f" />
      <path d="M8.2 2.6l4.6 4.6" stroke="#8a5a2b" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M11.3 1.5l3.2 3.2-1.5 1.5-3.2-3.2Z" fill="#9aa4b1" stroke="#4b5563" strokeWidth=".7" />
    </svg>
  );
}

/** ArcToolbox tool: the classic hammer. */
function HammerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <path d="M3 13.5l6.3-6.3" stroke="#a0692f" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 3.6l2.3-2.1 4.2 4.2-2 2.2-1.3-1.3-1.2 1.2-2.6-2.6 1.2-1.2Z" fill="#a7b0bd" stroke="#4b5563" strokeWidth=".8" strokeLinejoin="round" />
    </svg>
  );
}
