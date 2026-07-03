import { create } from 'zustand';

export type Message = {
  role: 'user' | 'assistant';
  content: string;
  sources?: { sourcePath: string; score: number; preview: string }[];
};

type CurieState = {
  messages: Message[];
  busy: boolean;
  stats: {
    indexedFiles: number;
    indexedChunks: number;
    lastIndexedAt: string | null;
  };
  setBusy: (busy: boolean) => void;
  addMessage: (message: Message) => void;
  setStats: (stats: CurieState['stats']) => void;
  clearMessages: () => void;
};

export const useCurieStore = create<CurieState>((set) => ({
  messages: [],
  busy: false,
  stats: {
    indexedFiles: 0,
    indexedChunks: 0,
    lastIndexedAt: null
  },
  setBusy: (busy) => set({ busy }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  setStats: (stats) => set({ stats }),
  clearMessages: () => set({ messages: [] })
}));
