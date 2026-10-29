import { useAppStore } from "@geolibre/core";
import { rasterCalc, readRasterData, writeRasterData, type RasterData } from "@geolibre/processing";
import { Button, cn, Input } from "@geolibre/ui";
import { Cog, FolderOpen, Loader2, Play, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { loadDroppedRasterFiles } from "../../lib/file-io/raster-photo-files";
import { readLocalFileBytes } from "../../lib/file-io/local-fs";
import { useProcessNotifier } from "../../lib/process-notify";
import { getShellActions } from "../../lib/shell-actions";
import { isTauri } from "../../lib/tauri-io";

/** Open state of the ArcMap-style Raster Calculator (Defani edition). */
export const useRasterCalculator = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
export const openRasterCalculator = () => useRasterCalculator.getState().setOpen(true);

interface RasterSource {
  name: string;
  load: () => Promise<ArrayBuffer>;
}

const KEYPAD = [
  ["7", "8", "9", "/", "==", "!=", "&"],
  ["4", "5", "6", "*", ">", ">=", "|"],
  ["1", "2", "3", "-", "<", "<=", "~"],
  ["0", ".", "(", ")", "+", ","],
];

const FUNCTIONS: Array<{ group: string; items: Array<[name: string, snippet: string, help: string]> }> = [
  {
    group: "Conditional",
    items: [
      ["Con", "Con(, , )", "Con(condition, true value, false value): pick a value per cell."],
      ["SetNull", "SetNull(, )", "SetNull(condition, value): NoData where the condition is true, the value elsewhere."],
    ],
  },
  {
    group: "Math",
    items: [
      ["Abs", "Abs()", "Absolute value."],
      ["Exp", "Exp()", "e raised to the value."],
      ["Ln", "Ln()", "Natural logarithm."],
      ["Log10", "Log10()", "Base-10 logarithm."],
      ["Power", "Power(, )", "Power(base, exponent)."],
      ["Sqrt", "Sqrt()", "Square root."],
      ["Min", "Min(, )", "Smaller of two values."],
      ["Max", "Max(, )", "Larger of two values."],
      ["Int", "Int()", "Truncate to a whole number."],
      ["Float", "Float()", "Keep decimals (all maths is floating point)."],
    ],
  },
  {
    group: "Trigonometric",
    items: [
      ["Sin", "Sin()", "Sine (radians)."],
      ["Cos", "Cos()", "Cosine (radians)."],
      ["Tan", "Tan()", "Tangent (radians)."],
    ],
  },
];

/**
 * Translate an ArcMap Map Algebra expression ("Layer" refs, Con, SetNull, Ln,
 * ...) into the band expression the raster engine evaluates (A1, A2, where,
 * log, ...). Returns the expression and the layers it uses, in band order.
 */
export function translateMapAlgebra(expression: string, known: string[]): { expr: string; used: string[] } {
  const used: string[] = [];
  let expr = expression.replace(/"([^"]+)"/g, (_, name: string) => {
    if (!known.includes(name)) throw new Error(`Unknown raster "${name}". Double-click a layer to insert it.`);
    let index = used.indexOf(name);
    if (index < 0) index = used.push(name) - 1;
    return `A${index + 1}`;
  });
  const fn = (name: string, to: string) => {
    expr = expr.replace(new RegExp(`\\b${name}\\s*\\(`, "gi"), to);
  };
  // SetNull(condition, value): NoData (0 / 0) where the condition holds.
  expr = expr.replace(/\bSetNull\s*\(([^,()]+),([^()]+)\)/gi, "where($1, 0 / 0, $2)");
  fn("Con", "where(");
  fn("Abs", "abs(");
  fn("Exp", "exp(");
  fn("Ln", "log(");
  fn("Sqrt", "sqrt(");
  fn("Min", "minimum(");
  fn("Max", "maximum(");
  fn("Sin", "sin(");
  fn("Cos", "cos(");
  fn("Tan", "tan(");
  fn("Float", "(");
  // Log10 / Power / Int as plain maths.
  expr = expr.replace(/\bLog10\s*\(([^()]*)\)/gi, "(log($1) / 2.302585092994046)");
  expr = expr.replace(/\bPower\s*\(([^(),]*),([^(),]*)\)/gi, "(($1) ** ($2))");
  expr = expr.replace(/\bInt\s*\(([^()]*)\)/gi, "(($1) - ($1) % 1)");
  // ArcMap logical operators: & | ~ (and, or, not).
  expr = expr.replace(/~/g, "!");
  return { expr, used };
}

/**
 * ArcMap-style Raster Calculator (Defani edition): layers and variables on the
 * left, a keypad of operators, Map Algebra functions, and the expression box —
 * evaluated in the app across several rasters of the same grid.
 */
export function RasterCalculatorWindow() {
  const { open, setOpen } = useRasterCalculator();
  const layers = useAppStore((s) => s.layers);
  const [extra, setExtra] = useState<RasterSource[]>([]);
  const [expression, setExpression] = useState("");
  const [outputName, setOutputName] = useState("rastercalc");
  const [help, setHelp] = useState("Build an expression from the layers, operators and functions, then press Run.");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [pos, setPos] = useState({ x: 120, y: 90 });
  const exprRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useProcessNotifier("Raster Calculator", running, !!error && !running, error);

  const sources = useMemo<RasterSource[]>(() => {
    const fromMap = layers
      .filter((layer) => layer.sourcePath && /\.tiff?$/i.test(layer.sourcePath))
      .map((layer) => ({
        name: layer.name,
        load: async () => (await readLocalFileBytes(layer.sourcePath!)).buffer as ArrayBuffer,
      }));
    return [...fromMap, ...extra.filter((e) => !fromMap.some((m) => m.name === e.name))];
  }, [layers, extra]);

  if (!open) return null;

  const insert = (text: string) => {
    const el = exprRef.current;
    const start = el?.selectionStart ?? expression.length;
    const end = el?.selectionEnd ?? expression.length;
    const next = expression.slice(0, start) + text + expression.slice(end);
    setExpression(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = start + (text.includes("(") ? text.indexOf("(") + 1 : text.length);
      el?.setSelectionRange(caret, caret);
    });
  };

  const addFiles = async () => {
    if (isTauri()) {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const picked = await pick({ multiple: true, filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }] });
      const paths = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(String);
      setExtra((current) => [
        ...current,
        ...paths.map((path) => ({
          name: path.split(/[\\/]/).pop()!.replace(/\.tiff?$/i, ""),
          load: async () => (await readLocalFileBytes(path)).buffer as ArrayBuffer,
        })),
      ]);
    } else {
      fileRef.current?.click();
    }
  };

  const run = async () => {
    setError(null);
    setLog([]);
    setRunning(true);
    try {
      const { expr, used } = translateMapAlgebra(expression, sources.map((s) => s.name));
      if (!used.length) throw new Error('Insert at least one raster, e.g. ("B8" - "B4") / ("B8" + "B4").');
      setLog((l) => [...l, `Expression: ${expr}`]);
      const rasters: RasterData[] = [];
      for (const name of used) {
        setLog((l) => [...l, `Reading ${name}…`]);
        const source = sources.find((s) => s.name === name)!;
        rasters.push(await readRasterData(await source.load()));
      }
      const first = rasters[0];
      for (const [index, raster] of rasters.entries()) {
        if (raster.width !== first.width || raster.height !== first.height) {
          throw new Error(
            `"${used[index]}" is ${raster.width}×${raster.height} but "${used[0]}" is ${first.width}×${first.height}. All rasters must share one grid.`,
          );
        }
      }
      const stacked: RasterData = { ...first, bands: rasters.map((r) => r.bands[0]) };
      const result = rasterCalc(stacked, { expression: expr });
      const bytes = writeRasterData(result);
      const name = `${outputName.trim() || "rastercalc"}.tif`;
      await getShellActions()?.addDroppedRasters(
        loadDroppedRasterFiles([new File([bytes], name, { type: "image/tiff" })]),
      );
      setLog((l) => [...l, `Done: ${first.width}×${first.height} cells → "${name}" added to Contents.`]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-label="Raster Calculator"
      className="qgis-alg fixed z-[45] flex w-[820px] max-w-[96vw] flex-col overflow-hidden rounded-md border bg-background text-[12.5px] shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="flex cursor-move select-none items-center gap-2 border-b bg-muted/70 px-3 py-1.5"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const start = { x: e.clientX - pos.x, y: e.clientY - pos.y };
          const move = (ev: PointerEvent) => setPos({ x: Math.max(0, ev.clientX - start.x), y: Math.max(0, ev.clientY - start.y) });
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <Cog className="h-4 w-4 text-[#4a8a3c]" />
        <span className="flex-1 font-semibold">Raster Calculator</span>
        <button type="button" aria-label="Close" className="rounded p-0.5 hover:bg-accent" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-3 p-3">
        {/* Map Algebra expression builder */}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-xs font-semibold">Map Algebra expression</div>
          <div className="grid grid-cols-[1fr_auto_150px] gap-2">
            <div className="flex min-h-0 flex-col rounded border">
              <div className="flex items-center justify-between border-b bg-muted/50 px-2 py-1 text-[11px] font-semibold">
                Layers and variables
                <button type="button" className="flex items-center gap-1 font-normal text-primary hover:underline" onClick={() => void addFiles()}>
                  <FolderOpen className="h-3 w-3" /> Add…
                </button>
              </div>
              <ul className="h-40 overflow-auto py-1">
                {sources.length === 0 ? (
                  <li className="px-2 py-1 text-[11px] text-muted-foreground">Add GeoTIFF rasters to the map or with “Add…”.</li>
                ) : (
                  sources.map((s) => (
                    <li key={s.name}>
                      <button
                        type="button"
                        className="w-full truncate px-2 py-0.5 text-start hover:bg-[#e5f1fb] dark:hover:bg-accent"
                        title="Double-click to insert"
                        onDoubleClick={() => insert(`"${s.name}"`)}
                      >
                        {s.name}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div className="grid content-start gap-1" onMouseOver={() => setHelp("Operators: arithmetic, comparison (==, !=, >, <) and logical & (and), | (or), ~ (not).")}>
              {KEYPAD.map((row, r) => (
                <div key={r} className="flex gap-1">
                  {row.map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={cn(
                        "h-7 min-w-8 rounded border bg-background px-1.5 font-mono text-[12px] hover:bg-accent",
                        /\d|\./.test(key) && "bg-muted/40",
                      )}
                      onClick={() => insert(/^[\d.(),]$/.test(key) ? key : ` ${key} `)}
                    >
                      {key}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex min-h-0 flex-col rounded border">
              <div className="border-b bg-muted/50 px-2 py-1 text-[11px] font-semibold">Functions</div>
              <ul className="h-40 overflow-auto py-1">
                {FUNCTIONS.map((group) => (
                  <li key={group.group}>
                    <div className="px-2 pt-1 text-[10.5px] font-semibold uppercase text-muted-foreground">{group.group}</div>
                    {group.items.map(([name, snippet, text]) => (
                      <button
                        key={name}
                        type="button"
                        className="block w-full px-3 py-0.5 text-start hover:bg-[#e5f1fb] dark:hover:bg-accent"
                        onMouseOver={() => setHelp(text)}
                        onDoubleClick={() => insert(snippet)}
                      >
                        {name}
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <textarea
            ref={exprRef}
            aria-label="Expression"
            className="h-20 w-full rounded border bg-background p-2 font-mono text-[12.5px] outline-none focus:ring-1 focus:ring-ring"
            placeholder={'("PostFire_Band_B8A" - "PostFire_Band_B12") / ("PostFire_Band_B8A" + "PostFire_Band_B12")'}
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">Output raster</span>
            <Input className="h-7 w-56 text-xs" value={outputName} onChange={(e) => setOutputName(e.target.value)} />
            <span className="text-[11px] text-muted-foreground">.tif, added to Contents</span>
          </div>
          {log.length || error ? (
            <div className="max-h-20 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px]">
              {log.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              {error ? <div className="text-destructive">Error: {error}</div> : null}
            </div>
          ) : null}
        </div>
        {/* Tool help, like ArcMap's "Show Help" pane */}
        <aside className="w-[190px] shrink-0 rounded border bg-muted/40 p-2 text-[11.5px] leading-relaxed">
          <h3 className="mb-1 text-[12.5px] font-semibold">Raster Calculator</h3>
          <p className="text-muted-foreground">{help}</p>
          <p className="mt-2 border-t pt-2 text-muted-foreground">
            Example (NBR):<br />
            <code className="text-[10.5px]">("B8A" - "B12") / ("B8A" + "B12")</code>
          </p>
        </aside>
      </div>

      <div className="flex items-center justify-end gap-2 border-t bg-muted/40 px-3 py-2">
        <input
          ref={fileRef}
          type="file"
          accept=".tif,.tiff"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            setExtra((current) => [
              ...current,
              ...files.map((file) => ({ name: file.name.replace(/\.tiff?$/i, ""), load: () => file.arrayBuffer() })),
            ]);
            e.target.value = "";
          }}
        />
        <Button size="sm" className="gap-1.5" disabled={running || !expression.trim()} onClick={() => void run()}>
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </div>,
    document.body,
  );
}
