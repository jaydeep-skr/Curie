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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 500,
  label = 'operation'
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[retry] ${label} attempt ${attempt}/${retries} failed: ${msg}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Web page fetcher (used by /api/web-fetch)
// ---------------------------------------------------------------------------

export async function fetchWebPage(url: string): Promise<{ title: string; content: string; url: string }> {
  const res = await withRetry(
    () => fetch(url, {
      headers: { 'User-Agent': 'CurieBot/1.0 (Research Assistant)' },
      signal: AbortSignal.timeout(15_000),
    }),
    2, 800, `fetch:${url}`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  // Strip tags, scripts, style blocks, then normalise whitespace
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 20_000); // cap to avoid ballooning context

  return { title, content: text, url };
}

// ---------------------------------------------------------------------------
// Cloud LLM helpers
// ---------------------------------------------------------------------------

/**
 * Ollama Cloud uses an OpenAI-compatible API at
 * https://<region>.api.ollama.com/v1/chat/completions
 * Auth: Bearer <OLLAMA_CLOUD_KEY>
 * Docs: https://docs.ollama.com/cloud
 */
async function ollamaCloudChat(
  messages: { role: string; content: string }[],
  stream: false
): Promise<string>;
async function ollamaCloudChat(
  messages: { role: string; content: string }[],
  stream: true,
  onToken: (token: string) => void
): Promise<string>;
async function ollamaCloudChat(
  messages: { role: string; content: string }[],
  stream: boolean,
  onToken?: (token: string) => void
): Promise<string> {
  const { ollamaCloudKey, ollamaCloudRegion, ollamaModel } = config;
  const baseUrl = `https://${ollamaCloudRegion}.api.ollama.com/v1`;

  const res = await withRetry(() => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ollamaCloudKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: ollamaModel, messages, stream }),
    signal: AbortSignal.timeout(120_000),
  }), 2, 1000, 'ollama-cloud-chat');

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama Cloud error ${res.status}: ${errText}`);
  }

  if (!stream || !onToken) {
    const data = await res.json() as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }

  // SSE streaming
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body from Ollama Cloud');
  const decoder = new TextDecoder();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const parsed = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] };
        const token = parsed.choices?.[0]?.delta?.content ?? '';
        if (token) { full += token; onToken(token); }
      } catch { /* skip malformed */ }
    }
  }
  return full;
}

async function cloudChat(
  messages: { role: string; content: string }[]
): Promise<string>;
async function cloudChat(
  messages: { role: string; content: string }[],
  stream: true,
  onToken: (token: string) => void
): Promise<string>;
async function cloudChat(
  messages: { role: string; content: string }[],
  stream?: boolean,
  onToken?: (token: string) => void
): Promise<string> {
  const { modelProvider, apiKey, ollamaModel } = config;

  if (modelProvider === 'ollama-cloud') {
    if (stream && onToken) return ollamaCloudChat(messages, true, onToken);
    return ollamaCloudChat(messages, false);
  }

  if (modelProvider === 'anthropic') {
    const body = {
      model: ollamaModel,
      max_tokens: 4096,
      stream: stream ?? false,
      system: messages.find(m => m.role === 'system')?.content ?? '',
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }))
    };
    const res = await withRetry(() => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    }), 2, 1000, 'anthropic-chat');

    if (!res.ok) {
      const e = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${e}`);
    }

    if (!stream || !onToken) {
      const data = await res.json() as { content: { text: string }[] };
      return data.content?.[0]?.text ?? '';
    }

    // Anthropic SSE streaming
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No body from Anthropic');
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6)) as { type?: string; delta?: { type?: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const t = ev.delta.text ?? '';
            full += t; onToken(t);
          }
        } catch { /* skip */ }
      }
    }
    return full;
  }

  if (modelProvider === 'gemini') {
    if (stream && onToken) {
      // Gemini streaming
      const contents = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      }));
      const systemContent = messages.find(m => m.role === 'system')?.content;
      const body: Record<string, unknown> = { contents };
      if (systemContent) body.systemInstruction = { parts: [{ text: systemContent }] };

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${ollamaModel}:streamGenerateContent?key=${apiKey}&alt=sse`;
      const res = await withRetry(() => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      }), 2, 1000, 'gemini-stream');

      if (!res.ok) {
        const e = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${e}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No body from Gemini');
      const decoder = new TextDecoder();
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6)) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
            const t = ev.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
            if (t) { full += t; onToken(t); }
          } catch { /* skip */ }
        }
      }
      return full;
    }

    // Non-streaming Gemini
    const contents = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));
    const res = await withRetry(() => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${ollamaModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents }),
        signal: AbortSignal.timeout(120_000),
      }
    ), 2, 1000, 'gemini-chat');
    if (!res.ok) {
      const e = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${e}`);
    }
    const data = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  // OpenAI-compatible (default)
  const res = await withRetry(() => fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: ollamaModel, messages, stream: stream ?? false }),
    signal: AbortSignal.timeout(120_000),
  }), 2, 1000, 'openai-chat');

  if (!res.ok) {
    const e = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${e}`);
  }

  if (!stream || !onToken) {
    const data = await res.json() as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }

  // OpenAI SSE streaming
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No body from OpenAI');
  const decoder = new TextDecoder();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const ev = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] };
        const t = ev.choices?.[0]?.delta?.content ?? '';
        if (t) { full += t; onToken(t); }
      } catch { /* skip */ }
    }
  }
  return full;
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

  // ---- stats ----------------------------------------------------------------
  async getStats(): Promise<VaultStats> {
    return this.index.stats;
  }

  getConfig() {
    const {
      ollamaHost, ollamaModel, ollamaEmbedModel, modelProvider, apiKey,
      ollamaCloudKey, ollamaCloudRegion, vaultPath, maxChunkSize, chunkOverlap, topK
    } = config;
    return {
      ollamaHost, ollamaModel, ollamaEmbedModel, modelProvider,
      apiKey: apiKey ? '***' : '',
      ollamaCloudKey: ollamaCloudKey ? '***' : '',
      ollamaCloudRegion, vaultPath, maxChunkSize, chunkOverlap, topK
    };
  }

  // ---- indexing -------------------------------------------------------------
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

  /** Index an uploaded file (from /api/upload) and merge into existing index */
  async indexUploadedFile(filePath: string, displayName: string): Promise<{ chunks: number }> {
    const document = await readVaultDocument(filePath);
    if (!document || !document.content.trim()) return { chunks: 0 };

    const pieces = chunkText(document.content, config.maxChunkSize, config.chunkOverlap);
    if (!pieces.length) return { chunks: 0 };

    const embeddings = await this.embedTexts(pieces.map((p) => `uploads/${displayName}\n${p}`));
    pieces.forEach((piece, idx) => {
      this.index.chunks.push({
        id: crypto.createHash('sha1').update(`upload:${displayName}:${idx}`).digest('hex'),
        sourcePath: `uploads/${displayName}`,
        content: piece,
        preview: piece.slice(0, 220),
        embedding: embeddings[idx],
        updatedAt: Date.now()
      });
    });

    this.index.stats.indexedChunks = this.index.chunks.length;
    await this.saveIndex();
    return { chunks: pieces.length };
  }

  /** Add a web page's content as searchable context */
  async indexWebPage(url: string, title: string, content: string): Promise<{ chunks: number }> {
    const pieces = chunkText(content, config.maxChunkSize, config.chunkOverlap);
    if (!pieces.length) return { chunks: 0 };

    const displayName = title || url;
    const embeddings = await this.embedTexts(pieces.map((p) => `web:${displayName}\n${p}`));
    pieces.forEach((piece, idx) => {
      this.index.chunks.push({
        id: crypto.createHash('sha1').update(`web:${url}:${idx}`).digest('hex'),
        sourcePath: `web:${url}`,
        content: piece,
        preview: piece.slice(0, 220),
        embedding: embeddings[idx],
        updatedAt: Date.now()
      });
    });

    this.index.stats.indexedChunks = this.index.chunks.length;
    await this.saveIndex();
    return { chunks: pieces.length };
  }

  // ---- search ---------------------------------------------------------------
  async search(query: string, topK = config.topK): Promise<SearchResult[]> {
    if (!this.index.chunks.length) return [];
    const [queryEmbedding] = await this.embedTexts([query]);
    return this.index.chunks
      .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ---- chat (streaming) -----------------------------------------------------
  async answerStream(
    question: string,
    history: ChatTurn[],
    sessionId: string | undefined,
    onToken: (token: string) => void,
    webContext?: string
  ): Promise<{ sessionId: string; sources: SearchResult[] }> {
    const sources = await this.search(question, config.topK);
    const context = sources
      .map((s, i) => `Source ${i + 1} (${s.sourcePath}):\n${s.content}`)
      .join('\n\n');

    const historyText = history
      .slice(-10)
      .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n');

    const systemPrompt =
      'You are Curie, an advanced research and study AI assistant with agentic capabilities. ' +
      'Use vault context, uploaded files, and web context when relevant. ' +
      'Be thorough, academically rigorous, and cite source file paths inline. ' +
      'When reasoning through complex problems, think step-by-step. ' +
      'When you propose to modify a file, output a JSON block wrapped in ' +
      '```file-edit\n{"filePath":"...","description":"...","proposedContent":"..."}\n``` ' +
      'and the user will be asked to approve before any write occurs. ' +
      'For code tasks, produce complete, runnable implementations. ' +
      'You have access to the user\'s documents, uploaded files, and fetched web pages as context.';

    const webSection = webContext ? `\nWeb page context:\n${webContext}\n` : '';
    const userPrompt =
      `Conversation so far:\n${historyText || 'None'}\n\n` +
      `Vault context:\n${context || 'No relevant vault context found.'}` +
      `${webSection}\n\n` +
      `Question: ${question}`;

    const msgs = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    let fullAnswer = '';

    if (config.modelProvider === 'ollama') {
      const stream = await withRetry(() => this.ollama.chat({
        model: config.ollamaModel,
        messages: msgs,
        stream: true,
      }), 2, 800, 'ollama-stream');

      for await (const part of stream) {
        const token = part.message?.content ?? '';
        if (token) { fullAnswer += token; onToken(token); }
      }
    } else {
      fullAnswer = await cloudChat(msgs, true, onToken);
    }

    const sid = await this.upsertSession(sessionId, question, fullAnswer, history);
    void this.indexInteraction(question, fullAnswer, sid);

    return { sessionId: sid, sources };
  }

  // ---- non-streaming chat (kept as fallback) ---------------------------------
  async answer(
    question: string,
    history: ChatTurn[],
    sessionId?: string,
    webContext?: string
  ): Promise<{ answer: string; sources: SearchResult[]; sessionId: string }> {
    const sources = await this.search(question, config.topK);
    const context = sources
      .map((s, i) => `Source ${i + 1} (${s.sourcePath}):\n${s.content}`)
      .join('\n\n');

    const historyText = history
      .slice(-10)
      .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n');

    const systemPrompt =
      'You are Curie, an advanced research and study AI assistant. ' +
      'Use vault context, uploaded files, and web context when relevant. ' +
      'Be thorough, academically rigorous, and cite source file paths. ' +
      'When you propose to modify a file, output a JSON block wrapped in ' +
      '```file-edit\n{"filePath":"...","description":"...","proposedContent":"..."}\n``` ' +
      'and the user will be asked to approve before any write occurs.';

    const webSection = webContext ? `\nWeb page context:\n${webContext}\n` : '';
    const userPrompt =
      `Conversation so far:\n${historyText || 'None'}\n\n` +
      `Vault context:\n${context || 'No relevant vault context found.'}` +
      `${webSection}\n\n` +
      `Question: ${question}`;

    let answer: string;

    if (config.modelProvider === 'ollama') {
      const response = await withRetry(() => this.ollama.chat({
        model: config.ollamaModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        stream: false
      }), 2, 800, 'ollama-chat');
      answer = response.message.content;
    } else {
      answer = await cloudChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);
    }

    const sid = await this.upsertSession(sessionId, question, answer, history);
    void this.indexInteraction(question, answer, sid);

    return { answer, sources, sessionId: sid };
  }

  // ---- file edit ------------------------------------------------------------
  async proposeFileEdit(
    sessionId: string,
    filePath: string,
    description: string,
    proposedContent: string
  ): Promise<FileEditProposal> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(config.vaultPath, filePath);
    let original = '';
    try { original = await fs.readFile(absolutePath, 'utf8'); } catch { /* new file */ }
    return { id: crypto.randomUUID(), filePath: absolutePath, originalContent: original, proposedContent, description };
  }

  async applyFileEdit(proposal: FileEditProposal): Promise<void> {
    await fs.mkdir(path.dirname(proposal.filePath), { recursive: true });
    await fs.writeFile(proposal.filePath, proposal.proposedContent, 'utf8');
  }

  // ---- history --------------------------------------------------------------
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

  // ---- private helpers ------------------------------------------------------
  private async upsertSession(
    sessionId: string | undefined,
    question: string,
    answer: string,
    priorHistory: ChatTurn[]
  ): Promise<string> {
    let session = sessionId
      ? this.history.sessions.find((s) => s.id === sessionId)
      : undefined;
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
    } catch { /* embedding failure must not break chat */ }
  }

  private async embedTexts(input: string[]): Promise<number[][]> {
    if (config.modelProvider === 'ollama') {
      const vectors: number[][] = [];
      for (const item of input) {
        const response = await withRetry(
          () => this.ollama.embeddings({ model: config.ollamaEmbedModel, prompt: item }),
          2, 400, 'ollama-embed'
        );
        vectors.push(response.embedding);
      }
      return vectors;
    }

    if (config.modelProvider === 'ollama-cloud') {
      // Ollama Cloud embedding endpoint (OpenAI-compatible embeddings)
      const { ollamaCloudKey, ollamaCloudRegion, ollamaEmbedModel } = config;
      const baseUrl = `https://${ollamaCloudRegion}.api.ollama.com/v1`;
      const vectors: number[][] = [];
      for (const item of input) {
        try {
          const res = await withRetry(() => fetch(`${baseUrl}/embeddings`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${ollamaCloudKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: ollamaEmbedModel, input: item }),
            signal: AbortSignal.timeout(30_000),
          }), 2, 600, 'ollama-cloud-embed');
          const data = await res.json() as { data?: { embedding?: number[] }[] };
          vectors.push(data.data?.[0]?.embedding ?? Array(1024).fill(0));
        } catch {
          vectors.push(Array(1024).fill(0));
        }
      }
      return vectors;
    }

    // Cloud providers without an embeddings API: return random-ish TF-IDF-like vectors
    // so at least token-frequency similarity is captured
    return input.map((text) => {
      const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
      const vec = Array(384).fill(0);
      for (const tok of tokens) {
        let h = 0;
        for (let i = 0; i < tok.length; i++) h = (Math.imul(31, h) + tok.charCodeAt(i)) | 0;
        vec[Math.abs(h) % 384] += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
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
