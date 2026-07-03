import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import {
  askCurie, applyFileEdit, deleteHistorySession as apiDeleteHistory,
  getHealth, getHistory, getSettings, proposeFileEdit, reindexVault, saveSettings
} from './api';
import { useCurieStore } from './store';
import type { FileEditProposal } from '../server/ragService.js';
import './styles.css';

// ── Inline SVG icons (no external deps) ────────────────────────────────────
const Icon = {
  Chat: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2 3h12a1 1 0 011 1v7a1 1 0 01-1 1H5l-3 2V4a1 1 0 011-1z"/>
    </svg>
  ),
  History: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2 1.5"/>
    </svg>
  ),
  Settings: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8" cy="8" r="2.5"/>
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42"/>
    </svg>
  ),
  Sidebar: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="1" y="2" width="14" height="12" rx="2"/>
      <path d="M5 2v12"/>
    </svg>
  ),
  New: () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 1v12M1 7h12"/>
    </svg>
  ),
  Trash: () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2 3.5h10M5 3.5V2.5h4v1M5.5 6v4M8.5 6v4M3 3.5l.7 8h6.6l.7-8"/>
    </svg>
  ),
  Send: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 2L2 7l5 1.5L14 2zM7 8.5L9 14l5-12"/>
    </svg>
  ),
  Refresh: () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12.5 2.5A6 6 0 102.5 11M2.5 7V11h4"/>
    </svg>
  ),
  Save: () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="1" y="1" width="12" height="12" rx="2"/><path d="M4 13V8h6v5M4 1v4h5"/>
    </svg>
  ),
  Warning: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 1L1 14h14L8 1z"/><path d="M8 6v4M8 11.5v.5"/>
    </svg>
  ),
};

// ── Markdown renderer ────────────────────────────────────────────────────────
marked.setOptions({ breaks: true, gfm: true });
function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

// ── File-edit proposal parser ────────────────────────────────────────────────
function parseEditProposal(text: string): { cleanText: string; proposal: Omit<FileEditProposal, 'id' | 'originalContent'> | null } {
  const match = text.match(/```file-edit\n([\s\S]*?)```/);
  if (!match) return { cleanText: text, proposal: null };
  try {
    const parsed = JSON.parse(match[1]) as { filePath: string; description: string; proposedContent: string };
    const cleanText = text.replace(/```file-edit\n[\s\S]*?```/, '').trim();
    return { cleanText, proposal: parsed };
  } catch {
    return { cleanText: text, proposal: null };
  }
}

// ── Toast component ──────────────────────────────────────────────────────────
function ToastLayer() {
  const { toast } = useCurieStore();
  if (!toast) return null;
  return (
    <div className="toast-container">
      <div className={`toast ${toast.kind}`}>{toast.message}</div>
    </div>
  );
}

// ── File edit approval modal ─────────────────────────────────────────────────
function ApprovalModal() {
  const { pendingEdit, setPendingEdit, setToast, sessionId } = useCurieStore();
  const [applying, setApplying] = useState(false);

  if (!pendingEdit) return null;

  async function handleApprove() {
    if (!pendingEdit) return;
    setApplying(true);
    try {
      await applyFileEdit(pendingEdit);
      setToast({ message: `File updated: ${pendingEdit.filePath}`, kind: 'success' });
      setPendingEdit(null);
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'Apply failed', kind: 'error' });
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setPendingEdit(null)}>
      <div className="modal">
        <div className="modal-header">
          <div className="modal-icon"><Icon.Warning /></div>
          <div style={{ flex: 1 }}>
            <div className="modal-title">Curie wants to modify a file</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{pendingEdit.filePath}</div>
          </div>
          <button className="btn-icon" onClick={() => setPendingEdit(null)}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.5 }}>
            {pendingEdit.description}
          </p>
          {pendingEdit.originalContent && (
            <>
              <div className="diff-label">Current content</div>
              <div className="diff-block" style={{ marginBottom: 12, color: 'var(--error)' }}>
                {pendingEdit.originalContent}
              </div>
            </>
          )}
          <div className="diff-label">Proposed content</div>
          <div className="diff-block" style={{ color: 'var(--success)' }}>
            {pendingEdit.proposedContent}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-glass" onClick={() => setPendingEdit(null)}>Reject</button>
          <button className="btn btn-primary" onClick={handleApprove} disabled={applying}>
            {applying ? 'Applying…' : 'Approve & write file'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────
function ChatPanel() {
  const { messages, busy, sessionId, addMessage, setBusy, setSessionId, clearMessages, setToast, setPendingEdit } = useCurieStore();
  const [question, setQuestion] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  function autoResize() {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    const prompt = question.trim();
    if (!prompt || busy) return;

    setQuestion('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    addMessage({ role: 'user', content: prompt });
    setBusy(true);

    try {
      const history = messages.map(({ role, content }) => ({ role, content }));
      const response = await askCurie(prompt, history, sessionId);
      setSessionId(response.sessionId);

      const { cleanText, proposal } = parseEditProposal(response.answer);

      addMessage({
        role: 'assistant',
        content: cleanText,
        sources: response.sources,
        editProposal: proposal
          ? { id: '', filePath: proposal.filePath, originalContent: '', proposedContent: proposal.proposedContent, description: proposal.description }
          : undefined,
      });

      if (proposal) {
        // Fetch original content and queue for approval
        const full = await proposeFileEdit({
          sessionId: response.sessionId,
          filePath: proposal.filePath,
          description: proposal.description,
          proposedContent: proposal.proposedContent,
        });
        setPendingEdit(full);
      }
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Chat failed', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  }

  const title = messages.length > 0 ? messages[0].content.slice(0, 60) : 'New conversation';

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{title}</div>
        <div className="topbar-actions">
          <button className="btn btn-ghost btn-sm" onClick={clearMessages} title="New chat">
            <Icon.New /> New
          </button>
        </div>
      </div>

      <div className="chat-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">⚛</div>
            <div className="empty-title">Ask Curie anything</div>
            <div className="empty-sub">
              Ground your questions in your vault. Curie reads notes, PDFs, code, and spreadsheets.
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} className={`message-wrapper ${msg.role}`}>
            <div className={`msg-avatar ${msg.role === 'assistant' ? 'curie' : 'user'}`}>
              {msg.role === 'assistant' ? '⚛' : '👤'}
            </div>
            <div className="msg-bubble">
              {msg.role === 'assistant' ? (
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
              ) : (
                msg.content
              )}

              {msg.sources && msg.sources.length > 0 && (
                <div className="sources-list">
                  {msg.sources.slice(0, 4).map((s) => (
                    <div key={s.sourcePath + s.preview} className="source-chip">
                      <span className="source-path">📄 {s.sourcePath}</span>
                      <span className="source-preview">{s.preview}</span>
                    </div>
                  ))}
                </div>
              )}

              {msg.editProposal && (
                <div className="edit-proposal-card">
                  <div className="edit-proposal-header"><Icon.Warning /> File edit proposed</div>
                  <div className="edit-proposal-body">
                    <strong>{msg.editProposal.filePath}</strong><br />
                    {msg.editProposal.description}
                  </div>
                  <div className="edit-proposal-actions">
                    <button
                      className="btn btn-sm btn-glass"
                      onClick={async () => {
                        const full = await proposeFileEdit({
                          sessionId: sessionId ?? '',
                          filePath: msg.editProposal!.filePath,
                          description: msg.editProposal!.description,
                          proposedContent: msg.editProposal!.proposedContent,
                        }).catch(() => null);
                        if (full) setPendingEdit(full);
                      }}
                    >
                      Review &amp; approve
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="message-wrapper assistant">
            <div className="msg-avatar curie">⚛</div>
            <div className="msg-bubble">
              <div className="thinking"><span/><span/><span/></div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <div className="composer-inner">
          <textarea
            ref={textareaRef}
            rows={1}
            value={question}
            placeholder="Ask a question grounded in your vault… (Shift+Enter for newline)"
            onChange={(e) => { setQuestion(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
          />
          <button
            className="btn btn-primary"
            style={{ borderRadius: 14, padding: '9px 13px', flexShrink: 0 }}
            onClick={() => handleSubmit()}
            disabled={busy || !question.trim()}
          >
            <Icon.Send />
          </button>
        </div>
      </div>
    </>
  );
}

// ── History panel ─────────────────────────────────────────────────────────────
function HistoryPanel() {
  const { historySessions, sessionId, loadSession, deleteHistorySession, setToast } = useCurieStore();

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await apiDeleteHistory(id);
      deleteHistorySession(id);
      setToast({ message: 'Session deleted', kind: 'info' });
    } catch {
      setToast({ message: 'Failed to delete session', kind: 'error' });
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">History</div>
      </div>
      <div className="panel-content">
        {historySessions.length === 0 && (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No sessions yet. Start chatting to build history.
          </div>
        )}
        {historySessions.map((s) => (
          <div
            key={s.id}
            className={`history-item ${sessionId === s.id ? 'active' : ''}`}
            onClick={() => loadSession(s as Parameters<typeof loadSession>[0])}
          >
            <div className="history-item-text">
              <div className="history-item-title">{s.title}</div>
              <div className="history-item-date">
                {new Date(s.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {' · '}{Math.floor(s.turns.length / 2)} turn{s.turns.length !== 2 ? 's' : ''}
              </div>
            </div>
            <button className="btn-icon" onClick={(e) => handleDelete(s.id, e)} title="Delete session">
              <Icon.Trash />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Settings panel ─────────────────────────────────────────────────────────────
function SettingsPanel() {
  const { settings, setSettings, setToast } = useCurieStore();
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(settings); }, [settings]);

  function field(key: keyof typeof draft) {
    return {
      value: String(draft[key] ?? ''),
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setDraft((prev) => ({ ...prev, [key]: e.target.value })),
      className: 'settings-input',
    };
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveSettings(draft);
      setSettings(draft);
      setToast({ message: 'Settings saved', kind: 'success' });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'Save failed', kind: 'error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">Settings</div>
        <div className="topbar-actions">
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            <Icon.Save />{saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="main-settings">
        <div className="settings-section">
          <div className="settings-section-header">Vault</div>
          <div className="settings-row">
            <span className="settings-label">Vault path</span>
            <input {...field('vaultPath')} placeholder="/Users/you/Documents/vault" style={{ width: 300 }} />
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-header">Model provider</div>
          <div className="settings-row">
            <span className="settings-label">Provider</span>
            <select
              className="settings-select"
              value={draft.modelProvider}
              onChange={(e) => setDraft((p) => ({ ...p, modelProvider: e.target.value as typeof draft.modelProvider }))}
            >
              <option value="ollama">Ollama (local)</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic Claude</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>
          <div className="settings-row">
            <span className="settings-label">Model name</span>
            <input {...field('ollamaModel')} placeholder="llama3.1:8b / gpt-4o / claude-3-5-sonnet-20241022" />
          </div>
          {draft.modelProvider === 'ollama' && (
            <>
              <div className="settings-row">
                <span className="settings-label">Ollama host</span>
                <input {...field('ollamaHost')} placeholder="http://localhost:11434" />
              </div>
              <div className="settings-row">
                <span className="settings-label">Embed model</span>
                <input {...field('ollamaEmbedModel')} placeholder="nomic-embed-text" />
              </div>
            </>
          )}
          {draft.modelProvider !== 'ollama' && (
            <div className="settings-row">
              <span className="settings-label">API key</span>
              <input
                type="password"
                {...field('apiKey')}
                placeholder="sk-… / claude-… / AIza…"
              />
            </div>
          )}
        </div>

        <div className="settings-section">
          <div className="settings-section-header">Indexing</div>
          <div className="settings-row">
            <span className="settings-label">Max chunk size</span>
            <input {...field('maxChunkSize')} type="number" style={{ width: 100 }} />
          </div>
          <div className="settings-row">
            <span className="settings-label">Chunk overlap</span>
            <input {...field('chunkOverlap')} type="number" style={{ width: 100 }} />
          </div>
          <div className="settings-row">
            <span className="settings-label">Top K results</span>
            <input {...field('topK')} type="number" style={{ width: 100 }} />
          </div>
        </div>
      </div>
    </>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function Sidebar() {
  const { activePanel, setActivePanel, sidebarOpen, stats, busy, setToast, setStats, setHistorySessions } = useCurieStore();
  const [indexing, setIndexing] = useState(false);
  const [serverOk, setServerOk] = useState(true);

  async function handleReindex() {
    setIndexing(true);
    try {
      const next = await reindexVault();
      setStats(next);
      setToast({ message: `Indexed ${next.indexedFiles} files, ${next.indexedChunks} chunks`, kind: 'success' });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : 'Indexing failed', kind: 'error' });
    } finally {
      setIndexing(false);
    }
  }

  async function refreshHistory() {
    try {
      const sessions = await getHistory();
      setHistorySessions(sessions as Parameters<typeof setHistorySessions>[0]);
    } catch { /* silent */ }
  }

  useEffect(() => { if (activePanel === 'history') refreshHistory(); }, [activePanel]);

  const navItems = [
    { id: 'chat' as const, label: 'Chat', icon: <Icon.Chat /> },
    { id: 'history' as const, label: 'History', icon: <Icon.History /> },
    { id: 'settings' as const, label: 'Settings', icon: <Icon.Settings /> },
  ];

  return (
    <aside className={`sidebar${sidebarOpen ? '' : ' collapsed'}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">⚛</div>
          <span className="sidebar-logo-text">Curie</span>
        </div>
      </div>

      <nav className="sidebar-nav" style={{ marginTop: 4 }}>
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-btn ${activePanel === item.id ? 'active' : ''}`}
            onClick={() => setActivePanel(item.id)}
          >
            {item.icon}{item.label}
          </button>
        ))}
      </nav>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />

      <div className="sidebar-stats">
        <div className="stat-row"><span>Files indexed</span><span>{stats.indexedFiles}</span></div>
        <div className="stat-row"><span>Chunks</span><span>{stats.indexedChunks}</span></div>
        <div className="stat-row">
          <span>Last indexed</span>
          <span>{stats.lastIndexedAt ? new Date(stats.lastIndexedAt).toLocaleDateString() : 'Never'}</span>
        </div>
      </div>

      <div className="sidebar-actions">
        <button className="btn btn-glass btn-sm" onClick={handleReindex} disabled={indexing || busy} style={{ justifyContent: 'flex-start' }}>
          <Icon.Refresh />{indexing ? 'Indexing…' : 'Reindex vault'}
        </button>
      </div>

      <div style={{ flex: 1 }} />

      <div className="sidebar-footer">
        <div className={`status-dot ${serverOk ? '' : 'offline'}`} />
        {serverOk ? 'Backend connected' : 'Backend offline'}
      </div>
    </aside>
  );
}

// ── Loading screen ─────────────────────────────────────────────────────────────
function LoadingScreen({ done }: { done: boolean }) {
  return (
    <div className={`loading-screen${done ? ' done' : ''}`}>
      <div className="loading-logo">⚛</div>
      <div className="loading-title">Curie</div>
      <div className="loading-sub">Research &amp; study copilot</div>
      <div className="loading-bar-track">
        <div className="loading-bar-fill" />
      </div>
    </div>
  );
}

// ── Root App ───────────────────────────────────────────────────────────────────
export default function App() {
  const {
    screen, setScreen, activePanel, sidebarOpen, setSidebarOpen,
    setStats, setSettings, setHistorySessions, setToast,
  } = useCurieStore();

  const [loadingDone, setLoadingDone] = useState(false);

  useEffect(() => {
    async function boot() {
      // Give the loading bar time to animate (1.8s), then fetch data
      await new Promise((r) => setTimeout(r, 1850));

      try {
        const [health, serverSettings, history] = await Promise.all([
          getHealth(),
          getSettings().catch(() => null),
          getHistory().catch(() => []),
        ]);
        setStats(health.stats);
        if (serverSettings) setSettings(serverSettings);
        setHistorySessions(history as Parameters<typeof setHistorySessions>[0]);
      } catch (e) {
        setToast({ message: e instanceof Error ? e.message : 'Could not reach backend', kind: 'error' });
      }

      setLoadingDone(true);
      // Wait for fade-out animation then switch screen
      setTimeout(() => setScreen('app'), 520);
    }
    boot();
  }, []);

  if (screen === 'loading') return <LoadingScreen done={loadingDone} />;

  return (
    <>
      <div className="aurora" />
      <div className="app-shell fade-in">
        <Sidebar />
        <div className="main-panel">
          {/* toggle sidebar */}
          <button
            className="btn-icon"
            style={{ position: 'absolute', top: 14, left: sidebarOpen ? 280 : 12, zIndex: 10, transition: 'left var(--transition-slow)' }}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="Toggle sidebar"
          >
            <Icon.Sidebar />
          </button>

          {activePanel === 'chat'     && <ChatPanel />}
          {activePanel === 'history'  && <HistoryPanel />}
          {activePanel === 'settings' && <SettingsPanel />}
        </div>
      </div>

      <ApprovalModal />
      <ToastLayer />
    </>
  );
}
