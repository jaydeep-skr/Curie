import fs from 'node:fs/promises';
import path from 'node:path';

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

export type AppConfig = {
  ollamaHost: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
  vaultPath: string;
  serverPort: number;
  maxChunkSize: number;
  chunkOverlap: number;
  topK: number;
  indexPath: string;
};

const requiredEnv = {
  OLLAMA_HOST: process.env.OLLAMA_HOST,
  OLLAMA_MODEL: process.env.OLLAMA_MODEL,
  OLLAMA_EMBED_MODEL: process.env.OLLAMA_EMBED_MODEL,
  VAULT_PATH: process.env.VAULT_PATH
};

for (const [key, value] of Object.entries(requiredEnv)) {
  if (!value) {
    throw new Error(`Missing required environment variable ${key}`);
  }
}

export const config: AppConfig = {
  ollamaHost: requiredEnv.OLLAMA_HOST!,
  ollamaModel: requiredEnv.OLLAMA_MODEL!,
  ollamaEmbedModel: requiredEnv.OLLAMA_EMBED_MODEL!,
  vaultPath: requiredEnv.VAULT_PATH!,
  serverPort: Number(process.env.SERVER_PORT ?? 8787),
  maxChunkSize: Number(process.env.MAX_CHUNK_SIZE ?? 1200),
  chunkOverlap: Number(process.env.CHUNK_OVERLAP ?? 200),
  topK: Number(process.env.TOP_K ?? 6),
  indexPath: path.resolve('.curie', 'index.json')
};

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(path.dirname(config.indexPath), { recursive: true });
}
