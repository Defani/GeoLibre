// Processing notifications (Defani edition): every tool run shows a card in the
// bottom-right corner with a running progress bar, then a "finished" or a red
// error card — like QGIS's message bar plus the task manager.

import { useEffect, useRef } from "react";
import { create } from "zustand";

export interface ProcessNotice {
  id: string;
  title: string;
  status: "running" | "done" | "failed";
  message?: string;
  startedAt: number;
}

interface ProcessNoticeState {
  notices: ProcessNotice[];
  upsert: (notice: ProcessNotice) => void;
  dismiss: (id: string) => void;
}

export const useProcessNotices = create<ProcessNoticeState>((set) => ({
  notices: [],
  upsert: (notice) =>
    set((state) => {
      const rest = state.notices.filter((n) => n.id !== notice.id);
      return { notices: [...rest, notice].slice(-5) };
    }),
  dismiss: (id) => set((state) => ({ notices: state.notices.filter((n) => n.id !== id) })),
}));

let counter = 0;

/**
 * Report a tool's run state: a running card while `running`, then a finished
 * card (auto-hidden after a few seconds) or an error card that stays until it
 * is closed.
 */
export function useProcessNotifier(
  title: string,
  running: boolean,
  failed: boolean,
  errorMessage?: string | null,
): void {
  const idRef = useRef<string | null>(null);
  const wasRunning = useRef(false);
  useEffect(() => {
    const { upsert, dismiss } = useProcessNotices.getState();
    if (running && !wasRunning.current) {
      idRef.current = `process-${++counter}`;
      upsert({ id: idRef.current, title, status: "running", startedAt: Date.now() });
    } else if (!running && wasRunning.current && idRef.current) {
      const id = idRef.current;
      const started = useProcessNotices.getState().notices.find((n) => n.id === id)?.startedAt ?? Date.now();
      if (failed) {
        upsert({ id, title, status: "failed", message: errorMessage ?? "The process failed. See the Log tab.", startedAt: started });
      } else {
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        upsert({ id, title, status: "done", message: `Finished in ${seconds} s`, startedAt: started });
        window.setTimeout(() => dismiss(id), 5000);
      }
    }
    wasRunning.current = running;
  }, [running, failed, errorMessage, title]);
}

/** One-off message card: green "done" (auto-hides) or a red error that stays. */
export function notifyProcess(notice: { kind: "success" | "error"; title: string; message: string }): void {
  const { upsert, dismiss } = useProcessNotices.getState();
  const id = `notice-${++counter}`;
  upsert({ id, title: notice.title, status: notice.kind === "error" ? "failed" : "done", message: notice.message, startedAt: Date.now() });
  if (notice.kind === "success") window.setTimeout(() => dismiss(id), 5000);
}
