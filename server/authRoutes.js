/**
 * Spotify OAuth 2.0 Authorization Code flow.
 *
 * The client secret and refresh token stay on this side of the wire. The browser
 * only ever receives short-lived access tokens, which the Web Playback SDK and
 * Web API calls need client-side. The refresh token sits in an HttpOnly cookie
 * so page scripts cannot read it.
 */

import { randomBytes } from 'node:crypto';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const REFRESH_COOKIE = 'sp_refresh';
const STATE_COOKIE = 'sp_oauth_state';
const STATE_MAX_AGE_SECONDS = 10 * 60;
const REFRESH_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export const SCOPES = [
  'playlist-read-private', // list and read the user's private playlists
  'playlist-read-collaborative', // include collaborative playlists
  'user-library-read', // the Liked Songs shelf
  'user-top-read', // the top songs and top artists shelves
  'streaming', // required by the Web Playback SDK
  'user-read-email', // required by the Web Playback SDK
  'user-read-private', // required by the Web Playback SDK
  'user-modify-playback-state', // start playback on the in-browser device
];

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0) {
      cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return cookies;
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Set-Cookie': cookies });
  res.end();
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {typeof fetch} fetchImpl injectable so tests never reach Spotify
 * @returns route handler resolving to true when it handled the request
 */
export function createAuthRoutes(config, fetchImpl = fetch) {
  const buildCookie = (name, value, maxAgeSeconds) =>
    [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax', // Lax still sends the cookie on Spotify's top-level redirect back
      `Max-Age=${maxAgeSeconds}`,
      ...(config.secureCookies ? ['Secure'] : []),
    ].join('; ');

  const clearCookie = (name) => buildCookie(name, '', 0);

  async function requestToken(params) {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }

  function handleLogin(req, res) {
    if (!config.configured) {
      return redirect(res, '/?auth_error=not_configured');
    }
    // Cookies are per-host, so state set on localhost would be missing when
    // Spotify returns to 127.0.0.1. Move to the redirect URI's host first.
    const requestOrigin = `${config.secureCookies ? 'https' : 'http'}://${req.headers.host}`;
    if (requestOrigin !== config.canonicalOrigin) {
      return redirect(res, `${config.canonicalOrigin}/auth/login`);
    }

    const state = randomBytes(24).toString('hex');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      scope: SCOPES.join(' '),
      redirect_uri: config.redirectUri,
      state,
    });
    redirect(res, `${AUTHORIZE_URL}?${query}`, [buildCookie(STATE_COOKIE, state, STATE_MAX_AGE_SECONDS)]);
  }

  async function handleCallback(req, res, url) {
    const cookies = parseCookies(req.headers.cookie);
    const clearState = clearCookie(STATE_COOKIE);
    const failWith = (code) => redirect(res, `/?auth_error=${encodeURIComponent(code)}`, [clearState]);

    // The state check stops an attacker from logging a victim into the attacker's account.
    const state = url.searchParams.get('state');
    if (!state || state !== cookies[STATE_COOKIE]) return failWith('state_mismatch');

    const spotifyError = url.searchParams.get('error');
    if (spotifyError) return failWith(spotifyError);

    const code = url.searchParams.get('code');
    if (!code) return failWith('missing_code');

    let result;
    try {
      result = await requestToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
      });
    } catch {
      return failWith('spotify_unreachable');
    }
    if (!result.ok || !result.body.refresh_token) return failWith('token_exchange_failed');

    redirect(res, '/', [
      clearState,
      buildCookie(REFRESH_COOKIE, result.body.refresh_token, REFRESH_MAX_AGE_SECONDS),
    ]);
  }

  /** Mints a fresh access token from the refresh cookie. */
  async function handleToken(req, res) {
    const refreshToken = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    if (!refreshToken) return sendJson(res, 401, { error: 'not_authenticated' });

    let result;
    try {
      result = await requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
    } catch {
      return sendJson(res, 502, { error: 'spotify_unreachable' });
    }

    if (!result.ok) {
      // invalid_grant means the token is dead, for example revoked or expired, so
      // sign out. Anything else may be a transient outage: keep the session.
      if (result.body.error === 'invalid_grant') {
        return sendJson(res, 401, { error: 'session_expired' }, { 'Set-Cookie': clearCookie(REFRESH_COOKIE) });
      }
      return sendJson(res, 502, { error: 'token_refresh_failed' });
    }

    // Spotify may rotate the refresh token. Keep the newest one if it does.
    const headers = result.body.refresh_token
      ? { 'Set-Cookie': buildCookie(REFRESH_COOKIE, result.body.refresh_token, REFRESH_MAX_AGE_SECONDS) }
      : {};
    sendJson(res, 200, { accessToken: result.body.access_token, expiresIn: result.body.expires_in }, headers);
  }

  return async function handleAuthRoute(req, res, url) {
    const { pathname } = url;
    const { method } = req;

    if (method === 'GET' && pathname === '/auth/status') {
      sendJson(res, 200, {
        configured: config.configured,
        missing: config.missing,
        authenticated: Boolean(parseCookies(req.headers.cookie)[REFRESH_COOKIE]),
      });
    } else if (method === 'GET' && pathname === '/auth/login') {
      handleLogin(req, res);
    } else if (method === 'GET' && pathname === config.callbackPath) {
      await handleCallback(req, res, url);
    } else if (method === 'GET' && pathname === '/auth/token') {
      await handleToken(req, res);
    } else if (method === 'POST' && pathname === '/auth/logout') {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(REFRESH_COOKIE) });
    } else {
      return false;
    }
    return true;
  };
}
