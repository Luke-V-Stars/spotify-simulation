/**
 * Lets a Spotify session play songs through YouTube instead. It has the same interface
 * as the players it wraps, so the rest of the app doesn't know which one is playing.
 *
 * When Spotify can never play here, such as without Premium or in an unsupported browser,
 * YouTube takes over for the rest of the session and switching back isn't offered.
 */

export const SPOTIFY = 'spotify';
export const YOUTUBE = 'youtube';

export class PlaybackSwitch {
  #spotify;
  #youtube;
  #source;
  /** Why Spotify can't play here, once it has said so. */
  #spotifyBlocked = null;
  #stateListeners = [];
  #errorListeners = [];
  #sourceListeners = [];

  /**
   * @param {object} options
   * @param {import('../spotify/playbackService.js').SpotifyPlayback} options.spotify
   * @param {import('../youtube/youtubePlayback.js').YouTubePlayback} options.youtube
   * @param {string} [options.source] which plays first
   */
  constructor({ spotify, youtube, source = SPOTIFY }) {
    this.#spotify = spotify;
    this.#youtube = youtube;
    this.#source = source === YOUTUBE ? YOUTUBE : SPOTIFY;

    spotify.onState((state) => {
      if (this.#source === SPOTIFY) this.#emitState(state);
    });
    youtube.onState((state) => {
      if (this.#source === YOUTUBE) this.#emitState(state);
    });
    youtube.onError((message, details) => {
      if (this.#source === YOUTUBE) this.#emitError(message, details);
    });
    spotify.onError((message, details) => {
      if (details.fatal) {
        this.#spotifyBlocked = message;
        if (this.#source === SPOTIFY) {
          this.#emitError(`${message} Songs will play from YouTube on the TV instead.`, { fatal: false });
          this.#switchTo(YOUTUBE);
        } else {
          this.#notifySource();
        }
      } else if (this.#source === SPOTIFY) {
        this.#emitError(message, details);
      }
    });
  }

  get source() {
    return this.#source;
  }

  /** False once Spotify has turned out to be unusable here. */
  get canSwitch() {
    return this.#spotifyBlocked === null;
  }

  onState(callback) {
    this.#stateListeners.push(callback);
  }

  onError(callback) {
    this.#errorListeners.push(callback);
  }

  /** @param {(source: string) => void} callback called whenever the source or canSwitch changes */
  onSource(callback) {
    this.#sourceListeners.push(callback);
  }

  async setSource(source) {
    if (source === this.#source || (source === SPOTIFY && !this.canSwitch)) return;
    await this.#switchTo(source);
  }

  start() {
    // Spotify always connects, so the session learns early whether it can play here.
    this.#spotify.start();
    this.#youtube.start();
  }

  async playTrack(track, playlist, shelfTracks) {
    if (this.#source === YOUTUBE) return this.#youtube.playTrack(track, playlist, shelfTracks);
    try {
      return await this.#spotify.playTrack(track, playlist, shelfTracks);
    } catch (error) {
      // Spotify said it can't play here while this song was starting: play it from YouTube.
      if (this.#source === YOUTUBE) return this.#youtube.playTrack(track, playlist, shelfTracks);
      throw error;
    }
  }

  toggle() {
    return this.#active().toggle();
  }

  next() {
    return this.#active().next();
  }

  previous() {
    return this.#active().previous();
  }

  seek(positionMs) {
    return this.#active().seek(positionMs);
  }

  setVolume(volume) {
    // Both, so switching keeps the volume the listener chose.
    this.#youtube.setVolume(volume);
    return this.#spotify.setVolume(volume);
  }

  #active() {
    return this.#source === YOUTUBE ? this.#youtube : this.#spotify;
  }

  async #switchTo(source) {
    const previous = this.#source;
    this.#source = source;
    this.#emitState(null);
    this.#notifySource();
    if (previous === YOUTUBE) {
      this.#youtube.stop();
    } else {
      await Promise.resolve(this.#spotify.pause()).catch(() => {});
    }
  }

  #emitState(state) {
    this.#stateListeners.forEach((listener) => listener(state));
  }

  #emitError(message, details) {
    this.#errorListeners.forEach((listener) => listener(message, details));
  }

  #notifySource() {
    this.#sourceListeners.forEach((listener) => listener(this.#source));
  }
}
