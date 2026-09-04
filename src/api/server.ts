import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve } from '@hono/node-server';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import {
  AuthConfig,
  authConfig,
  authenticationOptions,
  consumeEnrolToken,
  createSession,
  deleteSession,
  getSession,
  lookupEnrolToken,
  pruneAuth,
  registrationOptions,
  touchSession,
  verifyAuthentication,
  verifyRegistration,
} from '../core/auth.js';
import {
  addComment,
  archivedCards,
  boardView,
  cardDetail,
  changesSince,
  createBoard,
  createCard,
  editCard,
  editComment,
  listBoards,
  moveCard,
  nextWork,
} from '../core/cards.js';
import { listArtifacts, artifactPath } from '../core/artifacts.js';
import { listUploads, addUpload, uploadPath } from '../core/uploads.js';
import { contextDiff, listContextFiles, readContext, storeSecretForCard, writeContext } from '../core/context.js';
import { listRoutines, toggleRoutineContent } from '../core/routines.js';
import { sessionStatus } from '../core/runner.js';
import { cardSessions, listSessions, observationPath, sessionDetail, sessionStepsSince } from '../core/sessions.js';

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

// Cookie rules (spec Part 1): HttpOnly always, Secure iff the origin is
// https, SameSite=Lax, Path=/. ab_session rolls 30 days; ab_chal lives 300 s.
const SESSION_COOKIE = 'ab_session';
const CHALLENGE_COOKIE = 'ab_chal';

function cookieOpts(auth: AuthConfig, maxAge: number) {
  return { path: '/', httpOnly: true, secure: auth.secure, sameSite: 'Lax' as const, maxAge };
}

interface Challenge {
  purpose: 'register' | 'login';
  challenge: string;
  token?: string;
}

async function setChallenge(c: Context, auth: AuthConfig, data: Challenge): Promise<void> {
  await setSignedCookie(c, CHALLENGE_COOKIE, JSON.stringify(data), auth.secret, cookieOpts(auth, 300));
}

async function takeChallenge(c: Context, auth: AuthConfig, purpose: Challenge['purpose']): Promise<Challenge> {
  const raw = await getSignedCookie(c, auth.secret, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: '/' });
  if (!raw) throw new Error('Challenge expired — try again');
  const data = JSON.parse(raw) as Challenge;
  if (data.purpose !== purpose) throw new Error('Challenge mismatch — try again');
  return data;
}

async function startSession(c: Context, auth: AuthConfig, userId: string): Promise<void> {
  const s = createSession(userId, c.req.header('user-agent') ?? null);
  await setSignedCookie(c, SESSION_COOKIE, s.id, auth.secret, cookieOpts(auth, 30 * 24 * 60 * 60));
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

// v1.5 of vision besluit C: a human action pokes the same runner the cron
// uses; the single-flight lock arbitrates. Opt-in via AGENTBOARD_AUTORUN=1
// so dev servers and UI tests never start real sessions by accident.
function maybeAutorun(): void {
  if (process.env.AGENTBOARD_AUTORUN !== '1') return;
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/index.js');
  const child = spawn(process.execPath, [cli, 'runner', '--trigger', 'serve'], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function createApp(): Hono {
  const app = new Hono();
  const auth = authConfig();

  // Public: tells the UI whether to expect a login and whether to show Sign out.
  app.get('/auth/state', async (c) => {
    if (!auth.enabled) return c.json({ auth: false });
    const id = await getSignedCookie(c, auth.secret, SESSION_COOKIE);
    const session = id ? getSession(id) : null;
    return c.json({ auth: true, user: session ? { name: 'owner' } : null });
  });

  if (auth.enabled) {
    // Origin check on every mutating request replaces CSRF tokens: a
    // cross-site form or fetch never carries our origin.
    app.use('*', async (c, next) => {
      const m = c.req.method;
      const guarded = c.req.path.startsWith('/api/') || c.req.path.startsWith('/auth/');
      if (guarded && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && c.req.header('origin') !== auth.origin) {
        return c.json({ error: 'bad origin' }, 403);
      }
      await next();
    });

    // The static shell stays public (it carries no data); every /api route
    // needs a live session.
    app.use('/api/*', async (c, next) => {
      const id = await getSignedCookie(c, auth.secret, SESSION_COOKIE);
      const session = id ? getSession(id) : null;
      if (!session) return c.json({ error: 'unauthenticated' }, 401);
      touchSession(session);
      await next();
    });

    app.post('/auth/register/options', async (c) => {
      try {
        const body = await c.req.json();
        const token = String(body.token ?? '');
        const { user, name } = lookupEnrolToken(token);
        const options = await registrationOptions(user);
        await setChallenge(c, auth, { purpose: 'register', challenge: options.challenge, token });
        return c.json({ options, name });
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    app.post('/auth/register/verify', async (c) => {
      try {
        const body = await c.req.json();
        const chal = await takeChallenge(c, auth, 'register');
        const token = String(body.token ?? '');
        if (chal.token !== token) throw new Error('Enrol token mismatch — open the link again');
        const { user, name } = lookupEnrolToken(token);
        const cred = await verifyRegistration(user, body.response, chal.challenge, String(body.name || name));
        consumeEnrolToken(token);
        await startSession(c, auth, user.id);
        return c.json({ ok: true, credential: { id: cred.id, name: cred.name } }, 201);
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    app.post('/auth/login/options', async (c) => {
      try {
        const options = await authenticationOptions();
        await setChallenge(c, auth, { purpose: 'login', challenge: options.challenge });
        return c.json({ options });
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    app.post('/auth/login/verify', async (c) => {
      try {
        const body = await c.req.json();
        const chal = await takeChallenge(c, auth, 'login');
        const user = await verifyAuthentication(body.response, chal.challenge);
        await startSession(c, auth, user.id);
        return c.json({ ok: true });
      } catch (err) {
        return errorResponse(c, err);
      }
    });

    app.post('/auth/logout', async (c) => {
      const id = await getSignedCookie(c, auth.secret, SESSION_COOKIE);
      if (id) deleteSession(id);
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      return c.json({ ok: true });
    });
  }

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
      const result = moveCard(c.req.param('id'), body.status, { actor: ACTOR, reason: body.reason });
      maybeAutorun();
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/cards/:id/comments', async (c) => {
    try {
      const body = await c.req.json();
      const result = addComment(c.req.param('id'), body.text ?? '', ACTOR);
      maybeAutorun();
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post('/api/comments/:id', async (c) => {
    try {
      const body = await c.req.json();
      return c.json(editComment(Number(c.req.param('id')), body.body ?? '', ACTOR));
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

  app.get('/api/routines', (c) => {
    try {
      return c.json(listRoutines(c.req.query('board') || undefined));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // The only routine write path in the UI: pausing/resuming. Runs through
  // writeContext so invariant 3 holds (commit + event on the routine's card).
  app.post('/api/routines/toggle', async (c) => {
    try {
      const body = await c.req.json();
      const enabled = body.enabled === true;
      const { content, card, name } = toggleRoutineContent(String(body.path ?? ''), enabled);
      const result = await writeContext(String(body.path), content, {
        cardId: card,
        actor: ACTOR,
        message: `ctx: ${enabled ? 'resume' : 'pause'} routine ${name} (${card})`,
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/sessions', (c) => {
    try {
      const status = sessionStatus();
      const sessions = listSessions().map((s) => ({
        ...s,
        live: s.ended_at === null && status.running && status.session_id === s.id,
        observed: fs.existsSync(observationPath(s.id)),
      }));
      return c.json({ sessions });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/sessions/:id/steps', (c) => {
    try {
      const id = Number(c.req.param('id'));
      const r = sessionStepsSince(id, Number(c.req.query('offset') ?? 0), Number(c.req.query('n') ?? 0));
      const status = sessionStatus();
      return c.json({ ...r, live: status.running && status.session_id === id });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/sessions/:id', (c) => {
    try {
      const d = sessionDetail(Number(c.req.param('id')));
      const status = sessionStatus();
      const live = d.session.ended_at === null && status.running && status.session_id === d.session.id;
      return c.json({ ...d, session: { ...d.session, live } });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/cards/:id/sessions', (c) => {
    try {
      return c.json({ sessions: cardSessions(c.req.param('id')) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/session-status', (c) => {
    try {
      return c.json(sessionStatus());
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/changes', (c) => {
    try {
      return c.json(changesSince(c.req.query('since') || undefined, sessionStatus().running));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get('/api/ctx-diff/:sha', async (c) => {
    try {
      return c.json({ diff: await contextDiff(c.req.param('sha')) });
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
      // Revalidate, don't cache blind: a stale app.js would silently miss realtime.
      'Cache-Control': 'no-cache',
    });
  });

  return app;
}

export function startServer(port: number): void {
  const auth = authConfig();
  if (auth.enabled) pruneAuth();
  // Without an origin there is no auth, so the server must not be reachable
  // from other hosts: bind the loopback interface only.
  const hostname = auth.enabled ? '0.0.0.0' : '127.0.0.1';
  serve({ fetch: createApp().fetch, port, hostname });
  console.log(
    auth.enabled
      ? `Agentboard on ${auth.origin} (port ${port}, passkey auth on)`
      : `Agentboard on http://localhost:${port} (auth off — listening on localhost only; set AGENTBOARD_ORIGIN to expose it)`
  );
}
