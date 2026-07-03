import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type SourceChunk = {
  id: string;
  sourcePath: string;
  content: string;
  preview: string;
  embedding: number[];
  updatedAt: number;
};

export type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type SearchResult = SourceChunk & {
  score: number;
};

export type VaultStats = {
  indexedFiles: number;
  indexedChunks: number;
  lastIndexedAt: string | null;
};

export type ModelProvider = 'ollama' | 'openai' | 'anthropic' | 'gemini';

export type AppConfig = {
  ollamaHost: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
  modelProvider: ModelProvider;
  apiKey: string;
  vaultPath: string;
  serverPort: number;
  maxChunkSize: number;
  chunkOverlap: number;
  topK: number;
  indexPath: string;
  historyPath: string;
  dataDir: string;
};

// Central data directory — lives in user home so it survives vault changes
// and is easy to bundle in SwiftUI as a known path.
const DATA_DIR = process.env.CURIE_DATA_DIR
  ?? path.join(os.homedir(), '.curie');

export const config: AppConfig = {
  ollamaHost:      process.env.OLLAMA_HOST      ?? 'http://localhost:11434',
  ollamaModel:     process.env.OLLAMA_MODEL     ?? 'llama3.1:8b',
  ollamaEmbedModel:process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
  modelProvider:   (process.env.MODEL_PROVIDER  ?? 'ollama') as ModelProvider,
  apiKey:          process.env.MODEL_API_KEY     ?? '',
  vaultPath:       process.env.VAULT_PATH        ?? path.join(os.homedir(), 'Documents'),
  serverPort:      Number(process.env.SERVER_PORT ?? 8787),
  maxChunkSize:    Number(process.env.MAX_CHUNK_SIZE ?? 1200),
  chunkOverlap:    Number(process.env.CHUNK_OVERLAP ?? 200),
  topK:            Number(process.env.TOP_K ?? 6),
  dataDir:         DATA_DIR,
  indexPath:       path.join(DATA_DIR, 'index.json'),
  historyPath:     path.join(DATA_DIR, 'history.json'),
};

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

/** Persist a partial config update to a settings.json inside the data dir */
export async function patchConfig(patch: Partial<{
  ollamaHost: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
  modelProvider: ModelProvider;
  apiKey: string;
  vaultPath: string;
  maxChunkSize: number;
  chunkOverlap: number;
  topK: number;
}>): Promise<void> {
  await ensureDataDir();
  const settingsPath = path.join(config.dataDir, 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch { /* first write */ }

  const merged = { ...existing, ...patch };
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2));

  // Apply in-process
  Object.assign(config, patch);
}

/** Load persisted settings on startup */
export async function loadSettings(): Promise<void> {
  await ensureDataDir();
  const settingsPath = path.join(config.dataDir, 'settings.json');
  try {
    const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    Object.assign(config, saved);
    // Recompute paths if dataDir was overridden
    config.indexPath   = path.join(config.dataDir, 'index.json');
    config.historyPath = path.join(config.dataDir, 'history.json');
  } catch { /* no settings yet, keep defaults */ }
}
