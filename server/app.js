/**
 * HTTP application: OAuth routes plus static files.
 * There is no build step, so the browser loads ES modules directly, with Three.js
 * served out of node_modules at the paths mapped by the import map in index.html.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthRoutes } from './authRoutes.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** URL prefix to directory. Only these directories are ever exposed. */
const STATIC_MOUNTS = [
  ['/vendor/three/build/', join(ROOT, 'node_modules/three/build')],
  ['/vendor/three/examples/jsm/', join(ROOT, 'node_modules/three/examples/jsm')],
  ['/', join(ROOT, 'public')],
];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** Maps a URL path to a file, refusing anything that escapes its mount. */
function resolveStaticPath(pathname) {
  const mount = STATIC_MOUNTS.find(([prefix]) => pathname.startsWith(prefix));
  if (!mount) return null;
  const [prefix, directory] = mount;
  const relative = pathname.slice(prefix.length) || 'index.html';
  const filePath = resolve(directory, relative);
  return filePath.startsWith(directory + sep) ? filePath : null;
}

async function serveStatic(req, res, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  const filePath = resolveStaticPath(decodedPath);
  const contentType = filePath && CONTENT_TYPES[extname(filePath)];
  const fileInfo = contentType && (await stat(filePath).catch(() => null));
  if (!fileInfo?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileInfo.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(filePath).pipe(res);
}

export function createApp(config, fetchImpl) {
  const handleAuthRoute = createAuthRoutes(config, fetchImpl);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://internal');
      if (await handleAuthRoute(req, res, url)) return;

      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        res.writeHead(405).end('Method not allowed');
      }
    } catch (error) {
      // Log only the message: request details could include OAuth codes.
      console.error('Request failed:', error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}
