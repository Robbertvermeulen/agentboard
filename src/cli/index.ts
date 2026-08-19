#!/usr/bin/env node
import { Command } from 'commander';
import { initData } from '../core/db.js';

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
function run(fn: (opts: OutputOpts, ...args: any[]) => void | Promise<void>) {
  return async (...args: any[]) => {
    const cmd: Command = args[args.length - 1];
    const opts = cmd.optsWithGlobals() as OutputOpts;
    try {
      await fn(opts, ...args.slice(0, -2));
    } catch (err) {
      fail(opts, err);
    }
  };
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

program.parseAsync();
