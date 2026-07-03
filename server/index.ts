import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { config, loadSettings, patchConfig, type ChatTurn } from './config.js';
import { CurieRagService } from './ragService.js';

const app = express();
const service = new CurieRagService();

app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ---- health ---------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, stats: await service.getStats() });
});

// ---- settings -------------------------------------------------------------
app.get('/api/settings', (_req, res) => {
  res.json(service.getConfig());
});

app.post('/api/settings', async (req, res) => {
  try {
    await patchConfig(req.body);
    res.json({ ok: true, settings: service.getConfig() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Settings update failed' });
  }
});

// ---- indexing -------------------------------------------------------------
app.post('/api/index', async (_req, res) => {
  try {
    const stats = await service.reindexVault();
    res.json(stats);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Indexing failed';
    console.error('[index]', msg);
    res.status(500).json({ error: msg });
  }
});

// ---- search ---------------------------------------------------------------
app.post('/api/search', async (req, res) => {
  try {
    const query = String(req.body?.query ?? '');
    const results = await service.search(query);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Search failed' });
  }
});

// ---- chat -----------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  try {
    const question  = String(req.body?.question ?? '');
    const history   = (Array.isArray(req.body?.history) ? req.body.history : []) as ChatTurn[];
    const sessionId = req.body?.sessionId as string | undefined;
    const response  = await service.answer(question, history, sessionId);
    res.json(response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Chat failed';
    console.error('[chat]', msg);
    res.status(500).json({ error: msg });
  }
});

// ---- history --------------------------------------------------------------
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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Delete failed' });
  }
});

// ---- file edit ------------------------------------------------------------
app.post('/api/file-edit/propose', async (req, res) => {
  try {
    const { sessionId, filePath, description, proposedContent } = req.body;
    const proposal = await service.proposeFileEdit(sessionId, filePath, description, proposedContent);
    res.json(proposal);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Proposal failed' });
  }
});

app.post('/api/file-edit/apply', async (req, res) => {
  try {
    await service.applyFileEdit(req.body);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Apply failed' });
  }
});

// ---- startup --------------------------------------------------------------
(async () => {
  await loadSettings();
  await service.init();
  app.listen(config.serverPort, () => {
    console.log(`Curie backend listening on port ${config.serverPort}`);
    console.log(`Data directory: ${config.dataDir}`);
    console.log(`Vault: ${config.vaultPath}`);
  });
})().catch((err) => {
  console.error('[startup]', err);
  process.exit(1);
});
