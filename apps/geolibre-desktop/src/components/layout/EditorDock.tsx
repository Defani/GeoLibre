import { getGeometryEditTargetLayerId, subscribeGeometryEdit } from "@geolibre/plugins";
import { useAppStore } from "@geolibre/core";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getEditorActions } from "../../lib/editor-actions";

/**
 * ArcMap-style docked Editor toolbar (Defani edition). The geometry editor is a
 * MapLibre control that would float over the map; while a session is open its
 * toolbar is moved into the header, laid out in one row,
 * with Save / Stop Editing at the end. Nothing floats on the Data View map.
 */
export function EditorDock() {
  const editingLayerId = useSyncExternalStore(subscribeGeometryEdit, getGeometryEditTargetLayerId);
  const layerName = useAppStore((s) => s.layers.find((l) => l.id === editingLayerId)?.name);
  const slotRef = useRef<HTMLDivElement>(null);

  // While editing, the header menus shrink to icons so the whole Editor
  // toolbar fits beside them (see index.css).
  useEffect(() => {
    if (editingLayerId) document.documentElement.dataset.editing = "true";
    else delete document.documentElement.dataset.editing;
  }, [editingLayerId]);

  useEffect(() => {
    const adopt = () => {
      const slot = slotRef.current;
      const control = document.querySelector<HTMLElement>(".geo-editor-control");
      if (slot && control && control.parentElement !== slot) slot.appendChild(control);
    };
    adopt();
    const observer = new MutationObserver(adopt);
    observer.observe(document.body, { childList: true, subtree: true });
    const slot = slotRef.current;
    return () => {
      observer.disconnect();
      // Hand the control back to the map if this dock unmounts mid-session,
      // so React removing the slot does not drop the live editor toolbar.
      const control = slot?.querySelector(".geo-editor-control");
      const home = document.querySelector(".maplibregl-ctrl-top-left");
      if (control && home) home.appendChild(control);
    };
  }, []);

  return (
    <div
      className={`editor-dock ms-1 shrink-0 items-center gap-1.5 border-s ps-2 ${editingLayerId ? "flex" : "hidden"}`}
      role="toolbar"
      aria-label="Editor"
    >
      <span className="max-w-28 shrink-0 truncate text-[11px] text-muted-foreground" title={`Editing ${layerName ?? ""}`}>
        {layerName}
      </span>
      <div ref={slotRef} className="shrink-0" />
      <button
        type="button"
        title="Save Edits & Stop Editing"
        aria-label="Save Edits & Stop Editing"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border bg-background hover:bg-accent"
        onClick={() => editingLayerId && void getEditorActions()?.toggle(editingLayerId)}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden>
          <path d="M2.5 2.5h9l2 2v9h-11Z" fill="#9cc8f2" />
          <path d="M5 2.5v4h5v-4M5 13.5v-4h6v4" />
        </svg>
      </button>
      <button
        type="button"
        title="Discard Edits"
        aria-label="Discard Edits"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm hover:bg-accent"
        onClick={() => getEditorActions()?.cancel()}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" stroke="#d64545" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
