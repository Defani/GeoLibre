import { useAppStore } from "@geolibre/core";
import { getGeometryEditTargetLayerId, subscribeGeometryEdit } from "@geolibre/plugins";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ASSISTANT_PANEL_ID, openNativePanel } from "../../../lib/native-panels";
import { getEditorActions } from "../../../lib/editor-actions";
import { openProcessingToolbox, useProcessingToolboxStore } from "../../../lib/processing-toolbox";
import type { ToolbarChrome } from "./constants";

// ArcMap-style header menus (Defani edition): "Geoprocessing" lists the
// everyday overlay tools one click away, and "Editor" starts/stops a
// digitizing session like ArcMap's Editor toolbar.

// Native GeoLibre processing commands (the same ones ArcToolbox runs); the
// second item picks the glyph.
const GEOPROCESSING_TOOLS: Array<[commandId: string, glyph: string, label: string] | "sep"> = [
  ["proc.vector.buffer", "buffer", "Buffer"],
  ["proc.vector.clip", "clip", "Clip"],
  ["proc.vector.intersection", "intersect", "Intersect"],
  ["proc.vector.union", "union", "Union"],
  ["proc.vector.merge-layers", "merge", "Merge"],
  ["proc.vector.dissolve", "dissolve", "Dissolve"],
  "sep",
  ["proc.vector.difference", "tool", "Erase (Difference)"],
  ["proc.vector.spatial-join", "tool", "Spatial Join"],
  ["proc.vector.select-by-location", "tool", "Select by Location"],
  ["proc.vector.centroids", "tool", "Centroids"],
  ["proc.vector.reproject", "tool", "Project"],
];

/** Small two-tone glyphs drawn on a 16 px grid. */
const Glyph = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 16 16" className="me-2 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden>
    {children}
  </svg>
);

const TOOL_GLYPH: Record<string, ReactNode> = {
  buffer: (
    <Glyph>
      <circle cx="8" cy="8" r="6.2" fill="#c7dcf3" stroke="#2f7fd6" strokeDasharray="2 1.4" />
      <circle cx="8" cy="8" r="2.4" fill="#2f7fd6" stroke="none" />
    </Glyph>
  ),
  clip: (
    <Glyph>
      <rect x="1.5" y="1.5" width="9" height="9" fill="#e8eef5" />
      <path d="M5.5 5.5h9v9h-9Z" fill="none" />
      <rect x="5.5" y="5.5" width="5" height="5" fill="#ef7d22" stroke="none" />
    </Glyph>
  ),
  intersect: (
    <Glyph>
      <circle cx="6" cy="8" r="4.3" />
      <circle cx="10" cy="8" r="4.3" />
      <path d="M8 4.5a4.3 4.3 0 0 1 0 7a4.3 4.3 0 0 1 0-7Z" fill="#3ea044" stroke="none" />
    </Glyph>
  ),
  union: (
    <Glyph>
      <circle cx="6" cy="8" r="4.3" fill="#9cc8f2" />
      <circle cx="10" cy="8" r="4.3" fill="#9cc8f2" />
    </Glyph>
  ),
  merge: (
    <Glyph>
      <rect x="1.5" y="3" width="6" height="10" fill="#b9dca0" />
      <rect x="8.5" y="3" width="6" height="10" fill="#c7dcf3" />
      <path d="M6 8h4M8.6 6.6 10 8l-1.4 1.4" />
    </Glyph>
  ),
  dissolve: (
    <Glyph>
      <path d="M2 3h12v10H2Z" fill="#f2d78a" />
      <path d="M8 3v10M2 8h12" strokeDasharray="1.4 1.2" />
    </Glyph>
  ),
};

export function GeoprocessingMenu({ chrome }: { chrome: ToolbarChrome }) {
  const commands = useProcessingToolboxStore((s) => s.commands);
  const open = (commandId: string) => commands.find((c) => c.id === commandId)?.run();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className={chrome.buttonClass} variant="ghost" size={chrome.buttonSize} aria-label="Geoprocessing">
          <svg viewBox="0 0 24 24" className={chrome.iconClassName} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <circle cx="9" cy="12" r="6" fill="#9cc8f2" />
            <circle cx="15" cy="12" r="6" fill="#b9dca0" fillOpacity="0.8" />
            <path d="M12 7a6 6 0 0 1 0 10a6 6 0 0 1 0-10Z" fill="#3ea044" stroke="none" />
          </svg>
          {chrome.renderLabel("Geoprocessing")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuLabel>Geoprocessing</DropdownMenuLabel>
        {GEOPROCESSING_TOOLS.map((item, i) =>
          item === "sep" ? (
            <DropdownMenuSeparator key={`sep-${i}`} />
          ) : (
            <DropdownMenuItem
              key={item[0]}
              disabled={!commands.some((c) => c.id === item[0])}
              onSelect={() => open(item[0])}
            >
              {TOOL_GLYPH[item[1]] ?? (
                <Glyph>
                  <path d="M3 13.5l6.3-6.3" stroke="#a0692f" strokeWidth="2" strokeLinecap="round" />
                  <path d="M8 3.6l2.3-2.1 4.2 4.2-2 2.2-4.5-4.3Z" fill="#a7b0bd" stroke="#4b5563" strokeWidth=".8" />
                </Glyph>
              )}
              {item[2]}
            </DropdownMenuItem>
          ),
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openProcessingToolbox()}>
          <Glyph>
            <rect x="1.5" y="4.5" width="13" height="9" rx="1" fill="#d23c2f" stroke="#7a1f1f" />
            <path d="M5.5 4.5V3h5v1.5" stroke="#7a1f1f" />
          </Glyph>
          Toolbox…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function EditorMenu({ chrome }: { chrome: ToolbarChrome }) {
  const editingLayerId = useSyncExternalStore(subscribeGeometryEdit, getGeometryEditTargetLayerId);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const editingLayer = layers.find((l) => l.id === editingLayerId);
  const selectedLayer = layers.find((l) => l.id === selectedLayerId);
  const canStart = !editingLayerId && selectedLayer?.type === "geojson";

  const newSketchLayer = async (kind: string) => {
    const store = useAppStore.getState();
    const id = store.addGeoJsonLayer(`New ${kind}`, EMPTY);
    store.selectLayer(id);
    await getEditorActions()?.toggle(id);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className={chrome.buttonClass} variant="ghost" size={chrome.buttonSize} aria-label="Editor">
          <svg viewBox="0 0 24 24" className={chrome.iconClassName} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden>
            <path d="M3 18l3-9 7 1.5 2 6.5-6 3Z" fill="#c7dcf3" stroke="#2f7fd6" />
            <path d="M14.5 3.5l3 3-8 8-3.6.6.6-3.6Z" fill="#f2b630" />
            <path d="M13 5l3 3" />
          </svg>
          {chrome.renderLabel(editingLayer ? "Editing…" : "Editor")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>
          {editingLayer ? `Editing: ${editingLayer.name}` : "Editor"}
        </DropdownMenuLabel>
        <DropdownMenuItem
          disabled={!canStart}
          onSelect={() => selectedLayer && void getEditorActions()?.toggle(selectedLayer.id)}
        >
          <Glyph>
            <path d="M10.5 2.5l3 3-7 7-3.5.5.5-3.5Z" fill="#f2b630" />
          </Glyph>
          Start Editing{selectedLayer && !editingLayerId ? ` (${selectedLayer.name})` : ""}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!editingLayerId}
          onSelect={() => editingLayerId && void getEditorActions()?.toggle(editingLayerId)}
        >
          <Glyph>
            <path d="M2.5 2.5h9l2 2v9h-11Z" fill="#9cc8f2" />
            <path d="M5 2.5v4h5v-4M5 13.5v-4h6v4" />
          </Glyph>
          Save Edits &amp; Stop Editing
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!editingLayerId} onSelect={() => getEditorActions()?.cancel()}>
          <Glyph>
            <path d="M4 4l8 8M12 4l-8 8" stroke="#d64545" strokeWidth="1.6" />
          </Glyph>
          Discard Edits
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Create a new layer and draw</DropdownMenuLabel>
        <DropdownMenuItem disabled={!!editingLayerId} onSelect={() => void newSketchLayer("Points")}>
          <Glyph>
            <circle cx="5" cy="10" r="1.8" fill="#d64545" stroke="none" />
            <circle cx="11" cy="5" r="1.8" fill="#d64545" stroke="none" />
          </Glyph>
          New Point Layer
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!!editingLayerId} onSelect={() => void newSketchLayer("Lines")}>
          <Glyph>
            <path d="M2 12l4-6 4 4 4-7" stroke="#2f7fd6" strokeWidth="1.6" />
          </Glyph>
          New Line Layer
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!!editingLayerId} onSelect={() => void newSketchLayer("Polygons")}>
          <Glyph>
            <path d="M2.5 11l2.5-7.5 7 1.5 1.5 6-6 2.5Z" fill="#b9dca0" stroke="#3ea044" />
          </Glyph>
          New Polygon Layer
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!selectedLayer}
          onSelect={() => useAppStore.getState().setAttributeTableOpen(true)}
        >
          <Glyph>
            <rect x="1.5" y="2.5" width="13" height="11" fill="#fff" />
            <path d="M1.5 5.5h13M1.5 8.5h13M1.5 11h13M6 2.5v11" strokeWidth=".8" />
          </Glyph>
          Attribute Table
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Live MCP (Defani edition): opens the AI Assistant dock, the chat of the
 * built-in Live MCP Bridge that links this window to an AI client. The dot mirrors the link status the
 * bridge publishes on its (hidden) map button.
 */
export function LiveBridgeButton({ chrome }: { chrome: ToolbarChrome }) {
  const [status, setStatus] = useState("disconnected");
  useEffect(() => {
    const read = () => {
      const dot = document.querySelector<HTMLElement>(".glb-live-dot");
      setStatus(dot?.dataset.status ?? "disconnected");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-status"], childList: true });
    return () => observer.disconnect();
  }, []);
  const color = status === "connected" ? "#16a34a" : status === "connecting" ? "#f59e0b" : "#9ca3af";
  return (
    <Button
      className={chrome.buttonClass}
      variant="ghost"
      size={chrome.buttonSize}
      aria-label="Live MCP"
      title={`Live MCP (AI link): ${status}`}
      onClick={() => openNativePanel(ASSISTANT_PANEL_ID)}
    >
      <span className="relative inline-flex">
        <svg viewBox="0 0 24 24" className={chrome.iconClassName} fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="3" y="5" width="18" height="12" rx="2" fill="#c7dcf3" stroke="#2f7fd6" />
          <path d="M8 21h8M12 17v4" stroke="#2f7fd6" />
          <path d="M7 11.5c1.5-2 3-2 4.5 0s3 2 5.5-1" stroke="#2f7fd6" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-background" style={{ background: color }} />
      </span>
      {chrome.renderLabel("Live MCP")}
    </Button>
  );
}
