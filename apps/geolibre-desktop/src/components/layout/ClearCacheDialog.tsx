import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@geolibre/ui";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { create } from "zustand";

/** Open state of the Clear Cache dialog (Defani edition). */
export const useClearCacheDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export const openClearCacheDialog = () => useClearCacheDialog.getState().setOpen(true);

type CacheKind = "tiles" | "session" | "history";

/** Two-tone icons in the app's toolbar style. */
const Ico = ({ children, size = 28 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} fill="none" strokeLinejoin="round" strokeLinecap="round" aria-hidden className="shrink-0">
    {children}
  </svg>
);

/** A broom sweeping a map sheet: the dialog's own icon. */
export const ClearCacheIcon = ({ size = 28 }: { size?: number }) => (
  <Ico size={size}>
    <path d="M4 9l7-3 7 3 7-3v15l-7 3-7-3-7 3Z" fill="#e7f0fb" stroke="#2f7fd6" strokeWidth="1.4" />
    <path d="M11 6v15M18 9v15" stroke="#2f7fd6" strokeWidth="1.1" />
    <path d="M27 3 17.5 17.5" stroke="#8a5a2b" strokeWidth="2.2" />
    <path d="M14.5 16.5l5.5 3.5-2.5 6-7.5-5Z" fill="#f2b630" stroke="#a36a00" strokeWidth="1.2" />
    <path d="M12.6 21.6 9.5 24.4M15 23.4l-2.4 3.3M17.4 24.6l-1.5 3.6" stroke="#a36a00" strokeWidth="1.1" />
    <circle cx="6" cy="26" r="1.1" fill="#9cc8f2" />
    <circle cx="9" cy="28.5" r="0.8" fill="#9cc8f2" />
  </Ico>
);

const ICONS: Record<CacheKind, ReactNode> = {
  tiles: (
    <Ico>
      <rect x="4" y="4" width="11" height="11" rx="1.5" fill="#9cc8f2" stroke="#2f7fd6" strokeWidth="1.3" />
      <rect x="17" y="4" width="11" height="11" rx="1.5" fill="#b9dca0" stroke="#3ea044" strokeWidth="1.3" />
      <rect x="4" y="17" width="11" height="11" rx="1.5" fill="#b9dca0" stroke="#3ea044" strokeWidth="1.3" />
      <rect x="17" y="17" width="11" height="11" rx="1.5" fill="#f9d98a" stroke="#c98a00" strokeWidth="1.3" />
      <path d="M22.5 19.5v6M19.5 22.8l3 3 3-3" stroke="#c98a00" strokeWidth="1.5" />
    </Ico>
  ),
  session: (
    <Ico>
      <rect x="4" y="6" width="24" height="20" rx="2.5" fill="#efe3fb" stroke="#8a5cc7" strokeWidth="1.3" />
      <path d="M4 11h24" stroke="#8a5cc7" strokeWidth="1.3" />
      <circle cx="16" cy="19" r="5" fill="#fff" stroke="#8a5cc7" strokeWidth="1.3" />
      <path d="M16 16.5V19l2 1.4" stroke="#8a5cc7" strokeWidth="1.4" />
    </Ico>
  ),
  history: (
    <Ico>
      <path d="M8 5h12l5 5v17H8Z" fill="#fde8e8" stroke="#d64545" strokeWidth="1.3" />
      <path d="M20 5v5h5" stroke="#d64545" strokeWidth="1.3" />
      <path d="M5.5 15.5a8 8 0 1 0 2.3-5.7" stroke="#d64545" strokeWidth="1.5" />
      <path d="M5 7.5v3.8h3.8" stroke="#d64545" strokeWidth="1.5" />
      <path d="M13.5 13.5v4l2.6 1.6" stroke="#d64545" strokeWidth="1.4" />
    </Ico>
  ),
};

const OPTIONS: Array<{ id: CacheKind; label: string; detail: string; defaultOn: boolean }> = [
  {
    id: "tiles",
    label: "Map tiles and downloaded files",
    detail: "Basemap and layer tiles, fonts and other files kept for faster loading. They download again when needed.",
    defaultOn: true,
  },
  {
    id: "session",
    label: "Session data",
    detail: "Temporary data of this session (open dialogs, scratch values). Projects and settings are kept.",
    defaultOn: true,
  },
  {
    id: "history",
    label: "Project history snapshots",
    detail: "Saved versions in Project › History. This cannot be undone.",
    defaultOn: false,
  },
];

async function usageMb(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.usage != null ? estimate.usage / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

async function clearCaches(kinds: Set<CacheKind>): Promise<void> {
  if (kinds.has("tiles")) {
    if ("caches" in window) {
      for (const key of await caches.keys()) await caches.delete(key);
    }
    try {
      const maplibre = (await import("maplibre-gl")) as unknown as { default?: { clearStorage?: (cb?: () => void) => void }; clearStorage?: (cb?: () => void) => void };
      const clearStorage = maplibre.clearStorage ?? maplibre.default?.clearStorage;
      await new Promise<void>((resolve) => (clearStorage ? clearStorage(() => resolve()) : resolve()));
    } catch {
      // MapLibre's tile storage is optional; the Cache API sweep above covers it.
    }
  }
  if (kinds.has("session")) sessionStorage.clear();
  if (kinds.has("history")) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("geolibre-project-history");
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
}

/** Help › Clear Cache: frees the app's cached storage. */
export function ClearCacheDialog() {
  const { open, setOpen } = useClearCacheDialog();
  const [selected, setSelected] = useState<Set<CacheKind>>(
    () => new Set(OPTIONS.filter((o) => o.defaultOn).map((o) => o.id)),
  );
  const [before, setBefore] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    void usageMb().then(setBefore);
  }, [open]);

  const run = async () => {
    setBusy(true);
    try {
      await clearCaches(selected);
      const after = await usageMb();
      const freed = before != null && after != null ? Math.max(0, before - after) : null;
      setResult(freed != null ? `Done. Freed about ${freed.toFixed(1)} MB.` : "Done.");
      setBefore(after);
    } catch (error) {
      setResult(`Could not clear everything: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <ClearCacheIcon size={34} />
            <span>Clear Cache</span>
          </DialogTitle>
          <DialogDescription>
            {before != null ? `The app's stored data uses about ${before.toFixed(1)} MB.` : "Free the app's cached data."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {OPTIONS.map((option) => (
            <label
              key={option.id}
              className={`flex cursor-pointer items-center gap-3 rounded-md border p-2.5 transition-colors hover:bg-accent/50 ${
                selected.has(option.id) ? "border-primary/50 bg-primary/5" : ""
              }`}
            >
              {ICONS[option.id]}
              <input
                type="checkbox"
                className="order-last h-4 w-4 accent-[#0078d4]"
                checked={selected.has(option.id)}
                onChange={(e) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (e.target.checked) next.add(option.id);
                    else next.delete(option.id);
                    return next;
                  })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className={`block text-xs ${option.id === "history" ? "text-destructive" : "text-muted-foreground"}`}>
                  {option.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
        {result ? <p className="text-sm text-emerald-700">{result}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button onClick={() => void run()} disabled={busy || selected.size === 0} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClearCacheIcon size={18} />}
            Clear
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
