import { Button, cn } from "@geolibre/ui";
import { Cog, Loader2, Play, Square, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useProcessNotifier } from "../../lib/process-notify";
import { ParamHelpPane, useParamHelp } from "./ParamHelp";

export type AlgorithmWindowTab = "parameters" | "log";

interface QgisAlgorithmWindowProps {
  /** Tool name, shown in the title bar and the help pane. */
  title: string;
  description: ReactNode;
  /** The Parameters tab body. */
  parameters: ReactNode;
  /** The Log tab body. */
  log: ReactNode;
  running: boolean;
  /** Last run failed: the progress bar turns red. */
  failed?: boolean;
  /** Whether a run has finished (fills the progress bar). */
  done?: boolean;
  runDisabled?: boolean;
  onRun: () => void;
  onCancel?: () => void;
  onClose: () => void;
  /** Changes when another tool is opened, resetting to the Parameters tab. */
  resetKey?: string | null;
  /** Extra footer buttons placed before Run (e.g. Download). */
  footerExtra?: ReactNode;
}

/**
 * QGIS-style algorithm window (Defani edition): a floating, draggable window
 * (the map stays usable) with Parameters / Log tabs, a help pane on the right,
 * and a progress bar with Run / Close along the bottom.
 */
export function QgisAlgorithmWindow({
  title,
  description,
  parameters,
  log,
  running,
  failed = false,
  done = false,
  runDisabled,
  onRun,
  onCancel,
  onClose,
  resetKey,
  footerExtra,
}: QgisAlgorithmWindowProps) {
  const [tab, setTab] = useState<AlgorithmWindowTab>("parameters");
  useProcessNotifier(title, running, failed);
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, Math.round(window.innerWidth / 2 - 390)),
    y: Math.max(16, Math.round(window.innerHeight / 2 - 260)),
  }));
  const paramHelp = useParamHelp();
  useEffect(() => {
    setTab("parameters");
    paramHelp.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  return createPortal(
    <div
      role="dialog"
      aria-label={title}
      className="qgis-alg fixed z-[45] flex h-[520px] max-h-[90vh] w-[780px] max-w-[96vw] flex-col overflow-hidden rounded-md border bg-background text-[13px] shadow-2xl"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="flex cursor-move select-none items-center gap-2 border-b bg-muted/70 px-3 py-1.5"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const start = { x: e.clientX - pos.x, y: e.clientY - pos.y };
          const move = (ev: PointerEvent) =>
            setPos({ x: Math.max(0, ev.clientX - start.x), y: Math.max(0, ev.clientY - start.y) });
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <Cog className="h-4 w-4 text-[#4a8a3c]" />
        <span className="flex-1 truncate font-semibold">{title}</span>
        <button type="button" aria-label="Close" className="rounded p-0.5 hover:bg-accent" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex border-b px-2 pt-1 text-xs">
        {(["parameters", "log"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "-mb-px rounded-t border border-b-0 px-3 py-1",
              tab === id
                ? "border-border bg-background font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {id === "parameters" ? "Parameters" : "Log"}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto p-3" {...paramHelp.handlers}>
          {tab === "parameters" ? (
            <div className="flex flex-col gap-3">{parameters}</div>
          ) : (
            <div className="min-h-full rounded border bg-muted/30 p-2 font-mono text-xs">{log}</div>
          )}
        </div>
        <ParamHelpPane title={title} description={description} help={paramHelp.help} className="w-[260px] shrink-0 border-s" />
      </div>

      <div className="flex items-center gap-2 border-t bg-muted/40 px-3 py-2">
        <div className="relative h-4 min-w-0 flex-1 overflow-hidden rounded-sm border bg-background">
          <div
            className={cn(
              "absolute inset-y-0 left-0 bg-[#4a9a3c] transition-all",
              running ? "w-1/3 animate-[qgis-progress_1.2s_linear_infinite]" : done || failed ? "w-full" : "w-0",
              failed && "bg-destructive",
            )}
          />
          <span className="absolute inset-0 text-center text-[10px] leading-4">
            {running ? "Running…" : failed ? "Failed — see Log" : done ? "100%" : "0%"}
          </span>
        </div>
        {footerExtra}
        {running && onCancel ? (
          <Button variant="outline" size="sm" onClick={onCancel} className="gap-1.5">
            <Square className="h-3.5 w-3.5" />
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={() => {
            setTab("log");
            onRun();
          }}
          disabled={running || runDisabled}
          className="gap-1.5"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>,
    document.body,
  );
}
