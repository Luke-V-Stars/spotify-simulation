/**
 * Spotify Web Playback SDK integration: turns the browser into a Spotify Connect
 * device, then starts songs on it through the Web API.
 *
 * Premium is only detectable here, through the SDK's `account_error`. The Web API
 * no longer exposes the subscription level on the user profile.
 *
 * SpotifyPlayback and DemoPlayback (demoLibrary.js) share one interface:
 *   start(), playTrack(track, playlist, shelfTracks), toggle(), next(), previous(), setVolume(v)
 *   onState(cb), where cb gets a PlaybackState or null when nothing is playing
 *   onError(cb), where cb gets a user-facing message, and { fatal: true } if
 *     playback can never work in this session
 */

/**
 * @typedef {object} PlaybackState
 * @property {string[]} uris the playing song's URIs: track relinking means the URI
 *   Spotify plays can differ from the URI in the playlist, so match against any
 * @property {string} title
 * @property {string} artist
 * @property {string|null} artUrl
 * @property {boolean} paused
 * @property {string|null} contextUri
 */

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const PLAYER_NAME = 'Vinyl Listening Room';
const READY_TIMEOUT_MS = 15_000;

/**
 * What to ask Spotify to play. A real playlist plays as itself, so next and previous follow
 * it. A shelf the app assembled has no URI, so it plays as a list of its shelf's songs.
 */
export function playbackRequest(track, playlist, shelfTracks = [track]) {
  if (playlist?.uri) return { context_uri: playlist.uri, offset: { uri: track.uri } };
  const uris = shelfTracks.filter((candidate) => !candidate.isLocal).map((candidate) => candidate.uri);
  return { uris, offset: { uri: track.uri } };
}

/** Loads the SDK script once, resolving with the global `Spotify` namespace. */
function loadSdk() {
  if (window.Spotify) return Promise.resolve(window.Spotify);
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the Spotify player.'));
    document.head.append(script);
  });
}

export class SpotifyPlayback {
  #api;
  #getToken;
  #player = null;
  #deviceId = null;
  /** Message explaining why playback can never work here, such as no Premium. */
  #fatalError = null;
  #deviceReady;
  #resolveDeviceReady;
  #stateListeners = [];
  #errorListeners = [];

  /**
   * @param {import('./apiClient.js').SpotifyApiClient} api
   * @param {() => Promise<string>} getToken
   */
  constructor(api, getToken) {
    this.#api = api;
    this.#getToken = getToken;
    this.#deviceReady = new Promise((resolve) => {
      this.#resolveDeviceReady = resolve;
    });
  }

  onState(callback) {
    this.#stateListeners.push(callback);
  }

  onError(callback) {
    this.#errorListeners.push(callback);
  }

  /** Connects the in-browser device. Failures are reported through onError. */
  async start() {
    try {
      const Spotify = await loadSdk();
      this.#player = new Spotify.Player({
        name: PLAYER_NAME,
        volume: 0.6,
        // Called on connect and whenever the SDK needs a fresh token.
        getOAuthToken: (callback) => {
          this.#getToken()
            .then(callback)
            .catch((error) => this.#emitError(error.message));
        },
      });
      this.#attachListeners();
      await this.#player.connect();
    } catch (error) {
      this.#fail(error.message);
    }
  }

  #attachListeners() {
    const player = this.#player;
    player.addListener('ready', ({ device_id: deviceId }) => {
      this.#deviceId = deviceId;
      this.#resolveDeviceReady();
    });
    player.addListener('not_ready', () => {
      this.#deviceId = null;
    });
    player.addListener('player_state_changed', (state) => {
      const mapped = mapSdkState(state);
      this.#stateListeners.forEach((listener) => listener(mapped));
    });
    player.addListener('account_error', () => {
      this.#fail('Playing songs here requires Spotify Premium. You can still browse your shelves.');
    });
    player.addListener('initialization_error', () => {
      this.#fail('This browser can\'t run the Spotify player. Try a desktop version of Chrome, Edge or Firefox.');
    });
    player.addListener('authentication_error', ({ message }) => {
      this.#emitError(`Spotify could not authenticate the player: ${message}`);
    });
    player.addListener('playback_error', () => {
      this.#emitError('Spotify could not play that song.');
    });
    player.addListener('autoplay_failed', () => {
      this.#emitError('Your browser blocked autoplay. Click play to start the song.');
    });
  }

  /**
   * Plays a song within its playlist so next/previous keep moving along the shelf.
   * Must be called from a click handler: browsers only allow audio after a user gesture.
   */
  async playTrack(track, playlist, shelfTracks) {
    // Runs synchronously, before any await, to stay inside the click's user gesture.
    this.#player?.activateElement();
    await this.#whenDeviceReady();
    const body = playbackRequest(track, playlist, shelfTracks);
    await this.#api.put(`/me/player/play?device_id=${encodeURIComponent(this.#deviceId)}`, body);
  }

  async toggle() {
    this.#player?.activateElement();
    await this.#player?.togglePlay();
  }

  next() {
    return this.#player?.nextTrack();
  }

  previous() {
    return this.#player?.previousTrack();
  }

  setVolume(volume) {
    return this.#player?.setVolume(volume);
  }

  async #whenDeviceReady() {
    if (this.#fatalError) throw new Error(this.#fatalError);
    if (this.#deviceId) return;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The Spotify player is taking too long to connect.')), READY_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.#deviceReady, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!this.#deviceId) throw new Error(this.#fatalError ?? 'The Spotify player disconnected.');
  }

  #fail(message) {
    this.#fatalError = message;
    this.#emitError(message, { fatal: true });
  }

  #emitError(message, details = { fatal: false }) {
    this.#errorListeners.forEach((listener) => listener(message, details));
  }
}

/** @returns {PlaybackState|null} */
export function mapSdkState(state) {
  const track = state?.track_window?.current_track;
  if (!track) return null;
  return {
    uris: [track.uri, track.linked_from?.uri].filter(Boolean),
    title: track.name,
    artist: track.artists.map((artist) => artist.name).join(', '),
    artUrl: track.album?.images?.at(-1)?.url ?? null,
    paused: state.paused,
    contextUri: state.context?.uri ?? null,
  };
}
