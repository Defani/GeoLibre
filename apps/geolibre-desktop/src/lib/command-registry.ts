// Command registry (Defani edition): the toolbar publishes every command it
// allows (menus, palette and processing tools) so other surfaces, like the
// ArcGIS Pro-style ribbon, run exactly the same handlers by id.

import { create } from "zustand";
import type { Command } from "./commands";

interface CommandRegistryState {
  commands: Command[];
  setCommands: (commands: Command[]) => void;
}

export const useCommandRegistry = create<CommandRegistryState>((set) => ({
  commands: [],
  setCommands: (commands) => set({ commands }),
}));

/** Run a published command; returns false when it is not available. */
export function runCommand(id: string): boolean {
  const command = useCommandRegistry.getState().commands.find((c) => c.id === id);
  if (!command) return false;
  command.run();
  return true;
}

let openPalette: (() => void) | null = null;

export function publishCommandPalette(open: () => void): void {
  openPalette = open;
}

/** Open the command palette (Command Search). */
export function openCommandSearch(): void {
  openPalette?.();
}

let openRecent: ((path: string) => void) | null = null;

export function publishOpenRecent(open: (path: string) => void): void {
  openRecent = open;
}

/** Open a project from the recent list (Project tab). */
export function openRecentProject(path: string): void {
  openRecent?.(path);
}
