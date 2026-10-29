// Colour palettes (Defani edition): 200+ ramps for the symbology editor —
// ColorBrewer (all 35 schemes), Google Earth Engine Data Catalog palettes,
// scientific ramps (viridis family, cmocean), qualitative sets, Indonesian
// thematic palettes (KLHK, MapBiomas) and generated single / two-hue ramps.

export type PaletteKind = "sequential" | "diverging" | "qualitative" | "thematic";

export interface Palette {
  id: string;
  name: string;
  group: string;
  kind: PaletteKind;
  colors: string[];
}

const P = (group: string, kind: PaletteKind, name: string, colors: string[], id?: string): Palette => ({
  id: id ?? `${group}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name,
  group,
  kind,
  colors: colors.map((c) => (c.startsWith("#") ? c : `#${c}`).toLowerCase()),
});

// ---------------------------------------------------------------- ColorBrewer (Cynthia Brewer, max classes)
const CB_SEQ: Record<string, string[]> = {
  Blues: ["f7fbff", "deebf7", "c6dbef", "9ecae1", "6baed6", "4292c6", "2171b5", "08519c", "08306b"],
  Greens: ["f7fcf5", "e5f5e0", "c7e9c0", "a1d99b", "74c476", "41ab5d", "238b45", "006d2c", "00441b"],
  Greys: ["ffffff", "f0f0f0", "d9d9d9", "bdbdbd", "969696", "737373", "525252", "252525", "000000"],
  Oranges: ["fff5eb", "fee6ce", "fdd0a2", "fdae6b", "fd8d3c", "f16913", "d94801", "a63603", "7f2704"],
  Purples: ["fcfbfd", "efedf5", "dadaeb", "bcbddc", "9e9ac8", "807dba", "6a51a3", "54278f", "3f007d"],
  Reds: ["fff5f0", "fee0d2", "fcbba1", "fc9272", "fb6a4a", "ef3b2c", "cb181d", "a50f15", "67000d"],
  BuGn: ["f7fcfd", "e5f5f9", "ccece6", "99d8c9", "66c2a4", "41ae76", "238b45", "006d2c", "00441b"],
  BuPu: ["f7fcfd", "e0ecf4", "bfd3e6", "9ebcda", "8c96c6", "8c6bb1", "88419d", "810f7c", "4d004b"],
  GnBu: ["f7fcf0", "e0f3db", "ccebc5", "a8ddb5", "7bccc4", "4eb3d3", "2b8cbe", "0868ac", "084081"],
  OrRd: ["fff7ec", "fee8c8", "fdd49e", "fdbb84", "fc8d59", "ef6548", "d7301f", "b30000", "7f0000"],
  PuBu: ["fff7fb", "ece7f2", "d0d1e6", "a6bddb", "74a9cf", "3690c0", "0570b0", "045a8d", "023858"],
  PuBuGn: ["fff7fb", "ece2f0", "d0d1e6", "a6bddb", "67a9cf", "3690c0", "02818a", "016c59", "014636"],
  PuRd: ["f7f4f9", "e7e1ef", "d4b9da", "c994c7", "df65b0", "e7298a", "ce1256", "980043", "67001f"],
  RdPu: ["fff7f3", "fde0dd", "fcc5c0", "fa9fb5", "f768a1", "dd3497", "ae017e", "7a0177", "49006a"],
  YlGn: ["ffffe5", "f7fcb9", "d9f0a3", "addd8e", "78c679", "41ab5d", "238443", "006837", "004529"],
  YlGnBu: ["ffffd9", "edf8b1", "c7e9b4", "7fcdbb", "41b6c4", "1d91c0", "225ea8", "253494", "081d58"],
  YlOrBr: ["ffffe5", "fff7bc", "fee391", "fec44f", "fe9929", "ec7014", "cc4c02", "993404", "662506"],
  YlOrRd: ["ffffcc", "ffeda0", "fed976", "feb24c", "fd8d3c", "fc4e2a", "e31a1c", "bd0026", "800026"],
};
const CB_DIV: Record<string, string[]> = {
  BrBG: ["543005", "8c510a", "bf812d", "dfc27d", "f6e8c3", "f5f5f5", "c7eae5", "80cdc1", "35978f", "01665e", "003c30"],
  PiYG: ["8e0152", "c51b7d", "de77ae", "f1b6da", "fde0ef", "f7f7f7", "e6f5d0", "b8e186", "7fbc41", "4d9221", "276419"],
  PRGn: ["40004b", "762a83", "9970ab", "c2a5cf", "e7d4e8", "f7f7f7", "d9f0d3", "a6dba0", "5aae61", "1b7837", "00441b"],
  PuOr: ["7f3b08", "b35806", "e08214", "fdb863", "fee0b6", "f7f7f7", "d8daeb", "b2abd2", "8073ac", "542788", "2d004b"],
  RdBu: ["67001f", "b2182b", "d6604d", "f4a582", "fddbc7", "f7f7f7", "d1e5f0", "92c5de", "4393c3", "2166ac", "053061"],
  RdGy: ["67001f", "b2182b", "d6604d", "f4a582", "fddbc7", "ffffff", "e0e0e0", "bababa", "878787", "4d4d4d", "1a1a1a"],
  RdYlBu: ["a50026", "d73027", "f46d43", "fdae61", "fee090", "ffffbf", "e0f3f8", "abd9e9", "74add1", "4575b4", "313695"],
  RdYlGn: ["a50026", "d73027", "f46d43", "fdae61", "fee08b", "ffffbf", "d9ef8b", "a6d96a", "66bd63", "1a9850", "006837"],
  Spectral: ["9e0142", "d53e4f", "f46d43", "fdae61", "fee08b", "ffffbf", "e6f598", "abdda4", "66c2a5", "3288bd", "5e4fa2"],
};
const CB_QUAL: Record<string, string[]> = {
  Accent: ["7fc97f", "beaed4", "fdc086", "ffff99", "386cb0", "f0027f", "bf5b17", "666666"],
  Dark2: ["1b9e77", "d95f02", "7570b3", "e7298a", "66a61e", "e6ab02", "a6761d", "666666"],
  Paired: ["a6cee3", "1f78b4", "b2df8a", "33a02c", "fb9a99", "e31a1c", "fdbf6f", "ff7f00", "cab2d6", "6a3d9a", "ffff99", "b15928"],
  Pastel1: ["fbb4ae", "b3cde3", "ccebc5", "decbe4", "fed9a6", "ffffcc", "e5d8bd", "fddaec", "f2f2f2"],
  Pastel2: ["b3e2cd", "fdcdac", "cbd5e8", "f4cae4", "e6f5c9", "fff2ae", "f1e2cc", "cccccc"],
  Set1: ["e41a1c", "377eb8", "4daf4a", "984ea3", "ff7f00", "ffff33", "a65628", "f781bf", "999999"],
  Set2: ["66c2a5", "fc8d62", "8da0cb", "e78ac3", "a6d854", "ffd92f", "e5c494", "b3b3b3"],
  Set3: ["8dd3c7", "ffffb3", "bebada", "fb8072", "80b1d3", "fdb462", "b3de69", "fccde5", "d9d9d9", "bc80bd", "ccebc5", "ffed6f"],
};

// ---------------------------------------------------------------- Google Earth Engine Data Catalog
const GEE: Array<[string, PaletteKind, string[]]> = [
  ["MODIS NDVI", "sequential", ["FFFFFF", "CE7E45", "DF923D", "F1B555", "FCD163", "99B718", "74A901", "66A000", "529400", "3E8601", "207401", "056201", "004C00", "023B01", "012E01", "011D01", "011301"]],
  ["Landsat EVI", "sequential", ["FFFFFF", "CE7E45", "DF923D", "F1B555", "FCD163", "99B718", "74A901", "66A000", "529400", "3E8601", "207401", "056201", "004C00"]],
  ["NDWI water", "sequential", ["ffffff", "d4e7f7", "9ecae1", "4292c6", "08519c", "08306b"]],
  ["SRTM elevation", "sequential", ["006633", "E5FFCC", "662A00", "D8D8D8", "F5F5F5"]],
  ["Terrain (GEE)", "sequential", ["0000ff", "00ffff", "ffff00", "ff0000", "ffffff"]],
  ["ESA WorldCover", "thematic", ["006400", "ffbb22", "ffff4c", "f096ff", "fa0000", "b4b4b4", "f0f0f0", "0064c8", "0096a0", "00cf75", "fae6a0"]],
  ["Dynamic World", "thematic", ["419bdf", "397d49", "88b053", "7a87c6", "e49635", "dfc35a", "c4281b", "a59b8f", "b39fe1"]],
  ["MODIS Land Cover (IGBP)", "thematic", ["05450a", "086a10", "54a708", "78d203", "009900", "c6b044", "dcd159", "dade48", "fbff13", "b6ff05", "27ff87", "c24f44", "a5a5a5", "ff6d4c", "69fff8", "f9ffa4", "1c0dff"]],
  ["Copernicus Global LC", "thematic", ["282828", "ffbb22", "ffff4c", "f096ff", "fa0000", "b4b4b4", "f0f0f0", "0032c8", "0096a0", "fae6a0", "58481f", "009900", "70663e", "00cc00", "4e751f", "007800", "666000", "8db400", "8d7400", "a0dc00", "929900", "648c00", "000080"]],
  ["Hansen tree cover", "sequential", ["000000", "00ff00"]],
  ["Hansen loss year", "sequential", ["ffff00", "ff0000"]],
  ["JRC water occurrence", "sequential", ["ffffff", "ffbbbb", "0000ff"]],
  ["JRC water transitions", "thematic", ["ffffff", "0000ff", "22b14c", "d1102d", "99d9ea", "b5e61d", "e6a1aa", "ff7f27", "ffc90e", "7f7f7f", "c3c3c3"]],
  ["MODIS LST", "sequential", ["040274", "040281", "0502a3", "0502b8", "0502ce", "0502e6", "0602ff", "235cb1", "307ef3", "269db1", "30c8e2", "32d3ef", "3be285", "3ff38f", "86e26f", "3ae237", "b5e22e", "d6e21f", "fff705", "ffd611", "ffb613", "ff8b13", "ff6e08", "ff500d", "ff0000", "de0101", "c21301", "a71001", "911003"]],
  ["CHIRPS precipitation", "sequential", ["001137", "0aab1e", "e7eb05", "ff4a2d", "e90000"]],
  ["GPM precipitation", "sequential", ["000096", "0064ff", "00b4ff", "33db80", "9beb4a", "ffeb00", "ffb300", "ff6400", "eb1e00", "af0000"]],
  ["ERA5 temperature", "sequential", ["000080", "0000d9", "4000ff", "8000ff", "0080ff", "00ffff", "00ff80", "80ff00", "daff00", "ffff00", "fff500", "ffda00", "ffb000", "ffa400", "ff4f00", "ff2500", "ff0a00", "ff00ff"]],
  ["Sentinel-5P NO2", "sequential", ["000000", "0000ff", "800080", "00ffff", "008000", "ffff00", "ff0000"]],
  ["Sentinel-5P aerosol", "sequential", ["000000", "0000ff", "800080", "00ffff", "008000", "ffff00", "ff0000"]],
  ["MODIS ET", "sequential", ["ffffff", "fcd163", "99b718", "66a000", "3e8601", "207401", "056201", "004c00", "011301"]],
  ["MODIS burned area", "sequential", ["ffffff", "ff0000"]],
  ["MODIS GPP", "sequential", ["bbe029", "0a9501", "074b03"]],
  ["WorldPop population", "sequential", ["24126c", "1fff4f", "d4ff50"]],
  ["VIIRS night lights", "sequential", ["000000", "1a1a4a", "4b3b8f", "9e5ca8", "e88b77", "fde6a8", "ffffff"]],
  ["Canopy height (GEDI)", "sequential", ["ffffff", "e0f3db", "a8ddb5", "4eb3d3", "08589e", "08306b"]],
  ["Soil moisture (SMAP)", "sequential", ["0300ff", "418504", "efff07", "efff07", "ff0303"]],
  ["Snow cover", "sequential", ["000000", "0dffff", "0afffe", "ff1fff", "ffffff"]],
  ["Ocean colour chlorophyll", "sequential", ["3500a8", "0800ba", "003fd6", "00aca9", "77f800", "ff8800", "b30000", "920000", "880000"]],
  ["Sea surface temperature", "sequential", ["040274", "0502b8", "0602ff", "307ef3", "30c8e2", "3be285", "86e26f", "b5e22e", "fff705", "ffb613", "ff6e08", "ff0000", "c21301", "911003"]],
  ["Global mangrove", "sequential", ["d40115"]],
  ["GHSL built-up", "sequential", ["000000", "400000", "a00000", "ff4000", "ffff00", "ffffff"]],
  ["Global surface water", "sequential", ["ffffff", "99d9ea", "0000ff"]],
  ["Hillshade", "sequential", ["000000", "ffffff"]],
  ["Slope", "sequential", ["ffffff", "fef0d9", "fdcc8a", "fc8d59", "e34a33", "b30000"]],
  ["Aspect (cyclic)", "qualitative", ["ff0000", "ffff00", "00ff00", "00ffff", "0000ff", "ff00ff", "ff0000"]],
  ["Hansen forest change", "thematic", ["000000", "00ff00", "ff0000", "0000ff", "ff00ff"]],
  ["Palsar forest / non-forest", "thematic", ["006400", "feff99", "0000ff"]],
  ["Global forest watch alerts", "sequential", ["ffd400", "ff8800", "e31a1c"]],
  ["Drought index (SPEI)", "diverging", ["8b1a1a", "de2929", "f3641d", "fdc404", "9afa94", "03f2fd", "12adf3", "1771de", "00008b"]],
  ["Fire radiative power", "sequential", ["ffff00", "ff9900", "ff0000", "990000"]],
];

// ---------------------------------------------------------------- scientific and qualitative sets
const SCI: Array<[string, PaletteKind, string[]]> = [
  ["Viridis", "sequential", ["440154", "482878", "3e4989", "31688e", "26828e", "1f9e89", "35b779", "6ece58", "b5de2b", "fde725"]],
  ["Magma", "sequential", ["000004", "180f3e", "451077", "721f81", "9f2f7f", "cd4071", "f1605d", "fd9567", "fec98d", "fcfdbf"]],
  ["Inferno", "sequential", ["000004", "1b0c42", "4b0c6b", "781c6d", "a52c60", "cf4446", "ed6925", "fb9b06", "f7d13d", "fcffa4"]],
  ["Plasma", "sequential", ["0d0887", "46039f", "7201a8", "9c179e", "bd3786", "d8576b", "ed7953", "fb9f3a", "fdca26", "f0f921"]],
  ["Cividis", "sequential", ["00204d", "00336f", "39486b", "575d6d", "707173", "8a8779", "a69d75", "c4b56c", "e4cf5b", "ffea46"]],
  ["Turbo", "sequential", ["30123b", "4145ab", "4675ed", "39a2fc", "1bcfd4", "24eca6", "61fc6c", "a4fc3b", "d1e834", "f3c63a", "fe9b2d", "f36315", "d93806", "b11901", "7a0402"]],
  ["Rocket", "sequential", ["03051a", "2b1b44", "591e5a", "8a1d5f", "b8204e", "e13342", "f06043", "f59268", "f7c0a0", "faebdd"]],
  ["Mako", "sequential", ["0b0405", "2b1d3a", "3b3b6b", "395d8e", "357ba2", "3497a9", "3fb5ad", "6ad2a8", "abe5bd", "def5e5"]],
  ["Cubehelix", "sequential", ["000000", "1a1530", "163d4e", "1f6642", "54792f", "a07949", "d07e93", "cf9cda", "c1caf3", "ffffff"]],
  ["Rainbow", "sequential", ["6e40aa", "bf3caf", "fe4b83", "ff7847", "e2b72f", "aff05b", "52f667", "1ddfa3", "23abd8", "4c6edb"]],
  ["Thermal (cmocean)", "sequential", ["042333", "2c3395", "744992", "b15f82", "eb7958", "fbb43d", "e8fa5b"]],
  ["Haline (cmocean)", "sequential", ["2a186c", "14439c", "206e8b", "3c9387", "5ab978", "aad85c", "fdef9a"]],
  ["Deep (cmocean)", "sequential", ["fdfecc", "a3e1a6", "5bbaa4", "3e8b9e", "3c5d93", "3b3474", "281a2c"]],
  ["Dense (cmocean)", "sequential", ["e6f1f1", "a2cee2", "76a4e5", "7871d5", "7642a5", "621d62", "360e24"]],
  ["Algae (cmocean)", "sequential", ["d7f9d0", "a2d595", "64b463", "129450", "126e45", "1a482f", "122414"]],
  ["Matter (cmocean)", "sequential", ["fdedb0", "f7a76f", "eb6156", "c22a5d", "88175f", "4e1546", "2f0f3d"]],
  ["Speed (cmocean)", "sequential", ["fffdcd", "e0cd75", "a2ab1f", "4e8b17", "136c33", "1b4a2c", "11261b"]],
  ["Topo (cmocean)", "diverging", ["28265e", "3e5e9a", "5d9fb6", "b1dee0", "1a4b24", "629a49", "c0bd63", "f7e7c1"]],
  ["Balance (cmocean)", "diverging", ["181c43", "2a59c5", "6ea5d6", "f1ecec", "e09e86", "b2342d", "3c0912"]],
  ["Curl (cmocean)", "diverging", ["151d44", "1c6f71", "84b496", "fef6f5", "d79a8f", "a23d5b", "340d35"]],
  ["Okabe-Ito (colour-blind safe)", "qualitative", ["e69f00", "56b4e9", "009e73", "f0e442", "0072b2", "d55e00", "cc79a7", "000000"]],
  ["Tableau 10", "qualitative", ["4e79a7", "f28e2b", "e15759", "76b7b2", "59a14f", "edc948", "b07aa1", "ff9da7", "9c755f", "bab0ac"]],
  ["Tableau 20", "qualitative", ["4e79a7", "a0cbe8", "f28e2b", "ffbe7d", "59a14f", "8cd17d", "b6992d", "f1ce63", "499894", "86bcb6", "e15759", "ff9d9a", "79706e", "bab0ac", "d37295", "fabfd2", "b07aa1", "d4a6c8", "9d7660", "d7b5a6"]],
  ["Category 10 (D3)", "qualitative", ["1f77b4", "ff7f0e", "2ca02c", "d62728", "9467bd", "8c564b", "e377c2", "7f7f7f", "bcbd22", "17becf"]],
  ["ArcMap random (earth)", "qualitative", ["a87000", "d7c29e", "4e7d34", "beffe8", "e69800", "ffbee8", "73b2ff", "a3ff73", "cdaa66", "897044", "ffebaf", "70a800"]],
  ["ArcMap random (pastel)", "qualitative", ["bed2ff", "ffbebe", "d3ffbe", "ffebbe", "e8beff", "beffe8", "ffffbe", "ffbee8", "dbd6c3", "c4e0f5"]],
  ["ArcMap random (bold)", "qualitative", ["ff0000", "0070ff", "38a800", "ffaa00", "a900e6", "00c5ff", "e600a9", "a87000", "4ce600", "ff7f7f"]],
  ["Hypsometric tints", "sequential", ["6a9a6a", "8fbf7f", "c3d99a", "f0e8a8", "e4c38a", "c9a06b", "a67c52", "8a6d5c", "b3a69a", "ffffff"]],
  ["Bathymetry", "sequential", ["f7fcff", "c6e6f5", "8fc8e8", "57a6d8", "2c7fc0", "13579a", "0b3570", "081d48"]],
  ["Temperature (cool-warm)", "diverging", ["3b4cc0", "6788ee", "9abbff", "c9d7f0", "edd1c2", "f7a889", "e26952", "b40426"]],
];

// ---------------------------------------------------------------- Indonesian thematic
const ID_THEMATIC: Array<[string, string[]]> = [
  ["KLHK kawasan hutan (KSA, HL, HP, HPT, HPK, APL, air)", ["ad3fff", "00ad00", "ffff00", "8af200", "ff5eff", "ffffff", "ccffff"]],
  ["MapBiomas Indonesia Col 4.1", ["1f8d49", "04381d", "2f7360", "d89f5c", "c71585", "9065d0", "7a5900", "ffefc3", "9c0027", "d4271e", "db4d4f", "091077", "2532e4", "ffffff"]],
  ["KLHK tutupan lahan (hutan primer to non-hutan)", ["005c00", "00a600", "1a7a1a", "38a800", "70a800", "a5d96a", "e1d996", "ffff73", "f0b400", "c8a064", "ff0000", "73b2ff"]],
  ["SNI RBI (sungai, laut, jalan, permukiman)", ["00ffff", "ccffff", "ff00ff", "ff7f7f", "d9d9d9", "a8a800"]],
  ["Peat depth (gambut)", ["f6e8c3", "dfc27d", "bf812d", "8c510a", "543005"]],
  ["Fire hotspot confidence", ["ffffb2", "fecc5c", "fd8d3c", "e31a1c"]],
  ["Deforestation alert age", ["ffeda0", "feb24c", "f03b20", "800026"]],
  ["Land suitability (S1 to N)", ["1a9641", "a6d96a", "ffffbf", "fdae61", "d7191c"]],
  ["Carbon stock (t C/ha)", ["f7fcb9", "d9f0a3", "addd8e", "78c679", "41ab5d", "238443", "005a32"]],
  ["Flood hazard (BNPB)", ["ffffcc", "a1dab4", "41b6c4", "2c7fb8", "253494"]],
  ["Disaster risk (low to high)", ["38a800", "ffff00", "ff9900", "ff0000"]],
];

// ---------------------------------------------------------------- generated ramps
const HUES: Array<[string, string]> = [
  ["Red", "c0392b"], ["Crimson", "a50f15"], ["Orange", "e67e22"], ["Amber", "f39c12"], ["Gold", "d4a015"],
  ["Olive", "808000"], ["Lime", "7cb342"], ["Green", "2e7d32"], ["Forest", "1b5e20"], ["Teal", "00897b"],
  ["Cyan", "0097a7"], ["Sky", "039be5"], ["Blue", "1565c0"], ["Navy", "0d1b5e"], ["Indigo", "3949ab"],
  ["Violet", "6a1b9a"], ["Magenta", "ad1457"], ["Pink", "d81b60"], ["Brown", "6d4c41"], ["Slate", "455a64"],
  ["ArcGIS Blue", "0079c1"], ["Sand", "c2a35f"], ["Moss", "556b2f"], ["Rust", "8b3a0f"],
];
const mix = (a: string, b: string, t: number) => {
  const pa = [0, 2, 4].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [0, 2, 4].map((i) => parseInt(b.slice(i, i + 2), 16));
  return pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
};
const singleHue = (hex: string) => [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => mix("f7f7f7", hex, t));
const TWO_HUE: Array<[string, string, string]> = [
  ["Yellow to green", "ffffcc", "006837"], ["Yellow to blue", "ffffd9", "081d58"], ["Yellow to red", "ffffb2", "bd0026"],
  ["Cream to brown", "fff7bc", "662506"], ["White to teal", "f7fcf0", "00441b"], ["Sky to navy", "deebf7", "08306b"],
  ["Pink to purple", "fde0dd", "49006a"], ["Mint to forest", "e5f5e0", "00441b"], ["Peach to rust", "fee6ce", "7f2704"],
  ["Ice to indigo", "eff3ff", "08519c"], ["Lemon to olive", "ffffcc", "4d4d00"], ["Sand to dark brown", "f6e8c3", "543005"],
  ["Lilac to plum", "f2f0f7", "54278f"], ["Aqua to deep sea", "e0f3f8", "023858"], ["Blush to wine", "fff5f0", "67000d"],
];

function build(): Palette[] {
  const out: Palette[] = [];
  for (const [n, c] of Object.entries(CB_SEQ)) out.push(P("ColorBrewer", "sequential", n, c));
  for (const [n, c] of Object.entries(CB_DIV)) out.push(P("ColorBrewer", "diverging", n, c));
  for (const [n, c] of Object.entries(CB_QUAL)) out.push(P("ColorBrewer", "qualitative", n, c));
  for (const [n, k, c] of GEE) out.push(P("Earth Engine", k, n, c));
  for (const [n, k, c] of SCI) out.push(P("Scientific", k, n, c));
  for (const [n, c] of ID_THEMATIC) out.push(P("Indonesia", "thematic", n, c));
  for (const [n, c] of HUES) out.push(P("Single hue", "sequential", n, singleHue(c)));
  for (const [n, a, b] of TWO_HUE) out.push(P("Two hue", "sequential", n, [0, 0.25, 0.5, 0.75, 1].map((t) => mix(a, b, t))));
  // Reversed copies of the continuous ramps.
  for (const p of out.filter((x) => (x.group === "ColorBrewer" || x.group === "Earth Engine" || x.group === "Scientific") && (x.kind === "sequential" || x.kind === "diverging") && x.colors.length > 1)) {
    out.push({ ...p, id: `${p.id}-r`, name: `${p.name} (reversed)`, colors: [...p.colors].reverse() });
  }
  return out;
}

export const PALETTES: Palette[] = build();

/** `count` colours from a palette (interpolated, or cycled for qualitative sets). */
export function paletteColors(palette: Palette, count: number): string[] {
  const c = palette.colors;
  if (count <= 0) return [];
  if (palette.kind === "qualitative" || palette.kind === "thematic") {
    return Array.from({ length: count }, (_, i) => c[i % c.length]);
  }
  if (count === 1) return [c[Math.floor(c.length / 2)]];
  return Array.from({ length: count }, (_, i) => {
    const t = (i / (count - 1)) * (c.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(c.length - 1, lo + 1);
    return `#${mix(c[lo].slice(1), c[hi].slice(1), t - lo)}`;
  });
}

/** ArcMap-style random colours: pleasant, well separated, reproducible per seed. */
export function randomColors(count: number, seed = 1): string[] {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: count }, (_, i) => {
    const h = (i * 137.508 + rnd() * 25) % 360; // golden-angle spread
    const sat = 45 + rnd() * 35;
    const light = 55 + rnd() * 25;
    return hslToHex(h, sat, light);
  });
}

export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

export const PALETTE_GROUPS = [...new Set(PALETTES.map((p) => p.group))];
