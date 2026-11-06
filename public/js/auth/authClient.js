/**
 * Browser side of authentication. Talks only to our own /auth/* routes: all
 * contact with Spotify's accounts service and the client secret stays on the server.
 * Access tokens are kept in memory and never written to browser storage.
 */

const EXPIRY_MARGIN_MS = 60_000;

export class AuthExpiredError extends Error {
  constructor() {
    super('Your Spotify session has ended. Please reconnect.');
    this.name = 'AuthExpiredError';
  }
}

export class AuthClient {
  #token = null;
  #expiresAt = 0;
  #inFlight = null;

  /** @returns {Promise<{configured: boolean, missing: string[], authenticated: boolean}>} */
  async getStatus() {
    const response = await fetch('/auth/status');
    if (!response.ok) throw new Error('Could not reach the app server.');
    return response.json();
  }

  login() {
    window.location.assign('/auth/login');
  }

  async logout() {
    this.#token = null;
    this.#expiresAt = 0;
    await fetch('/auth/logout', { method: 'POST' });
  }

  /** Returns a valid access token, refreshing if needed. Concurrent callers share one refresh. */
  async getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.#token && Date.now() < this.#expiresAt) return this.#token;
    this.#inFlight ??= this.#refresh().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #refresh() {
    const response = await fetch('/auth/token');
    if (response.status === 401) {
      this.#token = null;
      throw new AuthExpiredError();
    }
    if (!response.ok) throw new Error('Could not refresh the Spotify session.');

    const { accessToken, expiresIn } = await response.json();
    this.#token = accessToken;
    this.#expiresAt = Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS;
    return accessToken;
  }
}
