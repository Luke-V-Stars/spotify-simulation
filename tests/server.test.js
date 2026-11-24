import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { SCOPES } from '../server/authRoutes.js';
import { loadConfig } from '../server/config.js';
import { MatchCache } from '../server/youtubeMatches.js';

const TEST_PORT = 18931;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
/** Where the room is served: YouTube won't play music on a page at an IP address. */
const APP_ORIGIN = `http://localhost:${TEST_PORT}`;
const NONCE = 'a1'.repeat(24);
const SECRET = 'test-secret-value';
const YOUTUBE_KEY = 'test-youtube-key-value';

const config = loadConfig({
  SPOTIFY_CLIENT_ID: 'test-id',
  SPOTIFY_CLIENT_SECRET: SECRET,
  SPOTIFY_REDIRECT_URI: `${ORIGIN}/auth/callback`,
  YOUTUBE_API_KEY: YOUTUBE_KEY,
});

/** Next answer from the fake Spotify token endpoint, and the last request it saw. */
let tokenResponse;
let lastTokenRequest;
const fakeFetch = async (url, options) => {
  lastTokenRequest = { url, headers: options.headers, params: Object.fromEntries(options.body) };
  return new Response(JSON.stringify(tokenResponse.body), { status: tokenResponse.status });
};

let server;
before(async () => {
  server = createApp(config, fakeFetch, { matchCache: new MatchCache({ filePath: null }) });
  await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
});
after(() => server.close());

/**
 * Requests a path from the test server, by default as the room's host (localhost).
 * fetch() forbids overriding Host, so this uses node:http and wraps the result in a Response.
 */
function get(path, cookie, { host = `localhost:${TEST_PORT}`, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(cookie ? { cookie } : {}) };
    request({ host: '127.0.0.1', port: TEST_PORT, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const body = Buffer.concat(chunks);
        resolve(new Response(body.length > 0 ? body : null, { status: res.statusCode, headers: responseHeaders }));
      });
    })
      .on('error', reject)
      .end();
  });
}
/** The same, as 127.0.0.1, the host Spotify returns to. */
const getAtRedirectHost = (path, cookie) => get(path, cookie, { host: `127.0.0.1:${TEST_PORT}` });

/** Reduces Set-Cookie headers to a name -> value map. */
function cookiesFrom(response) {
  return Object.fromEntries(
    response.headers.getSetCookie().map((line) => {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      return [pair.slice(0, index), decodeURIComponent(pair.slice(index + 1))];
    }),
  );
}

test('placeholder values from .env.example count as not configured', () => {
  const placeholder = loadConfig({
    SPOTIFY_CLIENT_ID: 'your_spotify_client_id',
    SPOTIFY_CLIENT_SECRET: 'your_spotify_client_secret',
  });
  assert.equal(placeholder.configured, false);
  assert.deepEqual(placeholder.missing, ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);
});

test('locally the room runs at localhost; deployed, at the host Spotify returns to', () => {
  assert.equal(loadConfig({}).appOrigin, 'http://localhost:8888');
  assert.equal(loadConfig({}).canonicalOrigin, 'http://127.0.0.1:8888');
  const hosted = loadConfig({ SPOTIFY_REDIRECT_URI: 'https://rooms.example/auth/callback' });
  assert.equal(hosted.appOrigin, 'https://rooms.example');
  assert.equal(hosted.canonicalOrigin, 'https://rooms.example');
});

test('login is refused cleanly when not configured', async () => {
  const unconfigured = createApp(loadConfig({}), fakeFetch, { matchCache: new MatchCache({ filePath: null }) });
  await new Promise((resolve) => unconfigured.listen(TEST_PORT + 1, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT + 1}/auth/login`, { redirect: 'manual' });
    assert.equal(response.headers.get('location'), '/?auth_error=not_configured');
  } finally {
    unconfigured.close();
  }
});

test('login starts at the room, which remembers a nonce, then moves to the redirect URI host', async () => {
  const response = await get('/auth/login');
  assert.equal(response.status, 302);
  const next = new URL(response.headers.get('location'));
  assert.equal(next.origin + next.pathname, `${ORIGIN}/auth/login`);
  assert.match(next.searchParams.get('handoff'), /^[0-9a-f]{48}$/);
  assert.equal(cookiesFrom(response).sp_handoff, next.searchParams.get('handoff'));
});

test('login at the redirect URI host without a nonce goes back to the room first', async () => {
  for (const path of ['/auth/login', '/auth/login?handoff=short']) {
    const response = await getAtRedirectHost(path);
    assert.equal(response.headers.get('location'), `${APP_ORIGIN}/auth/login`, path);
    assert.deepEqual(response.headers.getSetCookie(), [], path);
  }
});

test('login ends the Spotify session, then authorizes with the right parameters and a state cookie', async () => {
  const response = await getAtRedirectHost(`/auth/login?handoff=${NONCE}`);
  assert.equal(response.status, 302);
  const logout = new URL(response.headers.get('location'));
  assert.equal(logout.origin + logout.pathname, 'https://accounts.spotify.com/en/logout');

  const authorize = new URL(logout.searchParams.get('continue'));
  assert.equal(authorize.origin + authorize.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'test-id');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${ORIGIN}/auth/callback`);
  assert.equal(authorize.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(authorize.searchParams.get('show_dialog'), 'true');
  assert.equal(cookiesFrom(response).sp_oauth_state, authorize.searchParams.get('state'));
  assert.equal(cookiesFrom(response).sp_handoff, NONCE);
  assert.ok(!response.headers.get('location').includes(SECRET));
});

test('callback rejects a missing or wrong state without calling Spotify', async () => {
  lastTokenRequest = null;
  const response = await getAtRedirectHost('/auth/callback?code=abc&state=forged', `sp_oauth_state=real; sp_handoff=${NONCE}`);
  assert.equal(response.headers.get('location'), '/?auth_error=state_mismatch');
  assert.equal(lastTokenRequest, null);

  const noCookie = await getAtRedirectHost('/auth/callback?code=abc&state=forged');
  assert.equal(noCookie.headers.get('location'), '/?auth_error=state_mismatch');

  const noNonce = await getAtRedirectHost('/auth/callback?code=abc&state=s', 'sp_oauth_state=s');
  assert.equal(noNonce.headers.get('location'), '/?auth_error=state_mismatch');
  assert.equal(lastTokenRequest, null);
});

test('callback passes along a refusal from Spotify', async () => {
  const response = await getAtRedirectHost('/auth/callback?error=access_denied&state=s', `sp_oauth_state=s; sp_handoff=${NONCE}`);
  assert.equal(response.headers.get('location'), '/?auth_error=access_denied');
});

/** Signs in through the callback, returning the room's one-time handover URL. */
async function completeCallback() {
  tokenResponse = { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } };
  const response = await getAtRedirectHost('/auth/callback?code=abc&state=s', `sp_oauth_state=s; sp_handoff=${NONCE}`);
  return { response, handoff: new URL(response.headers.get('location')) };
}

test('callback exchanges the code, then hands the session to the room in an HttpOnly cookie', async () => {
  const { response, handoff } = await completeCallback();
  assert.equal(handoff.origin + handoff.pathname, `${APP_ORIGIN}/auth/handoff`);
  assert.ok(!handoff.searchParams.get('code').includes('rt'), 'the refresh token never appears in a URL');
  assert.equal(cookiesFrom(response).sp_refresh, undefined);
  assert.equal(lastTokenRequest.params.grant_type, 'authorization_code');
  assert.equal(lastTokenRequest.params.code, 'abc');
  assert.equal(
    lastTokenRequest.headers.Authorization,
    `Basic ${Buffer.from(`test-id:${SECRET}`).toString('base64')}`,
  );

  const collected = await get(handoff.pathname + handoff.search, `sp_handoff=${NONCE}`);
  assert.equal(collected.headers.get('location'), '/');
  const refreshCookie = collected.headers.getSetCookie().find((line) => line.startsWith('sp_refresh='));
  assert.match(refreshCookie, /HttpOnly/);
  assert.match(refreshCookie, /SameSite=Lax/);
  assert.equal(cookiesFrom(collected).sp_refresh, 'rt');
  assert.equal(cookiesFrom(collected).sp_handoff, '');

  const again = await get(handoff.pathname + handoff.search, `sp_handoff=${NONCE}`);
  assert.equal(again.headers.get('location'), '/?auth_error=handoff_failed', 'a handover works once');
  assert.equal(cookiesFrom(again).sp_refresh, undefined);
});

test('a handover is refused in a browser that did not start the sign-in', async () => {
  const { handoff } = await completeCallback();
  for (const cookie of [undefined, `sp_handoff=${'b2'.repeat(24)}`]) {
    const response = await get(handoff.pathname + handoff.search, cookie);
    assert.equal(response.headers.get('location'), '/?auth_error=handoff_failed');
    assert.equal(cookiesFrom(response).sp_refresh, undefined);
  }
  const owner = await get(handoff.pathname + handoff.search, `sp_handoff=${NONCE}`);
  assert.equal(owner.headers.get('location'), '/?auth_error=handoff_failed', 'a refused code is used up');
});

test('a failed code exchange reports an error and stores nothing', async () => {
  tokenResponse = { status: 400, body: { error: 'invalid_grant' } };
  const response = await getAtRedirectHost('/auth/callback?code=abc&state=s', `sp_oauth_state=s; sp_handoff=${NONCE}`);
  assert.equal(response.headers.get('location'), '/?auth_error=token_exchange_failed');
  assert.equal(cookiesFrom(response).sp_refresh, undefined);
});

test('token endpoint needs the refresh cookie', async () => {
  assert.equal((await get('/auth/token')).status, 401);
});

test('token endpoint returns only the access token, marked uncacheable', async () => {
  tokenResponse = { status: 200, body: { access_token: 'fresh', expires_in: 3600 } };
  const response = await get('/auth/token', 'sp_refresh=rt');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { accessToken: 'fresh', expiresIn: 3600 });
  assert.equal(lastTokenRequest.params.refresh_token, 'rt');
});

test('a rotated refresh token replaces the cookie but is not exposed to scripts', async () => {
  tokenResponse = { status: 200, body: { access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 } };
  const response = await get('/auth/token', 'sp_refresh=rt');
  assert.equal(cookiesFrom(response).sp_refresh, 'rotated');
  assert.ok(!JSON.stringify(await response.json()).includes('rotated'));
});

test('a revoked refresh token ends the session', async () => {
  tokenResponse = { status: 400, body: { error: 'invalid_grant' } };
  const response = await get('/auth/token', 'sp_refresh=rt');
  assert.equal(response.status, 401);
  assert.equal(cookiesFrom(response).sp_refresh, '');
});

test('a Spotify outage keeps the session', async () => {
  tokenResponse = { status: 503, body: {} };
  const response = await get('/auth/token', 'sp_refresh=rt');
  assert.equal(response.status, 502);
  assert.equal(cookiesFrom(response).sp_refresh, undefined);
});

test('logout requires POST and clears the cookie', async () => {
  assert.equal((await get('/auth/logout')).status, 404);
  const response = await fetch(`${ORIGIN}/auth/logout`, { method: 'POST' });
  assert.equal(cookiesFrom(response).sp_refresh, '');
});

test('status never reveals secrets', async () => {
  const text = await (await get('/auth/status')).text();
  assert.deepEqual(JSON.parse(text), { configured: true, missing: [], youtubeConfigured: true, authenticated: false });
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes(YOUTUBE_KEY));
});

test('serves the app and Three.js', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const three = await get('/vendor/three/build/three.module.js', undefined, { method: 'HEAD' });
  assert.equal(three.status, 200);
  assert.match(three.headers.get('content-type'), /javascript/);
});

test('pages opened at 127.0.0.1 move to localhost, keeping the query', async () => {
  for (const path of ['/', '/?demo=1', '/?auth_error=access_denied']) {
    const response = await getAtRedirectHost(path);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), `${APP_ORIGIN}${path}`, path);
  }
});

test('static serving cannot reach outside its folders', async () => {
  for (const path of [
    '/..%2f.env',
    '/..%2fpackage.json',
    '/..%5cpackage.json',
    '/vendor/three/build/..%2f..%2f..%2f..%2fpackage.json',
    '/%2e%2e/server/config.js',
    '/vendor/three/package.json',
  ]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.ok(!(await response.text()).includes('spotify-simulation'), path);
  }
});

test('malformed URL encoding gets a 400, not a crash', async () => {
  assert.equal((await get('/%E0%A4%A')).status, 400);
});
