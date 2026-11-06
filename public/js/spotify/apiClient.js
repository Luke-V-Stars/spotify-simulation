/**
 * Thin wrapper over the Spotify Web API: attaches the access token and handles
 * expired tokens (401), rate limits (429) and transient server errors (5xx).
 */

const API_BASE = 'https://api.spotify.com/v1';
const MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_AFTER_SECONDS = 2;

export class SpotifyApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SpotifyApiClient {
  #getToken;
  #fetch;
  #sleep;
  /** While rate limited, every request waits here, not only the one that hit the limit. */
  #rateLimitGate = Promise.resolve();

  /**
   * @param {(options?: {forceRefresh?: boolean}) => Promise<string>} getToken
   * @param {{fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>}} [options]
   */
  constructor(getToken, { fetchImpl = (...args) => fetch(...args), sleep = defaultSleep } = {}) {
    this.#getToken = getToken;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
  }

  get(path) {
    return this.request('GET', path);
  }

  put(path, body) {
    return this.request('PUT', path, body);
  }

  /** @param {string} path relative to the API base, or an absolute `next` URL from a page */
  async request(method, path, body) {
    const url = path.startsWith(API_BASE) ? path : `${API_BASE}${path}`;
    let forceRefresh = false;

    for (let attempt = 1; ; attempt++) {
      await this.#rateLimitGate;
      const token = await this.#getToken({ forceRefresh });
      forceRefresh = false;

      const response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.ok) {
        // Player commands answer 202/204 with an empty body.
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      if (attempt < MAX_ATTEMPTS) {
        if (response.status === 401) {
          forceRefresh = true;
          continue;
        }
        if (response.status === 429) {
          const seconds = Number(response.headers.get('Retry-After')) || DEFAULT_RETRY_AFTER_SECONDS;
          this.#rateLimitGate = this.#sleep(seconds * 1000);
          continue;
        }
        if (response.status >= 500) {
          await this.#sleep(500 * 2 ** (attempt - 1));
          continue;
        }
      }

      const detail = await response.json().catch(() => null);
      throw new SpotifyApiError(
        response.status,
        detail?.error?.message || `Spotify request failed (${response.status})`,
      );
    }
  }
}
