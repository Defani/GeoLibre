import { useEffect } from "react";
import { registerRightPanel } from "@geolibre/plugins/right-panel-registry";
import { NATIVE_PANELS } from "../lib/native-panels";

/**
 * Register the native right-dock panels (Defani edition) on the Style rail.
 * Their React bodies are portalled into the shell's shared native host.
 */
export function useRegisterNativePanels(): void {
  useEffect(() => {
    const unregister = NATIVE_PANELS.map((panel) =>
      registerRightPanel({
        id: panel.id,
        title: () => panel.title,
        dock: "replace-style",
        defaultWidth: panel.defaultWidth,
        render: () => {},
      }),
    );
    return () => {
      for (const dispose of unregister) dispose?.();
    };
  }, []);
}
