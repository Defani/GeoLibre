// KLHK symbology (Defani edition): official colours from SIMBOLOGI_IGT_KLHK.style
// (KepmenLHK 399/2024, Lampiran II), decoded to `klhk-styles.json`. A layer whose
// name follows a SIGAP layer (pl2025_ar_50k, kwshutan_ar_250k_jun2026, …) gets
// that symbology as a QGIS rule renderer when it is added, so the Contents
// legend shows the KLHK classes. "Simbologi KLHK" in the ribbon reapplies it.

import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { Feature } from "geojson";
import KB_JSON from "./klhk-styles.json";
import { createPluginLayerStyleActions } from "./plugin-layer-style";

interface KlhkSymbol {
  type: "polygon" | "line" | "point";
  label: string;
  fill?: string;
  fill_opacity?: number;
  outline?: string;
  outline_width?: number;
  color?: string;
  width?: number;
  size?: number;
  stroke?: string;
}

interface KlhkRule {
  re: string;
  category: string;
  field?: string;
  codes?: Record<string, string>;
  code_regex?: string;
  flags?: Record<string, string>;
}

interface KlhkKb {
  categories: Record<string, KlhkSymbol[]>;
  layers: KlhkRule[];
}

const KB = KB_JSON as unknown as KlhkKb;
const PT_TO_PX = 4 / 3; // ArcMap symbol sizes are in points
const KLHK_METADATA_KEY = "klhkSymbology";

type Kind = "polygon" | "line" | "point";
type ClassEntry = { value?: unknown; flagField?: string; symbol: KlhkSymbol };
interface Resolved { field: string | null; flags?: boolean; classes: ClassEntry[]; category: string }

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (s: unknown) => new Set(norm(s).split(" ").filter((t) => t.length > 1));

/** How well an attribute value names a symbology class (0..1). */
function similarity(value: unknown, label: string): number {
  const a = norm(value).replace(/ /g, "");
  const b = norm(label).replace(/ /g, "");
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 0.8;
  const ta = tokens(value);
  const tb = tokens(label);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return ta.size && tb.size ? inter / (ta.size + tb.size - inter) : 0;
}

/** The KLHK rule for a layer name (a SIGAP file name such as pl2025_ar_50k_Aceh). */
export function findKlhkRule(layerName: string): KlhkRule | null {
  const base = norm(layerName).replace(/ /g, "_");
  return KB.layers.find((r) => new RegExp(r.re).test(base)) ?? null;
}

function kindOf(features: Feature[]): Kind {
  const t = features.find((f) => f.geometry)?.geometry?.type ?? "Polygon";
  return t.includes("Line") ? "line" : t.includes("Point") ? "point" : "polygon";
}

function counts(features: Feature[], field: string) {
  const m = new Map<unknown, number>();
  for (const f of features) {
    const v = f.properties?.[field];
    if (v !== null && v !== undefined && v !== "") m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
}

export function resolveKlhkClasses(rule: KlhkRule, features: Feature[]): Resolved {
  const symbols = KB.categories[rule.category] ?? [];
  const byLabel = new Map(symbols.map((s) => [s.label, s]));
  const fields = Object.keys(features[0]?.properties ?? {});

  if (rule.flags) {
    // one flag column per class (e.g. ro1..ro12 > 0); the first matching rule wins
    const classes = Object.entries(rule.flags)
      .filter(([f, label]) => fields.includes(f) && byLabel.has(label) && features.some((x) => Number(x.properties?.[f]) > 0))
      .map(([f, label]) => ({ flagField: f, symbol: byLabel.get(label)! }));
    if (classes.length) return { field: null, flags: true, classes, category: rule.category };
  }
  if (rule.codes && rule.field) {
    const re = new RegExp(rule.field);
    const field = fields.find((f) => re.test(f));
    const codeRe = rule.code_regex ? new RegExp(rule.code_regex, "i") : null;
    if (field) {
      const classes: ClassEntry[] = [];
      for (const value of counts(features, field).keys()) {
        const key = codeRe ? String(value).match(codeRe)?.[1] : String(value);
        const label = key !== undefined ? rule.codes[key] : undefined;
        if (label && byLabel.has(label)) classes.push({ value, symbol: byLabel.get(label)! });
      }
      if (classes.length) return { field, classes, category: rule.category };
    }
  }
  if (symbols.length === 1) return { field: null, classes: [{ symbol: symbols[0] }], category: rule.category };

  // the column whose values best match the class labels
  let best: (Resolved & { score: number }) | null = null;
  for (const field of fields) {
    const c = counts(features, field);
    if (!c.size || c.size > 80) continue;
    const classes: ClassEntry[] = [];
    let covered = 0;
    for (const [value, n] of c) {
      let top: KlhkSymbol | null = null;
      let topScore = 0.5;
      for (const s of symbols) {
        const sc = similarity(value, s.label);
        if (sc > topScore) {
          top = s;
          topScore = sc;
        }
      }
      if (top) {
        classes.push({ value, symbol: top });
        covered += n;
      }
    }
    const score = covered / features.length + classes.length / c.size;
    if (classes.length && (!best || score > best.score)) best = { field, classes, category: rule.category, score };
  }
  return best ?? { field: null, classes: [{ symbol: symbols[0] }], category: rule.category };
}

const xmlEsc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function rgba(hex: string | undefined, alpha = 1) {
  const h = (hex ?? "#000000").replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return `${r},${g},${b},${Math.round(alpha * 255)}`;
}

function qmlSymbol(name: string, sym: KlhkSymbol, kind: Kind): string {
  const opt = (k: string, v: string) => `<Option name="${k}" value="${xmlEsc(v)}" type="QString"/>`;
  if (kind === "line") {
    const color = sym.type === "line" ? sym.color : sym.outline ?? sym.fill ?? sym.color;
    const width = (sym.type === "line" ? sym.width : sym.outline_width) ?? 1;
    return `<symbol name="${name}" type="line" alpha="1"><layer class="SimpleLine"><Option type="Map">${opt("line_color", rgba(color))}${opt("line_width", (width * PT_TO_PX).toFixed(2))}</Option></layer></symbol>`;
  }
  if (kind === "point") {
    const color = sym.type === "point" ? sym.color : sym.fill ?? sym.color;
    const size = sym.type === "point" ? sym.size ?? 8 : 8;
    return `<symbol name="${name}" type="marker" alpha="1"><layer class="SimpleMarker"><Option type="Map">${opt("color", rgba(color))}${opt("outline_color", rgba(sym.stroke ?? "#ffffff"))}${opt("outline_width", "1")}${opt("size", (size * PT_TO_PX).toFixed(1))}${opt("name", "circle")}</Option></layer></symbol>`;
  }
  let fill = sym.fill;
  let fillOpacity = sym.fill_opacity ?? 1;
  let outline = sym.outline;
  let outlineWidth = sym.outline_width ?? 0;
  if (sym.type === "line") {
    // a line symbol (e.g. Batas DAS) on polygon data: hollow polygon with that outline
    fill = sym.color;
    fillOpacity = 0;
    outline = sym.color;
    outlineWidth = sym.width ?? 1;
  } else if (sym.type === "point") {
    fill = sym.color;
    fillOpacity = 0.6;
  }
  const width = outline ? Math.max(outlineWidth * PT_TO_PX, 0.5) : 0;
  return `<symbol name="${name}" type="fill" alpha="1"><layer class="SimpleFill"><Option type="Map">${opt("color", rgba(fill, fillOpacity))}${opt("outline_color", rgba(outline ?? fill ?? "#000000"))}${opt("outline_width", width.toFixed(2))}</Option></layer></symbol>`;
}

const literal = (v: unknown) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const ELSE_SYMBOL: KlhkSymbol = { type: "polygon", label: "Lainnya", fill: "#bdbdbd", fill_opacity: 0.6, outline: "#808080", outline_width: 0.3 };

/** QML (QGIS rule renderer) for the resolved KLHK classes, in .style legend order. */
export function buildKlhkQml(resolved: Resolved, kind: Kind): string {
  const { field, classes } = resolved;
  if (!field && !resolved.flags) {
    return `<qgis><renderer-v2 type="singleSymbol"><symbols>${qmlSymbol("0", classes[0].symbol, kind)}</symbols></renderer-v2></qgis>`;
  }
  const rules: string[] = [];
  const symbols: string[] = [];
  const push = (label: string, filter: string, sym: KlhkSymbol) => {
    const i = symbols.length;
    rules.push(`<rule key="r${i}" symbol="${i}" label="${xmlEsc(label)}" filter="${xmlEsc(filter)}"/>`);
    symbols.push(qmlSymbol(String(i), sym, kind));
  };
  if (resolved.flags) {
    for (const c of classes) push(c.symbol.label, `"${c.flagField}" > 0`, c.symbol);
  } else {
    const order = new Map((KB.categories[resolved.category] ?? []).map((s, i) => [s.label, i]));
    const groups = new Map<string, { symbol: KlhkSymbol; values: unknown[] }>();
    for (const c of [...classes].sort((a, b) => (order.get(a.symbol.label) ?? 0) - (order.get(b.symbol.label) ?? 0))) {
      const g = groups.get(c.symbol.label) ?? { symbol: c.symbol, values: [] };
      g.values.push(c.value);
      groups.set(c.symbol.label, g);
    }
    const ref = `"${field!.replace(/"/g, '""')}"`;
    for (const [label, g] of groups) push(label, g.values.length === 1 ? `${ref} = ${literal(g.values[0])}` : `${ref} IN (${g.values.map(literal).join(", ")})`, g.symbol);
  }
  const i = symbols.length;
  rules.push(`<rule key="else" symbol="${i}" label="Lainnya" filter="ELSE"/>`);
  symbols.push(qmlSymbol(String(i), ELSE_SYMBOL, kind));
  return `<qgis><renderer-v2 type="RuleRenderer"><rules key="root">${rules.join("")}</rules><symbols>${symbols.join("")}</symbols></renderer-v2></qgis>`;
}

/** Apply the KLHK symbology to one layer; false when it is not a KLHK layer. */
export function applyKlhkSymbology(layer: GeoLibreLayer): boolean {
  const rule = findKlhkRule(layer.name);
  const features = layer.geojson?.features ?? [];
  if (!rule || !features.length) return false;
  const resolved = resolveKlhkClasses(rule, features);
  const result = createPluginLayerStyleActions().importLayerStyle(layer.id, buildKlhkQml(resolved, kindOf(features)));
  if (!result.ok) return false;
  const fresh = useAppStore.getState().layers.find((l) => l.id === layer.id);
  useAppStore.getState().updateLayer(layer.id, { metadata: { ...(fresh?.metadata ?? {}), [KLHK_METADATA_KEY]: rule.category } });
  return true;
}

/** Ribbon "Simbologi KLHK": (re)apply to every KLHK layer in the project. */
export function applyKlhkSymbologyToAll(): number {
  let n = 0;
  for (const layer of useAppStore.getState().layers) if (applyKlhkSymbology(layer)) n += 1;
  return n;
}

/**
 * Style KLHK layers once, when they are added. A layer that already carries the
 * metadata marker (e.g. reopened from a saved project) keeps its saved style.
 */
export function startKlhkAutoStyle(): () => void {
  const seen = new Set(useAppStore.getState().layers.map((l) => l.id));
  return useAppStore.subscribe((state) => {
    for (const layer of state.layers) {
      if (seen.has(layer.id) || !layer.geojson?.features.length) continue;
      seen.add(layer.id);
      if ((layer.metadata as Record<string, unknown> | undefined)?.[KLHK_METADATA_KEY]) continue;
      if (findKlhkRule(layer.name)) queueMicrotask(() => applyKlhkSymbology(layer));
    }
  });
}
