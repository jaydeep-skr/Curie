import { create } from 'zustand';
import type { FileEditProposal, HistorySession } from '../server/ragService.js';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  sources?: { sourcePath: string; score: number; preview: string }[];
  editProposal?: FileEditProposal;
  attachments?: { name: string; size: number; chunks: number }[];
  webPages?: { url: string; title: string; chunks: number }[];
};

export type Settings = {
  ollamaHost: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
  modelProvider: 'ollama' | 'ollama-cloud' | 'openai' | 'anthropic' | 'gemini';
  apiKey: string;
  ollamaCloudKey: string;
  ollamaCloudRegion: string;
  vaultPath: string;
  maxChunkSize: number;
  chunkOverlap: number;
  topK: number;
};

export type Panel = 'chat' | 'history' | 'settings';
export type AppScreen = 'loading' | 'app';

export type UploadedAttachment = {
  name: string;
  size: number;
  chunks: number;
};

export type FetchedPage = {
  url: string;
  title: string;
  contentLength: number;
  chunks: number;
};

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
  streamingMessageId: string | null;
  setBusy: (v: boolean) => void;
  addMessage: (m: Message) => void;
  updateMessage: (id: string, patch: Partial<Message>) => void;
  appendToMessage: (id: string, token: string) => void;
  setSessionId: (id: string | null) => void;
  clearMessages: () => void;

  // composer attachments (pending for the next message)
  pendingAttachments: UploadedAttachment[];
  pendingPages: FetchedPage[];
  addPendingAttachment: (a: UploadedAttachment) => void;
  addPendingPage: (p: FetchedPage) => void;
  clearPendingContext: () => void;

  // web context (accumulated fetched page text for current session)
  webContextText: string;
  appendWebContext: (text: string) => void;
  clearWebContext: () => void;

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

  // server status
  serverOk: boolean;
  setServerOk: (v: boolean) => void;
};

const defaultSettings: Settings = {
  ollamaHost: 'http://localhost:11434',
  ollamaModel: 'llama3.1:8b',
  ollamaEmbedModel: 'nomic-embed-text',
  modelProvider: 'ollama',
  apiKey: '',
  ollamaCloudKey: '',
  ollamaCloudRegion: 'us-east-1',
  vaultPath: '',
  maxChunkSize: 1200,
  chunkOverlap: 200,
  topK: 6,
};

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

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
  streamingMessageId: null,
  setBusy: (busy) => set({ busy }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  updateMessage: (id, patch) => set((s) => ({
    messages: s.messages.map((m) => m.id === id ? { ...m, ...patch } : m)
  })),
  appendToMessage: (id, token) => set((s) => ({
    messages: s.messages.map((m) =>
      m.id === id ? { ...m, content: m.content + token } : m
    )
  })),
  setSessionId: (id) => set({ sessionId: id }),
  clearMessages: () => set({ messages: [], sessionId: null, pendingAttachments: [], pendingPages: [], webContextText: '' }),

  pendingAttachments: [],
  pendingPages: [],
  addPendingAttachment: (a) => set((s) => ({ pendingAttachments: [...s.pendingAttachments, a] })),
  addPendingPage: (p) => set((s) => ({ pendingPages: [...s.pendingPages, p] })),
  clearPendingContext: () => set({ pendingAttachments: [], pendingPages: [] }),

  webContextText: '',
  appendWebContext: (text) => set((s) => ({ webContextText: s.webContextText + '\n\n' + text })),
  clearWebContext: () => set({ webContextText: '' }),

  stats: { indexedFiles: 0, indexedChunks: 0, lastIndexedAt: null },
  setStats: (stats) => set({ stats }),

  historySessions: [],
  setHistorySessions: (sessions) => set({ historySessions: sessions }),
  loadSession: (session) => set({
    sessionId: session.id,
    activePanel: 'chat',
    messages: session.turns.map((t, i) => ({
      id: `loaded-${i}`,
      role: t.role,
      content: t.content,
    })),
    pendingAttachments: [],
    pendingPages: [],
    webContextText: '',
  }),
  deleteHistorySession: (id) => set((s) => ({
    historySessions: s.historySessions.filter((h) => h.id !== id),
    ...(s.sessionId === id ? { sessionId: null, messages: [], webContextText: '' } : {})
  })),

  settings: defaultSettings,
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  pendingEdit: null,
  setPendingEdit: (edit) => set({ pendingEdit: edit }),

  toast: null,
  setToast: (toast) => {
    if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
    set({ toast });
    if (toast) {
      _toastTimer = setTimeout(() => {
        if (get().toast === toast) set({ toast: null });
      }, 4500);
    }
  },

  serverOk: true,
  setServerOk: (v) => set({ serverOk: v }),
}));
