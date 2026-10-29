import {
  closeEarthEnginePanel,
  isEarthEngineAvailable,
  isEarthEnginePanelVisible,
  openEarthEnginePanel,
} from "@geolibre/plugins";
import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openExternalLink } from "../../lib/open-external";
import { getShellActions } from "../../lib/shell-actions";

type AppApi = Parameters<typeof openEarthEnginePanel>[0];

/** Google Earth Engine's mark, drawn small for the dock header. */
function EarthEngineMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <circle cx="12" cy="12" r="9.5" fill="#e8f0fe" stroke="#1a73e8" strokeWidth="1.3" />
      <path d="M5 9.5c3-1 5 1.5 8 .5s4-3 6-2.5M4.5 14c3 1.5 6-1 9 0s4.5 2.5 6 1.5" fill="none" stroke="#34a853" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16.5" cy="7.5" r="1.6" fill="#fbbc04" />
    </svg>
  );
}

/**
 * Google Earth Engine dock (Defani edition): the Earth Engine control — sign
 * in, project, asset / script input, visualization and its layer list — runs
 * as a native right-dock panel instead of floating over the map.
 */
export function EarthEnginePanel() {
  const slotRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    const api = getShellActions()?.getAppApi() as AppApi | undefined;
    if (!api) return;
    if (!isEarthEngineAvailable()) {
      setState("unavailable");
      return;
    }
    // The control's toggle button and its panel (which MapLibre places over
    // the map) both move into the dock.
    const adopt = () => {
      const slot = slotRef.current;
      if (!slot) return;
      for (const selector of [".geolibre-earth-engine-control", ".plugin-control-panel.earth-engine-panel"]) {
        const element = document.querySelector<HTMLElement>(selector);
        if (element && element.parentElement !== slot) {
          slot.appendChild(element);
          setState("ready");
        }
      }
    };
    const observer = new MutationObserver(adopt);
    observer.observe(document.body, { childList: true, subtree: true });
    if (!isEarthEnginePanelVisible()) void openEarthEnginePanel(api);
    adopt();
    return () => {
      observer.disconnect();
      // Closing the dock closes the control (MapLibre removes its element).
      closeEarthEnginePanel(api);
    };
  }, []);

  return (
    <section aria-label="Google Earth Engine" className="ee-dock flex h-full min-h-0 flex-col bg-card text-[12.5px]">
      <header className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
        <EarthEngineMark />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">Google Earth Engine</h2>
          <p className="truncate text-[11px] text-muted-foreground">Planetary-scale imagery and analysis</p>
        </div>
        <button
          type="button"
          title="Open the Earth Engine Code Editor"
          aria-label="Open the Earth Engine Code Editor"
          className="rounded p-1 hover:bg-accent"
          onClick={() => void openExternalLink("https://code.earthengine.google.com/")}
        >
          <ExternalLink className="h-4 w-4" />
        </button>
      </header>
      {state === "unavailable" ? (
        <p className="m-3 rounded border border-amber-300 bg-amber-50 p-2 text-amber-800">
          Earth Engine is not available in this build.
        </p>
      ) : null}
      {state === "loading" ? (
        <p className="m-3 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading Earth Engine…
        </p>
      ) : null}
      <div ref={slotRef} className="min-h-0 flex-1 overflow-auto" />
    </section>
  );
}
