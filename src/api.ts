export async function getHealth() {
  const response = await fetch('/api/health');
  if (!response.ok) {
    throw new Error('Failed to load health');
  }
  return response.json();
}

export async function reindexVault() {
  const response = await fetch('/api/index', { method: 'POST' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? 'Failed to index vault');
  }
  return response.json();
}

export async function askCurie(question: string, history: { role: 'user' | 'assistant'; content: string }[]) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? 'Failed to chat with Curie');
  }

  return response.json();
}
