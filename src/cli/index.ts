#!/usr/bin/env node
import fs from 'node:fs';
import { Command } from 'commander';
import { initData } from '../core/db.js';
import {
  BoardEvent,
  Card,
  Comment,
  addComment,
  boardView,
  cardDetail,
  createBoard,
  createCard,
  editCard,
  listBoards,
  logEvent,
  moveCard,
  nextWork,
} from '../core/cards.js';
import {
  getSecret,
  listContextFiles,
  readContext,
  resolveSecret,
  setSecret,
  setSecretFromFile,
  writeContext,
} from '../core/context.js';

interface OutputOpts {
  json?: boolean;
}

function output(opts: OutputOpts, text: string, json: unknown): void {
  console.log(opts.json ? JSON.stringify(json, null, 2) : text);
}

function fail(opts: OutputOpts, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(opts.json ? JSON.stringify({ error: message }) : `Error: ${message}`);
  process.exit(1);
}

// Commander calls actions with (...positionals, options, command); hand
// handlers (opts, ...positionals) so the CLI layer stays uniform.
function run(fn: (opts: OutputOpts & Record<string, any>, ...args: any[]) => void | Promise<void>) {
  return async (...args: any[]) => {
    const cmd: Command = args[args.length - 1];
    const opts = cmd.optsWithGlobals() as OutputOpts & Record<string, any>;
    try {
      await fn(opts, ...args.slice(0, -2));
    } catch (err) {
      fail(opts, err);
    }
  };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonArray(value: string, what: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${what} must be valid JSON, e.g. '[{"label":"PR","url":"https://..."}]'`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${what} must be a JSON array`);
  return parsed;
}

function cardLine(card: Card): string {
  const parts = [`${card.id.padEnd(10)} ${card.title}`];
  if (card.owner === 'agent') parts.push('@agent');
  if (card.labels.length) parts.push(`[${card.labels.join(', ')}]`);
  return `  ${parts.join('  ')}`;
}

function renderTimeline(comments: Comment[], events: BoardEvent[]): string[] {
  const entries = [
    ...comments.map((c) => ({ at: c.created_at, line: `[comment] ${c.author}: ${c.body}` })),
    ...events.map((e) => {
      const detail =
        e.kind === 'status_changed'
          ? `${e.payload.from} -> ${e.payload.to} (${e.payload.reason})`
          : e.kind === 'context_written'
            ? `${e.payload.path} (${e.payload.message})`
            : typeof e.payload.note === 'string'
              ? e.payload.note
              : JSON.stringify(e.payload);
      return { at: e.created_at, line: `[event]   ${e.kind} by ${e.actor}: ${detail}` };
    }),
  ];
  entries.sort((a, b) => a.at.localeCompare(b.at));
  return entries.map((e) => `${e.at}  ${e.line}`);
}

const program = new Command();
program.name('agentboard').description('Agent-driven Kanban board: cards in SQLite, context in markdown + git');

program
  .command('init')
  .description('create data dir, schema, secrets.env and context git repo')
  .option('--default-board <id>', 'slug for the first board (default: main)')
  .option('--default-board-name <name>', 'display name for the first board')
  .option('--json', 'JSON output')
  .action(
    run(async (opts) => {
      const result = await initData({ defaultBoard: opts.defaultBoard, defaultBoardName: opts.defaultBoardName });
      const lines =
        result.created.length === 0
          ? [`Already initialized at ${result.dataDir}`]
          : [`Initialized ${result.dataDir}`, ...result.created.map((c) => `  created ${c}`)];
      output(opts, lines.join('\n'), result);
    })
  );

program
  .command('board [id]')
  .description('cards grouped by status; without id: every board')
  .option('--json', 'JSON output')
  .action(
    run((opts, id?: string) => {
      const views = boardView(id);
      const lines: string[] = [];
      for (const view of views) {
        if (views.length > 1) lines.push(`=== ${view.board.name} (${view.board.id}) ===`);
        let any = false;
        for (const [status, cards] of Object.entries(view.columns)) {
          if (!cards.length) continue;
          any = true;
          lines.push(`${status.toUpperCase()} (${cards.length})`);
          lines.push(...cards.map(cardLine));
        }
        if (!any) lines.push('(empty)');
        if (views.length > 1) lines.push('');
      }
      output(opts, lines.join('\n').trim() || 'Board is empty', views);
    })
  );

const boards = program.command('boards').description('manage boards');

boards
  .command('list')
  .description('all boards')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const all = listBoards();
      output(opts, all.map((b) => `  ${b.id.padEnd(12)} ${b.name}`).join('\n'), { boards: all });
    })
  );

boards
  .command('new <id>')
  .description('create a board (id is a slug)')
  .option('--name <name>', 'display name (default: the id)')
  .option('--json', 'JSON output')
  .action(
    run((opts, id: string) => {
      const b = createBoard(id, opts.name);
      output(opts, `Created board ${b.id} (${b.name})`, b);
    })
  );

program
  .command('next')
  .description('cards that need agent attention (ready, doing@agent, needs_input)')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const cards = nextWork();
      const lines = cards.map((c) => `  ${c.id.padEnd(10)} ${c.board_id.padEnd(12)} ${c.status.padEnd(12)} ${c.title}`);
      output(opts, lines.length ? lines.join('\n') : 'Nothing for the agent right now', { cards });
    })
  );

program
  .command('serve')
  .description('serve the web UI + API')
  .option('--port <port>', 'port to listen on', '4666')
  .action(
    run(async (opts) => {
      const { startServer } = await import('../api/server.js');
      startServer(Number(opts.port));
    })
  );

const card = program.command('card').description('manage cards');

card
  .command('new')
  .description('create a card (status: inbox)')
  .requiredOption('--type <type>', 'task | ops')
  .requiredOption('--title <title>', 'card title')
  .option('--body <body>', 'card body')
  .option('--owner <owner>', 'human | agent', 'human')
  .option('--board <id>', 'board (required when more than one board exists)')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const c = createCard({
        type: opts.type,
        title: opts.title,
        body: opts.body,
        owner: opts.owner,
        board: opts.board,
      });
      output(opts, `Created ${c.id}  ${c.title}  (${c.board_id}, ${c.status})`, c);
    })
  );

card
  .command('show <id>')
  .description('body + comments + events, chronological')
  .option('--json', 'JSON output')
  .action(
    run((opts, id: string) => {
      const detail = cardDetail(id);
      const c = detail.card;
      const lines = [
        `${c.id}  ${c.title}`,
        `board: ${c.board_id}  type: ${c.type}  status: ${c.status}  owner: ${c.owner}`,
      ];
      if (c.labels.length) lines.push(`labels: ${c.labels.join(', ')}`);
      if (c.refs.length) lines.push(`refs: ${JSON.stringify(c.refs)}`);
      if (c.context_refs.length) lines.push(`context: ${c.context_refs.join(', ')}`);
      lines.push(`created: ${c.created_at}  updated: ${c.updated_at}`);
      if (c.body) lines.push('', c.body);
      const timeline = renderTimeline(detail.comments, detail.events);
      if (timeline.length) lines.push('', ...timeline);
      output(opts, lines.join('\n'), detail);
    })
  );

card
  .command('move <id> <status>')
  .description('change status (writes an event)')
  .requiredOption('--reason <reason>', 'why this status change')
  .option('--as <actor>', 'human | agent', 'human')
  .option('--json', 'JSON output')
  .action(
    run((opts, id: string, status: string) => {
      const c = moveCard(id, status, { actor: opts.as, reason: opts.reason });
      output(opts, `${c.id} -> ${c.status}`, c);
    })
  );

card
  .command('comment <id> <text>')
  .description("add a comment ('-' reads stdin, e.g. to pipe a diff)")
  .option('--as <author>', 'human | agent', 'human')
  .option('--json', 'JSON output')
  .action(
    run(async (opts, id: string, text: string) => {
      const body = text === '-' ? await readStdin() : text;
      const comment = addComment(id, body, opts.as);
      output(opts, `Comment added to ${comment.card_id}`, comment);
    })
  );

card
  .command('log <id> <text>')
  .description('log an event on a card (action_taken or error)')
  .option('--kind <kind>', 'action_taken | error', 'action_taken')
  .option('--as <actor>', 'human | agent', 'human')
  .option('--json', 'JSON output')
  .action(
    run((opts, id: string, text: string) => {
      const event = logEvent(id, opts.kind, opts.as, text);
      output(opts, `Event logged on ${event.card_id} (${event.kind})`, event);
    })
  );

card
  .command('edit <id>')
  .description('edit card fields')
  .option('--title <title>', 'new title')
  .option('--body <body>', 'new body')
  .option('--labels <labels>', 'comma-separated, empty string clears')
  .option('--refs <json>', 'JSON array [{label, url?, note?}]')
  .option('--context-refs <paths>', 'comma-separated context paths, empty string clears')
  .option('--board <id>', 'move card to another board')
  .option('--json', 'JSON output')
  .action(
    run((opts, id: string) => {
      const c = editCard(id, {
        title: opts.title,
        body: opts.body,
        labels: opts.labels !== undefined ? splitList(opts.labels) : undefined,
        refs: opts.refs !== undefined ? parseJsonArray(opts.refs, 'refs') : undefined,
        contextRefs: opts.contextRefs !== undefined ? splitList(opts.contextRefs) : undefined,
        board: opts.board,
      });
      output(opts, `Updated ${c.id}`, c);
    })
  );

function renderTree(paths: string[]): string[] {
  const lines: string[] = [];
  const seenDirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/');
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        lines.push('  '.repeat(i) + parts[i] + '/');
      }
    }
    lines.push('  '.repeat(parts.length - 1) + parts[parts.length - 1]);
  }
  return lines;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const ctx = program.command('ctx').description('markdown context files (git-backed)');

ctx
  .command('list [pad]')
  .description('tree of context files')
  .option('--json', 'JSON output')
  .action(
    run((opts, pad?: string) => {
      const files = listContextFiles(pad);
      output(opts, files.length ? renderTree(files).join('\n') : 'No context files yet', { files });
    })
  );

ctx
  .command('show <pad>')
  .description('print a context file')
  .option('--json', 'JSON output')
  .action(
    run((opts, pad: string) => {
      const file = readContext(pad);
      output(opts, file.raw, { path: file.path, frontmatter: file.frontmatter, content: file.content });
    })
  );

ctx
  .command('write <pad>')
  .description('write a context file + git commit + event on the card')
  .requiredOption('--content <content>', "file content, '-' reads stdin")
  .requiredOption('--card <id>', 'card this write belongs to (goes in commit message + event)')
  .option('--message <message>', 'commit message override')
  .option('--as <actor>', 'human | agent', 'human')
  .option('--json', 'JSON output')
  .action(
    run(async (opts, pad: string) => {
      const content = opts.content === '-' ? await readStdin() : opts.content;
      const result = await writeContext(pad, content, { cardId: opts.card, actor: opts.as, message: opts.message });
      output(opts, `${result.action === 'add' ? 'Added' : 'Updated'} ${result.path}\ncommitted: ${result.message}`, result);
    })
  );

// Echo off so the value never shows on screen; raw mode gives us that
// without extra dependencies.
function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    let value = '';
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const secret = program.command('secret').description('secrets.env access');

secret
  .command('set <naam>')
  .description('set a secret; value via hidden prompt, piped stdin or --file — never as an argument')
  .option('--file <pad>', 'read value from file, stored base64 on one line (for SSH keys etc.)')
  .option('--json', 'JSON output')
  .action(
    run(async (opts, naam: string) => {
      let result;
      if (opts.file) {
        result = setSecretFromFile(naam, opts.file);
      } else {
        const value = process.stdin.isTTY
          ? await promptHidden(`Value for ${naam.toUpperCase()}: `)
          : (await readStdin()).trim();
        if (!value && !process.stdin.isTTY) {
          throw new Error(
            `No value on stdin. Run 'agentboard secret set ${naam}' in an interactive terminal for a hidden prompt, pipe the value, or use --file <pad>`
          );
        }
        result = setSecret(naam, value);
      }
      output(opts, `${result.action === 'add' ? 'Added' : 'Updated'} ${result.name} in secrets.env`, result);
    })
  );

secret
  .command('get <naam>')
  .description('read a secret; base64-stored values are decoded, --out writes to a file (chmod 600)')
  .option('--out <pad>', 'write decoded value to this file with chmod 600')
  .option('--json', 'JSON output')
  .action(
    run((opts, naam: string) => {
      const { data, encoded } = resolveSecret(naam);
      const name = naam.toUpperCase();
      if (opts.out) {
        fs.writeFileSync(opts.out, data, { mode: 0o600 });
        fs.chmodSync(opts.out, 0o600);
        output(opts, `Wrote ${name} to ${opts.out} (chmod 600)`, { name, out: opts.out, encoded });
        return;
      }
      if (opts.json) {
        output(opts, '', { name, value: data.toString('utf8'), encoded });
      } else {
        process.stdout.write(data);
        if (!data.length || data[data.length - 1] !== 0x0a) process.stdout.write('\n');
      }
    })
  );

program.parseAsync();
