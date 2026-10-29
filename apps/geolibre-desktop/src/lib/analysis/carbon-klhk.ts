// Carbon tools after the KLHK training module KHT.IK02.053.01 "Menghitung
// Cadangan Karbon" (Defani edition): vector land-cover stock (Table 1 AGC
// factors), InVEST-style stock change with valuation, and plot-based Tier 3.

import turfArea from "@turf/area";
import type { Feature, FeatureCollection } from "geojson";
import type { Table } from "./forest";

export const CO2_PER_C = 44 / 12;

/** Module Table 1: mean AGB / AGC (t/ha) per KLHK land-cover class, keyed by PL code. */
export const PL_CARBON_FACTORS: Array<{ code: string; acr: string; name: string; agb: number; agc: number }> = [
  { code: "2001", acr: "HP", name: "Hutan Lahan Kering Primer", agb: 269.4, agc: 126.618 },
  { code: "2002", acr: "HS", name: "Hutan Lahan Kering Sekunder", agb: 203.3, agc: 95.551 },
  { code: "2004", acr: "HMP", name: "Hutan Mangrove Primer", agb: 263.9, agc: 124.033 },
  { code: "20041", acr: "HMS", name: "Hutan Mangrove Sekunder", agb: 201.7, agc: 94.799 },
  { code: "2005", acr: "HRP", name: "Hutan Rawa Primer", agb: 274.8, agc: 129.156 },
  { code: "20051", acr: "HRS", name: "Hutan Rawa Sekunder", agb: 170.5, agc: 80.135 },
  { code: "2006", acr: "HT", name: "Hutan Tanaman", agb: 64, agc: 30.08 },
  { code: "2010", acr: "PK", name: "Perkebunan", agb: 63, agc: 29.61 },
  { code: "2007", acr: "B", name: "Semak Belukar", agb: 30, agc: 14.1 },
  { code: "20071", acr: "BR", name: "Semak Belukar Rawa", agb: 30, agc: 14.1 },
  { code: "20092", acr: "PC", name: "Pertanian Lahan Kering Campur", agb: 30, agc: 14.1 },
  { code: "20091", acr: "PT", name: "Pertanian Lahan Kering", agb: 10, agc: 4.7 },
  { code: "20122", acr: "TR", name: "Transmigrasi", agb: 10, agc: 4.7 },
  { code: "2012", acr: "PM", name: "Pemukiman", agb: 5, agc: 2.35 },
  { code: "3000", acr: "S", name: "Savanna/Padang Rumput", agb: 4.5, agc: 2.115 },
  { code: "2014", acr: "T", name: "Tanah Terbuka", agb: 2.5, agc: 1.175 },
  { code: "20093", acr: "SW", name: "Sawah", agb: 2, agc: 0.94 },
  { code: "20094", acr: "TM", name: "Tambak", agb: 0, agc: 0 },
  { code: "5001", acr: "A", name: "Badan Air", agb: 0, agc: 0 },
  { code: "50011", acr: "RW", name: "Rawa", agb: 0, agc: 0 },
  { code: "20121", acr: "BDR", name: "Bandara/Pelabuhan", agb: 0, agc: 0 },
  { code: "20141", acr: "PB", name: "Pertambangan", agb: 0, agc: 0 },
  { code: "2500", acr: "AW", name: "Awan", agb: 0, agc: 0 },
];

/** Module Table 3 (IPCC 2006): root-to-shoot ratio. "0" = AGC only (Table 1). */
export const ROOT_SHOOT_OPTIONS: Array<[string, string]> = [
  ["0", "Without roots (AGC only, module Table 1)"],
  ["0.37", "0.37 — tropical rain forest"],
  ["0.27", "0.27 — tropical mountain forest"],
  ["0.22", "0.22 — deciduous forest"],
  ["0.40", "0.40 — tropical shrubland"],
  ["0.42", "0.42 — tropical dry forest"],
];

/** Default factor text (one `code = tC/ha` per line), editable in the tool window. */
export const DEFAULT_FACTOR_TEXT = PL_CARBON_FACTORS.map((f) => `${f.code} = ${f.agc}   # ${f.acr} ${f.name}`).join("\n");

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Parse `key = value` lines (a `#` starts a comment); keys may be PL codes, acronyms or names. */
export function parseFactorText(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^(.+?)\s*[=:]\s*(-?\d+(?:[.,]\d+)?)$/);
    if (m) out.set(norm(m[1]), Number(m[2].replace(",", ".")));
  }
  return out;
}

/** tC/ha for a class value: by code, acronym or name, via the user's factor table. */
export function factorFor(value: unknown, factors: Map<string, number>): { tc: number; name: string } | null {
  const v = norm(value);
  if (factors.has(v)) {
    const known = PL_CARBON_FACTORS.find((f) => norm(f.code) === v || norm(f.acr) === v || norm(f.name) === v);
    return { tc: factors.get(v)!, name: known?.name ?? String(value) };
  }
  const known = PL_CARBON_FACTORS.find((f) => norm(f.code) === v || norm(f.acr) === v || norm(f.name) === v || (v.length > 4 && (norm(f.name).includes(v) || v.includes(norm(f.name)))));
  if (known && factors.has(norm(known.code))) return { tc: factors.get(norm(known.code))!, name: known.name };
  return null;
}

/** The field most likely holding KLHK land-cover classes (code, acronym or name). */
export function guessClassField(fc: FeatureCollection): string {
  const sample = fc.features.slice(0, 300);
  let best = "";
  let hits = 0;
  for (const field of Object.keys(sample[0]?.properties ?? {})) {
    const h = sample.filter((f) => PL_CARBON_FACTORS.some((p) => [p.code, p.acr, p.name].map(norm).includes(norm(f.properties?.[field])))).length;
    if (h > hits) {
      best = field;
      hits = h;
    }
  }
  return best;
}

export interface StockRow {
  value: string;
  name: string;
  ha: number;
  tcPerHa: number;
  tc: number;
  matched: boolean;
}

/** Carbon stock per class: area (geodesic, or an area field in ha) × factor × (1 + root:shoot). */
export function stockByClass(fc: FeatureCollection, field: string, factors: Map<string, number>, rootShoot: number, areaField?: string) {
  const areas = new Map<string, number>();
  for (const f of fc.features as Feature[]) {
    if (!f.geometry || !/Polygon/.test(f.geometry.type)) continue;
    const key = String(f.properties?.[field] ?? "");
    const ha = areaField ? Number(f.properties?.[areaField]) || 0 : turfArea(f) / 10_000;
    areas.set(key, (areas.get(key) ?? 0) + ha);
  }
  const rows: StockRow[] = [];
  for (const [value, ha] of areas) {
    const f = factorFor(value, factors);
    const tcPerHa = f ? f.tc * (1 + rootShoot) : 0;
    rows.push({ value, name: f?.name ?? value, ha, tcPerHa, tc: ha * tcPerHa, matched: !!f });
  }
  rows.sort((a, b) => b.tc - a.tc);
  const ha = rows.reduce((s, r) => s + r.ha, 0);
  const tc = rows.reduce((s, r) => s + r.tc, 0);
  return { rows, ha, tc };
}

export function stockTable(rows: StockRow[], ha: number, tc: number): Table {
  const r2 = (n: number, d = 2) => Number(n.toFixed(d));
  return {
    columns: ["Class", "Area (ha)", "tC/ha", "Total C (t)", "CO2e (t)"],
    rows: [
      ...rows.map((r) => [r.matched ? r.name : `${r.value} (no factor)`, r2(r.ha), r2(r.tcPerHa, 3), r2(r.tc), r2(r.tc * CO2_PER_C)]),
      ["TOTAL", r2(ha), r2(tc / (ha || 1), 3), r2(tc), r2(tc * CO2_PER_C)],
    ],
  };
}

/** InVEST Carbon valuation: NPV = price × (sequestration / T) × Σ 1 / ((1+r)^t (1+c)^t). */
export function investNpv(seqTonC: number, years: number, pricePerTonC: number, discount: number, priceChange: number): number {
  if (years <= 0) return 0;
  let sum = 0;
  for (let t = 0; t < years; t += 1) sum += 1 / ((1 + discount) ** t * (1 + priceChange) ** t);
  return pricePerTonC * (seqTonC / years) * sum;
}

const T95: Record<number, number> = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 15: 2.131, 20: 2.086, 30: 2.042 };
function tCrit(df: number) {
  if (df > 30) return 1.96;
  const k = Object.keys(T95).map(Number).filter((x) => x <= df).pop() ?? 1;
  return T95[k];
}

export interface Plot { id: string; agb: number; bgb: number; litter: number; deadTree: number; deadWood: number; soil: number }

/** Parse plot CSV: `plot, AGB, BGB, litter, dead tree, dead wood, soil` (tC/ha; BGB blank = AGB × root:shoot). */
export function parsePlots(text: string, rootShoot: number): Plot[] {
  const plots: Plot[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const c = line.split(/[;,\t]/).map((s) => s.trim());
    const n = (i: number) => Number((c[i] ?? "").replace(",", "."));
    if (!Number.isFinite(n(1))) continue; // header row
    const agb = n(1);
    plots.push({ id: c[0], agb, bgb: c[2] === "" || c[2] === undefined ? agb * rootShoot : n(2), litter: n(3) || 0, deadTree: n(4) || 0, deadWood: n(5) || 0, soil: n(6) || 0 });
  }
  return plots;
}

/** Module equations 7-9: Cplot, Cstratum = ΣCplot / n, total = Cstratum × stratum area; with a 95% CI. */
export function plotStats(plots: Plot[], stratumHa: number) {
  const c = plots.map((p) => p.agb + p.bgb + p.litter + p.deadTree + p.deadWood + p.soil);
  const n = c.length;
  const mean = c.reduce((a, b) => a + b, 0) / (n || 1);
  const sd = n > 1 ? Math.sqrt(c.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const ci = n ? tCrit(Math.max(n - 1, 1)) * (sd / Math.sqrt(n)) : 0;
  return { cplot: c, sum: c.reduce((a, b) => a + b, 0), n, mean, sd, ci, total: mean * stratumHa, low: (mean - ci) * stratumHa, high: (mean + ci) * stratumHa };
}

/** Module Table 4 example (forest area X, 63 ha): Cstratum 94.17 tC/ha, total ≈ 5,933 tC. */
export const PLOT_EXAMPLE = `plot, AGB, BGB, litter, dead tree, dead wood, soil
1, 65.87, 17.78, 0.45, 0.43, 0.22, 2.54
2, 58.91, 15.91, 0.38, 1.59, 0.44, 2.32
6, 62.09, 16.76, 0.56, 5.81, 0, 2.56
8, 92.41, 24.95, 1.15, 0, 0, 3.56`;
