import { useEffect } from "react";
import { registerRightPanel } from "@geolibre/plugins/right-panel-registry";
import { PROCESSING_TOOLBOX_PANEL_ID } from "../lib/processing-toolbox";

/**
 * Register the Processing Toolbox (Defani edition) as a dockable right panel on
 * the Style rail. It joins the rail when opened from the Processing toolbar
 * button; its React body is portalled into a dedicated host by the shell.
 */
export function useRegisterProcessingToolbox(): void {
  useEffect(
    () =>
      registerRightPanel({
        id: PROCESSING_TOOLBOX_PANEL_ID,
        title: () => "Toolbox",
        dock: "replace-style",
        defaultWidth: 340,
        render: () => {},
      }),
    [],
  );
}
