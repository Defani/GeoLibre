// Data View / Layout View (Defani edition), like ArcMap: the workspace shows
// either the map (Data View) or the built-in Layout Composer (Layout View).
// The composer is vendored under public/vendor/layout-composer and loaded on
// first use, then mounted into the map area of the shell.

import { create } from "zustand";

export type WorkspaceView = "data" | "layout";

interface LayoutViewState {
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
}

export const useLayoutViewStore = create<LayoutViewState>((set) => ({
  view: "data",
  setView: (view) => {
    // Layout View takes the whole workspace: the CSS hides the Contents panel,
    // the Manage Layers toolbar and the side docks while this is "layout".
    document.documentElement.dataset.workspaceView = view;
    set({ view });
  },
}));

/** Switch the workspace to the given view. */
export function setWorkspaceView(view: WorkspaceView): void {
  useLayoutViewStore.getState().setView(view);
}

interface ComposerApi {
  mount: (element: HTMLElement) => void;
  unmount: () => void;
}

let composerPromise: Promise<ComposerApi> | null = null;

/**
 * Load the vendored Layout Composer once and start it in embedded mode with the
 * app API (the same API a plugin receives), so its map frames, legends, tables
 * and charts read the live GeoLibre project.
 */
export function loadLayoutComposer(appApi: unknown): Promise<ComposerApi> {
  if (composerPromise) return composerPromise;
  const base = `${import.meta.env.BASE_URL ?? "/"}vendor/layout-composer/`;
  if (!document.querySelector('link[data-layout-composer]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${base}style.css`;
    link.dataset.layoutComposer = "";
    document.head.appendChild(link);
  }
  composerPromise = import(/* @vite-ignore */ `${base}index.js`).then(
    (module: { activateEmbedded: (app: unknown) => ComposerApi }) => module.activateEmbedded(appApi),
  );
  composerPromise.catch(() => {
    composerPromise = null;
  });
  return composerPromise;
}
