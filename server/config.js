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

/** The origin a request was made to, as the browser sees it. */
export function requestOrigin(req, config) {
  return `${config.secureCookies ? 'https' : 'http'}://${req.headers.host}`;
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
  const youtubeApiKey = isPlaceholder(env.YOUTUBE_API_KEY) ? null : env.YOUTUBE_API_KEY.trim();

  return {
    clientId,
    clientSecret,
    redirectUri,
    missing,
    configured: missing.length === 0,
    /** Server-side only: used to search YouTube, never sent to the browser. */
    youtubeApiKey,
    youtubeConfigured: youtubeApiKey !== null,
    /** Path the OAuth callback is served from, derived so it can't drift from the URI. */
    callbackPath: redirect.pathname,
    /** Origin Spotify redirects back to. Sign-in's state cookie must be set on this host. */
    canonicalOrigin: redirect.origin,
    /**
     * Origin the room itself is served from. Spotify insists on 127.0.0.1 for local
     * sign-in, but YouTube refuses to play licensed music on a page addressed by an IP
     * number, so locally the room runs at localhost and sign-in hands the session over.
     */
    appOrigin: isLoopback ? `http://localhost:${redirectPort}` : redirect.origin,
    /** Stay private on developer machines; hosted deployments set HOST and PORT. */
    host: env.HOST || (isLoopback ? redirect.hostname.replace(/[[\]]/g, '') : '0.0.0.0'),
    port: Number(env.PORT || redirectPort),
    secureCookies: redirect.protocol === 'https:',
    usesRejectedLocalhost: redirect.hostname === 'localhost',
  };
}
