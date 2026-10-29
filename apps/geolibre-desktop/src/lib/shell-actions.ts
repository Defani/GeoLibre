// Defani edition: shell helpers the native panels reuse (adding files and
// rasters to the map the same way a drop does). DesktopShell publishes them.

import type { DroppedRaster } from "./file-io/raster-photo-files";

export interface ShellActions {
  addFilePath: (path: string) => Promise<string | null>;
  addDroppedRasters: (rasters: DroppedRaster[]) => Promise<number>;
  /** The plugin-style app API bound to the live map engine. */
  getAppApi: () => unknown;
}

let actions: ShellActions | null = null;

export function publishShellActions(next: ShellActions): void {
  actions = next;
}

export function getShellActions(): ShellActions | null {
  return actions;
}
