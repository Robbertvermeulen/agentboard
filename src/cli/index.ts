#!/usr/bin/env node
import { Command } from 'commander';
import { initData } from '../core/db.js';
import {
  BoardEvent,
  Card,
  Comment,
  addComment,
  boardView,
  cardDetail,
  createCard,
  editCard,
  moveCard,
} from '../core/cards.js';

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
  .option('--json', 'JSON output')
  .action(
    run(async (opts) => {
      const result = await initData();
      const lines =
        result.created.length === 0
          ? [`Already initialized at ${result.dataDir}`]
          : [`Initialized ${result.dataDir}`, ...result.created.map((c) => `  created ${c}`)];
      output(opts, lines.join('\n'), result);
    })
  );

program
  .command('board')
  .description('cards grouped by status')
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const grouped = boardView();
      const lines: string[] = [];
      for (const [status, cards] of Object.entries(grouped)) {
        if (!cards.length) continue;
        lines.push(`${status.toUpperCase()} (${cards.length})`);
        lines.push(...cards.map(cardLine));
      }
      output(opts, lines.length ? lines.join('\n') : 'Board is empty', grouped);
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
  .option('--json', 'JSON output')
  .action(
    run((opts) => {
      const c = createCard({ type: opts.type, title: opts.title, body: opts.body, owner: opts.owner });
      output(opts, `Created ${c.id}  ${c.title}  (${c.status})`, c);
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
        `type: ${c.type}  status: ${c.status}  owner: ${c.owner}`,
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
  .description('add a comment')
  .option('--as <author>', 'human | agent', 'human')
  .option('--json', 'JSON output')
  .action(
    run((opts, id: string, text: string) => {
      const comment = addComment(id, text, opts.as);
      output(opts, `Comment added to ${comment.card_id}`, comment);
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
  .option('--json', 'JSON output')
  .action(
    run((opts, id: string) => {
      const c = editCard(id, {
        title: opts.title,
        body: opts.body,
        labels: opts.labels !== undefined ? splitList(opts.labels) : undefined,
        refs: opts.refs !== undefined ? parseJsonArray(opts.refs, 'refs') : undefined,
        contextRefs: opts.contextRefs !== undefined ? splitList(opts.contextRefs) : undefined,
      });
      output(opts, `Updated ${c.id}`, c);
    })
  );

program.parseAsync();
