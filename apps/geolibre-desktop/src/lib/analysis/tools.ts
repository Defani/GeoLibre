// Analysis Toolkit registry (Defani edition). Each tool declares its
// parameters and a run function; one generic QGIS-style window renders them.

import type { RasterData } from "@geolibre/processing";
import type { Feature, FeatureCollection, Position } from "geojson";
import { accuracyAssessment, randomForestClassify, randomPointsInPolygons, stratifiedRandom, systematicGrid } from "./classify";
import { costDistance, euclideanDistance, nearTable } from "./distance";
import { burnSeverity, carbonStock, fragmentation, parseLookup, tabulateArea, tabulateIntersection, trendAnalysis, type Table } from "./forest";
import { cutFill, fillSinks, flowAccumulation, flowDirection, terrainIndex, viewshed, watershed } from "./terrain";
import { isNoData, sameGrid, singleBand } from "./grid";
import { writeUint8Bands } from "@geolibre/processing";
import turfArea from "@turf/area";
import { CO2_PER_C, DEFAULT_FACTOR_TEXT, factorFor, guessClassField, investNpv, parseFactorText, parsePlots, plotStats, PLOT_EXAMPLE, ROOT_SHOOT_OPTIONS, stockByClass, stockTable } from "./carbon-klhk";

/** 2-98% stretch of one band to 1-255 (0 stays NoData). */
function stretch8(r: RasterData): Uint8Array {
  const vals: number[] = [];
  const band = r.bands[0];
  const step = Math.max(1, Math.floor(band.length / 200_000));
  for (let i = 0; i < band.length; i += step) if (!isNoData(band[i], r.nodata)) vals.push(band[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)] ?? 0, hi = vals[Math.floor(vals.length * 0.98)] ?? 1;
  const out = new Uint8Array(band.length);
  for (let i = 0; i < band.length; i += 1) {
    const v = band[i];
    out[i] = isNoData(v, r.nodata) ? 0 : Math.max(1, Math.min(255, Math.round(((v - lo) / (hi - lo || 1)) * 254) + 1));
  }
  return out;
}

/** Sentinel-2 band presets for composites. */
export const COMPOSITES: Record<string, { label: string; bands: [string, string, string] }> = {
  truecolor: { label: "True Color (B4, B3, B2)", bands: ["B4", "B3", "B2"] },
  falsecolor: { label: "False Color Infrared (B8, B4, B3)", bands: ["B8", "B4", "B3"] },
  swir: { label: "Short-wave Infrared (B12, B8A, B4)", bands: ["B12", "B8A", "B4"] },
  agriculture: { label: "Agriculture (B11, B8, B2)", bands: ["B11", "B8", "B2"] },
  vegetation: { label: "Healthy Vegetation (B8, B11, B2)", bands: ["B8", "B11", "B2"] },
};

/** The raster whose name ends with the band code (e.g. "PreFire_B8A" for B8A). */
export function matchBand(names: string[], code: string): string {
  const re = new RegExp(`(^|[^A-Za-z0-9])${code}$`, "i");
  return names.find((n) => re.test(n)) ?? "";
}

export const INDICES: Record<string, { label: string; needs: string[]; formula: string }> = {
  ndvi: { label: "NDVI - vegetation", needs: ["nir", "red"], formula: "(NIR - Red) / (NIR + Red)" },
  ndwi: { label: "NDWI - open water", needs: ["green", "nir"], formula: "(Green - NIR) / (Green + NIR)" },
  ndmi: { label: "NDMI - moisture", needs: ["nir", "swir1"], formula: "(NIR - SWIR1) / (NIR + SWIR1)" },
  nbr: { label: "NBR - burn ratio", needs: ["nir", "swir2"], formula: "(NIR - SWIR2) / (NIR + SWIR2)" },
  savi: { label: "SAVI - soil-adjusted vegetation", needs: ["nir", "red"], formula: "1.5 (NIR - Red) / (NIR + Red + 0.5)" },
  evi: { label: "EVI - enhanced vegetation", needs: ["nir", "red", "blue"], formula: "2.5 (NIR - Red) / (NIR + 6 Red - 7.5 Blue + 1)" },
};

export type ParamType = "raster" | "rasters" | "vector" | "field" | "number" | "text" | "textarea" | "select" | "point" | "checkbox";

export interface ToolParam {
  id: string;
  label: string;
  type: ParamType;
  help: string;
  optional?: boolean;
  /** vector: which geometries qualify. */
  geometry?: "polygon" | "point" | "line" | "any";
  /** field: the vector parameter whose fields to list. */
  of?: string;
  options?: Array<[value: string, label: string]>;
  default?: string | number | boolean;
  /** Only shown when another parameter has this value. */
  when?: [param: string, value: string];
}

export interface ToolContext {
  raster: (name: string) => Promise<RasterData>;
  layer: (id: string) => { id: string; name: string; geojson: FeatureCollection };
  addRaster: (raster: RasterData, name: string) => Promise<void>;
  /** Add an already-encoded GeoTIFF (e.g. an 8-bit RGB composite). */
  addRasterBytes: (bytes: ArrayBuffer, name: string) => Promise<void>;
  addVector: (fc: FeatureCollection, name: string) => void;
  updateVector: (id: string, fc: FeatureCollection) => void;
  addTiles: (name: string, url: string, attribution: string, bounds?: [number, number, number, number]) => void;
  mapBounds: () => [number, number, number, number];
  httpFetch: (url: string) => Promise<string>;
  log: (line: string) => void;
}

export interface ToolResult {
  summary?: string;
  table?: Table;
}

export interface AnalysisTool {
  id: string;
  title: string;
  description: string;
  params: ToolParam[];
  run: (v: Record<string, string>, ctx: ToolContext) => Promise<ToolResult>;
}

const num = (v: string | undefined, d = 0) => (v === undefined || v === "" ? d : Number(v));
const point = (v: string): Position => {
  const [lon, lat] = v.split(",").map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error("Pick a point on the map (lon, lat).");
  return [lon, lat];
};
const fc = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });

export const ANALYSIS_TOOLS: AnalysisTool[] = [
  {
    id: "composite",
    title: "Composite Bands",
    description: "Stack three single-band rasters into one RGB image (2-98% stretch), with Sentinel-2 presets. Bands are picked automatically from names ending in B2, B3, B4, B8, B8A, B11, B12.",
    params: [
      { id: "preset", label: "Combination", type: "select", default: "truecolor", options: [...Object.entries(COMPOSITES).map(([k, v]) => [k, v.label] as [string, string]), ["custom", "Custom (choose bands)"]], help: "True Color looks natural; False Color shows vegetation in red; SWIR highlights burn scars and moisture; Agriculture separates crops." },
      { id: "red", label: "Red channel", type: "raster", help: "Raster for the red channel (auto-filled from the preset when names match)." },
      { id: "green", label: "Green channel", type: "raster", help: "Raster for the green channel." },
      { id: "blue", label: "Blue channel", type: "raster", help: "Raster for the blue channel." },
    ],
    run: async (v, ctx) => {
      const r = await ctx.raster(v.red), g = await ctx.raster(v.green), b = await ctx.raster(v.blue);
      sameGrid(r, g, v.red, v.green);
      sameGrid(r, b, v.red, v.blue);
      const name = v.preset === "custom" || !v.preset ? `composite_${v.red}_${v.green}_${v.blue}` : `composite_${v.preset}`;
      await ctx.addRasterBytes(writeUint8Bands(r, [stretch8(r), stretch8(g), stretch8(b)], 0), name);
      return { summary: `RGB composite "${name}" added.` };
    },
  },
  {
    id: "band-index",
    title: "Band Index",
    description: "Spectral indices from single-band rasters: NDVI, NDWI, NDMI, NBR, SAVI, EVI.",
    params: [
      { id: "index", label: "Index", type: "select", default: "ndvi", options: Object.entries(INDICES).map(([k, v]) => [k, v.label] as [string, string]), help: "NDVI vegetation vigour; NDWI water; NDMI canopy moisture; NBR burned areas; SAVI sparse vegetation; EVI dense canopy." },
      { id: "nir", label: "NIR (B8 / B8A)", type: "raster", help: "Near-infrared band." },
      { id: "red", label: "Red (B4)", type: "raster", optional: true, help: "Red band (NDVI, SAVI, EVI)." },
      { id: "green", label: "Green (B3)", type: "raster", optional: true, help: "Green band (NDWI)." },
      { id: "blue", label: "Blue (B2)", type: "raster", optional: true, help: "Blue band (EVI)." },
      { id: "swir1", label: "SWIR1 (B11)", type: "raster", optional: true, help: "Short-wave infrared 1 (NDMI)." },
      { id: "swir2", label: "SWIR2 (B12)", type: "raster", optional: true, help: "Short-wave infrared 2 (NBR)." },
    ],
    run: async (v, ctx) => {
      const key = v.index || "ndvi";
      const spec = INDICES[key];
      const bands: Record<string, RasterData> = {};
      for (const need of spec.needs) {
        if (!v[need]) throw new Error(`${spec.label} needs the ${need.toUpperCase()} band.`);
        bands[need] = await ctx.raster(v[need]);
      }
      const ref = bands[spec.needs[0]];
      Object.entries(bands).forEach(([k, r]) => sameGrid(ref, r, spec.needs[0], k));
      const n = ref.width * ref.height;
      const out = new Float32Array(n);
      const get = (k: string, i: number) => bands[k].bands[0][i];
      for (let i = 0; i < n; i += 1) {
        if (spec.needs.some((k) => isNoData(get(k, i), bands[k].nodata))) { out[i] = -9999; continue; }
        let value: number;
        switch (key) {
          case "ndwi": value = (get("green", i) - get("nir", i)) / (get("green", i) + get("nir", i)); break;
          case "ndmi": value = (get("nir", i) - get("swir1", i)) / (get("nir", i) + get("swir1", i)); break;
          case "nbr": value = (get("nir", i) - get("swir2", i)) / (get("nir", i) + get("swir2", i)); break;
          case "savi": value = (1.5 * (get("nir", i) - get("red", i))) / (get("nir", i) + get("red", i) + 0.5); break;
          case "evi": value = (2.5 * (get("nir", i) - get("red", i))) / (get("nir", i) + 6 * get("red", i) - 7.5 * get("blue", i) + 1); break;
          default: value = (get("nir", i) - get("red", i)) / (get("nir", i) + get("red", i));
        }
        out[i] = Number.isFinite(value) ? value : -9999;
      }
      await ctx.addRaster(singleBand(ref, out, -9999), key.toUpperCase());
      return { summary: `${key.toUpperCase()} = ${spec.formula} added.` };
    },
  },
  {
    id: "tabulate-area",
    title: "Tabulate Area",
    description: "Area (ha) of every class of a class raster (land cover, forest / non-forest) inside each polygon, written as new fields of the polygon layer.",
    params: [
      { id: "zones", label: "Zones (polygons)", type: "vector", geometry: "polygon", help: "Plots, concessions, villages... Each receives one field per class." },
      { id: "classes", label: "Class raster", type: "raster", help: "A categorical raster (integer class codes), e.g. land cover." },
      { id: "prefix", label: "Field prefix", type: "text", default: "lc_", help: "Fields are named <prefix><class>_ha, plus <prefix>total_ha." },
    ],
    run: async (v, ctx) => {
      const zones = ctx.layer(v.zones);
      const { collection, table } = await tabulateArea(zones.geojson, await ctx.raster(v.classes), v.prefix || "lc_");
      ctx.updateVector(zones.id, collection);
      return { summary: `Class areas written to "${zones.name}".`, table };
    },
  },
  {
    id: "tabulate-intersection",
    title: "Tabulate Intersection",
    description: "Overlap of each zone polygon with the classes of another polygon layer (forest area, peat, protected status...), in hectares and percent of the zone — the core of an EUDR check.",
    params: [
      { id: "zones", label: "Zones (polygons)", type: "vector", geometry: "polygon", help: "The parcels to check, e.g. farm plots." },
      { id: "classes", label: "Class polygons", type: "vector", geometry: "polygon", help: "The reference polygons, e.g. kawasan hutan, peat, forest cover." },
      { id: "field", label: "Class field", type: "field", of: "classes", help: "The attribute that names each class (e.g. FUNGSIKWS)." },
      { id: "prefix", label: "Field prefix", type: "text", default: "x_", help: "New fields: <prefix><class>_ha and <prefix><class>_pct, plus <prefix>zone_ha." },
    ],
    run: async (v, ctx) => {
      const zones = ctx.layer(v.zones);
      const { collection, table } = tabulateIntersection(zones.geojson, ctx.layer(v.classes).geojson, v.field, v.prefix || "x_");
      ctx.updateVector(zones.id, collection);
      return { summary: `Overlaps written to "${zones.name}".`, table };
    },
  },
  {
    id: "fragmentation",
    title: "Landscape Fragmentation",
    description: "FRAGSTATS-style class metrics from a class raster: number of patches, PLAND, mean patch size, largest patch index, edge length and density, and core area.",
    params: [
      { id: "classes", label: "Class raster", type: "raster", help: "Land cover or forest / non-forest (integer codes)." },
      { id: "edge", label: "Edge depth (cells)", type: "number", default: 1, help: "Cells closer than this to another class are edge, not core habitat." },
      { id: "focus", label: "Patch map for class", type: "text", default: "", optional: true, help: "Optional class code: adds a raster of that class's patches coloured by patch area (ha)." },
    ],
    run: async (v, ctx) => {
      const focus = v.focus === "" ? null : Number(v.focus);
      const { table, patchAreaRaster } = await fragmentation(await ctx.raster(v.classes), Math.max(0, Math.round(num(v.edge, 1))), focus);
      if (focus !== null) await ctx.addRaster(patchAreaRaster, `patch_area_class_${focus}`);
      return { table };
    },
  },
  {
    id: "burn-severity",
    title: "Burn Severity (dNBR)",
    description: "dNBR = NBR before − NBR after, classified with the USGS (Key & Benson) severity table, with burned area per class. Give NIR and SWIR2 bands for each date (Sentinel-2 B8A / B12), or ready NBR rasters.",
    params: [
      { id: "input", label: "Input", type: "select", default: "bands", options: [["bands", "NIR + SWIR bands"], ["nbr", "NBR rasters"]], help: "Bands: NBR is computed for you. NBR: give the two NBR rasters." },
      { id: "preNir", label: "Pre-fire NIR (B8A)", type: "raster", when: ["input", "bands"], help: "Near infrared before the fire." },
      { id: "preSwir", label: "Pre-fire SWIR2 (B12)", type: "raster", when: ["input", "bands"], help: "Short-wave infrared 2 before the fire." },
      { id: "postNir", label: "Post-fire NIR (B8A)", type: "raster", when: ["input", "bands"], help: "Near infrared after the fire." },
      { id: "postSwir", label: "Post-fire SWIR2 (B12)", type: "raster", when: ["input", "bands"], help: "Short-wave infrared 2 after the fire." },
      { id: "preNbr", label: "Pre-fire NBR", type: "raster", when: ["input", "nbr"], help: "NBR before the fire." },
      { id: "postNbr", label: "Post-fire NBR", type: "raster", when: ["input", "nbr"], help: "NBR after the fire." },
    ],
    run: async (v, ctx) => {
      const pre = v.input === "nbr" ? { nbr: await ctx.raster(v.preNbr) } : { nir: await ctx.raster(v.preNir), swir: await ctx.raster(v.preSwir) };
      const post = v.input === "nbr" ? { nbr: await ctx.raster(v.postNbr) } : { nir: await ctx.raster(v.postNir), swir: await ctx.raster(v.postSwir) };
      const r = await burnSeverity(pre, post);
      await ctx.addRaster(r.dnbr, "dNBR");
      await ctx.addRaster(r.classes, "burn_severity_USGS");
      return { table: r.table, summary: "Classes: 1 high regrowth … 3 unburned … 7 high severity." };
    },
  },
  {
    id: "carbon-stock",
    title: "Carbon Stock & Emissions",
    description: "Carbon stock per land-cover class (tC/ha × area) for one year, or two years with the change converted to emissions (tCO2e = ΔC × 44/12).",
    params: [
      { id: "year1", label: "Land cover — year 1", type: "raster", help: "Class raster of the first year." },
      { id: "year2", label: "Land cover — year 2", type: "raster", optional: true, help: "Optional second year (same grid) to compute emissions or removals." },
      {
        id: "factors",
        label: "Carbon per class (tC/ha)",
        type: "textarea",
        default: "1: 180\n2: 110\n3: 60\n4: 40\n5: 5",
        help: "One “class code: tC/ha” per line. Use IPCC defaults, SNI 7724/7725 plot results, or your project's values (above-ground + below-ground as you report).",
      },
    ],
    run: async (v, ctx) => {
      const r = await carbonStock(await ctx.raster(v.year1), parseLookup(v.factors), v.year2 ? await ctx.raster(v.year2) : undefined);
      await ctx.addRaster(r.densityRaster, "carbon_density_tC_ha_year1");
      return { summary: r.summary, table: r.table };
    },
  },
  {
    id: "klhk-carbon",
    title: "Cadangan Karbon — Modul KLHK (vektor)",
    description: "Cadangan karbon = luas (ha) × faktor karbon (t C/ha) per kelas penutupan lahan KLHK (modul KHT.IK02.053.01, Tabel 1). Kelas dikenali dari kode PL (2001, 20092…), singkatan (HP, PC…) atau nama. CO2e = C × 44/12.",
    params: [
      { id: "layer", label: "Penutupan lahan", type: "vector", geometry: "polygon", help: "Layer poligon penutupan lahan, mis. PL2025 KLHK." },
      { id: "field", label: "Kolom kelas", type: "field", of: "layer", optional: true, help: "Kosongkan agar dideteksi otomatis (kode/nama kelas PL KLHK)." },
      { id: "areaField", label: "Kolom luas (ha)", type: "field", of: "layer", optional: true, help: "Kosongkan untuk luas geodesik dari geometri." },
      { id: "rootShoot", label: "Biomassa akar (BGB)", type: "select", default: "0", options: ROOT_SHOOT_OPTIONS, help: "Modul Tabel 3: BGB = AGC × nisbah akar-pucuk. Default 0 = AGC saja seperti Tabel 1." },
      { id: "factors", label: "Faktor karbon (t C/ha)", type: "textarea", default: DEFAULT_FACTOR_TEXT, help: "Satu “kode = t C/ha” per baris. Default = Mean AGC Tabel 1 modul; ganti dengan nilai plot SNI 7724 bila ada." },
      { id: "addLayer", label: "Tambahkan peta karbon (c_ton_ha)", type: "checkbox", default: true, help: "Salinan layer dengan kolom c_ton_ha dan c_ton per poligon." },
    ],
    run: async (v, ctx) => {
      const layer = ctx.layer(v.layer);
      const field = v.field || guessClassField(layer.geojson);
      if (!field) throw new Error("Kolom kelas tidak dikenali; pilih kolom kelas.");
      const factors = parseFactorText(v.factors);
      const rootShoot = num(v.rootShoot);
      const r = stockByClass(layer.geojson, field, factors, rootShoot, v.areaField || undefined);
      if (v.addLayer === "true") {
        ctx.addVector(fc(layer.geojson.features.map((f) => {
          const k = factorFor(f.properties?.[field], factors);
          const perHa = k ? k.tc * (1 + rootShoot) : 0;
          const ha = v.areaField ? Number(f.properties?.[v.areaField]) || 0 : turfArea(f) / 10_000;
          return { ...f, properties: { ...f.properties, c_ton_ha: Number(perHa.toFixed(3)), c_ton: Number((perHa * ha).toFixed(3)) } };
        })), `${layer.name}_karbon`);
      }
      const missing = r.rows.filter((x) => !x.matched).length;
      ctx.log(`Kolom kelas: ${field}${missing ? ` — ${missing} kelas tanpa faktor dihitung 0` : ""}`);
      return {
        summary: `Cadangan karbon ${r.tc.toLocaleString("id-ID", { maximumFractionDigits: 2 })} t C (${(r.tc * CO2_PER_C).toLocaleString("id-ID", { maximumFractionDigits: 2 })} t CO2e) pada ${r.ha.toLocaleString("id-ID", { maximumFractionDigits: 2 })} ha.`,
        table: stockTable(r.rows, r.ha, r.tc),
      };
    },
  },
  {
    id: "invest-carbon",
    title: "Karbon InVEST — Perubahan & Valuasi",
    description: "Model InVEST Carbon Storage & Sequestration untuk dua periode penutupan lahan vektor: stok = Σ luas × t C/ha; sekuestrasi = stok akhir − stok awal; NPV = harga × (sekuestrasi / T) × Σ 1/((1+r)^t (1+c)^t).",
    params: [
      { id: "cur", label: "Penutupan lahan awal", type: "vector", geometry: "polygon", help: "Mis. PL2024." },
      { id: "curField", label: "Kolom kelas (awal)", type: "field", of: "cur", optional: true, help: "Kosongkan untuk deteksi otomatis." },
      { id: "fut", label: "Penutupan lahan akhir", type: "vector", geometry: "polygon", help: "Mis. PL2025." },
      { id: "futField", label: "Kolom kelas (akhir)", type: "field", of: "fut", optional: true, help: "Kosongkan untuk deteksi otomatis." },
      { id: "years", label: "Rentang tahun (T)", type: "number", default: 1, help: "Tahun akhir − tahun awal." },
      { id: "price", label: "Harga per t CO2e", type: "number", default: 10, help: "Mata uang bebas (USD, Rp…)." },
      { id: "discount", label: "Diskonto (%/tahun)", type: "number", default: 7, help: "Tingkat diskonto pasar." },
      { id: "priceChange", label: "Perubahan harga (%/tahun)", type: "number", default: 0, help: "Kenaikan harga karbon per tahun." },
      { id: "rootShoot", label: "Biomassa akar (BGB)", type: "select", default: "0", options: ROOT_SHOOT_OPTIONS, help: "Nisbah akar-pucuk (modul Tabel 3)." },
      { id: "factors", label: "Faktor karbon (t C/ha)", type: "textarea", default: DEFAULT_FACTOR_TEXT, help: "Jumlah pool InVEST (atas + tanah + bahan mati) per kelas." },
    ],
    run: async (v, ctx) => {
      const factors = parseFactorText(v.factors);
      const rs = num(v.rootShoot);
      const stock = (id: string, field: string) => {
        const g = ctx.layer(id).geojson;
        return stockByClass(g, field || guessClassField(g), factors, rs);
      };
      const a = stock(v.cur, v.curField);
      const b = stock(v.fut, v.futField);
      const seq = b.tc - a.tc;
      const npv = investNpv(seq, num(v.years, 1), num(v.price) * CO2_PER_C, num(v.discount) / 100, num(v.priceChange) / 100);
      const names = new Map<string, [number, number, number, number]>();
      for (const r of a.rows) names.set(r.name, [r.ha, 0, r.tc, 0]);
      for (const r of b.rows) {
        const x = names.get(r.name) ?? [0, 0, 0, 0];
        names.set(r.name, [x[0], r.ha, x[2], r.tc]);
      }
      const r2 = (n: number) => Number(n.toFixed(2));
      return {
        summary: `Stok awal ${r2(a.tc)} t C, akhir ${r2(b.tc)} t C → ${seq >= 0 ? "sekuestrasi" : "emisi"} ${r2(Math.abs(seq))} t C (${r2(Math.abs(seq) * CO2_PER_C)} t CO2e). NPV ${r2(npv)}.`,
        table: { columns: ["Kelas", "Luas awal (ha)", "Luas akhir (ha)", "C awal (t)", "C akhir (t)", "ΔC (t)"], rows: [...names].map(([n, [h0, h1, c0, c1]]) => [n, r2(h0), r2(h1), r2(c0), r2(c1), r2(c1 - c0)]) },
      };
    },
  },
  {
    id: "carbon-plot",
    title: "Karbon Plot Lapangan (Tier 3)",
    description: "Modul persamaan 7–9: Cplot = AGB + BGB + serasah + pohon mati + kayu mati + tanah (t C/ha); Cstratum = ΣCplot / n; total = Cstratum × luas stratum, dengan selang kepercayaan 95%.",
    params: [
      { id: "plots", label: "Data plot (CSV)", type: "textarea", default: PLOT_EXAMPLE, help: "Kolom: plot, AGB, BGB, serasah, pohon mati, kayu mati, tanah (t C/ha). BGB kosong = AGB × nisbah akar-pucuk. Contoh = Tabel 4 modul." },
      { id: "rootShoot", label: "Nisbah akar-pucuk", type: "select", default: "0.27", options: ROOT_SHOOT_OPTIONS.filter(([k]) => k !== "0"), help: "Dipakai bila kolom BGB kosong." },
      { id: "area", label: "Luas stratum (ha)", type: "number", default: 63, help: "Luas strata hutan yang diwakili plot." },
    ],
    run: async (v) => {
      const s = plotStats(parsePlots(v.plots, num(v.rootShoot)), num(v.area));
      if (!s.n) throw new Error("Belum ada baris plot yang valid.");
      const r2 = (n: number) => Number(n.toFixed(2));
      return {
        summary: `Cstratum ${r2(s.mean)} t C/ha (±${r2(s.ci)}, 95%) × ${num(v.area)} ha = ${r2(s.total)} t C (${r2(s.total * CO2_PER_C)} t CO2e).`,
        table: {
          columns: ["Ukuran", "Nilai"],
          rows: [["ΣCplot (t C/ha)", r2(s.sum)], ["n plot", s.n], ["Cstratum (t C/ha)", r2(s.mean)], ["Simpangan baku", r2(s.sd)], ["SK 95% (±t C/ha)", r2(s.ci)], ["Total (t C)", r2(s.total)], ["Rentang 95% (t C)", `${r2(s.low)} – ${r2(s.high)}`], ["CO2e (t)", r2(s.total * CO2_PER_C)]],
        },
      };
    },
  },
  {
    id: "trend",
    title: "Time Series Trend (Mann-Kendall)",
    description: "Per-pixel trend across a time series of rasters (NDVI, EVI, NBR...): Sen's slope, Mann-Kendall Z, and significance at 95% — for degradation and recovery.",
    params: [{ id: "series", label: "Rasters, oldest first", type: "rasters", help: "At least 4 rasters on the same grid, in date order (oldest at the top)." }],
    run: async (v, ctx) => {
      const names = v.series.split("\n").filter(Boolean);
      const series: RasterData[] = [];
      for (const n of names) series.push(await ctx.raster(n));
      const r = trendAnalysis(series);
      await ctx.addRaster(r.slope, "trend_sen_slope");
      await ctx.addRaster(r.z, "trend_mk_z");
      await ctx.addRaster(r.significance, "trend_significance");
      return { table: r.table, summary: "Significance raster: 1 = decreasing, 2 = no trend, 3 = increasing (95%)." };
    },
  },
  {
    id: "rf-classify",
    title: "Supervised Classification (Random Forest)",
    description: "Classify imagery with a Random Forest trained from polygons you draw (Editor › New Polygon Layer, add a class field). Reports the out-of-bag accuracy.",
    params: [
      { id: "bands", label: "Bands / rasters", type: "rasters", help: "The predictor rasters on one grid (e.g. Sentinel-2 B2, B3, B4, B8, B11, B12, NDVI)." },
      { id: "training", label: "Training polygons", type: "vector", geometry: "polygon", help: "Polygons over typical areas of each class." },
      { id: "field", label: "Class field", type: "field", of: "training", help: "Class code (1, 2, 3…) or name; names are numbered in the legend." },
      { id: "trees", label: "Trees", type: "number", default: 50, help: "More trees are steadier but slower. 50–100 is typical." },
      { id: "depth", label: "Max depth", type: "number", default: 12, help: "Limits each tree's depth to avoid overfitting." },
      { id: "samples", label: "Samples per class", type: "number", default: 1500, help: "Training pixels drawn per class (balanced)." },
    ],
    run: async (v, ctx) => {
      const names = v.bands.split("\n").filter(Boolean);
      const bands: RasterData[] = [];
      for (const n of names) bands.push(await ctx.raster(n));
      ctx.log(`Training on ${names.length} bands…`);
      const r = await randomForestClassify(bands, ctx.layer(v.training).geojson, v.field, { trees: num(v.trees, 50), maxDepth: num(v.depth, 12), samplesPerClass: num(v.samples, 1500) });
      await ctx.addRaster(r.classified, "rf_classification");
      return { summary: `Out-of-bag accuracy ${r.oobAccuracy === null ? "–" : `${Math.round(r.oobAccuracy * 1000) / 10}%`} from ${r.samples} training pixels.${r.legend ? ` Classes: ${r.legend}.` : ""}` };
    },
  },
  {
    id: "accuracy",
    title: "Accuracy Assessment",
    description: "Confusion matrix, overall accuracy, Kappa, and user's / producer's accuracy of a classified raster against reference points.",
    params: [
      { id: "classified", label: "Classified raster", type: "raster", help: "The map to assess (integer class codes)." },
      { id: "points", label: "Reference points", type: "vector", geometry: "point", help: "Field or image-interpreted points, independent from the training data." },
      { id: "field", label: "Reference class field", type: "field", of: "points", help: "The true class code at each point." },
    ],
    run: async (v, ctx) => {
      const r = await accuracyAssessment(ctx.layer(v.points).geojson, v.field, await ctx.raster(v.classified));
      return { summary: r.summary, table: r.table };
    },
  },
  {
    id: "sampling",
    title: "Sampling Design",
    description: "Generate sample points: simple random or a systematic grid inside polygons, or stratified random per class of a class raster — for field inventory plots or validation.",
    params: [
      { id: "mode", label: "Design", type: "select", default: "random", options: [["random", "Simple random (in polygons)"], ["grid", "Systematic grid (in polygons)"], ["stratified", "Stratified random (per class)"]], help: "Random and grid fill an area layer; stratified draws the same number of points in every class." },
      { id: "area", label: "Area (polygons)", type: "vector", geometry: "polygon", when: ["mode", "random"], help: "The study area." },
      { id: "count", label: "Number of points", type: "number", default: 100, when: ["mode", "random"], help: "Total points to place." },
      { id: "areaGrid", label: "Area (polygons)", type: "vector", geometry: "polygon", when: ["mode", "grid"], help: "The study area." },
      { id: "spacing", label: "Grid spacing (m)", type: "number", default: 500, when: ["mode", "grid"], help: "Distance between plots, e.g. 500 m for a forest inventory grid." },
      { id: "strata", label: "Class raster", type: "raster", when: ["mode", "stratified"], help: "Land cover or any class raster used as strata." },
      { id: "perClass", label: "Points per class", type: "number", default: 30, when: ["mode", "stratified"], help: "30–50 per class is common for accuracy assessment." },
    ],
    run: async (v, ctx) => {
      let pts: Feature[];
      if (v.mode === "grid") pts = systematicGrid(ctx.layer(v.areaGrid).geojson, num(v.spacing, 500));
      else if (v.mode === "stratified") pts = await stratifiedRandom(await ctx.raster(v.strata), num(v.perClass, 30));
      else pts = randomPointsInPolygons(ctx.layer(v.area).geojson, num(v.count, 100));
      ctx.addVector(fc(pts), `sample_points_${v.mode}`);
      return { summary: `${pts.length} sample points added to Contents.` };
    },
  },
  {
    id: "hydrology",
    title: "Hydrology (Flow & Streams)",
    description: "From a DEM: fill sinks, D8 flow direction (ESRI codes), flow accumulation, and a stream network above a threshold.",
    params: [
      { id: "dem", label: "DEM", type: "raster", help: "Elevation raster (DEMNAS, SRTM...)." },
      { id: "threshold", label: "Stream threshold (cells)", type: "number", default: 500, help: "Cells draining more than this many upstream cells become streams." },
    ],
    run: async (v, ctx) => {
      const filled = fillSinks(await ctx.raster(v.dem));
      const { dir, esri } = await flowDirection(filled);
      const acc = flowAccumulation(filled, dir);
      const t = num(v.threshold, 500);
      const streams = new Float32Array(acc.bands[0].length);
      acc.bands[0].forEach((a, i) => (streams[i] = !isNoData(a, acc.nodata) && a >= t ? 1 : 0));
      await ctx.addRaster(filled, "dem_filled");
      await ctx.addRaster(esri, "flow_direction_d8");
      await ctx.addRaster(acc, "flow_accumulation");
      await ctx.addRaster(singleBand(acc, streams, 0), `streams_${t}`);
      return { summary: "Filled DEM, flow direction, accumulation and streams added." };
    },
  },
  {
    id: "watershed",
    title: "Watershed",
    description: "The catchment draining to a pour point (snapped to the strongest flow nearby), from a DEM.",
    params: [
      { id: "dem", label: "DEM", type: "raster", help: "Elevation raster." },
      { id: "pour", label: "Pour point", type: "point", help: "Click the outlet on the map (a river point)." },
    ],
    run: async (v, ctx) => {
      const filled = fillSinks(await ctx.raster(v.dem));
      const { dir } = await flowDirection(filled);
      const acc = flowAccumulation(filled, dir);
      const r = await watershed(dir, acc, point(v.pour));
      await ctx.addRaster(r.mask, "watershed");
      return { summary: `Watershed area ${Math.round(r.areaHa).toLocaleString("id-ID")} ha.` };
    },
  },
  {
    id: "viewshed",
    title: "Viewshed",
    description: "Cells visible from an observer on a DEM (line of sight), within a radius.",
    params: [
      { id: "dem", label: "DEM", type: "raster", help: "Elevation raster." },
      { id: "observer", label: "Observer", type: "point", help: "Click the observation point on the map." },
      { id: "height", label: "Observer height (m)", type: "number", default: 10, help: "Height above ground, e.g. a watch tower." },
      { id: "radius", label: "Radius (m)", type: "number", default: 5000, help: "Maximum viewing distance." },
    ],
    run: async (v, ctx) => {
      const r = await viewshed(await ctx.raster(v.dem), point(v.observer), num(v.height, 10), num(v.radius, 5000));
      await ctx.addRaster(r.raster, "viewshed");
      return { summary: `Visible area ${Math.round(r.visibleHa).toLocaleString("id-ID")} ha.` };
    },
  },
  {
    id: "cut-fill",
    title: "Cut / Fill",
    description: "Volume removed (cut) and added (fill) between two surfaces, or between a surface and a design level.",
    params: [
      { id: "before", label: "Surface before", type: "raster", help: "The original DEM." },
      { id: "mode", label: "Compare with", type: "select", default: "raster", options: [["raster", "Surface after (raster)"], ["level", "A flat design level"]], help: "A second DEM, or one elevation (e.g. a planned platform)." },
      { id: "after", label: "Surface after", type: "raster", when: ["mode", "raster"], help: "The DEM after the works." },
      { id: "level", label: "Design level (m)", type: "number", default: 0, when: ["mode", "level"], help: "The planned elevation." },
    ],
    run: async (v, ctx) => {
      const r = await cutFill(await ctx.raster(v.before), v.mode === "level" ? num(v.level) : await ctx.raster(v.after));
      await ctx.addRaster(r.raster, "cut_fill_difference");
      return { table: r.table };
    },
  },
  {
    id: "terrain-index",
    title: "Terrain Indices",
    description: "TPI (position: ridge / valley), TRI (ruggedness), curvature, or TWI (wetness, for peat and wetland mapping) from a DEM.",
    params: [
      { id: "dem", label: "DEM", type: "raster", help: "Elevation raster." },
      { id: "index", label: "Index", type: "select", default: "tpi", options: [["tpi", "TPI — Topographic Position"], ["tri", "TRI — Terrain Ruggedness"], ["curvature", "Curvature"], ["twi", "TWI — Topographic Wetness"]], help: "TPI > 0 ridges, < 0 valleys; TWI is high where water collects." },
      { id: "radius", label: "TPI radius (cells)", type: "number", default: 3, when: ["index", "tpi"], help: "Neighbourhood for TPI." },
    ],
    run: async (v, ctx) => {
      const index = v.index as "tpi" | "tri" | "curvature" | "twi";
      await ctx.addRaster(await terrainIndex(await ctx.raster(v.dem), index, num(v.radius, 3)), index.toUpperCase());
      return { summary: `${index.toUpperCase()} added.` };
    },
  },
  {
    id: "euclidean-distance",
    title: "Euclidean Distance",
    description: "Distance in metres from every cell to the nearest feature (roads, rivers, villages, forest edge), on a template raster's grid.",
    params: [
      { id: "features", label: "Features", type: "vector", geometry: "any", help: "Points, lines or polygons to measure from." },
      { id: "template", label: "Template raster", type: "raster", help: "Gives the extent and cell size of the result." },
      { id: "max", label: "Max distance (m)", type: "number", default: 0, optional: true, help: "Optional: cells farther than this become NoData (0 = no limit)." },
    ],
    run: async (v, ctx) => {
      const r = await euclideanDistance(await ctx.raster(v.template), ctx.layer(v.features).geojson, num(v.max) || undefined);
      await ctx.addRaster(r, `distance_m_${ctx.layer(v.features).name}`);
      return { summary: "Distance raster (metres) added." };
    },
  },
  {
    id: "cost-distance",
    title: "Cost Distance & Least-Cost Path",
    description: "Accumulated travel cost from a source over a cost raster (e.g. slope or land-cover friction), and the cheapest path to a destination.",
    params: [
      { id: "cost", label: "Cost raster", type: "raster", help: "Cost per metre of each cell (higher = harder). Negative or NoData cells are barriers." },
      { id: "source", label: "Source", type: "point", help: "Click the start on the map." },
      { id: "destination", label: "Destination", type: "point", optional: true, help: "Optional: click the end to get the least-cost path." },
    ],
    run: async (v, ctx) => {
      const r = await costDistance(await ctx.raster(v.cost), point(v.source), v.destination ? point(v.destination) : undefined);
      await ctx.addRaster(r.accumulated, "cost_distance");
      if (r.path) ctx.addVector(fc([r.path]), "least_cost_path");
      return { summary: r.path ? `Least-cost path added (cost ${Math.round(r.pathCost!)}, ${r.path.properties?.length_m} m).` : "Accumulated cost raster added." };
    },
  },
  {
    id: "near-table",
    title: "Near Table",
    description: "For each feature, the nearest feature of another layer and the distance in metres, as new fields — e.g. distance from each plot to the forest boundary.",
    params: [
      { id: "input", label: "Input features", type: "vector", geometry: "any", help: "The features that get the new fields." },
      { id: "near", label: "Near features", type: "vector", geometry: "any", help: "The features to measure to." },
      { id: "idField", label: "Near ID field", type: "field", of: "near", optional: true, help: "Which attribute identifies the nearest feature (default: its order)." },
      { id: "prefix", label: "Field prefix", type: "text", default: "near_", help: "New fields <prefix>id and <prefix>dist_m." },
    ],
    run: async (v, ctx) => {
      const input = ctx.layer(v.input);
      ctx.updateVector(input.id, nearTable(input.geojson, ctx.layer(v.near).geojson, v.idField, v.prefix || "near_"));
      return { summary: `Nearest features written to "${input.name}".` };
    },
  },
  {
    id: "firms",
    title: "Fire Hotspots (NASA FIRMS)",
    description: "Active fire detections from NASA FIRMS (VIIRS / MODIS) for the current map view and the last days. Needs a free FIRMS MAP_KEY (firms.modaps.eosdis.nasa.gov/api).",
    params: [
      { id: "key", label: "FIRMS MAP_KEY", type: "text", default: "", help: "Get a free key at firms.modaps.eosdis.nasa.gov/api/map_key — it is stored on this computer only." },
      { id: "source", label: "Sensor", type: "select", default: "VIIRS_SNPP_NRT", options: [["VIIRS_SNPP_NRT", "VIIRS S-NPP (375 m)"], ["VIIRS_NOAA20_NRT", "VIIRS NOAA-20 (375 m)"], ["MODIS_NRT", "MODIS (1 km)"]], help: "VIIRS detects smaller fires than MODIS." },
      { id: "days", label: "Days (1–10)", type: "number", default: 7, help: "Detections from the last N days." },
      { id: "zones", label: "Count per polygon", type: "vector", geometry: "polygon", optional: true, help: "Optional: add a hotspot count field to these polygons (concessions, villages)." },
    ],
    run: async (v, ctx) => {
      if (!v.key) throw new Error("Enter your FIRMS MAP_KEY.");
      try { localStorage.setItem("the-funny-gis:firms-key", v.key); } catch { /* ignore */ }
      const [w, s, e, n] = ctx.mapBounds();
      const days = Math.min(10, Math.max(1, Math.round(num(v.days, 7))));
      const csv = await ctx.httpFetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(v.key)}/${v.source}/${w.toFixed(4)},${s.toFixed(4)},${e.toFixed(4)},${n.toFixed(4)}/${days}`);
      const lines = csv.trim().split(/\r?\n/);
      if (!lines[0]?.includes("latitude")) throw new Error(lines[0] || "FIRMS returned no data.");
      const head = lines[0].split(",");
      const features = lines.slice(1).map((line) => {
        const cells = line.split(",");
        const props: Record<string, unknown> = {};
        head.forEach((h, i) => (props[h] = Number.isFinite(Number(cells[i])) && cells[i] !== "" ? Number(cells[i]) : cells[i]));
        return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [Number(props.longitude), Number(props.latitude)] } } as Feature;
      });
      ctx.addVector(fc(features), `FIRMS ${v.source} last ${days} days`);
      if (v.zones) {
        const zones = ctx.layer(v.zones);
        const { pointInPolygons } = await import("./grid");
        const out = zones.geojson.features.map((z) => {
          const g = z.geometry as { type: string; coordinates: unknown } | null;
          const polys = !g ? [] : ((g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Position[][][]);
          const count = features.filter((f) => pointInPolygons((f.geometry as { coordinates: Position }).coordinates[0], (f.geometry as { coordinates: Position }).coordinates[1], polys)).length;
          return { ...z, properties: { ...(z.properties ?? {}), hotspots: count } };
        });
        ctx.updateVector(zones.id, { ...zones.geojson, features: out });
      }
      return { summary: `${features.length} hotspots added.` };
    },
  },
  {
    id: "s1-flood",
    title: "Flood Map (Sentinel-1 radar)",
    description: "Open water and flooding from Sentinel-1 radar (sees through cloud): VV backscatter below a threshold over the current view and dates, from Microsoft Planetary Computer.",
    params: [
      { id: "from", label: "From", type: "text", default: `${new Date().getFullYear()}-01-01`, help: "Start date (YYYY-MM-DD) — choose the flood period." },
      { id: "to", label: "To", type: "text", default: new Date().toISOString().slice(0, 10), help: "End date (YYYY-MM-DD)." },
      { id: "threshold", label: "VV threshold (dB)", type: "number", default: -18, help: "Water is darker than this; −18 to −20 dB is typical for open water." },
    ],
    run: async (v, ctx) => {
      const [w, s, e, n] = ctx.mapBounds();
      const body = {
        "filter-lang": "cql2-json",
        filter: { op: "and", args: [
          { op: "=", args: [{ property: "collection" }, "sentinel-1-rtc"] },
          { op: "anyinteracts", args: [{ property: "datetime" }, { interval: [`${v.from}T00:00:00Z`, `${v.to}T23:59:59Z`] }] },
          { op: "s_intersects", args: [{ property: "geometry" }, { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }] },
        ] },
        sortby: [{ field: "datetime", direction: "desc" }],
      };
      const res = await fetch("https://planetarycomputer.microsoft.com/api/data/v1/mosaic/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Planetary Computer answered ${res.status}`);
      const { searchid } = (await res.json()) as { searchid: string };
      const linear = Math.pow(10, num(v.threshold, -18) / 10).toFixed(5);
      const url = `https://planetarycomputer.microsoft.com/api/data/v1/mosaic/${searchid}/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png?collection=sentinel-1-rtc&expression=vv%3C${linear}&asset_as_band=true&rescale=0,1&colormap_name=blues&nodata=0`;
      ctx.addTiles(`Flood / water (S1 VV < ${v.threshold} dB) ${v.from} – ${v.to}`, url, "Contains modified Copernicus Sentinel-1 data, Microsoft Planetary Computer", [w, s, e, n]);
      return { summary: "Water layer added (blue = water). Zoom to level 9 or closer." };
    },
  },
];

export function getAnalysisTool(id: string): AnalysisTool | undefined {
  return ANALYSIS_TOOLS.find((t) => t.id === id);
}
