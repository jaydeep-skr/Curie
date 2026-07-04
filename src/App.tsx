import { ChangeEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import {
  askCurieStream,
  askCurie,
  applyFileEdit,
  deleteHistorySession as apiDeleteHistory,
  fetchAndIndexUrl,
  getHealth, getHistory, getSettings,
  proposeFileEdit, reindexVault, saveSettings,
  uploadFile,
} from './api';
import { useCurieStore } from './store';
import type { FileEditProposal } from '../server/ragService.js';
import './styles.css';

// ── Inline SVG icons ─────────────────────────────────────────────────────────
const Icon = {
  Chat: () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.65">
      <path d="M2 3h12a1 1 0 011 1v7a1 1 0 01-1 1H5l-3 2V4a1 1 0 011-1z"/>
    </svg>
  ),
  History: () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.65">
      <circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2 1.5"/>
    </svg>
  ),
  Settings: () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.65">
      <circle cx="8" cy="8" r="2.5"/>
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42"/>
    </svg>
  ),
  Sidebar: () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.65">
      <rect x="1" y="2" width="14" height="12" rx="2"/><path d="M5 2v12"/>
    </svg>
  ),
  New: () => (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 1v12M1 7h12"/>
    </svg>
  ),
  Trash: () => (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2 3.5h10M5 3.5V2.5h4v1M5.5 6v4M8.5 6v4M3 3.5l.7 8h6.6l.7-8"/>
    </svg>
  ),
  Send: () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M14 2L2 7l5 1.5L14 2zM7 8.5L9 14l5-12"/>
    </svg>
  ),
  Refresh: () => (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M12.5 2.5A6 6 0 102.5 11M2.5 7V11h4"/>
    </svg>
  ),
  Save: () => (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="1" y="1" width="12" height="12" rx="2"/><path d="M4 13V8h6v5M4 1v4h5"/>
    </svg>
  ),
  Warning: () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.65">
      <path d="M8 1L1 14h14L8 1z"/><path d="M8 6v4M8 11.5v.5"/>
    </svg>
  ),
  Upload: () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.65">
      <path d="M8 2v9M4 6l4-4 4 4"/><path d="M2 13h12"/>
    </svg>
  ),
  Globe: () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.65">
      <circle cx="8" cy="8" r="6"/>
      <path d="M8 2c-2 2-3 3.5-3 6s1 4 3 6M8 2c2 2 3 3.5 3 6s-1 4-3 6"/>
      <path d="M2.5 6h11M2.5 10h11"/>
    </svg>
  ),
  Stop: () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="3" y="3" width="8" height="8" rx="1.5"/>
    </svg>
  ),
  Copy: () => (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="4" y="4" width="9" height="9" rx="2"/><path d="M2 9V2h7"/>
    </svg>
  ),
  Close: () => (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 2l10 10M12 2L2 12"/>
    </svg>
  ),
};

// ── Markdown ─────────────────────────────────────────────────────────────────
marked.setOptions({ breaks: true, gfm: true });
function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

// ── File-edit proposal parser ─────────────────────────────────────────────────
function parseEditProposal(text: string): {
  cleanText: string;
  proposal: Omit<FileEditProposal, 'id' | 'originalContent'> | null;
} {
  const match = text.match(/```file-edit\n([\s\S]*?)```/);
  if (!match) return { cleanText: text, proposal: null };
  try {
    const parsed = JSON.parse(match[1]) as { filePath: string; description: string; proposedContent: string };
    return {
      cleanText: text.replace(/```file-edit\n[\s\S]*?```/, '').trim(),
      proposal: parsed,
    };
  } catch {
    return { cleanText: text, proposal: null };
  }
}

function uid() {
  return Math.random().toString(36).slice(2);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function ToastLayer() {
  const { toast } = useCurieStore();
  if (!toast) return null;
  const icon = toast.kind === 'error' ? '⚠' : toast.kind === 'success' ? '✓' : 'ℹ';
  return (
    <div className="toast-container">
      <div className={`toast ${toast.kind}`}>{icon} {toast.message}</div>
    </div>
  );
}

// ── Connection banner ─────────────────────────────────────────────────────────
function ConnectionBanner() {
  const { serverOk } = useCurieStore();
  if (serverOk) return null;
  return (
    <div className="connection-banner">
      <Icon.Warning />
      Backend offline — check that the server is running on port 8787
      <button className="retry-btn" onClick={() => window.location.reload()}>Retry</button>
    </div>
  );
}

// ── Approval modal ────────────────────────────────────────────────────────────
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
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{pendingEdit.filePath}</div>
          </div>
          <button className="btn-icon" onClick={() => setPendingEdit(null)}><Icon.Close /></button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.55 }}>
            {pendingEdit.description}
          </p>
          {pendingEdit.originalContent && (
            <>
              <div className="diff-label">Current content</div>
              <div className="diff-block" style={{ marginBottom: 12, color: 'var(--error)', opacity: 0.85 }}>
                {pendingEdit.originalContent}
              </div>
            </>
          )}
          <div className="diff-label">Proposed content</div>
          <div className="diff-block" style={{ color: 'var(--success)', opacity: 0.9 }}>
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
  const {
    messages, busy, sessionId, settings,
    addMessage, appendToMessage, updateMessage,
    setBusy, setSessionId, clearMessages,
    setToast, setPendingEdit,
    pendingAttachments, pendingPages, clearPendingContext,
    webContextText,
  } = useCurieStore();

  const [question, setQuestion] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadingName, setUploadingName] = useState('');
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  function autoResize() {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }

  // Handle file upload
  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setUploadingFile(true);
    setUploadingName(file.name);
    try {
      const result = await uploadFile(file);
      useCurieStore.getState().addPendingAttachment({
        name: result.name,
        size: result.size,
        chunks: result.chunks,
      });
      setToast({ message: `Indexed "${result.name}" (${result.chunks} chunks)`, kind: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Upload failed', kind: 'error' });
    } finally {
      setUploadingFile(false);
      setUploadingName('');
    }
  }

  // Handle URL fetch
  async function handleFetchUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setFetchingUrl(true);
    try {
      const result = await fetchAndIndexUrl(url);
      useCurieStore.getState().addPendingPage({
        url: result.url,
        title: result.title,
        contentLength: result.contentLength,
        chunks: result.chunks,
      });
      // Also store the content in webContextText for immediate use
      useCurieStore.getState().appendWebContext(`From ${result.title} (${result.url})`);
      setToast({ message: `Fetched "${result.title}" (${result.chunks} chunks)`, kind: 'success' });
      setUrlInput('');
      setShowUrlInput(false);
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Web fetch failed', kind: 'error' });
    } finally {
      setFetchingUrl(false);
    }
  }

  // Submit with streaming
  async function handleSubmit(e?: FormEvent, overridePrompt?: string) {
    e?.preventDefault();
    const prompt = (overridePrompt ?? question).trim();
    if (!prompt || busy) return;

    setQuestion('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const userMsgId = uid();
    addMessage({
      id: userMsgId,
      role: 'user',
      content: prompt,
      attachments: pendingAttachments.length ? [...pendingAttachments] : undefined,
      webPages: pendingPages.length ? [...pendingPages] : undefined,
    });
    clearPendingContext();
    setBusy(true);

    const assistantId = uid();
    addMessage({ id: assistantId, role: 'assistant', content: '', streaming: true });

    const ac = new AbortController();
    setAbortController(ac);

    const history = messages.map(({ role, content }) => ({ role, content }));

    try {
      let sources: { sourcePath: string; score: number; preview: string }[] = [];
      let receivedSessionId = sessionId;
      let gotAnyToken = false;

      await askCurieStream(
        prompt,
        history,
        sessionId,
        (event) => {
          if (event.type === 'token') {
            appendToMessage(assistantId, event.token);
            gotAnyToken = true;
          } else if (event.type === 'done') {
            receivedSessionId = event.sessionId;
            sources = event.sources;
          } else if (event.type === 'error') {
            throw new Error(event.error);
          }
        },
        webContextText || undefined,
        ac.signal
      );

      // Finalize message — parse any edit proposals, attach sources
      const finalContent = useCurieStore.getState().messages.find((m) => m.id === assistantId)?.content ?? '';
      const { cleanText, proposal } = parseEditProposal(finalContent);

      updateMessage(assistantId, {
        content: cleanText,
        streaming: false,
        sources: sources.filter((s) => s.score > 0.1),
        editProposal: proposal
          ? { id: '', filePath: proposal.filePath, originalContent: '', proposedContent: proposal.proposedContent, description: proposal.description }
          : undefined,
      });

      if (receivedSessionId) setSessionId(receivedSessionId);

      if (proposal) {
        const full = await proposeFileEdit({
          sessionId: receivedSessionId ?? '',
          filePath: proposal.filePath,
          description: proposal.description,
          proposedContent: proposal.proposedContent,
        }).catch(() => null);
        if (full) setPendingEdit(full);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User stopped — mark as complete
        updateMessage(assistantId, { streaming: false });
        return;
      }

      // Streaming failed — try non-streaming fallback
      const streamedSoFar = useCurieStore.getState().messages.find((m) => m.id === assistantId)?.content ?? '';
      if (streamedSoFar.length > 0) {
        // We got partial content — just finalize it
        updateMessage(assistantId, { streaming: false });
      } else {
        // Zero tokens — try fallback
        try {
          const res = await askCurie(prompt, history, sessionId, webContextText || undefined);
          const { cleanText, proposal } = parseEditProposal(res.answer);
          updateMessage(assistantId, {
            content: cleanText,
            streaming: false,
            sources: res.sources.filter((s) => s.score > 0.1),
            editProposal: proposal
              ? { id: '', filePath: proposal.filePath, originalContent: '', proposedContent: proposal.proposedContent, description: proposal.description }
              : undefined,
          });
          setSessionId(res.sessionId);

          if (proposal) {
            const full = await proposeFileEdit({
              sessionId: res.sessionId,
              filePath: proposal.filePath,
              description: proposal.description,
              proposedContent: proposal.proposedContent,
            }).catch(() => null);
            if (full) setPendingEdit(full);
          }
        } catch (fallbackErr) {
          updateMessage(assistantId, {
            content: `⚠ Error: ${fallbackErr instanceof Error ? fallbackErr.message : 'Chat failed'}`,
            streaming: false,
          });
          setToast({ message: fallbackErr instanceof Error ? fallbackErr.message : 'Chat failed', kind: 'error' });
        }
      }
    } finally {
      setBusy(false);
      setAbortController(null);
    }
  }

  function handleStop() {
    abortController?.abort();
    setBusy(false);
    setAbortController(null);
    // Mark streaming message as done
    const msgs = useCurieStore.getState().messages;
    const streaming = msgs.find((m) => m.streaming);
    if (streaming) updateMessage(streaming.id, { streaming: false });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  }

  function copyMessage(content: string) {
    navigator.clipboard.writeText(content).then(() => {
      setToast({ message: 'Copied to clipboard', kind: 'info' });
    });
  }

  const title = messages.length > 0
    ? messages[0].content.slice(0, 55) + (messages[0].content.length > 55 ? '…' : '')
    : 'New conversation';

  const suggestions = [
    'Summarise my notes on this topic',
    'What are the key concepts in my vault?',
    'Find connections between my documents',
    'Explain this concept step by step',
  ];

  return (
    <>
      <div className="topbar">
        <div className="topbar-title">{title}</div>
        <div className="topbar-actions">
          {busy && (
            <button className="btn btn-glass btn-sm" onClick={handleStop} title="Stop generation">
              <Icon.Stop /> Stop
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={clearMessages} title="New chat">
            <Icon.New /> New
          </button>
        </div>
      </div>

      <ConnectionBanner />

      <div className="chat-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">⚛</div>
            <div className="empty-title">Ask Curie anything</div>
            <div className="empty-sub">
              Ground questions in your vault. Upload files or fetch web pages for extra context.
            </div>
            <div className="suggestion-chips">
              {suggestions.map((s) => (
                <button key={s} className="suggestion-chip" onClick={() => handleSubmit(undefined, s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`message-wrapper ${msg.role}`}>
            <div className={`msg-avatar ${msg.role === 'assistant' ? 'curie' : 'user'}`}>
              {msg.role === 'assistant' ? '⚛' : '👤'}
            </div>
            <div className="msg-bubble">
              {msg.role === 'assistant' ? (
                <div
                  className={msg.streaming ? 'streaming-cursor' : ''}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content || '\u200b') }}
                />
              ) : (
                <>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                  {/* Attachment pills on user message */}
                  {(msg.attachments?.length || msg.webPages?.length) ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                      {msg.attachments?.map((a) => (
                        <span key={a.name} style={{ fontSize: 11, background: 'rgba(52,211,153,0.15)', color: 'var(--success)', borderRadius: 5, padding: '2px 7px' }}>
                          📄 {a.name}
                        </span>
                      ))}
                      {msg.webPages?.map((p) => (
                        <span key={p.url} style={{ fontSize: 11, background: 'rgba(167,139,250,0.15)', color: 'var(--purple)', borderRadius: 5, padding: '2px 7px' }}>
                          🌐 {p.title || p.url}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </>
              )}

              {/* Sources */}
              {msg.sources && msg.sources.length > 0 && (
                <div className="sources-list">
                  {msg.sources.slice(0, 5).map((s) => (
                    <div key={s.sourcePath + s.preview} className="source-chip">
                      <span className="source-path" title={s.sourcePath}>
                        {s.sourcePath.startsWith('web:') ? '🌐' : s.sourcePath.startsWith('upload') ? '📄' : '📖'}{' '}
                        {s.sourcePath.replace(/^web:/, '').replace(/^uploads\//, '')}
                      </span>
                      <span className="source-score">{(s.score * 100).toFixed(0)}%</span>
                      <span className="source-preview">{s.preview}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Edit proposal card */}
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

              {/* Copy button on assistant messages */}
              {msg.role === 'assistant' && !msg.streaming && msg.content && (
                <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                  <button className="btn-icon" style={{ padding: 4 }} onClick={() => copyMessage(msg.content)} title="Copy">
                    <Icon.Copy />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && !messages.some((m) => m.streaming) && (
          <div className="message-wrapper assistant">
            <div className="msg-avatar curie">⚛</div>
            <div className="msg-bubble">
              <div className="thinking"><span /><span /><span /></div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="composer">
        {/* Attachment/page chips */}
        {(pendingAttachments.length > 0 || pendingPages.length > 0 || uploadingFile) && (
          <div className="composer-attachments">
            {uploadingFile && (
              <div className="composer-attachment-chip file">
                <div className="upload-spinner" />
                <span>{uploadingName}</span>
              </div>
            )}
            {pendingAttachments.map((a) => (
              <div key={a.name} className="composer-attachment-chip file">
                <span>📄 {a.name}</span>
                <span className="chip-remove" onClick={() => useCurieStore.getState().clearPendingContext()}>
                  <Icon.Close />
                </span>
              </div>
            ))}
            {pendingPages.map((p) => (
              <div key={p.url} className="composer-attachment-chip web">
                <span>🌐 {p.title || p.url}</span>
                <span className="chip-remove" onClick={() => useCurieStore.getState().clearPendingContext()}>
                  <Icon.Close />
                </span>
              </div>
            ))}
          </div>
        )}

        {/* URL input row */}
        {showUrlInput && (
          <div className="url-input-row">
            <input
              className="url-input"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com/article"
              onKeyDown={(e) => { if (e.key === 'Enter') handleFetchUrl(); if (e.key === 'Escape') setShowUrlInput(false); }}
              autoFocus
            />
            <button className="btn btn-primary btn-sm" onClick={handleFetchUrl} disabled={fetchingUrl || !urlInput.trim()}>
              {fetchingUrl ? <><div className="upload-spinner" />Fetching…</> : 'Fetch'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowUrlInput(false)}>Cancel</button>
          </div>
        )}

        <div className="composer-inner">
          <textarea
            ref={textareaRef}
            rows={1}
            value={question}
            placeholder="Ask a question grounded in your vault… (Shift+Enter for newline)"
            onChange={(e) => { setQuestion(e.target.value); autoResize(); }}
            onKeyDown={handleKeyDown}
            disabled={busy}
          />

          <div className="composer-tools">
            {/* File upload */}
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: 'none' }}
              accept=".pdf,.docx,.txt,.md,.csv,.py,.js,.ts,.tsx,.json,.yaml,.yml,.xlsx"
              onChange={handleFileChange}
            />
            <button
              className="btn-icon"
              title="Upload file"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingFile}
            >
              <Icon.Upload />
            </button>

            {/* Web fetch */}
            <button
              className="btn-icon"
              title="Fetch web page"
              onClick={() => setShowUrlInput(!showUrlInput)}
              style={showUrlInput ? { color: 'var(--accent)' } : undefined}
            >
              <Icon.Globe />
            </button>

            {/* Send */}
            <button
              className="btn btn-primary"
              style={{ borderRadius: 12, padding: '8px 12px' }}
              onClick={() => handleSubmit()}
              disabled={busy || !question.trim()}
            >
              <Icon.Send />
            </button>
          </div>
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
          <div style={{ padding: '24px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
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
                {' · '}{Math.floor(s.turns.length / 2)} msg{s.turns.length / 2 !== 1 ? 's' : ''}
              </div>
            </div>
            <button className="btn-icon" onClick={(e) => handleDelete(s.id, e)} title="Delete">
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

  function field(key: keyof typeof draft, inputType = 'text') {
    return {
      value: String(draft[key] ?? ''),
      type: inputType,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setDraft((prev) => ({ ...prev, [key]: inputType === 'number' ? Number(e.target.value) : e.target.value })),
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

  const isOllama = draft.modelProvider === 'ollama';
  const isOllamaCloud = draft.modelProvider === 'ollama-cloud';
  const isCloud = !isOllama;

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
        {/* Vault */}
        <div className="settings-section">
          <div className="settings-section-header">Vault</div>
          <div className="settings-row settings-row-col">
            <span className="settings-label">Vault path</span>
            <input {...field('vaultPath')} className="settings-input settings-input-wide" placeholder="/Users/you/Documents/vault" />
            <span className="settings-hint">The folder containing your notes, PDFs and other documents to index.</span>
          </div>
        </div>

        {/* Model provider */}
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
              <option value="ollama-cloud">Ollama Cloud</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic Claude</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>

          <div className="settings-row">
            <span className="settings-label">Model name</span>
            <input {...field('ollamaModel')} placeholder={isOllama ? 'llama3.1:8b' : isOllamaCloud ? 'llama3.3:70b' : 'gpt-4o / claude-3-5-sonnet-20241022'} />
          </div>

          {isOllama && (
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

          {isOllamaCloud && (
            <>
              <div className="settings-row settings-row-col">
                <span className="settings-label">Ollama Cloud API Key</span>
                <input
                  {...field('ollamaCloudKey', 'password')}
                  className="settings-input settings-input-wide"
                  placeholder="ollama-cloud-key-…"
                />
                <span className="settings-hint">Get your API key at <a href="https://ollama.com/cloud" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>ollama.com/cloud</a></span>
              </div>
              <div className="settings-row">
                <span className="settings-label">Region</span>
                <select
                  className="settings-select"
                  value={draft.ollamaCloudRegion}
                  onChange={(e) => setDraft((p) => ({ ...p, ollamaCloudRegion: e.target.value }))}
                >
                  <option value="us-east-1">US East (us-east-1)</option>
                  <option value="us-west-2">US West (us-west-2)</option>
                  <option value="eu-west-1">EU West (eu-west-1)</option>
                  <option value="ap-southeast-1">AP Southeast (ap-southeast-1)</option>
                </select>
              </div>
              <div className="settings-row">
                <span className="settings-label">Embed model</span>
                <input {...field('ollamaEmbedModel')} placeholder="nomic-embed-text" />
              </div>
            </>
          )}

          {isCloud && !isOllamaCloud && (
            <div className="settings-row settings-row-col">
              <span className="settings-label">API key</span>
              <input
                {...field('apiKey', 'password')}
                className="settings-input settings-input-wide"
                placeholder="sk-… / sk-ant-… / AIza…"
              />
            </div>
          )}
        </div>

        {/* Indexing */}
        <div className="settings-section">
          <div className="settings-section-header">Indexing & retrieval</div>
          <div className="settings-row">
            <span className="settings-label">Max chunk size</span>
            <input {...field('maxChunkSize', 'number')} style={{ width: 90 }} />
          </div>
          <div className="settings-row">
            <span className="settings-label">Chunk overlap</span>
            <input {...field('chunkOverlap', 'number')} style={{ width: 90 }} />
          </div>
          <div className="settings-row">
            <span className="settings-label">Top K results</span>
            <input {...field('topK', 'number')} style={{ width: 90 }} />
          </div>
        </div>
      </div>
    </>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar() {
  const {
    activePanel, setActivePanel, sidebarOpen, stats, busy, settings,
    setToast, setStats, setHistorySessions, serverOk, setServerOk,
  } = useCurieStore();
  const [indexing, setIndexing] = useState(false);

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

  useEffect(() => {
    if (activePanel === 'history') refreshHistory();
  }, [activePanel]);

  // Model provider badge label
  const providerLabel: Record<string, string> = {
    ollama: 'Local',
    'ollama-cloud': 'Cloud',
    openai: 'OpenAI',
    anthropic: 'Claude',
    gemini: 'Gemini',
  };

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
          <span className="sidebar-model-badge">{providerLabel[settings.modelProvider] ?? settings.modelProvider}</span>
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

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '6px 0' }} />

      <div className="sidebar-section">
        <div className="sidebar-section-label">Vault index</div>
        <div className="sidebar-stats">
          <div className="stat-row"><span>Files indexed</span><span>{stats.indexedFiles}</span></div>
          <div className="stat-row"><span>Chunks</span><span>{stats.indexedChunks}</span></div>
          <div className="stat-row">
            <span>Last indexed</span>
            <span>{stats.lastIndexedAt ? new Date(stats.lastIndexedAt).toLocaleDateString() : 'Never'}</span>
          </div>
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
        {serverOk ? `${settings.ollamaModel}` : 'Backend offline'}
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
      <div className="loading-sub">AI research &amp; study assistant</div>
      <div className="loading-bar-track">
        <div className="loading-bar-fill" />
      </div>
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const {
    screen, setScreen, activePanel, sidebarOpen, setSidebarOpen,
    setStats, setSettings, setHistorySessions, setToast, setServerOk,
  } = useCurieStore();
  const [loadingDone, setLoadingDone] = useState(false);

  useEffect(() => {
    async function boot() {
      await new Promise((r) => setTimeout(r, 1800));

      try {
        const [health, serverSettings, history] = await Promise.all([
          getHealth(),
          getSettings().catch(() => null),
          getHistory().catch(() => []),
        ]);
        setStats(health.stats);
        if (serverSettings) setSettings(serverSettings);
        setHistorySessions(history as Parameters<typeof setHistorySessions>[0]);
        setServerOk(true);
      } catch {
        setServerOk(false);
        setToast({ message: 'Could not reach backend — start the server and refresh', kind: 'error' });
      }

      setLoadingDone(true);
      setTimeout(() => setScreen('app'), 520);
    }
    boot();
  }, []);

  // Periodic server health check
  useEffect(() => {
    if (screen !== 'app') return;
    const id = setInterval(async () => {
      try {
        await getHealth();
        setServerOk(true);
      } catch {
        setServerOk(false);
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [screen]);

  if (screen === 'loading') return <LoadingScreen done={loadingDone} />;

  return (
    <>
      <div className="aurora" />
      <div className="app-shell fade-in">
        <Sidebar />
        <div className="main-panel">
          {/* Sidebar toggle */}
          <button
            className="btn-icon"
            style={{
              position: 'absolute', top: 13, left: sidebarOpen ? 276 : 10, zIndex: 10,
              transition: 'left var(--t-slow)',
            }}
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
