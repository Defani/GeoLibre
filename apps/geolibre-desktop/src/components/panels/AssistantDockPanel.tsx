import { closeRightPanel } from "@geolibre/plugins/right-panel-registry";
import { ASSISTANT_PANEL_ID } from "../../lib/native-panels";
import { useEffect, useRef } from "react";

declare global {
  interface Window {
    __glbDockHost?: HTMLElement;
    __glbOpenDock?: () => void;
  }
}

/**
 * Live MCP dock (Defani edition): one plain sidebar panel for the Live MCP
 * Bridge (connection settings, chat, setup guide for every desktop MCP client)
 * instead of a floating robot and settings window. The bridge mounts into
 * `window.__glbDockHost`.
 */
export function AssistantDockPanel() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    window.__glbDockHost = host;
    window.dispatchEvent(new Event("glb-dock-host"));
    // The assistant takes the Contents pane's place while it is open (see
    // index.css); asking for Layers again closes the assistant.
    document.documentElement.dataset.aiDock = "open";
    const onRailClick = (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest("button");
      const label = button?.getAttribute("aria-label") ?? "";
      if (!label.endsWith("Layers")) return;
      // Contents is only hidden (still expanded): show it rather than collapse it.
      if (label.startsWith("Collapse")) {
        event.preventDefault();
        event.stopPropagation();
      }
      closeRightPanel(ASSISTANT_PANEL_ID);
    };
    document.addEventListener("click", onRailClick, true);
    return () => {
      delete document.documentElement.dataset.aiDock;
      document.removeEventListener("click", onRailClick, true);
      if (window.__glbDockHost === host) delete window.__glbDockHost;
      window.dispatchEvent(new Event("glb-dock-host"));
    };
  }, []);
  return (
    // Plain panel, no icons: the bridge mounts Koneksi, chat and the MCP client
    // guide into the host below.
    <section aria-label="Live MCP" className="flex h-full min-h-0 flex-col bg-card">
      <header className="border-b bg-muted/60 px-3 py-2">
        <h2 className="truncate text-sm font-semibold">Live MCP</h2>
      </header>
      <div ref={hostRef} className="flex min-h-0 flex-1 flex-col" />
    </section>
  );
}
