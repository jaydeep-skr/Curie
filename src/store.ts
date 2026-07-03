import { create } from 'zustand';
import type { FileEditProposal, HistorySession } from '../server/ragService.js';

export type Message = {
  role: 'user' | 'assistant';
  content: string;
  sources?: { sourcePath: string; score: number; preview: string }[];
  editProposal?: FileEditProposal;
};

export type Settings = {
  ollamaHost: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
  modelProvider: 'ollama' | 'openai' | 'anthropic' | 'gemini';
  apiKey: string;
  vaultPath: string;
  maxChunkSize: number;
  chunkOverlap: number;
  topK: number;
};

export type Panel = 'chat' | 'history' | 'settings';
export type AppScreen = 'loading' | 'app';

type CurieState = {
  // app lifecycle
  screen: AppScreen;
  setScreen: (s: AppScreen) => void;

  // layout
  sidebarOpen: boolean;
  activePanel: Panel;
  setSidebarOpen: (v: boolean) => void;
  setActivePanel: (p: Panel) => void;

  // current session
  sessionId: string | null;
  messages: Message[];
  busy: boolean;
  setBusy: (v: boolean) => void;
  addMessage: (m: Message) => void;
  setSessionId: (id: string | null) => void;
  clearMessages: () => void;

  // vault stats
  stats: { indexedFiles: number; indexedChunks: number; lastIndexedAt: string | null };
  setStats: (s: CurieState['stats']) => void;

  // history
  historySessions: HistorySession[];
  setHistorySessions: (sessions: HistorySession[]) => void;
  loadSession: (session: HistorySession) => void;
  deleteHistorySession: (id: string) => void;

  // settings
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;

  // approval queue for file edits
  pendingEdit: FileEditProposal | null;
  setPendingEdit: (edit: FileEditProposal | null) => void;

  // global error / toast
  toast: { message: string; kind: 'error' | 'success' | 'info' } | null;
  setToast: (t: CurieState['toast']) => void;
};

const defaultSettings: Settings = {
  ollamaHost: 'http://localhost:11434',
  ollamaModel: 'llama3.1:8b',
  ollamaEmbedModel: 'nomic-embed-text',
  modelProvider: 'ollama',
  apiKey: '',
  vaultPath: '',
  maxChunkSize: 1200,
  chunkOverlap: 200,
  topK: 6,
};

export const useCurieStore = create<CurieState>((set, get) => ({
  screen: 'loading',
  setScreen: (screen) => set({ screen }),

  sidebarOpen: true,
  activePanel: 'chat',
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setActivePanel: (p) => set({ activePanel: p }),

  sessionId: null,
  messages: [],
  busy: false,
  setBusy: (busy) => set({ busy }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setSessionId: (id) => set({ sessionId: id }),
  clearMessages: () => set({ messages: [], sessionId: null }),

  stats: { indexedFiles: 0, indexedChunks: 0, lastIndexedAt: null },
  setStats: (stats) => set({ stats }),

  historySessions: [],
  setHistorySessions: (sessions) => set({ historySessions: sessions }),
  loadSession: (session) => set({
    sessionId: session.id,
    activePanel: 'chat',
    messages: session.turns.map((t) => ({ role: t.role, content: t.content })),
  }),
  deleteHistorySession: (id) => set((s) => ({
    historySessions: s.historySessions.filter((h) => h.id !== id),
    ...(s.sessionId === id ? { sessionId: null, messages: [] } : {})
  })),

  settings: defaultSettings,
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  pendingEdit: null,
  setPendingEdit: (edit) => set({ pendingEdit: edit }),

  toast: null,
  setToast: (toast) => {
    set({ toast });
    if (toast) setTimeout(() => { if (get().toast === toast) set({ toast: null }); }, 4000);
  },
}));
