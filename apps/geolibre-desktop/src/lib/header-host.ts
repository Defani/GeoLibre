// Home tab host (Defani edition): when the Data View ribbon is shown, the
// top menu bar (Project, Edit, View, Add Data, Processing, …, Help) renders
// inside the ribbon's Home tab instead of a separate header row.

import { create } from "zustand";

interface HeaderHostState {
  host: HTMLElement | null;
  setHost: (host: HTMLElement | null) => void;
}

export const useHeaderHost = create<HeaderHostState>((set) => ({
  host: null,
  setHost: (host) => set({ host }),
}));
