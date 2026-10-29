import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

/** KoboToolbox's mark, drawn small for the dock header. */
function KoboMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="#2095f3" />
      <path d="M8 7v10M8 12l6-5M10.5 10.5 15 17" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * KoboToolbox dock (Defani edition): Defani's Kobo Connector (built in, see
 * lib/native-inaturalist.ts) signs in to a KoboToolbox / KoboCollect server,
 * picks a form and its geo field, and maps the submissions — here as a native
 * right-dock panel instead of a floating map button.
 */
export function KoboPanel() {
  const slotRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let panel: HTMLElement | null = null;
    let home: Node | null = null;
    const adopt = () => {
      const slot = slotRef.current;
      const found = document.querySelector<HTMLElement>(".kobo-connector-panel");
      if (!slot || !found || found.parentElement === slot) return;
      if (!found.classList.contains("expanded")) {
        document.querySelector<HTMLElement>(".kobo-connector-toggle")?.click();
      }
      panel = found;
      home = found.parentNode;
      slot.appendChild(found);
      setReady(true);
    };
    const observer = new MutationObserver(adopt);
    observer.observe(document.body, { childList: true, subtree: true });
    adopt();
    return () => {
      observer.disconnect();
      // Hand the panel back to the map (hidden there) so it can be docked again.
      if (panel && home) {
        home.appendChild(panel);
        if (panel.classList.contains("expanded")) {
          document.querySelector<HTMLElement>(".kobo-connector-toggle")?.click();
        }
      }
    };
  }, []);

  return (
    <section aria-label="KoboToolbox" className="kobo-dock flex h-full min-h-0 flex-col bg-card text-[12.5px]">
      <header className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
        <KoboMark />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">KoboToolbox</h2>
          <p className="truncate text-[11px] text-muted-foreground">Field survey submissions as map layers</p>
        </div>
      </header>
      {!ready ? (
        <p className="m-3 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the Kobo connector…
        </p>
      ) : null}
      <div ref={slotRef} className="min-h-0 flex-1 overflow-auto" />
    </section>
  );
}
