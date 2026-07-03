import { FormEvent, useEffect, useState } from 'react';
import { askCurie, getHealth, reindexVault } from './api';
import { useCurieStore } from './store';
import './styles.css';

export default function App() {
  const { messages, busy, stats, addMessage, setBusy, setStats, clearMessages } = useCurieStore();
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHealth()
      .then((data) => setStats(data.stats))
      .catch((err: Error) => setError(err.message));
  }, [setStats]);

  async function handleReindex() {
    setBusy(true);
    setError(null);
    try {
      const nextStats = await reindexVault();
      setStats(nextStats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Indexing failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || busy) {
      return;
    }

    const prompt = question.trim();
    setQuestion('');
    setError(null);
    addMessage({ role: 'user', content: prompt });
    setBusy(true);

    try {
      const history = [...messages, { role: 'user' as const, content: prompt }].map(({ role, content }) => ({ role, content }));
      const response = await askCurie(prompt, history);
      addMessage({
        role: 'assistant',
        content: response.answer,
        sources: response.sources
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chat failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Curie</h1>
        <p className="muted">Research and study copilot for your Obsidian vault.</p>
        <div className="stat-card">
          <div><strong>Indexed files</strong><span>{stats.indexedFiles}</span></div>
          <div><strong>Indexed chunks</strong><span>{stats.indexedChunks}</span></div>
          <div><strong>Last indexed</strong><span>{stats.lastIndexedAt ?? 'Never'}</span></div>
        </div>
        <button onClick={handleReindex} disabled={busy}>Reindex vault</button>
        <button className="secondary" onClick={clearMessages} disabled={busy}>Clear chat</button>
        {error ? <p className="error">{error}</p> : null}
      </aside>
      <main className="chat-panel">
        <div className="messages">
          {messages.length === 0 ? <div className="empty-state">Ask Curie about notes, papers, code, or concepts in your vault.</div> : null}
          {messages.map((message, index) => (
            <article key={`${message.role}-${index}`} className={`message ${message.role}`}>
              <header>{message.role === 'user' ? 'You' : 'Curie'}</header>
              <p>{message.content}</p>
              {message.sources?.length ? (
                <ul className="sources">
                  {message.sources.map((source) => (
                    <li key={`${source.sourcePath}-${source.preview}`}>
                      <strong>{source.sourcePath}</strong>
                      <span>{source.preview}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
          {busy ? <div className="empty-state">Curie is thinking…</div> : null}
        </div>
        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask a question grounded in your vault…"
            rows={4}
          />
          <button type="submit" disabled={busy || !question.trim()}>Send</button>
        </form>
      </main>
    </div>
  );
}
