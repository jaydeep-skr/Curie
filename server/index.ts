import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { config, type ChatTurn } from './config.js';
import { CurieRagService } from './ragService.js';

const app = express();
const service = new CurieRagService();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, stats: await service.getStats() });
});

app.post('/api/index', async (_req, res) => {
  try {
    const stats = await service.reindexVault();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Indexing failed' });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const query = String(req.body?.query ?? '');
    const results = await service.search(query);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Search failed' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const question = String(req.body?.question ?? '');
    const history = (Array.isArray(req.body?.history) ? req.body.history : []) as ChatTurn[];
    const response = await service.answer(question, history);
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Chat failed' });
  }
});

service
  .init()
  .then(() => {
    app.listen(config.serverPort, () => {
      console.log(`Curie backend listening on port ${config.serverPort}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
