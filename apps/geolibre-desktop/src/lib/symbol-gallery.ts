// Symbol gallery (Defani edition): ArcMap-style Symbol Selector content —
// 150+ point, line and fill symbols. Each entry is a LayerStyle patch the
// selector applies to a layer (or to one class of a renderer).

import type { LayerStyle } from "@geolibre/core";

export type SymbolKind = "point" | "line" | "fill";

export interface GallerySymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  group: string;
  tags?: string;
  style: Partial<LayerStyle>;
}

// ---------------------------------------------------------------- SVG icons (24 x 24, drawn in currentColor-free solid fills)
const svg = (body: string, vb = "0 0 24 24") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="48" height="48">${body}</svg>`;
const ICONS: Record<string, [string, string]> = {
  // name: [label, svg body]
  village: ["Village", '<path d="M3 12 12 4l9 8v8H3Z" fill="#c0392b" stroke="#fff" stroke-width="1.2"/><rect x="10" y="14" width="4" height="6" fill="#fff"/>'],
  city: ["City / town", '<rect x="3" y="3" width="18" height="18" fill="#fff" stroke="#000" stroke-width="2"/><circle cx="12" cy="12" r="4.5" fill="#000"/>'],
  capital: ["Capital", '<circle cx="12" cy="12" r="10" fill="#fff" stroke="#c00" stroke-width="2"/><path d="m12 5 2 5h5l-4 3 1.6 5L12 15l-4.6 3L9 13 5 10h5Z" fill="#c00"/>'],
  provcapital: ["Provincial capital", '<circle cx="12" cy="12" r="9" fill="#fff" stroke="#000" stroke-width="2"/><circle cx="12" cy="12" r="5" fill="#c00"/>'],
  mosque: ["Mosque", '<path d="M5 20V12a7 7 0 0 1 14 0v8Z" fill="#1b8a3a"/><path d="M12 2v3" stroke="#1b8a3a" stroke-width="1.6"/><path d="M10.6 3.4a1.6 1.6 0 1 0 2.4 1.4 1.3 1.3 0 1 1-2.4-1.4Z" fill="#1b8a3a"/><rect x="10.5" y="15" width="3" height="5" fill="#fff"/>'],
  church: ["Church", '<path d="M11 2h2v3h3v2h-3v3l6 4v8H5v-8l6-4V7H8V5h3Z" fill="#5b3a8f"/>'],
  temple: ["Temple", '<path d="M12 2 4 8h16Zm-7 7h14v2H5Zm1 3h2v7H6Zm5 0h2v7h-2Zm5 0h2v7h-2ZM4 20h16v2H4Z" fill="#b8860b"/>'],
  school: ["School", '<path d="m12 4 10 5-10 5L2 9Z" fill="#1565c0"/><path d="M6 11v5c3 2.6 9 2.6 12 0v-5l-6 3Z" fill="#1565c0"/>'],
  hospital: ["Hospital / health", '<rect x="2" y="2" width="20" height="20" rx="3" fill="#d32f2f"/><path d="M10 6h4v4h4v4h-4v4h-4v-4H6v-4h4Z" fill="#fff"/>'],
  office: ["Government office", '<path d="M12 2 2 7v2h20V7Zm-8 8h2v8H4Zm5 0h2v8H9Zm4 0h2v8h-2Zm5 0h2v8h-2ZM2 19h20v3H2Z" fill="#37474f"/>'],
  market: ["Market", '<path d="M4 4h16l2 5H2Zm-1 6h18v10H3Z" fill="#e65100"/><rect x="9" y="13" width="6" height="7" fill="#fff"/>'],
  airport: ["Airport", '<circle cx="12" cy="12" r="11" fill="#0d47a1"/><path d="M11 4h2l.5 6 6 3v2l-6-1.5-.5 4 2 1.5v1.5l-3-1-3 1v-1.5l2-1.5-.5-4L4.5 15v-2l6-3Z" fill="#fff"/>'],
  port: ["Seaport / harbour", '<circle cx="12" cy="5" r="2.5" fill="none" stroke="#01579b" stroke-width="2"/><path d="M12 7.5V21M7 11h10M4 15c1 4 4 6 8 6s7-2 8-6" fill="none" stroke="#01579b" stroke-width="2"/>'],
  bridge: ["Bridge", '<path d="M2 9h20v3H2Zm2 3h3v6H4Zm13 0h3v6h-3ZM7 12c2 3 8 3 10 0" fill="#455a64"/>'],
  tower: ["Tower / antenna", '<path d="m12 4-6 18h2.5l1.2-4h4.6l1.2 4H18Zm-1.6 11L12 9.5l1.6 5.5Z" fill="#6d4c41"/><path d="M8 4a6 6 0 0 1 8 0M5.5 1.5a10 10 0 0 1 13 0" fill="none" stroke="#6d4c41" stroke-width="1.4"/>'],
  spring: ["Spring / water source", '<circle cx="12" cy="12" r="10" fill="#e1f5fe" stroke="#0288d1" stroke-width="2"/><path d="M12 5c3 4 5 6 5 9a5 5 0 0 1-10 0c0-3 2-5 5-9Z" fill="#0288d1"/>'],
  well: ["Well", '<circle cx="12" cy="12" r="9" fill="#fff" stroke="#0288d1" stroke-width="2.5"/><circle cx="12" cy="12" r="3.5" fill="#0288d1"/>'],
  waterfall: ["Waterfall", '<path d="M3 4h18v3H3Z" fill="#5d4037"/><path d="M7 7v13M11 7v14M15 7v13M19 7v11" stroke="#0288d1" stroke-width="2"/>'],
  peak: ["Peak / summit", '<path d="M12 3 22 21H2Z" fill="#6d4c41"/><path d="m12 3 3.5 6.3-2-1.3-1.5 2-1.5-2-2 1.3Z" fill="#fff"/>'],
  volcano: ["Volcano", '<path d="m9 8-7 13h20L15 8Z" fill="#5d4037"/><path d="M9 8h6M10 6c0-2 1-3 2-4m2 4c0-2 1-3 2-3M8 5c-1-1-1-2 0-3" stroke="#e53935" stroke-width="1.6" fill="none"/>'],
  cave: ["Cave", '<path d="M2 21c1-9 5-15 10-15s9 6 10 15Z" fill="#5d4037"/><path d="M8 21c0-5 2-8 4-8s4 3 4 8Z" fill="#000"/>'],
  hotspot: ["Fire hotspot", '<path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-7 0 3 1 4 2 4 0-3 0-6 1-9Z" fill="#e53935"/><path d="M12 13c1 2 3 3 3 5a3 3 0 0 1-6 0c0-2 2-3 3-5Z" fill="#ffca28"/>'],
  tree: ["Tree", '<path d="M12 2c4 0 7 3 7 7 0 3-2 5-5 6v7h-4v-7c-3-1-5-3-5-6 0-4 3-7 7-7Z" fill="#2e7d32"/>'],
  conifer: ["Conifer", '<path d="m12 2 6 8h-3l5 7h-6v5h-4v-5H4l5-7H6Z" fill="#1b5e20"/>'],
  palm: ["Oil palm / palm", '<path d="M11 22h2l-.5-12h-1Z" fill="#6d4c41"/><path d="M12 10c-3-4-7-4-10-2 3 0 6 1 10 2Zm0 0c3-4 7-4 10-2-3 0-6 1-10 2Zm0 0c-1-4-4-7-7-7 3 2 5 4 7 7Zm0 0c1-4 4-7 7-7-3 2-5 4-7 7Z" fill="#43a047"/>'],
  mangrove: ["Mangrove", '<path d="M12 2c4 0 6 3 6 6s-3 5-6 5-6-2-6-5 2-6 6-6Z" fill="#1b5e20"/><path d="M12 13v3m0 0-5 6m5-6 5 6m-5-6-2 6m2-6 2 6" stroke="#5d4037" stroke-width="1.6" fill="none"/>'],
  plot: ["Sample plot", '<rect x="3" y="3" width="18" height="18" fill="#fff" stroke="#c62828" stroke-width="2.5"/><path d="M3 3l18 18M21 3 3 21" stroke="#c62828" stroke-width="1.6"/>'],
  sample: ["Sample point", '<circle cx="12" cy="12" r="9" fill="#fff" stroke="#000" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="#000"/>'],
  benchmark: ["Benchmark / triangulation", '<path d="M12 3 22 20H2Z" fill="#fff" stroke="#000" stroke-width="2"/><circle cx="12" cy="14" r="2.5" fill="#000"/>'],
  gcp: ["Ground control point", '<circle cx="12" cy="12" r="8" fill="none" stroke="#d81b60" stroke-width="2"/><path d="M12 1v7m0 8v7M1 12h7m8 0h7" stroke="#d81b60" stroke-width="2"/>'],
  camera: ["Camera trap", '<rect x="3" y="7" width="18" height="13" rx="2" fill="#37474f"/><path d="M8 7l2-3h4l2 3" fill="#37474f"/><circle cx="12" cy="13.5" r="4" fill="#fff"/><circle cx="12" cy="13.5" r="2" fill="#37474f"/>'],
  drone: ["Drone photo point", '<circle cx="5" cy="5" r="3" fill="none" stroke="#263238" stroke-width="1.6"/><circle cx="19" cy="5" r="3" fill="none" stroke="#263238" stroke-width="1.6"/><circle cx="5" cy="19" r="3" fill="none" stroke="#263238" stroke-width="1.6"/><circle cx="19" cy="19" r="3" fill="none" stroke="#263238" stroke-width="1.6"/><path d="M7 7l3 3m4 0 3-3M7 17l3-3m4 0 3 3" stroke="#263238" stroke-width="1.6"/><rect x="9" y="9" width="6" height="6" rx="1.5" fill="#263238"/>'],
  flag: ["Flag / marker", '<path d="M5 2h2v20H5Z" fill="#455a64"/><path d="M7 3h12l-3 4 3 4H7Z" fill="#e53935"/>'],
  warning: ["Hazard / warning", '<path d="M12 2 23 21H1Z" fill="#ffc107" stroke="#000" stroke-width="1.2"/><path d="M11 8h2v7h-2Zm0 9h2v2h-2Z" fill="#000"/>'],
  info: ["Information", '<circle cx="12" cy="12" r="10" fill="#1976d2"/><path d="M11 10h2v8h-2Zm0-4h2v2h-2Z" fill="#fff"/>'],
  camp: ["Camp / post", '<path d="M12 3 2 21h20Z" fill="#8d6e63"/><path d="M12 3v18M9 21l3-6 3 6" stroke="#fff" stroke-width="1.4" fill="none"/>'],
  mine: ["Mine", '<path d="M4 20 15 9m-5-5c4-1 9 1 11 6-3-2-6-3-9-2" stroke="#424242" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M3 21h4" stroke="#424242" stroke-width="2.4"/>'],
  fuel: ["Fuel station", '<rect x="4" y="3" width="10" height="18" rx="1.5" fill="#2e7d32"/><rect x="6" y="6" width="6" height="5" fill="#fff"/><path d="M14 9h3l2 3v6a1.5 1.5 0 0 1-3 0v-4h-2" fill="none" stroke="#2e7d32" stroke-width="1.6"/>'],
  police: ["Police / security post", '<path d="M12 2 4 5v6c0 5 3 9 8 11 5-2 8-6 8-11V5Z" fill="#1a237e"/><path d="m12 7 1.4 3h3.1l-2.5 2 1 3.2L12 13.4l-3 1.8 1-3.2-2.5-2h3.1Z" fill="#ffd600"/>'],
  forestpost: ["Forest ranger post", '<path d="M3 12 12 4l9 8v8H3Z" fill="#1b5e20"/><path d="m12 9 3 5h-2l2 4H9l2-4H9Z" fill="#a5d6a7"/>'],
  nursery: ["Seedling / nursery", '<path d="M12 21v-8" stroke="#2e7d32" stroke-width="2"/><path d="M12 13c0-5-4-7-8-7 0 4 3 7 8 7Zm0-1c0-4 3-6 7-6 0 4-3 6-7 6Z" fill="#43a047"/><path d="M6 21h12" stroke="#6d4c41" stroke-width="2"/>'],
  birds: ["Wildlife sighting", '<path d="M2 10c3-3 6-3 8 0 2-3 5-3 8 0-3-1-5 0-8 3-3-3-5-4-8-3Z" fill="#37474f"/><circle cx="16" cy="17" r="4" fill="#8d6e63"/>'],
};

const icon = (key: string) => svg(ICONS[key][1]);

// ---------------------------------------------------------------- fill textures (tileable SVG, 32 x 32)
const tex = (body: string, bg = "none") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${bg !== "none" ? `<rect width="32" height="32" fill="${bg}"/>` : ""}${body}</svg>`;
const TEXTURES: Array<[string, string, string, string]> = [
  // id, name, group, svg
  ["forest", "Forest (trees)", "Vegetation", tex('<path d="m8 4 5 8H3Zm16 12 5 8H19Z" fill="#1b5e20"/><path d="M8 12v3m16 9v3" stroke="#5d4037" stroke-width="1.5"/>', "#c8e6c9")],
  ["secondary-forest", "Secondary forest", "Vegetation", tex('<circle cx="8" cy="8" r="4" fill="#43a047"/><circle cx="24" cy="24" r="4" fill="#43a047"/>', "#dcedc8")],
  ["mangrove", "Mangrove", "Vegetation", tex('<circle cx="10" cy="9" r="4" fill="#1b5e20"/><path d="M10 13v3m0 0-3 4m3-4 3 4" stroke="#5d4037" stroke-width="1.2" fill="none"/><circle cx="26" cy="25" r="3" fill="#1b5e20"/>', "#b2dfdb")],
  ["swamp", "Swamp / marsh", "Wetland", tex('<path d="M3 10h8M5 13h4M19 26h8M21 29h4" stroke="#0277bd" stroke-width="1.4"/><path d="M7 10V5m-2 5-1-4m5 4 1-4M23 26v-5m-2 5-1-4m5 4 1-4" stroke="#2e7d32" stroke-width="1.2"/>', "#e0f2f1")],
  ["peat", "Peat (gambut)", "Wetland", tex('<path d="M2 8h10M18 8h12M8 18h14M2 28h8M16 28h14" stroke="#5d4037" stroke-width="1.6"/>', "#efebe9")],
  ["paddy", "Rice paddy (sawah)", "Agriculture", tex('<path d="M4 4v8M8 4v8M20 18v8M24 18v8" stroke="#558b2f" stroke-width="1.3"/><path d="M2 13h12M18 27h12" stroke="#0288d1" stroke-width="1.2"/>', "#f1f8e9")],
  ["plantation", "Plantation (rows)", "Agriculture", tex('<circle cx="8" cy="8" r="3" fill="#2e7d32"/><circle cx="24" cy="8" r="3" fill="#2e7d32"/><circle cx="8" cy="24" r="3" fill="#2e7d32"/><circle cx="24" cy="24" r="3" fill="#2e7d32"/>', "#f9fbe7")],
  ["oilpalm", "Oil palm", "Agriculture", tex('<path d="M8 12V6m0 0-5-2m5 2 5-2M8 6 4 9m4-3 4 3M24 28v-6m0 0-5-2m5 2 5-2m-5 2-4 3m4-3 4 3" stroke="#388e3c" stroke-width="1.4" fill="none"/>', "#f3e5f5")],
  ["dryfield", "Dry field (tegalan)", "Agriculture", tex('<path d="M3 6l4 4 4-4M19 22l4 4 4-4" stroke="#8d6e63" stroke-width="1.4" fill="none"/>', "#fff8e1")],
  ["shrub", "Shrub / bush (semak)", "Vegetation", tex('<path d="M4 12c1-4 6-4 7 0M20 28c1-4 6-4 7 0" stroke="#689f38" stroke-width="1.6" fill="none"/>', "#f1f8e9")],
  ["grass", "Grassland (savana)", "Vegetation", tex('<path d="M6 12V6M4 12l-2-4M8 12l2-4M22 28v-6m-2 6-2-4m6 4 2-4" stroke="#7cb342" stroke-width="1.2"/>', "#f9fbe7")],
  ["sand", "Sand / beach", "Bare", tex('<circle cx="5" cy="6" r="1"/><circle cx="14" cy="11" r="1"/><circle cx="25" cy="5" r="1"/><circle cx="9" cy="20" r="1"/><circle cx="21" cy="17" r="1"/><circle cx="28" cy="26" r="1"/><circle cx="16" cy="28" r="1"/>'.replace(/<circle/g, '<circle fill="#a1887f"'), "#fff3e0")],
  ["rock", "Rock / outcrop", "Bare", tex('<path d="M3 13 8 5l5 8Zm16 16 5-8 5 8Z" fill="none" stroke="#616161" stroke-width="1.4"/>', "#eeeeee")],
  ["bare", "Bare soil", "Bare", tex('<path d="M2 30 30 2" stroke="#a1887f" stroke-width="1"/>', "#efebe9")],
  ["urban", "Built-up (bricks)", "Built-up", tex('<path d="M0 8h32M0 24h32M8 0v8M24 8v16M8 24v8" stroke="#c62828" stroke-width="1.2"/>', "#ffebee")],
  ["industry", "Industry", "Built-up", tex('<path d="M2 26V14l7 5v-5l7 5v-5l7 5V6h4v20Z" fill="#9e9e9e"/>', "#fafafa")],
  ["mining", "Mining area", "Built-up", tex('<path d="M4 14 14 4m-6-1c3-1 6 0 8 3-2-1-4-2-6-1M20 30 30 20" stroke="#424242" stroke-width="1.6" fill="none"/>', "#fbe9e7")],
  ["water", "Water (waves)", "Water", tex('<path d="M0 8c4-3 8 3 12 0s8 3 12 0 8 3 8 0M0 24c4-3 8 3 12 0s8 3 12 0 8 3 8 0" stroke="#0277bd" stroke-width="1.3" fill="none"/>', "#e1f5fe")],
  ["fishpond", "Fishpond / aquaculture (tambak)", "Water", tex('<rect x="2" y="2" width="12" height="12" fill="none" stroke="#0277bd" stroke-width="1.2"/><rect x="18" y="18" width="12" height="12" fill="none" stroke="#0277bd" stroke-width="1.2"/>', "#b3e5fc")],
  ["flood", "Flood-prone", "Water", tex('<path d="M0 32 32 0M-8 24 24-8M8 40 40 8" stroke="#0288d1" stroke-width="1.6"/>', "none")],
  ["burnt", "Burnt area", "Hazard", tex('<path d="M8 3c1 3 4 4 4 8a4 4 0 0 1-8 0c0-2 2-4 4-8Zm16 16c1 3 4 4 4 8a4 4 0 0 1-8 0c0-2 2-4 4-8Z" fill="#e53935" opacity=".7"/>', "#3e2723")],
  ["cloud", "Cloud / no data", "Other", tex('<path d="M6 12a4 4 0 0 1 7-3 3 3 0 0 1 5 2 3 3 0 0 1-1 5H7a3 3 0 0 1-1-4Z" fill="#bdbdbd"/>', "#ffffff")],
  ["protected", "Protected area", "Other", tex('<path d="M0 0h32v32H0Z" fill="none" stroke="#7b1fa2" stroke-width="3" stroke-dasharray="6 4"/>', "none")],
  ["concession", "Concession / permit", "Other", tex('<path d="M0 16h32M16 0v32" stroke="#ef6c00" stroke-width="1"/>', "none")],
  ["dots-dense", "Dense dots", "Other", tex('<circle cx="4" cy="4" r="1.6" fill="#424242"/><circle cx="12" cy="12" r="1.6" fill="#424242"/><circle cx="20" cy="4" r="1.6" fill="#424242"/><circle cx="28" cy="12" r="1.6" fill="#424242"/><circle cx="4" cy="20" r="1.6" fill="#424242"/><circle cx="12" cy="28" r="1.6" fill="#424242"/><circle cx="20" cy="20" r="1.6" fill="#424242"/><circle cx="28" cy="28" r="1.6" fill="#424242"/>', "none")],
  ["checker", "Checkerboard", "Other", tex('<path d="M0 0h16v16H0Zm16 16h16v16H16Z" fill="#9e9e9e" opacity=".45"/>', "none")],
];

// ---------------------------------------------------------------- build
function build(): GallerySymbol[] {
  const out: GallerySymbol[] = [];
  // Points: built-in shapes in a set of colours.
  const shapes = ["circle", "square", "triangle", "diamond", "star", "cross", "pin"] as const;
  const pointColors: Array<[string, string]> = [["Red", "#e53935"], ["Blue", "#1e88e5"], ["Green", "#43a047"], ["Black", "#212121"]];
  for (const shape of shapes) {
    for (const [cn, c] of pointColors) {
      out.push({ id: `pt-${shape}-${cn}`.toLowerCase(), name: `${shape[0].toUpperCase()}${shape.slice(1)} ${cn.toLowerCase()}`, kind: "point", group: "Basic shapes", style: { markerEnabled: true, markerShape: shape, markerColor: c, markerSize: 16, fillColor: c, strokeColor: "#ffffff", circleRadius: 6 } });
    }
  }
  // Points: cartographic icons.
  const iconGroups: Record<string, string> = {
    village: "Settlements", city: "Settlements", capital: "Settlements", provcapital: "Settlements",
    mosque: "Facilities", church: "Facilities", temple: "Facilities", school: "Facilities", hospital: "Facilities", office: "Facilities", market: "Facilities", police: "Facilities", fuel: "Facilities",
    airport: "Transport", port: "Transport", bridge: "Transport", tower: "Transport",
    spring: "Water & terrain", well: "Water & terrain", waterfall: "Water & terrain", peak: "Water & terrain", volcano: "Water & terrain", cave: "Water & terrain",
    hotspot: "Forestry & field", tree: "Forestry & field", conifer: "Forestry & field", palm: "Forestry & field", mangrove: "Forestry & field", plot: "Forestry & field", sample: "Forestry & field", benchmark: "Forestry & field", gcp: "Forestry & field", camera: "Forestry & field", drone: "Forestry & field", camp: "Forestry & field", forestpost: "Forestry & field", nursery: "Forestry & field", birds: "Forestry & field", mine: "Forestry & field",
    flag: "General", warning: "General", info: "General",
  };
  for (const key of Object.keys(ICONS)) {
    out.push({ id: `icon-${key}`, name: ICONS[key][0], kind: "point", group: iconGroups[key] ?? "General", tags: key, style: { markerEnabled: true, markerShape: "custom", markerSvg: icon(key), markerSize: 24 } });
  }
  // Lines.
  const L = (id: string, name: string, group: string, color: string, width: number, dash?: number[], casing?: string): GallerySymbol => ({
    id: `ln-${id}`, name, kind: "line", group, style: { strokeColor: color, strokeWidth: width, strokeWidthUnit: "pixels", strokeDasharray: dash ?? [], strokeCasingColor: casing },
  });
  out.push(
    L("solid-thin", "Solid thin", "Basic", "#212121", 1), L("solid", "Solid", "Basic", "#212121", 2), L("solid-thick", "Solid thick", "Basic", "#212121", 4),
    L("dash", "Dashed", "Basic", "#212121", 1.5, [4, 2]), L("dash-long", "Long dash", "Basic", "#212121", 1.5, [8, 3]), L("dot", "Dotted", "Basic", "#212121", 2, [0.5, 2]),
    L("dash-dot", "Dash dot", "Basic", "#212121", 1.5, [5, 2, 1, 2]), L("dash-dot-dot", "Dash dot dot", "Basic", "#212121", 1.5, [6, 2, 1, 2, 1, 2]),
    L("red", "Red line", "Basic", "#e53935", 2), L("blue", "Blue line", "Basic", "#1e88e5", 2), L("green", "Green line", "Basic", "#43a047", 2), L("orange", "Orange line", "Basic", "#fb8c00", 2),
    L("bnd-country", "Batas negara", "Boundaries (BIG / KLHK)", "#000000", 2.5, [6, 2, 1, 2, 1, 2]),
    L("bnd-prov", "Batas provinsi", "Boundaries (BIG / KLHK)", "#000000", 2, [6, 2, 1, 2]),
    L("bnd-kab", "Batas kabupaten / kota", "Boundaries (BIG / KLHK)", "#000000", 1.5, [5, 2, 1, 2, 1, 2]),
    L("bnd-kec", "Batas kecamatan", "Boundaries (BIG / KLHK)", "#000000", 1.2, [4, 2]),
    L("bnd-desa", "Batas desa / kelurahan", "Boundaries (BIG / KLHK)", "#000000", 1, [1, 2]),
    L("bnd-kawasan", "Batas kawasan hutan", "Boundaries (BIG / KLHK)", "#007a00", 1.5, [6, 2]),
    L("bnd-konsesi", "Batas konsesi / izin", "Boundaries (BIG / KLHK)", "#e65100", 1.5, [3, 1.5]),
    L("bnd-study", "Batas area studi", "Boundaries (BIG / KLHK)", "#d50000", 2.5),
    L("river", "Sungai", "Water", "#00a4e5", 1.5), L("river-major", "Sungai besar", "Water", "#0288d1", 3), L("canal", "Kanal / saluran", "Water", "#29b6f6", 1.2, [4, 2]),
    L("coast", "Garis pantai", "Water", "#00c1ff", 1.5), L("river-seasonal", "Sungai musiman", "Water", "#4fc3f7", 1.2, [3, 2]),
    L("road-arteri", "Jalan arteri", "Transport", "#e53935", 3.5, undefined, "#7f0000"), L("road-kolektor", "Jalan kolektor", "Transport", "#fb8c00", 2.8, undefined, "#8d4b00"),
    L("road-lokal", "Jalan lokal", "Transport", "#ffd54f", 2.2, undefined, "#795548"), L("road-lain", "Jalan lain", "Transport", "#9e9e9e", 1.5), L("road-setapak", "Jalan setapak", "Transport", "#424242", 1, [3, 2]),
    L("toll", "Jalan tol", "Transport", "#7b1fa2", 4, undefined, "#311b92"), L("railway", "Rel kereta api", "Transport", "#212121", 2.5, [5, 3], "#ffffff"),
    L("contour", "Kontur", "Terrain", "#a1887f", 0.8), L("contour-index", "Kontur indeks", "Terrain", "#6d4c41", 1.6), L("ridge", "Punggungan", "Terrain", "#5d4037", 1.2, [2, 1.5]),
    L("power", "Jaringan listrik", "Utilities", "#ff6f00", 1.2, [8, 2, 1, 2]), L("pipe", "Pipa", "Utilities", "#6a1b9a", 1.5, [6, 2]),
    L("trail", "Jalur patroli", "Field", "#d81b60", 1.6, [2, 2]), L("transect", "Transek", "Field", "#c62828", 2, [6, 2]), L("track", "GPS track", "Field", "#3949ab", 2),
  );
  // Fills: solid colours (ArcMap palette-like).
  const solids: Array<[string, string]> = [
    ["Light green", "#a5d6a7"], ["Forest green", "#2e7d32"], ["Lime", "#c5e1a5"], ["Olive", "#9e9d24"], ["Yellow", "#fff59d"], ["Sand", "#ffe0b2"],
    ["Orange", "#ffb74d"], ["Brown", "#a1887f"], ["Red", "#ef9a9a"], ["Pink", "#f8bbd0"], ["Purple", "#ce93d8"], ["Lavender", "#d1c4e9"],
    ["Light blue", "#b3e5fc"], ["Blue", "#64b5f6"], ["Navy", "#1a237e"], ["Teal", "#80cbc4"], ["Grey", "#e0e0e0"], ["Dark grey", "#757575"],
  ];
  for (const [n, c] of solids) out.push({ id: `fl-${n}`.toLowerCase().replace(/\s+/g, "-"), name: n, kind: "fill", group: "Solid", style: { fillColor: c, fillOpacity: 1, fillPattern: "none", strokeColor: "#6e6e6e", strokeWidth: 0.6 } });
  out.push(
    { id: "fl-hollow", name: "Hollow (outline only)", kind: "fill", group: "Solid", style: { fillOpacity: 0, fillPattern: "none", strokeColor: "#000000", strokeWidth: 1.2 } },
    { id: "fl-hollow-red", name: "Hollow red", kind: "fill", group: "Solid", style: { fillOpacity: 0, fillPattern: "none", strokeColor: "#e53935", strokeWidth: 2 } },
    { id: "fl-hollow-dash", name: "Hollow dashed", kind: "fill", group: "Solid", style: { fillOpacity: 0, fillPattern: "none", strokeColor: "#000000", strokeWidth: 1.2, strokeDasharray: [4, 2] } },
    { id: "fl-transparent-50", name: "50% transparent", kind: "fill", group: "Solid", style: { fillColor: "#4fb0ea", fillOpacity: 0.5, fillPattern: "none", strokeColor: "#0079c1", strokeWidth: 1 } },
  );
  // Fills: line patterns.
  const patterns = ["hatch", "cross-hatch", "horizontal", "vertical", "dots"] as const;
  for (const p of patterns) {
    for (const [cn, c] of [["black", "#212121"], ["red", "#e53935"], ["green", "#2e7d32"]] as const) {
      out.push({ id: `fl-${p}-${cn}`, name: `${p.replace("-", " ")} ${cn}`, kind: "fill", group: "Line patterns", style: { fillPattern: p, fillPatternColor: c, fillColor: "#ffffff", fillOpacity: 1, strokeColor: c, strokeWidth: 0.8 } });
    }
  }
  // Fills: textures.
  for (const [id, name, group, s] of TEXTURES) {
    out.push({ id: `tx-${id}`, name, kind: "fill", group: `Texture: ${group}`, style: { fillPattern: "svg", fillPatternSvg: s, fillOpacity: 1, strokeColor: "#6e6e6e", strokeWidth: 0.6 } });
  }
  return out;
}

export const GALLERY: GallerySymbol[] = build();

// ---------------------------------------------------------------- user symbols (SVG uploads, font glyphs)
const USER_KEY = "tfg-user-symbols";

export function userSymbols(): GallerySymbol[] {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) ?? "[]") as GallerySymbol[];
  } catch {
    return [];
  }
}

export function saveUserSymbol(symbol: GallerySymbol): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify([symbol, ...userSymbols().filter((s) => s.id !== symbol.id)].slice(0, 300)));
  } catch {
    // storage full or private mode
  }
}

export function removeUserSymbol(id: string): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(userSymbols().filter((s) => s.id !== id)));
  } catch {
    // ignore
  }
}

/** Make a symbol from an uploaded SVG file (a point marker or a fill texture). */
export function symbolFromSvg(name: string, markup: string, kind: "point" | "fill"): GallerySymbol {
  const id = `user-${kind}-${Date.now().toString(36)}`;
  return kind === "point"
    ? { id, name, kind, group: "My symbols", style: { markerEnabled: true, markerShape: "custom", markerSvg: markup, markerSize: 24 } }
    : { id, name, kind, group: "My symbols", style: { fillPattern: "svg", fillPatternSvg: markup, fillOpacity: 1 } };
}

/** Render one font character (e.g. Wingdings, ESRI fonts) to a PNG marker. */
export function symbolFromGlyph(font: string, char: string, color: string, size = 64): GallerySymbol {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(size * 0.8)}px "${font}"`;
  ctx.fillText(char, size / 2, size / 2 + size * 0.04);
  const url = canvas.toDataURL("image/png");
  const code = char.codePointAt(0)?.toString(16).toUpperCase() ?? "";
  return {
    id: `user-glyph-${font}-${code}-${color}`.replace(/[^a-z0-9-]+/gi, "-"),
    name: `${font} U+${code}`,
    kind: "point",
    group: "My symbols",
    style: { markerEnabled: true, markerShape: "custom", markerSvg: url, markerSize: 24 },
  };
}

/** A small preview of a symbol as SVG markup (for the gallery grid). */
let previewSeq = 0;

export function symbolPreview(sym: GallerySymbol): string {
  const s = sym.style;
  // Inline SVGs share one document: every pattern needs its own id.
  const pid = `tfgp${++previewSeq}`;
  if (sym.kind === "point") {
    if (s.markerShape === "custom" && s.markerSvg) {
      return s.markerSvg.startsWith("<") ? s.markerSvg : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><image href="${s.markerSvg}" width="24" height="24"/></svg>`;
    }
    const c = s.markerColor ?? s.fillColor ?? "#000";
    const shapes: Record<string, string> = {
      circle: `<circle cx="12" cy="12" r="7" fill="${c}" stroke="#fff" stroke-width="1.5"/>`,
      square: `<rect x="5" y="5" width="14" height="14" fill="${c}" stroke="#fff" stroke-width="1.5"/>`,
      triangle: `<path d="M12 4 20 19H4Z" fill="${c}" stroke="#fff" stroke-width="1.5"/>`,
      diamond: `<path d="M12 3 21 12 12 21 3 12Z" fill="${c}" stroke="#fff" stroke-width="1.5"/>`,
      star: `<path d="m12 3 2.6 6 6.4.6-4.9 4.2 1.5 6.3L12 16.8l-5.6 3.3 1.5-6.3L3 9.6 9.4 9Z" fill="${c}"/>`,
      cross: `<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6Z" fill="${c}"/>`,
      pin: `<path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7Z" fill="${c}"/><circle cx="12" cy="9" r="2.6" fill="#fff"/>`,
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${shapes[s.markerShape ?? "circle"] ?? shapes.circle}</svg>`;
  }
  if (sym.kind === "line") {
    const dash = s.strokeDasharray?.length ? `stroke-dasharray="${s.strokeDasharray.map((d) => d * (s.strokeWidth ?? 1)).join(" ")}"` : "";
    const casing = s.strokeCasingColor ? `<path d="M3 16 C 12 4, 26 26, 37 10" stroke="${s.strokeCasingColor}" stroke-width="${(s.strokeWidth ?? 1) + 2}" fill="none" stroke-linecap="round"/>` : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 24">${casing}<path d="M3 16 C 12 4, 26 26, 37 10" stroke="${s.strokeColor}" stroke-width="${s.strokeWidth}" fill="none" ${dash}/></svg>`;
  }
  // fill
  const outline = `stroke="${s.strokeColor ?? "#6e6e6e"}" stroke-width="${Math.max(1, s.strokeWidth ?? 1)}" ${s.strokeDasharray?.length ? `stroke-dasharray="${s.strokeDasharray.join(" ")}"` : ""}`;
  if (s.fillPattern === "svg" && s.fillPatternSvg) {
    const data = `data:image/svg+xml;utf8,${encodeURIComponent(s.fillPatternSvg)}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24"><defs><pattern id="${pid}" width="16" height="16" patternUnits="userSpaceOnUse"><image href="${data}" width="16" height="16"/></pattern></defs><rect x="2" y="2" width="28" height="20" fill="url(#${pid})" ${outline}/></svg>`;
  }
  if (s.fillPattern && s.fillPattern !== "none") {
    const pc = s.fillPatternColor ?? "#000";
    const pat: Record<string, string> = {
      hatch: `<path d="M0 6 6 0" stroke="${pc}"/>`,
      "cross-hatch": `<path d="M0 6 6 0M0 0l6 6" stroke="${pc}"/>`,
      horizontal: `<path d="M0 3h6" stroke="${pc}"/>`,
      vertical: `<path d="M3 0v6" stroke="${pc}"/>`,
      dots: `<circle cx="3" cy="3" r="1" fill="${pc}"/>`,
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24"><defs><pattern id="${pid}" width="6" height="6" patternUnits="userSpaceOnUse">${pat[s.fillPattern] ?? ""}</pattern></defs><rect x="2" y="2" width="28" height="20" fill="${s.fillColor ?? "#fff"}"/><rect x="2" y="2" width="28" height="20" fill="url(#${pid})" ${outline}/></svg>`;
  }
  const opacity = s.fillOpacity ?? 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24"><rect x="2" y="2" width="28" height="20" fill="${s.fillColor ?? "#ccc"}" fill-opacity="${opacity}" ${outline}/></svg>`;
}
