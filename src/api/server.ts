import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import {
  addComment,
  archivedCards,
  boardView,
  cardDetail,
  createBoard,
  createCard,
  editCard,
  listBoards,
  moveCard,
  nextWork,
} from '../core/cards.js';
import { listArtifacts, artifactPath } from '../core/artifacts.js';
import { listUploads, addUpload, uploadPath } from '../core/uploads.js';
import { listContextFiles, readContext, storeSecretForCard } from '../core/context.js';

// The UI user is by definition the human; the agent uses the CLI.
const ACTOR = 'human';

// Secrets are write-only through the API: POST stores a value, nothing can
// ever read one back. Values never travel to the browser, in any form.

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function errorResponse(c: Context, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = /not found|no such|unknown board/i.test(message) ? 404 : 400;
  return c.json({ error: message }, status);
}

const WEB_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Artifact files: render known-safe types inline, everything else (including
// svg/html, which could carry scripts) downloads as an attachment.
const ARTIFACT_INLINE: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

function webDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
}

export function createApp(): Hono {
  const app = new Hono();

  app.get('/api/boards', (c) => {
    try {
      return c.json({ boards: listBoards() });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // No event: boards have no timeline. Slug/duplicate checks live in createBoard.
  app.post('/api/boards', async (c) => {
    try {
      const body = await c.req.json();
      return c.json(createBoard(body.id ?? '', body.name || undefined), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/boards/:board', (c) => {
    try {
      return c.json(boardView(c.req.param('board'))[0]);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/boards/:board/archived', (c) => {
    try {
      return c.json({ cards: archivedCards(c.req.param('board')) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/boards/:board/cards', async (c) => {
    try {
      const body = await c.req.json();
      const card = createCard({
        type: body.type,
        title: body.title ?? '',
        body: body.body,
        labels: body.labels,
        board: c.req.param('board'),
      });
      return c.json(card, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/cards/:id', (c) => {
    try {
      return c.json(cardDetail(c.req.param('id')));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/cards/:id/move', async (c) => {
    try {
      const body = await c.req.json();
      return c.json(moveCard(c.req.param('id'), body.status, { actor: ACTOR, reason: body.reason }));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/cards/:id/comments', async (c) => {
    try {
      const body = await c.req.json();
      return c.json(addComment(c.req.param('id'), body.text ?? '', ACTOR), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.patch('/api/cards/:id', async (c) => {
    try {
      const body = await c.req.json();
      return c.json(
        editCard(c.req.param('id'), {
          title: body.title,
          body: body.body,
          labels: body.labels,
          refs: body.refs,
          contextRefs: body.contextRefs,
          board: body.board,
        })
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/cards/:id/artifacts', (c) => {
    try {
      return c.json({ artifacts: listArtifacts(c.req.param('id')) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  const serveStoredFile = (c: Context, abs: string) => {
    const ext = path.extname(abs).toLowerCase();
    const inline = ARTIFACT_INLINE[ext];
    return c.body(new Uint8Array(fs.readFileSync(abs)), 200, {
      'Content-Type': inline ?? 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${path.basename(abs)}"`,
    });
  };

  app.get('/api/cards/:id/artifacts/:file', (c) => {
    try {
      return serveStoredFile(c, artifactPath(c.req.param('id'), c.req.param('file')));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/cards/:id/uploads', (c) => {
    try {
      return c.json({ uploads: listUploads(c.req.param('id')) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/cards/:id/uploads', async (c) => {
    try {
      if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) {
        return c.json({ error: 'Upload too large (max 50 MB per request)' }, 413);
      }
      const body = await c.req.parseBody({ all: true });
      const files = Object.values(body)
        .flat()
        .filter((v): v is File => v instanceof File);
      if (files.length === 0) return c.json({ error: 'No files in request' }, 400);
      if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) {
        return c.json({ error: 'Upload too large (max 50 MB per request)' }, 413);
      }
      const id = c.req.param('id');
      for (const f of files) {
        addUpload(id, f.name, Buffer.from(await f.arrayBuffer()), ACTOR);
      }
      return c.json({ uploads: listUploads(id) }, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/cards/:id/uploads/:file', (c) => {
    try {
      return serveStoredFile(c, uploadPath(c.req.param('id'), c.req.param('file')));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Write-only: the response carries name + action, never the value.
  app.post('/api/cards/:id/secrets', async (c) => {
    try {
      const body = await c.req.json();
      const result = storeSecretForCard(c.req.param('id'), body.name ?? '', body.value ?? '', {
        actor: ACTOR,
        encoded: body.encoding === 'base64',
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/next', (c) => {
    try {
      return c.json({ cards: nextWork() });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/ctx', (c) => {
    try {
      return c.json({ files: listContextFiles() });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/ctx/*', (c) => {
    try {
      const rel = decodeURIComponent(c.req.path.slice('/api/ctx/'.length));
      const file = readContext(rel);
      return c.json({ path: file.path, frontmatter: file.frontmatter, content: file.content });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Static web/ — hash routing, so only '/' maps to index.html.
  app.get('*', (c) => {
    const root = webDir();
    const rel = c.req.path === '/' ? 'index.html' : c.req.path.slice(1);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.body(new Uint8Array(fs.readFileSync(abs)), 200, {
      'Content-Type': WEB_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
    });
  });

  return app;
}

export function startServer(port: number): void {
  serve({ fetch: createApp().fetch, port });
  console.log(`Agentboard on http://localhost:${port}`);
}
