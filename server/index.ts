import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { config, loadSettings, patchConfig, ensureDataDir, type ChatTurn } from './config.js';
import { CurieRagService, fetchWebPage } from './ragService.js';

const app = express();
const service = new CurieRagService();

app.use(cors());
app.use(express.json({ limit: '8mb' }));

// ---- File upload storage ---------------------------------------------------
// Lazily computed after ensureDataDir has run
let upload: multer.Multer;

function getUpload() {
  if (!upload) {
    upload = multer({
      dest: path.join(config.dataDir, 'uploads'),
      limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
    });
  }
  return upload;
}

// ---- health ----------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  try {
    res.json({ ok: true, stats: await service.getStats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Health check failed' });
  }
});

// ---- settings --------------------------------------------------------------
app.get('/api/settings', (_req, res) => {
  res.json(service.getConfig());
});

app.post('/api/settings', async (req, res) => {
  try {
    await patchConfig(req.body);
    res.json({ ok: true, settings: service.getConfig() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Settings update failed' });
  }
});

// ---- indexing --------------------------------------------------------------
app.post('/api/index', async (_req, res) => {
  try {
    const stats = await service.reindexVault();
    res.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Indexing failed';
    console.error('[index]', msg);
    res.status(500).json({ error: msg });
  }
});

// ---- search ----------------------------------------------------------------
app.post('/api/search', async (req, res) => {
  try {
    const query = String(req.body?.query ?? '');
    if (!query.trim()) return res.status(400).json({ error: 'query is required' });
    const results = await service.search(query);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
  }
});

// ---- chat (streaming SSE) --------------------------------------------------
app.post('/api/chat/stream', async (req, res) => {
  const question  = String(req.body?.question ?? '').trim();
  const history   = (Array.isArray(req.body?.history) ? req.body.history : []) as ChatTurn[];
  const sessionId = req.body?.sessionId as string | undefined;
  const webContext = req.body?.webContext as string | undefined;

  if (!question) {
    res.status(400).json({ error: 'question is required' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Flush if available (Node.js HTTP)
    if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
      (res as unknown as { flush: () => void }).flush();
    }
  };

  try {
    const { sessionId: sid, sources } = await service.answerStream(
      question,
      history,
      sessionId,
      (token) => send('token', { token }),
      webContext
    );
    send('done', { sessionId: sid, sources });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Chat failed';
    console.error('[chat/stream]', msg);
    send('error', { error: msg });
  } finally {
    res.end();
  }
});

// ---- chat (non-streaming fallback) -----------------------------------------
app.post('/api/chat', async (req, res) => {
  try {
    const question  = String(req.body?.question ?? '').trim();
    const history   = (Array.isArray(req.body?.history) ? req.body.history : []) as ChatTurn[];
    const sessionId = req.body?.sessionId as string | undefined;
    const webContext = req.body?.webContext as string | undefined;

    if (!question) return res.status(400).json({ error: 'question is required' });

    const response = await service.answer(question, history, sessionId, webContext);
    res.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Chat failed';
    console.error('[chat]', msg);
    res.status(500).json({ error: msg });
  }
});

// ---- file upload -----------------------------------------------------------
app.post('/api/upload', async (req, res) => {
  await new Promise<void>((resolve) => {
    getUpload().single('file')(req as express.Request, res, (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : 'Upload error';
        res.status(400).json({ error: msg });
      }
      resolve();
    });
  });
  if (res.headersSent) return;

  const multerReq = req as express.Request & { file?: Express.Multer.File };
  const file = multerReq.file;
  if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }

  try {
    const result = await service.indexUploadedFile(file.path, file.originalname);
    res.json({ ok: true, name: file.originalname, size: file.size, chunks: result.chunks });
  } catch (err) {
    console.error('[upload]', err instanceof Error ? err.message : err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Upload indexing failed' });
  }
});

// ---- web fetch + index -----------------------------------------------------
app.post('/api/web-fetch', async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const page = await fetchWebPage(url);
    const indexResult = await service.indexWebPage(page.url, page.title, page.content);
    res.json({ ok: true, title: page.title, url: page.url, contentLength: page.content.length, chunks: indexResult.chunks });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Web fetch failed';
    console.error('[web-fetch]', msg);
    res.status(500).json({ error: msg });
  }
});

// ---- history ---------------------------------------------------------------
app.get('/api/history', (_req, res) => {
  res.json(service.getHistorySessions());
});

app.get('/api/history/:id', (req, res) => {
  const session = service.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    await service.deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Delete failed' });
  }
});

// ---- file edit -------------------------------------------------------------
app.post('/api/file-edit/propose', async (req, res) => {
  try {
    const { sessionId, filePath, description, proposedContent } = req.body;
    if (!filePath || !proposedContent) return res.status(400).json({ error: 'filePath and proposedContent required' });
    const proposal = await service.proposeFileEdit(sessionId, filePath, description, proposedContent);
    res.json(proposal);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Proposal failed' });
  }
});

app.post('/api/file-edit/apply', async (req, res) => {
  try {
    await service.applyFileEdit(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Apply failed' });
  }
});

// ---- startup ---------------------------------------------------------------
(async () => {
  await loadSettings();
  await ensureDataDir();
  await service.init();
  app.listen(config.serverPort, () => {
    console.log(`Curie backend listening on port ${config.serverPort}`);
    console.log(`Data directory: ${config.dataDir}`);
    console.log(`Vault: ${config.vaultPath}`);
    console.log(`Model provider: ${config.modelProvider}`);
  });
})().catch((err) => {
  console.error('[startup]', err);
  process.exit(1);
});
