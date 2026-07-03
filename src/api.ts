import type { Settings } from './store';
import type { FileEditProposal } from '../server/ragService.js';

const BASE = '/api';

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}

// ---- health ---------------------------------------------------------------
export const getHealth = () =>
  req<{ ok: boolean; stats: { indexedFiles: number; indexedChunks: number; lastIndexedAt: string | null } }>('/health');

// ---- settings -------------------------------------------------------------
export const getSettings = () => req<Settings>('/settings');

export const saveSettings = (patch: Partial<Settings>) =>
  req<{ ok: boolean; settings: Settings }>('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

// ---- indexing -------------------------------------------------------------
export const reindexVault = () =>
  req<{ indexedFiles: number; indexedChunks: number; lastIndexedAt: string }>('/index', { method: 'POST' });

// ---- chat -----------------------------------------------------------------
export const askCurie = (
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  sessionId?: string | null
) =>
  req<{ answer: string; sources: { sourcePath: string; score: number; preview: string }[]; sessionId: string }>('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history, sessionId }),
  });

// ---- history --------------------------------------------------------------
export const getHistory = () =>
  req<{ id: string; title: string; createdAt: string; updatedAt: string; turns: { role: string; content: string }[] }[]>('/history');

export const deleteHistorySession = (id: string) =>
  req<{ ok: boolean }>(`/history/${id}`, { method: 'DELETE' });

// ---- file edit ------------------------------------------------------------
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
