/**
 * Plays songs from YouTube in the on-screen TV, for anyone Spotify can't play for.
 * It has the same interface as SpotifyPlayback (see playbackService.js), plus stop().
 *
 * Only the sound and picture come from YouTube. The title, artist and artwork shown are
 * the Spotify song's, so the room behaves the same whichever service is playing.
 */

import { createYouTubePlayer } from './youtubeApi.js';
import { findVideos as findVideosOnServer } from './videoMatcher.js';

/** YT.PlayerState values. */
const ENDED = 0;
const PLAYING = 1;
const BUFFERING = 3;

/**
 * Player errors meaning this video can't play here, so the next match is worth trying:
 * 2 bad video ID, 5 the browser's video player failed, 100 removed or private,
 * 101 and 150 the owner doesn't allow it to play on other sites.
 */
const SKIPPABLE_ERRORS = new Set([2, 5, 100, 101, 150]);

/** Stops a run of unplayable songs from skipping through a whole playlist. */
const MAX_SKIPPED_IN_A_ROW = 3;

export class YouTubePlayback {
  #tv;
  #findVideos;
  #createPlayer;
  #player = null;
  #playerReady = null;
  #stateListeners = [];
  #errorListeners = [];

  #queue = [];
  #index = -1;
  #playlist = null;
  #track = null;
  /** Whether the current song was reached by playing on, rather than being chosen. */
  #automatic = false;
  #videos = [];
  #videoIndex = 0;
  #playerState = -1;
  /** Whether the current video has started, so the player's time and duration are its own. */
  #started = false;
  /** Bumped for every song, so a slow search for an earlier song is ignored. */
  #request = 0;
  #skippedInARow = 0;
  #volume = 0.6;

  /**
   * @param {object} options
   * @param {{mountElement: HTMLElement, show: (status: string) => void, hide: () => void}} options.tv
   * @param {typeof findVideosOnServer} [options.findVideos]
   * @param {typeof createYouTubePlayer} [options.createPlayer]
   */
  constructor({ tv, findVideos = findVideosOnServer, createPlayer = createYouTubePlayer }) {
    this.#tv = tv;
    this.#findVideos = findVideos;
    this.#createPlayer = createPlayer;
  }

  onState(callback) {
    this.#stateListeners.push(callback);
  }

  onError(callback) {
    this.#errorListeners.push(callback);
  }

  /** The player loads on first play instead, so nothing of YouTube's loads until it's used. */
  async start() {}

  /** Plays a song, then carries on through its playlist, or its shelf if that isn't a playlist. */
  async playTrack(track, playlist, shelfTracks = [track]) {
    const list = playlist?.uri ? playlist.tracks : shelfTracks;
    this.#queue = list.filter((candidate) => !candidate.isLocal);
    if (!this.#queue.includes(track)) this.#queue = [track];
    this.#playlist = playlist;
    this.#skippedInARow = 0;
    await this.#playAt(this.#queue.indexOf(track), { automatic: false });
  }

  async toggle() {
    if (!this.#player || this.#videos.length === 0) return;
    if (this.#isPlaying()) this.#player.pauseVideo();
    else this.#player.playVideo();
  }

  next() {
    if (this.#queue.length === 0) return undefined;
    return this.#playAt((this.#index + 1) % this.#queue.length, { automatic: false });
  }

  previous() {
    if (this.#queue.length === 0) return undefined;
    return this.#playAt((this.#index - 1 + this.#queue.length) % this.#queue.length, { automatic: false });
  }

  async seek(positionMs) {
    if (!this.#started) return;
    this.#player.seekTo(positionMs / 1000, true);
    // The player reports no state change for a seek, so report the new position here.
    this.#emitState(positionMs);
  }

  setVolume(volume) {
    this.#volume = volume;
    this.#player?.setVolume(Math.round(volume * 100));
  }

  /** Stops playing and puts the TV away, for when Spotify takes over. */
  stop() {
    this.#request++;
    this.#player?.stopVideo();
    this.#queue = [];
    this.#index = -1;
    this.#track = null;
    this.#videos = [];
    this.#tv.hide();
    this.#emitState();
  }

  async #playAt(index, { automatic }) {
    const request = ++this.#request;
    this.#index = index;
    this.#track = this.#queue[index];
    this.#automatic = automatic;
    this.#videos = [];
    this.#videoIndex = 0;
    this.#started = false;
    this.#playerState = -1;
    this.#player?.pauseVideo(); // the last song shouldn't play on while the next is found
    this.#tv.show(`Finding “${this.#track.title}” on YouTube…`);
    this.#emitState();

    let videos;
    try {
      [videos] = await Promise.all([this.#findVideos(this.#track), this.#ensurePlayer()]);
    } catch (error) {
      if (request !== this.#request) return;
      this.#tv.show(error.message);
      this.#emitError(error.message);
      return;
    }
    if (request !== this.#request) return;

    if (videos.length === 0) {
      this.#cannotPlay();
      return;
    }
    this.#videos = videos;
    this.#loadVideo();
  }

  #loadVideo() {
    const video = this.#videos[this.#videoIndex];
    this.#tv.show(`YouTube: ${video.title}${video.channel ? ` · ${video.channel}` : ''}`);
    this.#player.loadVideoById(video.id);
  }

  /** Nothing found will play. A song reached by playing on is skipped; a chosen one isn't. */
  #cannotPlay() {
    const message = `No YouTube video of “${this.#track.title}” can play here.`;
    const hasNext = this.#index < this.#queue.length - 1;
    if (this.#automatic && hasNext && this.#skippedInARow < MAX_SKIPPED_IN_A_ROW) {
      this.#skippedInARow++;
      this.#emitError(`${message} Skipping to the next song.`);
      this.#playAt(this.#index + 1, { automatic: true });
      return;
    }
    this.#videos = [];
    this.#tv.show(message);
    this.#emitError(message);
    this.#emitState();
  }

  #ensurePlayer() {
    this.#playerReady ??= this.#createPlayer(this.#tv.mountElement, {
      onStateChange: (state) => this.#handleStateChange(state),
      onError: (code) => this.#handleError(code),
      onAutoplayBlocked: () => {
        this.#emitError('Your browser blocked autoplay. Press play on the TV or the player bar to start the song.');
      },
    })
      .then((player) => {
        this.#player = player;
        player.setVolume(Math.round(this.#volume * 100));
        return player;
      })
      .catch((error) => {
        this.#playerReady = null; // try loading the player again next time
        throw error;
      });
    return this.#playerReady;
  }

  #handleStateChange(state) {
    // Events from the last song can still arrive while the next is being found.
    if (this.#videos.length === 0) return;
    this.#playerState = state;
    if (state === PLAYING) {
      this.#started = true;
      this.#skippedInARow = 0;
    }
    if (state === ENDED) {
      this.#playOn();
      return;
    }
    this.#emitState();
  }

  #handleError(code) {
    if (this.#videos.length === 0) return;
    if (SKIPPABLE_ERRORS.has(code) && this.#videoIndex < this.#videos.length - 1) {
      this.#videoIndex++;
      this.#loadVideo();
      return;
    }
    this.#cannotPlay();
  }

  /** At the end of a song, plays the next one. The list stops at its end, as Spotify's do. */
  #playOn() {
    if (this.#index < this.#queue.length - 1) {
      this.#playAt(this.#index + 1, { automatic: true });
    } else {
      this.#emitState();
    }
  }

  #isPlaying() {
    return this.#playerState === PLAYING || this.#playerState === BUFFERING;
  }

  /** @param {number} [positionMs] overrides the player's position, which lags just after a seek */
  #emitState(positionMs) {
    const track = this.#track;
    let state = null;
    if (track) {
      const videoDurationMs = this.#started ? this.#player.getDuration() * 1000 : 0;
      state = {
        uris: [track.uri],
        title: track.title,
        artist: track.artists.join(', '),
        artUrl: track.artThumbUrl ?? null,
        paused: !this.#isPlaying(),
        contextUri: this.#playlist?.uri ?? null,
        positionMs: positionMs ?? (this.#started ? this.#player.getCurrentTime() * 1000 : 0),
        // The video's own length, once known: it can differ a little from Spotify's.
        durationMs: videoDurationMs > 0 ? videoDurationMs : track.durationMs,
      };
    }
    this.#stateListeners.forEach((listener) => listener(state));
  }

  #emitError(message) {
    this.#errorListeners.forEach((listener) => listener(message, { fatal: false }));
  }
}
