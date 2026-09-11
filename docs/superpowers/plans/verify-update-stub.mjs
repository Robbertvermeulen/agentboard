// Stub for two remote APIs the update path talks to:
//   GET  /releases/latest                      → GitHub "latest release" JSON
//   GET  /v1/apps/:app/machines/:id            → Fly machine with a config
//   POST /v1/apps/:app/machines/:id            → records the body, returns ok
// Usage: node verify-update-stub.mjs <port> <latest version> <record file>
import http from 'node:http';
import fs from 'node:fs';

const [port, latest, record] = process.argv.slice(2);
const calls = [];
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: body || null });
      fs.writeFileSync(record, JSON.stringify(calls, null, 2));
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/releases/latest') {
        return res.end(JSON.stringify({ tag_name: `v${latest}`, html_url: `https://example.test/releases/v${latest}`, published_at: '2026-09-04T10:00:00Z' }));
      }
      if (req.url.startsWith('/v1/apps/') && req.method === 'GET') {
        return res.end(JSON.stringify({ id: 'm1', config: { image: 'ghcr.io/robbertvermeulen/agentboard:0.1.0', env: { TZ: 'Europe/Amsterdam' }, services: [] } }));
      }
      if (req.url.startsWith('/v1/apps/') && req.method === 'POST') {
        return res.end(JSON.stringify({ id: 'm1', state: 'replacing' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  })
  .listen(Number(port), '127.0.0.1');
