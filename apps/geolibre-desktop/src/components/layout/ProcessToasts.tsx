import { cn } from "@geolibre/ui";
import { CheckCircle2, Cog, X, XCircle } from "lucide-react";
import { useProcessNotices } from "../../lib/process-notify";

/** Bottom-right processing cards (Defani edition); see `lib/process-notify.ts`. */
export function ProcessToasts() {
  const notices = useProcessNotices((s) => s.notices);
  const dismiss = useProcessNotices((s) => s.dismiss);
  if (!notices.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-9 right-3 z-[80] flex w-80 flex-col gap-2" aria-live="polite">
      {notices.map((notice) => (
        <div
          key={notice.id}
          role={notice.status === "failed" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto overflow-hidden rounded-md border bg-card text-[12.5px] shadow-lg",
            notice.status === "failed" && "border-destructive/50",
          )}
        >
          <div className="flex items-start gap-2 px-3 py-2">
            {notice.status === "running" ? (
              <Cog className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#4a8a3c] [animation-duration:2.5s]" />
            ) : notice.status === "done" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{notice.title}</div>
              <div className={cn("text-[11.5px]", notice.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {notice.status === "running" ? "Running…" : notice.message}
              </div>
            </div>
            {notice.status !== "running" ? (
              <button type="button" aria-label="Dismiss" className="rounded p-0.5 hover:bg-accent" onClick={() => dismiss(notice.id)}>
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <div className="relative h-1 bg-muted">
            <div
              className={cn(
                "absolute inset-y-0 left-0",
                notice.status === "running" && "w-1/3 animate-[qgis-progress_1.2s_linear_infinite] bg-[#4a9a3c]",
                notice.status === "done" && "w-full bg-emerald-500",
                notice.status === "failed" && "w-full bg-destructive",
              )}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
