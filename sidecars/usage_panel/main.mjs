/**
 * Context & Usage sidecar backend.
 *
 * Runs either inside Antigravity via `sidecar_sdk` or in `--standalone` mode on
 * `127.0.0.1` for local verification and browser previews.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSnapshot, findAppDataDirs, ID_RE } from './lib/usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/fonts/InterVariable.woff2': ['fonts/InterVariable.woff2', 'font/woff2'],
  '/fonts/MapleMono-Regular.woff2': ['fonts/MapleMono-Regular.woff2', 'font/woff2'],
};

const BINARY_EXT_RE = /\.(jpg|jpeg|png|ico|webp|woff2)$/i;

const VALID_RANGES = new Set(['1', '7', '14', '30', '90', 'all']);
const VALID_SCOPES = new Set(['all', 'main']);

function parseTzOffset(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return new Date().getTimezoneOffset();
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < -840 || n > 840) {
    return new Date().getTimezoneOffset();
  }
  return Math.trunc(n);
}

async function handleSnapshot(params, hostConversationId = '') {
  const activeConversationId = ID_RE.test(params.conversationId || '')
    ? params.conversationId
    : hostConversationId;
  const targetConversationId = ID_RE.test(params.target || '') ? params.target : '';
  const rangeDays = VALID_RANGES.has(params.range) ? params.range : '30';
  const scope = VALID_SCOPES.has(params.scope) ? params.scope : 'all';
  const tzOffsetMinutes = parseTzOffset(params.tzOffset);
  const knownEtag = typeof params.etag === 'string' ? params.etag : '';

  return collectSnapshot({
    appDataDirs: findAppDataDirs(),
    activeConversationId,
    targetConversationId,
    rangeDays,
    scope,
    tzOffsetMinutes,
    knownEtag,
  });
}

function readPublicFile(name) {
  const fullPath = join(PUBLIC_DIR, name);
  return BINARY_EXT_RE.test(name) ? readFileSync(fullPath) : readFileSync(fullPath, 'utf-8');
}

async function startSidecarMode() {
  const { SidecarApp, Response } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => readPublicFile('index.html'));

  for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
    app.api(
      route,
      () =>
        new Response(readPublicFile(file), {
          contentType,
          headers: { 'Cache-Control': 'no-cache' },
        }),
      'GET',
    );
  }

  app.api(
    '/api/snapshot',
    async (data) => {
      const payload = await handleSnapshot(data, app.config.conversationId || '');
      return new Response(JSON.stringify(payload), {
        contentType: 'application/json; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
      });
    },
    'GET',
  );

  await app.run();
}

function parsePortArg() {
  const idx = process.argv.indexOf('--port');
  if (idx >= 0 && process.argv[idx + 1]) {
    const p = Number(process.argv[idx + 1]);
    if (Number.isInteger(p) && p >= 0 && p <= 65535) return p;
  }
  const envPort = Number(process.env.STANDALONE_PORT);
  return Number.isInteger(envPort) && envPort >= 0 ? envPort : 0;
}

function startStandaloneMode() {
  const port = parsePortArg();
  const hostConv = process.env.ANTIGRAVITY_CONVERSATION_ID || '';

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readPublicFile('index.html'));
        return;
      }

      if (url.pathname === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end('/* standalone preload shim */\n');
        return;
      }

      if (STATIC_ASSETS[url.pathname]) {
        const [file, contentType] = STATIC_ASSETS[url.pathname];
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        res.end(readPublicFile(file));
        return;
      }

      if (url.pathname === '/api/snapshot') {
        const params = Object.fromEntries(url.searchParams.entries());
        const payload = await handleSnapshot(params, hostConv);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    console.log(`[usage_panel:standalone] listening on http://127.0.0.1:${addr.port}/`);
  });
}

const forceStandalone = process.argv.includes('--standalone') || !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
if (forceStandalone) {
  startStandaloneMode();
} else {
  await startSidecarMode();
}
