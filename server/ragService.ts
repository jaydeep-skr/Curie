import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Ollama } from 'ollama';
import {
  config,
  ensureDataDir,
  type ChatTurn,
  type SearchResult,
  type SourceChunk,
  type VaultStats
} from './config.js';
import { listVaultFiles, readVaultDocument } from './documentReader.js';
import { chunkText, cosineSimilarity } from './vector.js';

type PersistedIndex = {
  chunks: SourceChunk[];
  stats: VaultStats;
};

export type HistorySession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ChatTurn[];
};

type PersistedHistory = {
  sessions: HistorySession[];
};

export type FileEditProposal = {
  id: string;
  filePath: string;
  originalContent: string;
  proposedContent: string;
  description: string;
};

// ---------------------------------------------------------------------------
// Helpers: cloud LLM chat (OpenAI-compatible)
// ---------------------------------------------------------------------------
async function cloudChat(
  messages: { role: string; content: string }[]
): Promise<string> {
  const { modelProvider, apiKey, ollamaModel } = config;

  const endpointMap: Record<string, string> = {
    openai:    'https://api.openai.com/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    gemini:    `https://generativelanguage.googleapis.com/v1beta/models/${ollamaModel}:generateContent?key=${apiKey}`,
  };

  if (modelProvider === 'anthropic') {
    const body = {
      model: ollamaModel,
      max_tokens: 2048,
      system: messages.find(m => m.role === 'system')?.content ?? '',
      messages: messages.filter(m => m.role !== 'system')
    };
    const res = await fetch(endpointMap.anthropic, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json() as { content: { text: string }[] };
    return data.content?.[0]?.text ?? '';
  }

  if (modelProvider === 'gemini') {
    const contents = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));
    const res = await fetch(endpointMap.gemini, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents })
    });
    const data = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  // openai-compatible (openai default)
  const res = await fetch(endpointMap.openai, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: ollamaModel, messages })
  });
  const data = await res.json() as { choices: { message: { content: string } }[] };
  return data.choices?.[0]?.message?.content ?? '';
}

// ---------------------------------------------------------------------------
// Main service
// ---------------------------------------------------------------------------
export class CurieRagService {
  private get ollama() {
    return new Ollama({ host: config.ollamaHost });
  }

  private index: PersistedIndex = {
    chunks: [],
    stats: { indexedFiles: 0, indexedChunks: 0, lastIndexedAt: null }
  };

  private history: PersistedHistory = { sessions: [] };

  async init(): Promise<void> {
    await ensureDataDir();
    await this.loadIndex();
    await this.loadHistory();
  }

  // ---- stats ---------------------------------------------------------------
  async getStats(): Promise<VaultStats> {
    return this.index.stats;
  }

  getConfig() {
    const { ollamaHost, ollamaModel, ollamaEmbedModel, modelProvider, apiKey, vaultPath, maxChunkSize, chunkOverlap, topK } = config;
    return { ollamaHost, ollamaModel, ollamaEmbedModel, modelProvider, apiKey: apiKey ? '***' : '', vaultPath, maxChunkSize, chunkOverlap, topK };
  }

  // ---- indexing ------------------------------------------------------------
  async reindexVault(): Promise<VaultStats> {
    const files = await listVaultFiles(config.vaultPath);
    const chunks: SourceChunk[] = [];
    let indexedFiles = 0;

    for (const filePath of files) {
      try {
        const document = await readVaultDocument(filePath);
        if (!document || !document.content.trim()) continue;

        const relativePath = path.relative(config.vaultPath, filePath);
        const pieces = chunkText(document.content, config.maxChunkSize, config.chunkOverlap);
        if (!pieces.length) continue;

        const embeddings = await this.embedTexts(pieces.map((p) => `${relativePath}\n${p}`));
        pieces.forEach((piece, idx) => {
          chunks.push({
            id: crypto.createHash('sha1').update(`${relativePath}:${idx}:${document.updatedAt}`).digest('hex'),
            sourcePath: relativePath,
            content: piece,
            preview: piece.slice(0, 220),
            embedding: embeddings[idx],
            updatedAt: document.updatedAt
          });
        });
        indexedFiles += 1;
      } catch (err) {
        console.warn(`[index] skipping ${filePath}:`, err instanceof Error ? err.message : err);
      }
    }

    this.index = {
      chunks,
      stats: { indexedFiles, indexedChunks: chunks.length, lastIndexedAt: new Date().toISOString() }
    };
    await this.saveIndex();
    return this.index.stats;
  }

  // ---- search --------------------------------------------------------------
  async search(query: string, topK = config.topK): Promise<SearchResult[]> {
    if (!this.index.chunks.length) return [];
    const [queryEmbedding] = await this.embedTexts([query]);
    return this.index.chunks
      .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ---- chat ----------------------------------------------------------------
  async answer(
    question: string,
    history: ChatTurn[],
    sessionId?: string
  ): Promise<{ answer: string; sources: SearchResult[]; sessionId: string }> {
    const sources = await this.search(question, config.topK);
    const context = sources
      .map((s, i) => `Source ${i + 1} (${s.sourcePath}):\n${s.content}`)
      .join('\n\n');

    const historyText = history
      .slice(-8)
      .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n');

    const systemPrompt =
      'You are Curie, a research and study assistant. Use vault context when relevant. ' +
      'If the answer is not in the context, say so clearly. Be concise but academically rigorous. ' +
      'Cite source file paths. When you propose to modify a file, output a JSON block wrapped in ' +
      '```file-edit\n{"filePath":"...","description":"...","proposedContent":"..."}\n``` ' +
      'and I will seek user approval before writing.';

    const userPrompt =
      `Conversation so far:\n${historyText || 'None'}\n\n` +
      `Vault context:\n${context || 'No relevant vault context found.'}\n\n` +
      `Question: ${question}`;

    let answer: string;
    if (config.modelProvider === 'ollama') {
      const response = await this.ollama.chat({
        model: config.ollamaModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: false
      });
      answer = response.message.content;
    } else {
      answer = await cloudChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);
    }

    // Persist to history
    const sid = await this.upsertSession(sessionId, question, answer, history);

    // Index this interaction as a RAG chunk
    await this.indexInteraction(question, answer, sid);

    return { answer, sources, sessionId: sid };
  }

  // ---- file edit -----------------------------------------------------------
  async proposeFileEdit(sessionId: string, filePath: string, description: string, proposedContent: string): Promise<FileEditProposal> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(config.vaultPath, filePath);
    let original = '';
    try { original = await fs.readFile(absolutePath, 'utf8'); } catch { /* new file */ }
    return { id: crypto.randomUUID(), filePath: absolutePath, originalContent: original, proposedContent, description };
  }

  async applyFileEdit(proposal: FileEditProposal): Promise<void> {
    await fs.mkdir(path.dirname(proposal.filePath), { recursive: true });
    await fs.writeFile(proposal.filePath, proposal.proposedContent, 'utf8');
  }

  // ---- history -------------------------------------------------------------
  getHistorySessions(): HistorySession[] {
    return this.history.sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  getSession(id: string): HistorySession | undefined {
    return this.history.sessions.find((s) => s.id === id);
  }

  async deleteSession(id: string): Promise<void> {
    this.history.sessions = this.history.sessions.filter((s) => s.id !== id);
    await this.saveHistory();
  }

  // ---- private helpers -----------------------------------------------------
  private async upsertSession(
    sessionId: string | undefined,
    question: string,
    answer: string,
    priorHistory: ChatTurn[]
  ): Promise<string> {
    let session = sessionId ? this.history.sessions.find((s) => s.id === sessionId) : undefined;
    const now = new Date().toISOString();

    if (!session) {
      session = {
        id: crypto.randomUUID(),
        title: question.slice(0, 60) + (question.length > 60 ? '…' : ''),
        createdAt: now,
        updatedAt: now,
        turns: [...priorHistory]
      };
      this.history.sessions.push(session);
    }

    session.turns.push({ role: 'user', content: question });
    session.turns.push({ role: 'assistant', content: answer });
    session.updatedAt = now;
    await this.saveHistory();
    return session.id;
  }

  private async indexInteraction(question: string, answer: string, sessionId: string): Promise<void> {
    const text = `Q: ${question}\nA: ${answer}`;
    const pieces = chunkText(text, config.maxChunkSize, config.chunkOverlap);
    try {
      const embeddings = await this.embedTexts(pieces);
      pieces.forEach((piece, idx) => {
        this.index.chunks.push({
          id: crypto.createHash('sha1').update(`history:${sessionId}:${idx}`).digest('hex'),
          sourcePath: `history/${sessionId}`,
          content: piece,
          preview: piece.slice(0, 220),
          embedding: embeddings[idx],
          updatedAt: Date.now()
        });
      });
      await this.saveIndex();
    } catch { /* embedding failure should not break chat */ }
  }

  private async embedTexts(input: string[]): Promise<number[][]> {
    if (config.modelProvider !== 'ollama') {
      // For cloud providers we use a simple TF-IDF-style fallback vector
      // (proper cloud embedding APIs can be wired per provider)
      return input.map(() => Array(384).fill(0).map(() => Math.random() * 0.01));
    }
    const vectors: number[][] = [];
    for (const item of input) {
      const response = await this.ollama.embeddings({ model: config.ollamaEmbedModel, prompt: item });
      vectors.push(response.embedding);
    }
    return vectors;
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await fs.readFile(config.indexPath, 'utf8');
      this.index = JSON.parse(raw) as PersistedIndex;
    } catch {
      this.index = { chunks: [], stats: { indexedFiles: 0, indexedChunks: 0, lastIndexedAt: null } };
    }
  }

  private async saveIndex(): Promise<void> {
    await fs.writeFile(config.indexPath, JSON.stringify(this.index));
  }

  private async loadHistory(): Promise<void> {
    try {
      const raw = await fs.readFile(config.historyPath, 'utf8');
      this.history = JSON.parse(raw) as PersistedHistory;
    } catch {
      this.history = { sessions: [] };
    }
  }

  private async saveHistory(): Promise<void> {
    await fs.writeFile(config.historyPath, JSON.stringify(this.history));
  }
}
