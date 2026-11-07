import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { SCOPES } from '../server/authRoutes.js';
import { loadConfig } from '../server/config.js';

const TEST_PORT = 18931;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const SECRET = 'test-secret-value';

const config = loadConfig({
  SPOTIFY_CLIENT_ID: 'test-id',
  SPOTIFY_CLIENT_SECRET: SECRET,
  SPOTIFY_REDIRECT_URI: `${ORIGIN}/auth/callback`,
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
  server = createApp(config, fakeFetch);
  await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
});
after(() => server.close());

const get = (path, cookie) =>
  fetch(`${ORIGIN}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

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

test('login is refused cleanly when not configured', async () => {
  const unconfigured = createApp(loadConfig({}), fakeFetch);
  await new Promise((resolve) => unconfigured.listen(TEST_PORT + 1, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT + 1}/auth/login`, { redirect: 'manual' });
    assert.equal(response.headers.get('location'), '/?auth_error=not_configured');
  } finally {
    unconfigured.close();
  }
});

test('login ends the Spotify session, then authorizes with the right parameters and a state cookie', async () => {
  const response = await get('/auth/login');
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
  assert.ok(!response.headers.get('location').includes(SECRET));
});

test('login on another hostname moves to the redirect URI host first', async () => {
  // fetch() forbids overriding Host, so this one request uses node:http.
  const response = await new Promise((resolve, reject) => {
    request(`${ORIGIN}/auth/login`, { headers: { host: `localhost:${TEST_PORT}` } }, resolve)
      .on('error', reject)
      .end();
  });
  response.resume();
  assert.equal(response.headers.location, `${ORIGIN}/auth/login`);
  assert.equal(response.headers['set-cookie'], undefined);
});

test('callback rejects a missing or wrong state without calling Spotify', async () => {
  lastTokenRequest = null;
  const response = await get('/auth/callback?code=abc&state=forged', 'sp_oauth_state=real');
  assert.equal(response.headers.get('location'), '/?auth_error=state_mismatch');
  assert.equal(lastTokenRequest, null);

  const noCookie = await get('/auth/callback?code=abc&state=forged');
  assert.equal(noCookie.headers.get('location'), '/?auth_error=state_mismatch');
});

test('callback passes along a refusal from Spotify', async () => {
  const response = await get('/auth/callback?error=access_denied&state=s', 'sp_oauth_state=s');
  assert.equal(response.headers.get('location'), '/?auth_error=access_denied');
});

test('callback exchanges the code and stores the refresh token in an HttpOnly cookie', async () => {
  tokenResponse = { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } };
  const response = await get('/auth/callback?code=abc&state=s', 'sp_oauth_state=s');

  assert.equal(response.headers.get('location'), '/');
  assert.equal(lastTokenRequest.params.grant_type, 'authorization_code');
  assert.equal(lastTokenRequest.params.code, 'abc');
  assert.equal(
    lastTokenRequest.headers.Authorization,
    `Basic ${Buffer.from(`test-id:${SECRET}`).toString('base64')}`,
  );

  const refreshCookie = response.headers.getSetCookie().find((line) => line.startsWith('sp_refresh='));
  assert.match(refreshCookie, /HttpOnly/);
  assert.match(refreshCookie, /SameSite=Lax/);
  assert.equal(cookiesFrom(response).sp_refresh, 'rt');
});

test('a failed code exchange reports an error and stores nothing', async () => {
  tokenResponse = { status: 400, body: { error: 'invalid_grant' } };
  const response = await get('/auth/callback?code=abc&state=s', 'sp_oauth_state=s');
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
  assert.deepEqual(JSON.parse(text), { configured: true, missing: [], authenticated: false });
  assert.ok(!text.includes(SECRET));
});

test('serves the app and Three.js', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const three = await fetch(`${ORIGIN}/vendor/three/build/three.module.js`, { method: 'HEAD' });
  assert.equal(three.status, 200);
  assert.match(three.headers.get('content-type'), /javascript/);
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
