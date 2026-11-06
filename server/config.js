/**
 * Reads and validates server configuration from environment variables.
 *
 * The app must still boot with placeholder credentials so the room can be
 * explored in demo mode, so missing values are reported rather than thrown.
 */

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/auth/callback';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/** True when a value is unset or still the placeholder from .env.example. */
function isPlaceholder(value) {
  return !value || /^your_/i.test(value.trim());
}

export function loadConfig(env = process.env) {
  const clientId = env.SPOTIFY_CLIENT_ID;
  const clientSecret = env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = isPlaceholder(env.SPOTIFY_REDIRECT_URI)
    ? DEFAULT_REDIRECT_URI
    : env.SPOTIFY_REDIRECT_URI.trim();

  const redirect = new URL(redirectUri);
  const missing = [];
  if (isPlaceholder(clientId)) missing.push('SPOTIFY_CLIENT_ID');
  if (isPlaceholder(clientSecret)) missing.push('SPOTIFY_CLIENT_SECRET');

  const isLoopback = LOOPBACK_HOSTS.has(redirect.hostname);
  const redirectPort = redirect.port || (redirect.protocol === 'https:' ? '443' : '80');

  return {
    clientId,
    clientSecret,
    redirectUri,
    missing,
    configured: missing.length === 0,
    /** Path the OAuth callback is served from, derived so it can't drift from the URI. */
    callbackPath: redirect.pathname,
    /** Origin Spotify redirects back to. Cookies must be set on this host. */
    canonicalOrigin: redirect.origin,
    /** Stay private on developer machines; hosted deployments set HOST and PORT. */
    host: env.HOST || (isLoopback ? redirect.hostname.replace(/[[\]]/g, '') : '0.0.0.0'),
    port: Number(env.PORT || redirectPort),
    secureCookies: redirect.protocol === 'https:',
    usesRejectedLocalhost: redirect.hostname === 'localhost',
  };
}
