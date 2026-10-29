// Symbol Selector (Defani edition), like ArcMap's: the gallery on the left
// (search, groups, My symbols), the current symbol and its properties on the
// right, plus SVG upload and font-glyph markers.

import type { LayerStyle } from "@geolibre/core";
import { Search, Upload, Type, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  GALLERY,
  removeUserSymbol,
  saveUserSymbol,
  symbolFromGlyph,
  symbolFromSvg,
  symbolPreview,
  userSymbols,
  type GallerySymbol,
  type SymbolKind,
} from "../../lib/symbol-gallery";
import { ColorButton, NO_COLOR } from "./ColorPicker";

export const DASHES: Array<[string, number[]]> = [
  ["Solid", []],
  ["Dashed", [4, 2]],
  ["Long dash", [8, 3]],
  ["Dotted", [0.5, 2]],
  ["Dash dot", [5, 2, 1, 2]],
  ["Dash dot dot", [6, 2, 1, 2, 1, 2]],
  ["Short dash", [2, 2]],
];

const dashKey = (d?: number[]) => DASHES.find(([, v]) => JSON.stringify(v) === JSON.stringify(d ?? []))?.[0] ?? "Solid";

export function SymbolSwatch({ kind, style, size = 44 }: { kind: SymbolKind; style: Partial<LayerStyle>; size?: number }) {
  const markup = symbolPreview({ id: "", name: "", kind, group: "", style });
  return <span className="sym-swatch" style={{ width: size, height: size * (kind === "point" ? 1 : 0.75) }} dangerouslySetInnerHTML={{ __html: markup }} />;
}

/** Symbol properties (right side of the selector, also used inline). */
export function SymbolEditor({ kind, style, onChange }: { kind: SymbolKind; style: Partial<LayerStyle>; onChange: (patch: Partial<LayerStyle>) => void }) {
  const fillNone = (style.fillOpacity ?? 1) === 0;
  return (
    <div className="sym-props">
      {kind === "fill" ? (
        <>
          <label>Fill type
            <select value={style.fillPattern === "svg" ? "texture" : style.fillPattern && style.fillPattern !== "none" ? "pattern" : "color"} onChange={(e) => {
              const v = e.target.value;
              onChange(v === "color" ? { fillPattern: "none" } : v === "pattern" ? { fillPattern: "hatch", fillPatternColor: style.fillPatternColor ?? "#212121" } : { fillPattern: "svg" });
            }}>
              <option value="color">Color fill</option>
              <option value="pattern">Pattern fill (hatch, cross, dots…)</option>
              <option value="texture">Texture / picture fill (SVG)</option>
            </select>
          </label>
          <label>Fill color<ColorButton value={fillNone ? NO_COLOR : style.fillColor ?? "#cccccc"} onChange={(c) => onChange(c === NO_COLOR ? { fillOpacity: 0 } : { fillColor: c, fillOpacity: style.fillOpacity || 1 })} /></label>
          {style.fillPattern && style.fillPattern !== "none" && style.fillPattern !== "svg" ? (
            <>
              <label>Pattern
                <select value={style.fillPattern} onChange={(e) => onChange({ fillPattern: e.target.value as LayerStyle["fillPattern"] })}>
                  {["hatch", "cross-hatch", "horizontal", "vertical", "dots"].map((p) => <option key={p} value={p}>{p.replace("-", " ")}</option>)}
                </select>
              </label>
              <label>Pattern color<ColorButton value={style.fillPatternColor ?? "#212121"} allowNone={false} onChange={(c) => onChange({ fillPatternColor: c })} /></label>
            </>
          ) : null}
        </>
      ) : null}
      {kind === "point" ? (
        <>
          <label>Marker
            <select value={style.markerEnabled === false ? "circle-plain" : style.markerShape ?? "circle"} onChange={(e) => {
              const v = e.target.value;
              onChange(v === "circle-plain" ? { markerEnabled: false } : { markerEnabled: true, markerShape: v as LayerStyle["markerShape"] });
            }}>
              <option value="circle-plain">Simple circle</option>
              {["circle", "square", "triangle", "diamond", "star", "cross", "pin", "custom"].map((s) => <option key={s} value={s}>{s === "custom" ? "Picture / SVG / font" : s}</option>)}
            </select>
          </label>
          <label>Color<ColorButton value={style.markerColor ?? style.fillColor ?? "#e53935"} allowNone={false} onChange={(c) => onChange({ markerColor: c, fillColor: c })} /></label>
          <label>Size (px)<input type="number" min={2} max={128} value={style.markerEnabled === false ? (style.circleRadius ?? 6) * 2 : style.markerSize ?? 18} onChange={(e) => onChange(style.markerEnabled === false ? { circleRadius: Number(e.target.value) / 2 } : { markerSize: Number(e.target.value) })} /></label>
        </>
      ) : null}
      <label>{kind === "line" ? "Line color" : "Outline color"}<ColorButton value={(style.strokeWidth ?? 1) === 0 ? NO_COLOR : style.strokeColor ?? "#000000"} onChange={(c) => onChange(c === NO_COLOR ? { strokeWidth: 0 } : { strokeColor: c, strokeWidth: style.strokeWidth || 1 })} /></label>
      <label>{kind === "line" ? "Width (px)" : "Outline width"}<input type="number" min={0} max={40} step={0.1} value={style.strokeWidth ?? 1} onChange={(e) => onChange({ strokeWidth: Number(e.target.value) })} /></label>
      {kind !== "point" ? (
        <label>Line style
          <select value={dashKey(style.strokeDasharray)} onChange={(e) => onChange({ strokeDasharray: DASHES.find(([n]) => n === e.target.value)?.[1] ?? [] })}>
            {DASHES.map(([n]) => <option key={n}>{n}</option>)}
          </select>
        </label>
      ) : null}
      {kind === "line" ? (
        <label>Casing (edge)<ColorButton value={style.strokeCasingColor ?? NO_COLOR} onChange={(c) => onChange({ strokeCasingColor: c === NO_COLOR ? undefined : c })} /></label>
      ) : null}
      {kind !== "line" ? (
        <label>Transparency
          <span className="sym-range">
            <input type="range" min={0} max={100} value={Math.round((1 - (style.fillOpacity ?? 1)) * 100)} onChange={(e) => onChange({ fillOpacity: 1 - Number(e.target.value) / 100 })} />
            <em>{Math.round((1 - (style.fillOpacity ?? 1)) * 100)}%</em>
          </span>
        </label>
      ) : null}
    </div>
  );
}

function GlyphPicker({ onPick }: { onPick: (s: GallerySymbol) => void }) {
  const [font, setFont] = useState("Wingdings");
  const [color, setColor] = useState("#1e88e5");
  const chars = useMemo(() => Array.from({ length: 224 }, (_, i) => String.fromCharCode(33 + i)), []);
  return (
    <div className="sym-glyphs">
      <div className="flex items-center gap-2">
        <input list="sym-fonts" value={font} onChange={(e) => setFont(e.target.value)} className="sym-input" placeholder="Font name" />
        <datalist id="sym-fonts">
          {["Wingdings", "Wingdings 2", "Wingdings 3", "Webdings", "Segoe UI Symbol", "Segoe UI Emoji", "Segoe MDL2 Assets", "Symbol", "ESRI Default Marker", "ESRI Geometric Symbols", "ESRI Transportation & Municipal", "ESRI Environmental & Icons", "ESRI Business", "ESRI Crime Analysis", "ESRI North", "Arial"].map((f) => <option key={f} value={f} />)}
        </datalist>
        <ColorButton value={color} allowNone={false} onChange={setColor} />
      </div>
      <div className="sym-glyph-grid" style={{ fontFamily: `"${font}"` }}>
        {chars.map((c) => (
          <button key={c} type="button" title={`U+${c.charCodeAt(0).toString(16).toUpperCase()}`} style={{ color }} onClick={() => onPick(symbolFromGlyph(font, c, color))}>{c}</button>
        ))}
      </div>
    </div>
  );
}

export function SymbolSelector({ kind, initial, onApply, onClose }: { kind: SymbolKind; initial: Partial<LayerStyle>; onApply: (patch: Partial<LayerStyle>) => void; onClose: () => void }) {
  const [current, setCurrent] = useState<Partial<LayerStyle>>(initial);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [mine, setMine] = useState(userSymbols);
  const [glyphs, setGlyphs] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const all = useMemo(() => [...mine, ...GALLERY].filter((s) => s.kind === kind), [mine, kind]);
  const groups = useMemo(() => ["All", ...new Set(all.map((s) => s.group))], [all]);
  const shown = all.filter((s) => (group === "All" || s.group === group) && (!query || `${s.name} ${s.group} ${s.tags ?? ""}`.toLowerCase().includes(query.toLowerCase())));
  const pick = (s: GallerySymbol) => setCurrent((c) => ({ ...c, ...s.style }));
  const upload = async (file: File) => {
    const text = await file.text();
    if (!/<svg[\s>]/i.test(text)) return;
    const sym = symbolFromSvg(file.name.replace(/\.svg$/i, ""), text, kind === "fill" ? "fill" : "point");
    saveUserSymbol(sym);
    setMine(userSymbols());
    pick(sym);
  };
  return createPortal(
    <div className="sym-overlay" onMouseDown={onClose}>
      <div className="sym-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sym-head">
          <span>Symbol Selector — {kind === "fill" ? "Fill" : kind === "line" ? "Line" : "Marker"} symbols</span>
          <button type="button" onClick={onClose} title="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="sym-main">
          <div className="sym-left">
            <div className="sym-tools">
              <div className="sym-search"><Search className="h-3.5 w-3.5" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search symbols…" /></div>
              <select value={group} onChange={(e) => setGroup(e.target.value)} className="sym-input">
                {groups.map((g) => <option key={g}>{g}</option>)}
              </select>
            </div>
            {glyphs ? (
              <GlyphPicker onPick={(s) => { saveUserSymbol(s); setMine(userSymbols()); pick(s); setGlyphs(false); }} />
            ) : (
              <div className="sym-grid">
                {shown.map((s) => (
                  <button key={s.id} type="button" className="sym-cell" title={`${s.name} (${s.group})`} onClick={() => pick(s)} onDoubleClick={() => { onApply({ ...current, ...s.style }); onClose(); }}>
                    <SymbolSwatch kind={kind} style={s.style} />
                    <span>{s.name}</span>
                    {s.id.startsWith("user-") ? (
                      <i className="sym-del" title="Remove from My symbols" onClick={(e) => { e.stopPropagation(); removeUserSymbol(s.id); setMine(userSymbols()); }}><Trash2 className="h-3 w-3" /></i>
                    ) : null}
                  </button>
                ))}
                {!shown.length ? <p className="sym-empty">No symbols match.</p> : null}
              </div>
            )}
          </div>
          <div className="sym-right">
            <div className="sym-current">
              <div className="sym-cap">Current symbol</div>
              <SymbolSwatch kind={kind} style={current} size={110} />
            </div>
            <SymbolEditor kind={kind} style={current} onChange={(p) => setCurrent((c) => ({ ...c, ...p }))} />
            <div className="sym-actions">
              {kind !== "line" ? (
                <button type="button" className="lp-btn" onClick={() => fileRef.current?.click()}><Upload className="me-1 inline h-3.5 w-3.5" />Upload SVG…</button>
              ) : null}
              {kind === "point" ? (
                <button type="button" className={`lp-btn ${glyphs ? "primary" : ""}`} onClick={() => setGlyphs((g) => !g)}><Type className="me-1 inline h-3.5 w-3.5" />From font…</button>
              ) : null}
              <button type="button" className="lp-btn" onClick={() => { saveUserSymbol({ id: `user-${kind}-${Date.now().toString(36)}`, name: "My symbol", kind, group: "My symbols", style: current }); setMine(userSymbols()); }}>Save to My symbols</button>
            </div>
            <input ref={fileRef} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
          </div>
        </div>
        <div className="sym-foot">
          <button type="button" className="lp-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="lp-btn primary" onClick={() => { onApply(current); onClose(); }}>OK</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
