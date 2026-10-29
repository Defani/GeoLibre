// Native right-dock panels (Defani edition): built-in features that open in the
// right sidebar (Species Distribution Modeling, iNaturalist, ...). Each entry is
// registered as a right panel and its React body is portalled into one shared
// host by the shell, so adding a panel needs no new shell wiring.

import type { ComponentType, LazyExoticComponent } from "react";
import { lazy } from "react";
import { openRightPanel } from "@geolibre/plugins/right-panel-registry";

export interface NativePanel {
  id: string;
  title: string;
  defaultWidth: number;
  component: LazyExoticComponent<ComponentType>;
}

export const SDM_PANEL_ID = "species-distribution-modeling";
export const ASSISTANT_PANEL_ID = "ai-assistant-dock";
export const EARTH_ENGINE_PANEL_ID = "earth-engine-dock";
export const KOBO_PANEL_ID = "kobo-dock";
export const DATA_INDONESIA_PANEL_ID = "data-indonesia-dock";

export const NATIVE_PANELS: NativePanel[] = [
  {
    id: ASSISTANT_PANEL_ID,
    title: "Live MCP",
    defaultWidth: 360,
    component: lazy(() =>
      import("../components/panels/AssistantDockPanel").then((module) => ({
        default: module.AssistantDockPanel,
      })),
    ),
  },
  {
    id: EARTH_ENGINE_PANEL_ID,
    title: "Google Earth Engine",
    defaultWidth: 400,
    component: lazy(() =>
      import("../components/panels/EarthEnginePanel").then((module) => ({
        default: module.EarthEnginePanel,
      })),
    ),
  },
  {
    id: DATA_INDONESIA_PANEL_ID,
    title: "Data Indonesia",
    defaultWidth: 360,
    component: lazy(() =>
      import("../components/panels/DataIndonesiaPanel").then((module) => ({ default: module.DataIndonesiaPanel })),
    ),
  },
  {
    id: KOBO_PANEL_ID,
    title: "KoboToolbox",
    defaultWidth: 360,
    component: lazy(() =>
      import("../components/panels/KoboPanel").then((module) => ({ default: module.KoboPanel })),
    ),
  },
  {
    id: SDM_PANEL_ID,
    title: "Species Distribution Modeling",
    defaultWidth: 380,
    component: lazy(() =>
      import("../components/panels/SdmPanel").then((module) => ({ default: module.SdmPanel })),
    ),
  },
];

export function getNativePanel(id: string | null | undefined): NativePanel | undefined {
  return id ? NATIVE_PANELS.find((panel) => panel.id === id) : undefined;
}

/** Open a native panel in the right sidebar. */
export function openNativePanel(id: string): void {
  openRightPanel(id);
}

// The Live MCP Bridge opens the assistant dock when the AI talks to the user.
if (typeof window !== "undefined") {
  window.__glbOpenDock = () => openRightPanel(ASSISTANT_PANEL_ID);
}
