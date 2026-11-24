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
import { requestOrigin } from './config.js';
import { createYouTubeMatcher, MatchCache, parseMatchQuery, YouTubeMatchError } from './youtubeMatches.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MATCH_CACHE_PATH = join(ROOT, 'data', 'youtube-matches.json');

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
    // YouTube's embedded player requires a Referer naming the site it's on, and refuses to
    // play without one. This policy sends other sites only the origin, never the full URL.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(filePath).pipe(res);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** GET /youtube/match?title=…&artist=…&durationMs=…, answering with the videos to try, best first. */
async function handleYouTubeMatch(res, url, findVideos) {
  const song = parseMatchQuery(url.searchParams);
  if (!song) {
    sendJson(res, 400, { error: 'A song title is required.' });
    return;
  }
  try {
    const videos = await findVideos(song);
    sendJson(res, 200, { videos: videos.map(({ id, title, channel }) => ({ id, title, channel })) });
  } catch (error) {
    if (!(error instanceof YouTubeMatchError)) throw error;
    sendJson(res, error.status, { error: error.message });
  }
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {typeof fetch} [fetchImpl] injectable so tests never reach Spotify or YouTube
 * @param {{matchCache?: MatchCache}} [options]
 */
export function createApp(config, fetchImpl = fetch, { matchCache = new MatchCache({ filePath: MATCH_CACHE_PATH }) } = {}) {
  const handleAuthRoute = createAuthRoutes(config, fetchImpl);
  const findVideos = createYouTubeMatcher(config, { cache: matchCache, fetchImpl });

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://internal');
      if (await handleAuthRoute(req, res, url)) return;

      if (req.method === 'GET' && url.pathname === '/youtube/match') {
        await handleYouTubeMatch(res, url, findVideos);
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        // Locally, the room runs at localhost rather than 127.0.0.1, where YouTube won't
        // play music (see appOrigin in config.js). Sign-in still uses 127.0.0.1.
        if (config.appOrigin !== config.canonicalOrigin && requestOrigin(req, config) === config.canonicalOrigin) {
          res.writeHead(302, { Location: `${config.appOrigin}${req.url}`, 'Cache-Control': 'no-store' }).end();
          return;
        }
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
