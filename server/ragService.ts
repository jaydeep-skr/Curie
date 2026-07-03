import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Ollama } from 'ollama';
import { config, ensureDataDir, type ChatTurn, type SearchResult, type SourceChunk, type VaultStats } from './config.js';
import { listVaultFiles, readVaultDocument } from './documentReader.js';
import { chunkText, cosineSimilarity } from './vector.js';

type PersistedIndex = {
  chunks: SourceChunk[];
  stats: VaultStats;
};

export class CurieRagService {
  private readonly ollama = new Ollama({ host: config.ollamaHost });
  private index: PersistedIndex = {
    chunks: [],
    stats: { indexedFiles: 0, indexedChunks: 0, lastIndexedAt: null }
  };

  async init(): Promise<void> {
    await ensureDataDir();
    await this.loadIndex();
  }

  async getStats(): Promise<VaultStats> {
    return this.index.stats;
  }

  async reindexVault(): Promise<VaultStats> {
    const files = await listVaultFiles(config.vaultPath);
    const chunks: SourceChunk[] = [];
    let indexedFiles = 0;

    for (const filePath of files) {
      const document = await readVaultDocument(filePath);
      if (!document || !document.content.trim()) {
        continue;
      }

      const relativePath = path.relative(config.vaultPath, filePath);
      const pieces = chunkText(document.content, config.maxChunkSize, config.chunkOverlap);
      if (!pieces.length) {
        continue;
      }

      const embeddings = await this.embedTexts(pieces.map((piece) => `${relativePath}\n${piece}`));
      pieces.forEach((piece, index) => {
        chunks.push({
          id: crypto.createHash('sha1').update(`${relativePath}:${index}:${document.updatedAt}`).digest('hex'),
          sourcePath: relativePath,
          content: piece,
          preview: piece.slice(0, 220),
          embedding: embeddings[index],
          updatedAt: document.updatedAt
        });
      });

      indexedFiles += 1;
    }

    this.index = {
      chunks,
      stats: {
        indexedFiles,
        indexedChunks: chunks.length,
        lastIndexedAt: new Date().toISOString()
      }
    };

    await this.saveIndex();
    return this.index.stats;
  }

  async search(query: string, topK = config.topK): Promise<SearchResult[]> {
    if (!this.index.chunks.length) {
      return [];
    }

    const [queryEmbedding] = await this.embedTexts([query]);
    return this.index.chunks
      .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async answer(question: string, history: ChatTurn[]): Promise<{ answer: string; sources: SearchResult[] }> {
    const sources = await this.search(question, config.topK);
    const context = sources
      .map((source, index) => `Source ${index + 1} (${source.sourcePath}):\n${source.content}`)
      .join('\n\n');

    const historyText = history
      .slice(-6)
      .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
      .join('\n');

    const response = await this.ollama.chat({
      model: config.ollamaModel,
      messages: [
        {
          role: 'system',
          content:
            'You are Curie, a study and research assistant. Use the provided vault context when relevant. If the answer is not supported by the context, say so clearly. Be concise but academically useful. Cite source file paths explicitly.'
        },
        {
          role: 'user',
          content: `Conversation so far:\n${historyText || 'None'}\n\nVault context:\n${context || 'No relevant vault context found.'}\n\nQuestion: ${question}`
        }
      ],
      stream: false
    });

    return {
      answer: response.message.content,
      sources
    };
  }

  private async embedTexts(input: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const item of input) {
      const response = await this.ollama.embeddings({
        model: config.ollamaEmbedModel,
        prompt: item
      });
      vectors.push(response.embedding);
    }
    return vectors;
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await fs.readFile(config.indexPath, 'utf8');
      this.index = JSON.parse(raw) as PersistedIndex;
    } catch {
      this.index = {
        chunks: [],
        stats: { indexedFiles: 0, indexedChunks: 0, lastIndexedAt: null }
      };
    }
  }

  private async saveIndex(): Promise<void> {
    await fs.writeFile(config.indexPath, JSON.stringify(this.index));
  }
}
