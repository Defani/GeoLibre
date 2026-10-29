// Built-in features made from Defani's own GeoLibre plugins (Defani edition):
// the iNaturalist Extractor and the Live MCP Bridge. Their modules are vendored
// under public/vendor/ and activated at startup with the app API, so they are
// part of the app rather than installable plugins. Their floating map buttons
// are hidden (index.css); they open from the dock rail, Toolbox and the header.

import { openRightPanel } from "@geolibre/plugins/right-panel-registry";
import { getPluginManager } from "../hooks/usePlugins";
import { isTauri } from "./is-tauri";

/** The right-panel id the iNaturalist Extractor registers. */
export const INATURALIST_PANEL_ID = "geolibre-inaturalist-extractor-panel";
/** The floating-panel id the Live MCP Bridge registers. */
export const LIVE_BRIDGE_PANEL_ID = "geolibre-live-bridge-panel";

interface BuiltinPlugin {
  activate: (app: unknown) => void;
  deactivate: (app: unknown) => void;
}

const BUILTINS = [
  { id: "geolibre-inaturalist-extractor", dir: "inaturalist" },
  { id: "geolibre-live-bridge", dir: "live-bridge" },
  { id: "geolibre-kobo-connector", dir: "kobo" },
] as const;

const active = new Map<string, { app: unknown; plugin: BuiltinPlugin }>();
let loading: Promise<void> | null = null;

/**
 * Public KoboToolbox servers. kf.kobotoolbox.org sends no CORS header for the
 * app origin, so the WebView `fetch` fails; these hosts go through Tauri's
 * native HTTP client instead. Keep in sync with the `http:default` scope in
 * src-tauri/capabilities/default.json. A self-hosted server keeps browser fetch.
 */
const KOBO_NATIVE_HOSTS = new Set([
  "kf.kobotoolbox.org",
  "kc.kobotoolbox.org",
  "eu.kobotoolbox.org",
  "kc-eu.kobotoolbox.org",
  "kobo.humanitarianresponse.info",
  "kc.humanitarianresponse.info",
]);

/**
 * The Kobo Connector looks for `window.__TAURI__.http.fetch` (the app does not
 * enable `withGlobalTauri`), so hand it a fetch that routes Kobo hosts natively.
 */
async function installKoboNativeFetch(): Promise<void> {
  if (!isTauri()) return;
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  const koboFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (KOBO_NATIVE_HOSTS.has(new URL(href).host)) return tauriFetch(input, init);
    } catch {
      // Unparseable URL: let the browser fetch report it.
    }
    return globalThis.fetch(input, init);
  };
  const w = window as unknown as { __TAURI__?: Record<string, unknown> };
  w.__TAURI__ = { ...w.__TAURI__, http: { ...(w.__TAURI__?.http as object), fetch: koboFetch } };
}

async function activateOne(id: string, dir: string, appApi: unknown): Promise<void> {
  const current = active.get(id);
  if (current?.app === appApi) return;
  // An older installed copy of the same plugin would run twice: turn it off.
  const manager = getPluginManager();
  if (manager.isActive(id)) {
    try {
      manager.deactivate(id, appApi as Parameters<typeof manager.deactivate>[1]);
    } catch (error) {
      console.warn(`[built-in] could not turn off the installed ${id}`, error);
    }
  }
  const base = `${import.meta.env.BASE_URL ?? "/"}vendor/${dir}/`;
  if (!document.querySelector(`link[data-builtin="${dir}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${base}style.css`;
    link.dataset.builtin = dir;
    document.head.appendChild(link);
  }
  if (dir === "kobo") await installKoboNativeFetch();
  const module = (await import(/* @vite-ignore */ `${base}index.js`)) as { plugin: BuiltinPlugin };
  if (current) current.plugin.deactivate(current.app);
  module.plugin.activate(appApi);
  active.set(id, { app: appApi, plugin: module.plugin });
}

/** Activate every built-in feature for the current map engine. */
export function activateINaturalist(appApi: { getMap?: () => unknown }): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    for (const builtin of BUILTINS) {
      try {
        await activateOne(builtin.id, builtin.dir, appApi);
      } catch (error) {
        console.error(`[built-in] ${builtin.id} could not start`, error);
      }
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** Open the iNaturalist Extractor in the right sidebar. */
export function openINaturalist(): void {
  openRightPanel(INATURALIST_PANEL_ID);
}
