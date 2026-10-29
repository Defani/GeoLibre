// ArcGIS Pro-style Layout ribbon (Defani edition). While Layout View is open,
// the composer's own tools move into GeoLibre's header, beside Project /
// Settings / Help, arranged in captioned groups (Map Frames, Map Surrounds,
// Graphics and Text, ...) with a label under each icon. The composer builds its
// toolbar once, so moving the buttons keeps their listeners; everything goes
// back to where it came from when Layout View closes.

interface RibbonGroup {
  caption: string;
  items: Array<[selector: string, label: string]>;
}

const GROUPS: RibbonGroup[] = [
  { caption: "File", items: [[".glc-mainmenu", "Menu"], [".glc-layoutpick", ""]] },
  { caption: "History", items: [['.glc-ibtn[title^="Undo"]', "Undo"], ['.glc-ibtn[title^="Redo"]', "Redo"]] },
  {
    caption: "Navigate",
    items: [['[data-tool="select"]', "Select"], ['[data-tool="pan"]', "Pan"], ['[data-tool="content"]', "Map Content"]],
  },
  { caption: "Map Frames", items: [['[data-tool="map"]', "Map Frame"], ['[data-tool="inset"]', "Inset"]] },
  {
    caption: "Map Surrounds",
    items: [
      ['[data-tool="legend"]', "Legend"],
      ['[data-tool="north"]', "North Arrow"],
      ['.glc-ins[data-tools^="scalebar"]', "Scale Bar"],
      ['[data-tool="colorbar"]', "Color Bar"],
    ],
  },
  {
    caption: "Graphics and Text",
    items: [
      ['.glc-ins[data-tools^="title"]', "Text"],
      ['.glc-ins[data-tools^="shape"]', "Shape"],
      ['.glc-ins[data-tools^="pen"]', "Draw"],
      ['.glc-ins[data-tools^="image"]', "Picture"],
      ['.glc-ins[data-tools^="marker"]', "Symbol"],
    ],
  },
  { caption: "Data", items: [['.glc-ins[data-tools^="attrtable"]', "Table / Chart"]] },
  { caption: "Zoom", items: [[".glc-zoompill", ""], ['.glc-ibtn[title^="Fit page"]', "Fit Page"]] },
  { caption: "Panes", items: [[".glc-docktog", "Contents"], [".glc-docktog ~ .glc-docktog", "Properties"]] },
  { caption: "Share", items: [['.glc-ibtn[title^="Save layout"]', "Save"], [".glc-exportbtn", "Export"]] },
];

const SHOW_ICONS: Record<string, string> = {
  rulers:
    '<svg viewBox="0 0 24 24" fill="none" stroke-linejoin="round"><path d="M3 3h18v5H8v13H3Z" fill="#fde7c7" stroke="#a36a00" stroke-width="1.3"/><path d="M7 3v2.5M11 3v2.5M15 3v2.5M19 3v2.5M3 11h2.5M3 15h2.5M3 19h2.5" stroke="#a36a00" stroke-width="1.2"/></svg>',
  guides:
    '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="1.5" fill="#fff" stroke="#8b95a3" stroke-width="1.2"/><path d="M9 2v20M2 15h20" stroke="#2f7fd6" stroke-width="1.4" stroke-dasharray="2 1.6"/></svg>',
  grid:
    '<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="3.5" width="17" height="17" rx="1.5" fill="#e7f0fb" stroke="#2f7fd6" stroke-width="1.2"/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" stroke="#2f7fd6" stroke-width="1"/></svg>',
  snap:
    '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4Z" fill="#fde8e8" stroke="#d64545" stroke-width="1.3"/><path d="M6 7.5h4M14 7.5h4" stroke="#d64545" stroke-width="1.3"/></svg>',
};

/**
 * The "Show" group: View-menu style check items (with icons) for rulers,
 * guides, grid and snap. Guides / grid / snap drive the composer's own
 * toggles; rulers hide its ruler bars.
 */
function buildShowGroup(composerRoot: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "pro-group";
  const items = document.createElement("div");
  items.className = "pro-items pro-checks";
  const entries: Array<{ id: string; label: string; isOn: () => boolean; toggle: () => void }> = [
    {
      id: "rulers",
      label: "Rulers",
      isOn: () => !composerRoot.classList.contains("no-rulers"),
      toggle: () => composerRoot.classList.toggle("no-rulers"),
    },
    ...(["guides", "grid", "snap"] as const).map((kind) => ({
      id: kind,
      label: kind === "grid" ? "Grid" : kind === "guides" ? "Guides" : "Snap",
      isOn: () => !!composerRoot.querySelector(`.glc-vtog[data-kind="${kind}"].active`),
      toggle: () => composerRoot.querySelector<HTMLElement>(`.glc-vtog[data-kind="${kind}"]`)?.click(),
    })),
  ];
  const buttons = entries.map((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pro-check";
    button.setAttribute("role", "menuitemcheckbox");
    button.innerHTML = `<span class="pro-box"></span>${SHOW_ICONS[entry.id]}<span>${entry.label}</span>`;
    button.addEventListener("click", () => {
      entry.toggle();
      sync();
    });
    items.appendChild(button);
    return { button, entry };
  });
  const sync = () => {
    for (const { button, entry } of buttons) button.setAttribute("aria-checked", String(entry.isOn()));
  };
  sync();
  new MutationObserver(sync).observe(composerRoot, { subtree: true, attributes: true, attributeFilter: ["class"] });
  const caption = document.createElement("div");
  caption.className = "pro-cap";
  caption.textContent = "Show";
  box.append(items, caption);
  return box;
}

interface ComposerMapFrameApi {
  mapFrame?: (action: string, arg?: unknown) => number | null;
  mapFrameLayers?: () => Array<{ id: string; name: string }>;
  activeFrame?: () => string | null;
}
const composerApi = () => (window as unknown as { LayoutComposer?: ComposerMapFrameApi }).LayoutComposer;

const FRAME_ICONS: Record<string, string> = {
  activate: '<svg viewBox="0 0 24 24" fill="none" stroke-linejoin="round"><rect x="3" y="4" width="18" height="15" rx="1.5" fill="#e7f0fb" stroke="#2f7fd6" stroke-width="1.3"/><path d="M12 8v7M8.5 11.5H15.5M12 8l-1.6 1.6M12 8l1.6 1.6M12 15l-1.6-1.6M12 15l1.6-1.6" stroke="#0b5cad" stroke-width="1.3" stroke-linecap="round"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><rect x="3" y="4" width="18" height="15" rx="1.5" fill="#eaf6e6" stroke="#3a9e43" stroke-width="1.3"/><path d="M7 10l3-3 4 4 3-2v7H7Z" fill="#3a9e43" opacity=".7"/><path d="M3 8V4h4M21 8V4h-4M3 15v4h4M21 15v4h-4" stroke="#1f6e27" stroke-width="1.6"/></svg>',
  match: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><circle cx="12" cy="12" r="8.5" fill="#e7f0fb" stroke="#2f7fd6" stroke-width="1.3"/><path d="M7.5 10.5a5 5 0 0 1 8.6-2.3M16.5 13.5a5 5 0 0 1-8.6 2.3" stroke="#0079C1" stroke-width="1.6"/><path d="M16.6 5.6v2.8h-2.8M7.4 18.4v-2.8h2.8" stroke="#0079C1" stroke-width="1.6"/></svg>',
  zin: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5" fill="#fff" stroke="#2f7fd6" stroke-width="1.6"/><path d="M15.5 15.5 20 20" stroke="#2f7fd6" stroke-width="2"/><path d="M7.5 10.5h6M10.5 7.5v6" stroke="#0b5cad" stroke-width="1.6"/></svg>',
  zout: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5" fill="#fff" stroke="#2f7fd6" stroke-width="1.6"/><path d="M15.5 15.5 20 20" stroke="#2f7fd6" stroke-width="2"/><path d="M7.5 10.5h6" stroke="#0b5cad" stroke-width="1.6"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6 4 12l6 6M4.5 12H20" stroke="#5b6573" stroke-width="1.8"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m14 6 6 6-6 6M19.5 12H4" stroke="#5b6573" stroke-width="1.8"/></svg>',
  north: '<svg viewBox="0 0 24 24" fill="none" stroke-linejoin="round"><path d="M12 3 17 20l-5-4-5 4Z" fill="#d23c2f" stroke="#7a1f1f" stroke-width="1.1"/><path d="M12 3v13l-5 4Z" fill="#fff"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="1.5" fill="#fde7c7" stroke="#a36a00" stroke-width="1.3"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="#a36a00" stroke-width="1.5"/></svg>',
};

/**
 * "Map Frame" group (ArcGIS Pro's Map Frame tools): activate the frame to pan /
 * zoom inside it, fit all layers, match the Data View, zoom, previous / next
 * extent, north up, zoom to a layer and a scale box. Acts on the selected map
 * frame, else the first one on the page.
 */
function buildMapFrameGroup(): HTMLElement {
  const box = document.createElement("div");
  box.className = "pro-group pro-mapframe";
  const items = document.createElement("div");
  items.className = "pro-items";
  const scale = document.createElement("input");
  const syncScale = (value: number | null | undefined) => {
    if (value && document.activeElement !== scale) scale.value = String(Math.round(value));
  };
  const run = (action: string, arg?: unknown) => syncScale(composerApi()?.mapFrame?.(action, arg));
  const button = (action: string, label: string, title: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pro-frame-btn";
    b.title = title;
    b.dataset.action = action;
    b.innerHTML = `${FRAME_ICONS[action]}<span>${label}</span>`;
    b.addEventListener("click", () => run(action));
    return b;
  };
  const small = (action: string, label: string, title: string) => {
    const b = button(action, label, title);
    b.classList.add("small");
    return b;
  };
  const stack = (...nodes: HTMLElement[]) => {
    const s = document.createElement("div");
    s.className = "pro-frame-stack";
    s.append(...nodes);
    return s;
  };
  const activate = button("activate", "Activate", "Activate the map frame: drag to pan, scroll to zoom inside it (Esc to finish)");
  items.append(
    activate,
    button("fit", "Fit All", "Zoom the map frame to all visible layers"),
    button("match", "Data View", "Use the current Data View extent in the map frame"),
  );
  const layerSelect = document.createElement("select");
  layerSelect.className = "pro-frame-select";
  layerSelect.title = "Zoom the map frame to a layer";
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const fillLayers = () => {
    const layers = composerApi()?.mapFrameLayers?.() ?? [];
    layerSelect.innerHTML = `<option value="">Zoom to layer…</option>${layers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("")}`;
  };
  layerSelect.addEventListener("mousedown", fillLayers);
  layerSelect.addEventListener("focus", fillLayers);
  layerSelect.addEventListener("change", () => {
    if (layerSelect.value) run("layer", layerSelect.value);
    layerSelect.value = "";
  });
  fillLayers();
  scale.type = "number";
  scale.min = "1";
  scale.step = "1000";
  scale.className = "pro-frame-scale";
  scale.placeholder = "Scale";
  scale.title = "Map frame scale 1 : n (Enter to apply)";
  scale.addEventListener("keydown", (e) => {
    if (e.key === "Enter") run("scale", Number(scale.value));
  });
  const scaleRow = document.createElement("label");
  scaleRow.className = "pro-frame-scalerow";
  const scaleLabel = document.createElement("span");
  scaleLabel.textContent = "1 :";
  scaleRow.append(scaleLabel, scale);
  items.append(
    stack(small("zin", "Zoom In", "Zoom the map frame in"), small("zout", "Zoom Out", "Zoom the map frame out"), small("north", "North Up", "Rotate the map frame to north up")),
    stack(small("prev", "Previous", "Previous map frame extent"), small("next", "Next", "Next map frame extent"), small("lock", "Lock Scale", "Lock / unlock the map frame scale")),
    stack(layerSelect, scaleRow),
  );
  // Show which frame is active and keep the scale box current.
  const tick = window.setInterval(() => {
    const api = composerApi();
    activate.classList.toggle("on", !!api?.activeFrame?.());
    if (document.activeElement !== scale && api?.mapFrame && document.contains(box)) {
      const lc = (window as unknown as { LayoutComposer?: { hasMapFrame?: () => boolean } }).LayoutComposer;
      if (lc?.hasMapFrame?.()) syncScale(api.mapFrame("scaleOf"));
    }
  }, 800);
  box.addEventListener("pro-dispose", () => window.clearInterval(tick));
  const caption = document.createElement("div");
  caption.className = "pro-cap";
  caption.textContent = "Map Frame";
  box.append(items, caption);
  return box;
}

/** Build the ribbon in `header`; returns a function that puts everything back. */
export function mountLayoutRibbon(composerRoot: HTMLElement, header: HTMLElement): () => void {
  const moved: Array<{ el: Element; parent: Node; next: Node | null; label: string | null }> = [];
  const ribbon = document.createElement("div");
  ribbon.className = "pro-ribbon";
  const docktogs = [...composerRoot.querySelectorAll<HTMLElement>(".glc-docktog")];
  for (const group of GROUPS) {
    const box = document.createElement("div");
    box.className = "pro-group";
    const items = document.createElement("div");
    items.className = "pro-items";
    for (const [selector, label] of group.items) {
      const el =
        selector === ".glc-docktog"
          ? docktogs[0]
          : selector === ".glc-docktog ~ .glc-docktog"
            ? docktogs[1]
            : composerRoot.querySelector(selector);
      if (!el || !el.parentNode) continue;
      moved.push({ el, parent: el.parentNode, next: el.nextSibling, label: el.getAttribute("data-pro-label") });
      if (label) el.setAttribute("data-pro-label", label);
      items.appendChild(el);
    }
    if (!items.children.length) continue;
    const caption = document.createElement("div");
    caption.className = "pro-cap";
    caption.textContent = group.caption;
    box.append(items, caption);
    ribbon.appendChild(box);
    if (group.caption === "Map Frames") ribbon.appendChild(buildMapFrameGroup());
  }
  ribbon.appendChild(buildShowGroup(composerRoot));
  // Before the header's right-hand cluster (theme switch), not after it.
  const rightCluster = header.querySelector(":scope > .ms-auto");
  header.insertBefore(ribbon, rightCluster);
  composerRoot.classList.add("pro-ribbon-host");
  return () => {
    for (const { el, parent, next, label } of moved.reverse()) {
      if (label === null) el.removeAttribute("data-pro-label");
      parent.insertBefore(el, next && next.parentNode === parent ? next : null);
    }
    ribbon.querySelectorAll(".pro-mapframe").forEach((g) => g.dispatchEvent(new Event("pro-dispose")));
    ribbon.remove();
    composerRoot.classList.remove("pro-ribbon-host");
  };
}
