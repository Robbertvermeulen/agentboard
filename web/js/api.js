// Thin fetch wrappers around the Agentboard API. Errors become Error(msg).

async function req(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  boards: () => req('/api/boards'),
  createBoard: (id, name) => req('/api/boards', json('POST', { id, name })),
  board: (id) => req(`/api/boards/${encodeURIComponent(id)}`),
  archived: (id) => req(`/api/boards/${encodeURIComponent(id)}/archived`),
  createCard: (board, data) => req(`/api/boards/${encodeURIComponent(board)}/cards`, json('POST', data)),
  card: (id) => req(`/api/cards/${encodeURIComponent(id)}`),
  move: (id, status, reason) => req(`/api/cards/${encodeURIComponent(id)}/move`, json('POST', { status, reason })),
  comment: (id, text) => req(`/api/cards/${encodeURIComponent(id)}/comments`, json('POST', { text })),
  editComment: (id, body) => req(`/api/comments/${encodeURIComponent(id)}`, json('POST', { body })),
  edit: (id, fields) => req(`/api/cards/${encodeURIComponent(id)}`, json('PATCH', fields)),
  artifacts: (id) => req(`/api/cards/${encodeURIComponent(id)}/artifacts`),
  artifactUrl: (id, name) => `/api/cards/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`,
  ctxTree: () => req('/api/ctx'),
  ctxDiff: (sha) => req(`/api/ctx-diff/${encodeURIComponent(sha)}`),
  ctxFile: (path) => req(`/api/ctx/${path.split('/').map(encodeURIComponent).join('/')}`),
  uploads: (id) => req(`/api/cards/${encodeURIComponent(id)}/uploads`),
  uploadUrl: (id, name) => `/api/cards/${encodeURIComponent(id)}/uploads/${encodeURIComponent(name)}`,
  uploadFiles: (id, files) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    return req(`/api/cards/${encodeURIComponent(id)}/uploads`, { method: 'POST', body: fd });
  },
  // Write-only by design: there is no call that reads a secret back.
  storeSecret: (id, { name, value, encoding }) =>
    req(`/api/cards/${encodeURIComponent(id)}/secrets`, json('POST', { name, value, encoding })),
  routines: (board) => req(`/api/routines${board ? `?board=${encodeURIComponent(board)}` : ''}`),
  toggleRoutine: (path, enabled) => req('/api/routines/toggle', json('POST', { path, enabled })),
  sessions: () => req('/api/sessions'),
  session: (id) => req(`/api/sessions/${encodeURIComponent(id)}`),
  sessionSteps: (id, offset, n) => req(`/api/sessions/${encodeURIComponent(id)}/steps?offset=${offset}&n=${n}`),
  cardSessions: (id) => req(`/api/cards/${encodeURIComponent(id)}/sessions`),
  sessionStatus: () => req('/api/session-status'),
  changes: (since) => req(`/api/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`),
};
