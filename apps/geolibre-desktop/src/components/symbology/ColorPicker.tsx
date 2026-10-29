// Colour picker (Defani edition), ArcMap / QGIS style: a palette of colour
// squares, a round HSV colour wheel with a brightness slider, HEX / RGB / HSV
// fields, "No Color" and the recently used colours.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hslToHex } from "../../lib/color-palettes";

export const NO_COLOR = "transparent";

// ---------------------------------------------------------------- colour maths
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0) as [number, number, number];
}
const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// ---------------------------------------------------------------- ArcMap-like palette (12 x 10)
const PALETTE: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 12; i++) out.push(hslToHex(0, 0, 100 - (i * 100) / 11));
  const hues = [0, 18, 35, 52, 75, 110, 150, 180, 200, 222, 265, 305];
  const rows: Array<[number, number]> = [[90, 92], [80, 84], [75, 74], [80, 62], [85, 50], [90, 40], [80, 30], [70, 22], [55, 15]];
  for (const [s, l] of rows) for (const h of hues) out.push(hslToHex(h, s, l));
  return out;
})();

const RECENT_KEY = "tfg-recent-colors";
const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
};
const pushRecent = (hex: string) => {
  try {
    const next = [hex, ...readRecent().filter((c) => c !== hex)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // private mode
  }
};

// ---------------------------------------------------------------- wheel
function ColorWheel({ hsv, onChange }: { hsv: [number, number, number]; onChange: (hsv: [number, number, number]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const SIZE = 168;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(SIZE, SIZE);
    const r0 = SIZE / 2;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const dx = x - r0, dy = y - r0, d = Math.hypot(dx, dy);
        const i = (y * SIZE + x) * 4;
        if (d > r0) { img.data[i + 3] = 0; continue; }
        const h = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
        const [r, g, b] = hsvToRgb(h, d / r0, hsv[2]);
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [hsv[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const dx = e.clientX - rect.left - SIZE / 2, dy = e.clientY - rect.top - SIZE / 2;
    const s = Math.min(1, Math.hypot(dx, dy) / (SIZE / 2));
    const h = (Math.atan2(dy, dx) * 180) / Math.PI + 180;
    onChange([h, s, hsv[2] || 1]);
  };
  const angle = ((hsv[0] - 180) * Math.PI) / 180;
  const kx = SIZE / 2 + Math.cos(angle) * hsv[1] * (SIZE / 2);
  const ky = SIZE / 2 + Math.sin(angle) * hsv[1] * (SIZE / 2);
  return (
    <div className="cp-wheel" style={{ width: SIZE, height: SIZE }}>
      <canvas
        ref={ref}
        width={SIZE}
        height={SIZE}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); pick(e); }}
        onPointerMove={(e) => e.buttons && pick(e)}
      />
      <span className="cp-knob" style={{ left: kx, top: ky }} />
    </div>
  );
}

// ---------------------------------------------------------------- panel
export function ColorPanel({ value, onChange, allowNone = true }: { value: string; onChange: (c: string) => void; allowNone?: boolean }) {
  const isNone = value === NO_COLOR || !value;
  const hex = isNone ? "#ffffff" : value.startsWith("#") ? value : "#000000";
  const [hsv, setHsv] = useState<[number, number, number]>(() => rgbToHsv(...hexToRgb(hex)));
  const [hexText, setHexText] = useState(hex);
  const [mode, setMode] = useState<"palette" | "wheel">("palette");
  const recent = useMemo(readRecent, []);
  useEffect(() => {
    setHexText(hex);
    setHsv(rgbToHsv(...hexToRgb(hex)));
  }, [hex]);
  const commit = (c: string) => {
    if (c !== NO_COLOR) pushRecent(c);
    onChange(c);
  };
  const fromHsv = (next: [number, number, number]) => {
    setHsv(next);
    commit(rgbToHex(...hsvToRgb(...next)));
  };
  const [r, g, b] = hexToRgb(hex);
  return (
    <div className="cp-panel">
      <div className="cp-tabs">
        <button type="button" className={mode === "palette" ? "on" : ""} onClick={() => setMode("palette")}>Palette</button>
        <button type="button" className={mode === "wheel" ? "on" : ""} onClick={() => setMode("wheel")}>Colour wheel</button>
        {allowNone ? (
          <button type="button" className={`cp-none ${isNone ? "on" : ""}`} onClick={() => commit(NO_COLOR)} title="No Color (transparent)">No Color</button>
        ) : null}
      </div>
      {mode === "palette" ? (
        <div className="cp-grid">
          {PALETTE.map((c) => (
            <button key={c} type="button" title={c} className={c === hex ? "on" : ""} style={{ background: c }} onClick={() => commit(c)} />
          ))}
        </div>
      ) : (
        <div className="cp-wheelrow">
          <ColorWheel hsv={hsv} onChange={fromHsv} />
          <input
            type="range"
            className="cp-bright"
            min={0}
            max={100}
            value={Math.round(hsv[2] * 100)}
            onChange={(e) => fromHsv([hsv[0], hsv[1], Number(e.target.value) / 100])}
            title="Brightness"
            style={{ background: `linear-gradient(to top, #000, ${rgbToHex(...hsvToRgb(hsv[0], hsv[1], 1))})` }}
          />
        </div>
      )}
      {recent.length ? (
        <div className="cp-recent">
          <span>Recent</span>
          {recent.map((c) => <button key={c} type="button" title={c} style={{ background: c }} onClick={() => commit(c)} />)}
        </div>
      ) : null}
      <div className="cp-fields">
        <span className="cp-preview" style={{ background: isNone ? undefined : hex }} data-none={isNone || undefined} />
        <label>HEX<input value={hexText} onChange={(e) => setHexText(e.target.value)} onBlur={() => /^#?[0-9a-f]{3,6}$/i.test(hexText) && commit(`#${hexText.replace("#", "").padEnd(6, "0").slice(0, 6)}`)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></label>
        {(["R", "G", "B"] as const).map((k, i) => (
          <label key={k}>{k}<input type="number" min={0} max={255} value={[r, g, b][i]} onChange={(e) => { const v = [r, g, b]; v[i] = Number(e.target.value); commit(rgbToHex(v[0], v[1], v[2])); }} /></label>
        ))}
        <label>H<input type="number" min={0} max={360} value={Math.round(hsv[0])} onChange={(e) => fromHsv([Number(e.target.value), hsv[1], hsv[2]])} /></label>
        <label>S<input type="number" min={0} max={100} value={Math.round(hsv[1] * 100)} onChange={(e) => fromHsv([hsv[0], Number(e.target.value) / 100, hsv[2]])} /></label>
        <label>V<input type="number" min={0} max={100} value={Math.round(hsv[2] * 100)} onChange={(e) => fromHsv([hsv[0], hsv[1], Number(e.target.value) / 100])} /></label>
      </div>
    </div>
  );
}

/** A colour swatch button that opens the picker in a floating panel. */
export function ColorButton({ value, onChange, allowNone = true, title }: { value: string; onChange: (c: string) => void; allowNone?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const r = btn.current!.getBoundingClientRect();
    const left = Math.min(window.innerWidth - 300, r.left);
    const top = r.bottom + 360 > window.innerHeight ? Math.max(8, r.top - 360) : r.bottom + 4;
    setPos({ left, top });
    const onDown = (e: MouseEvent) => {
      if (!btn.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const none = value === NO_COLOR || !value;
  return (
    <>
      <button ref={btn} type="button" className="cp-swatch" title={title ?? value} data-none={none || undefined} style={{ background: none ? undefined : value }} onClick={() => setOpen((o) => !o)}>
        <span className="cp-caret">▾</span>
      </button>
      {open
        ? createPortal(
            <div ref={pop} className="cp-pop" style={{ left: pos.left, top: pos.top }}>
              <ColorPanel value={value} onChange={onChange} allowNone={allowNone} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
