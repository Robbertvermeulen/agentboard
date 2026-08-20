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
  board: (id) => req(`/api/boards/${encodeURIComponent(id)}`),
  archived: (id) => req(`/api/boards/${encodeURIComponent(id)}/archived`),
  createCard: (board, data) => req(`/api/boards/${encodeURIComponent(board)}/cards`, json('POST', data)),
  card: (id) => req(`/api/cards/${encodeURIComponent(id)}`),
  move: (id, status, reason) => req(`/api/cards/${encodeURIComponent(id)}/move`, json('POST', { status, reason })),
  comment: (id, text) => req(`/api/cards/${encodeURIComponent(id)}/comments`, json('POST', { text })),
  edit: (id, fields) => req(`/api/cards/${encodeURIComponent(id)}`, json('PATCH', fields)),
  artifacts: (id) => req(`/api/cards/${encodeURIComponent(id)}/artifacts`),
  artifactUrl: (id, name) => `/api/cards/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`,
  ctxTree: () => req('/api/ctx'),
  ctxFile: (path) => req(`/api/ctx/${path.split('/').map(encodeURIComponent).join('/')}`),
};
