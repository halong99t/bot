import { create } from "zustand";
import type { Overview, Signal, Position } from "../types";

interface AppState {
  overview: Overview | null;
  signals: Signal[];
  positions: Position[];
  connected: boolean;
  lastScanAt: string | null;

  setOverview: (o: Overview) => void;
  setSignals: (s: Signal[]) => void;
  setPositions: (p: Position[]) => void;
  setConnected: (c: boolean) => void;

  addSignal: (s: Signal) => void;
  upsertPosition: (p: Partial<Position> & { id: number }) => void;
  setLastScan: (at: string) => void;
}

export const useStore = create<AppState>((set) => ({
  overview: null,
  signals: [],
  positions: [],
  connected: false,
  lastScanAt: null,

  setOverview: (overview) => set({ overview }),
  setSignals: (signals) => set({ signals }),
  setPositions: (positions) => set({ positions }),
  setConnected: (connected) => set({ connected }),

  addSignal: (s) => set((state) => ({ signals: [s, ...state.signals].slice(0, 100) })),
  upsertPosition: (p) =>
    set((state) => {
      const idx = state.positions.findIndex((x) => x.id === p.id);
      if (idx === -1) return state;
      const positions = [...state.positions];
      positions[idx] = { ...positions[idx], ...p };
      return { positions };
    }),
  setLastScan: (at) => set({ lastScanAt: at }),
}));
