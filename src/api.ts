import type { Settings } from './store';
import type { FileEditProposal } from '../server/ragService.js';

const BASE = '/api';

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      ...options,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
    return json as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Request timed out — the server took too long to respond.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
export const getHealth = () =>
  req<{ ok: boolean; stats: { indexedFiles: number; indexedChunks: number; lastIndexedAt: string | null } }>('/health');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export const getSettings = () => req<Settings>('/settings');

export const saveSettings = (patch: Partial<Settings>) =>
  req<{ ok: boolean; settings: Settings }>('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------
export const reindexVault = () =>
  req<{ indexedFiles: number; indexedChunks: number; lastIndexedAt: string }>('/index', { method: 'POST' });

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------
export const uploadFile = (file: File): Promise<{ ok: boolean; name: string; size: number; chunks: number }> => {
  const form = new FormData();
  form.append('file', file);
  return req('/upload', { method: 'POST', body: form });
};

// ---------------------------------------------------------------------------
// Web fetch
// ---------------------------------------------------------------------------
export const fetchAndIndexUrl = (url: string): Promise<{ ok: boolean; title: string; url: string; contentLength: number; chunks: number }> =>
  req('/web-fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

// ---------------------------------------------------------------------------
// Chat — streaming SSE
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: 'token'; token: string }
  | { type: 'done'; sessionId: string; sources: { sourcePath: string; score: number; preview: string }[] }
  | { type: 'error'; error: string };

export async function askCurieStream(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  sessionId: string | null | undefined,
  onEvent: (event: StreamEvent) => void,
  webContext?: string,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history, sessionId, webContext }),
    signal,
  });

  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(json.error ?? `Chat failed (${res.status})`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body for streaming');
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const lines = part.split('\n');
      let eventName = 'message';
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        if (line.startsWith('data: ')) dataStr = line.slice(6);
      }
      if (!dataStr) continue;
      try {
        const parsed = JSON.parse(dataStr) as Record<string, unknown>;
        if (eventName === 'token') onEvent({ type: 'token', token: parsed.token as string });
        else if (eventName === 'done') onEvent({ type: 'done', sessionId: parsed.sessionId as string, sources: parsed.sources as { sourcePath: string; score: number; preview: string }[] });
        else if (eventName === 'error') onEvent({ type: 'error', error: parsed.error as string });
      } catch { /* skip malformed */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Chat — non-streaming fallback
// ---------------------------------------------------------------------------
export const askCurie = (
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  sessionId?: string | null,
  webContext?: string
) =>
  req<{ answer: string; sources: { sourcePath: string; score: number; preview: string }[]; sessionId: string }>('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history, sessionId, webContext }),
  });

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
export const getHistory = () =>
  req<{ id: string; title: string; createdAt: string; updatedAt: string; turns: { role: string; content: string }[] }[]>('/history');

export const deleteHistorySession = (id: string) =>
  req<{ ok: boolean }>(`/history/${id}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// File edit
// ---------------------------------------------------------------------------
export const proposeFileEdit = (payload: {
  sessionId: string;
  filePath: string;
  description: string;
  proposedContent: string;
}) =>
  req<FileEditProposal>('/file-edit/propose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

export const applyFileEdit = (proposal: FileEditProposal) =>
  req<{ ok: boolean }>('/file-edit/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(proposal),
  });
