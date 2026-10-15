#!/usr/bin/env node
// Bundled MCP server exposing a small, task-shaped browser tool surface
// (navigate/click/fill/read/screenshot) backed by Playwright/Chromium.
// Wired into every session unconditionally by runSession() (issue #107:
// "default always on", no opt-in env var) via --mcp-config on the spawned
// `claude` command. One browser + page per server process, which lives for
// the lifetime of the session that spawned it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium, type Browser, type Page } from 'playwright';
import { z } from 'zod';
import { artifactWritePath } from '../core/artifacts.js';

let browser: Browser | undefined;
let page: Page | undefined;

async function getPage(): Promise<Page> {
  if (!browser) browser = await chromium.launch({ headless: true });
  if (!page) page = await browser.newPage();
  return page;
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function toolError(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

const server = new McpServer({ name: 'agentboard-browser', version: '1.0.0' });

server.registerTool(
  'browser_navigate',
  {
    description: 'Navigate the shared browser page to a URL and return its title.',
    inputSchema: { url: z.string().describe('URL to load, including protocol (https://...)') },
  },
  async ({ url }) => {
    const p = await getPage();
    const response = await p.goto(url, { waitUntil: 'load' });
    return text(`Loaded ${p.url()} (status ${response?.status() ?? 'unknown'})\nTitle: ${await p.title()}`);
  }
);

server.registerTool(
  'browser_click',
  {
    description: 'Click the first element matching a CSS selector on the current page.',
    inputSchema: { selector: z.string().describe('CSS selector of the element to click') },
  },
  async ({ selector }) => {
    const p = await getPage();
    try {
      await p.click(selector, { timeout: 10_000 });
      return text(`Clicked '${selector}'`);
    } catch (err) {
      return toolError(`Could not click '${selector}': ${(err as Error).message}`);
    }
  }
);

server.registerTool(
  'browser_fill',
  {
    description: 'Fill a form field (input/textarea) matching a CSS selector with text.',
    inputSchema: {
      selector: z.string().describe('CSS selector of the field to fill'),
      text: z.string().describe('Text to type into the field'),
    },
  },
  async ({ selector, text: value }) => {
    const p = await getPage();
    try {
      await p.fill(selector, value, { timeout: 10_000 });
      return text(`Filled '${selector}'`);
    } catch (err) {
      return toolError(`Could not fill '${selector}': ${(err as Error).message}`);
    }
  }
);

server.registerTool(
  'browser_read',
  {
    description:
      'Read the visible text of the current page, or of one element when a selector is given.',
    inputSchema: { selector: z.string().optional().describe('CSS selector; omit to read the whole page') },
  },
  async ({ selector }) => {
    const p = await getPage();
    try {
      const content = selector ? await p.locator(selector).first().innerText() : await p.innerText('body');
      return text(content);
    } catch (err) {
      return toolError(`Could not read '${selector ?? 'body'}': ${(err as Error).message}`);
    }
  }
);

server.registerTool(
  'browser_screenshot',
  {
    description:
      "Save a screenshot of the current page as a card artifact (artifacts/<cardId>/<name>.png) and return its path.",
    inputSchema: {
      cardId: z.string().describe('Card id the screenshot belongs to, e.g. task_3ab6'),
      name: z.string().optional().describe('File name without extension; defaults to a timestamp'),
    },
  },
  async ({ cardId, name }) => {
    const p = await getPage();
    const fileName = `${name ?? `screenshot-${Date.now()}`}.png`;
    let dest: string;
    try {
      dest = artifactWritePath(cardId, fileName);
    } catch (err) {
      return toolError((err as Error).message);
    }
    await p.screenshot({ path: dest });
    return text(`Saved screenshot to ${dest}`);
  }
);

async function shutdown() {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
