/** The song information panel opened by clicking a record. */

import { formatDuration, formatReleaseDate } from './format.js';

const byId = (id) => document.getElementById(id);

export class SongPanel {
  #root = byId('song-panel');
  #play = byId('song-play');
  #note = byId('song-note');
  #art = byId('song-art');
  #record = null;
  /** Why songs can't play at all here, such as no Premium subscription. */
  #playbackBlockedReason = null;

  /**
   * @param {object} handlers
   * @param {(record: object) => void} handlers.onPlay
   * @param {() => void} handlers.onClose
   */
  constructor({ onPlay, onClose }) {
    this.#play.addEventListener('click', () => onPlay(this.#record));
    const close = () => {
      this.close();
      onClose();
    };
    byId('song-close').addEventListener('click', close);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.#root.hidden) close();
    });
  }

  get record() {
    return this.#record;
  }

  open(record) {
    const { track } = record;
    this.#record = record;

    // All text goes through textContent: song metadata is untrusted input.
    byId('song-title').textContent = track.title;
    byId('song-artist').textContent = track.artists.join(', ') || 'Unknown artist';
    byId('song-album').textContent = track.album;
    byId('song-duration').textContent = formatDuration(track.durationMs);
    byId('song-release').textContent = formatReleaseDate(track.releaseDate, track.releaseDatePrecision);

    if (track.artFullUrl) this.#art.src = track.artFullUrl;
    else this.#art.removeAttribute('src');
    this.#art.alt = `Album artwork for ${track.album}`;

    this.#refreshPlayability();
    this.#root.hidden = false;
  }

  #refreshPlayability() {
    const isLocal = Boolean(this.#record?.track.isLocal);
    const reason = this.#playbackBlockedReason ?? (isLocal ? 'This is a local file, which Spotify can\'t stream here.' : null);
    this.#play.hidden = reason !== null;
    this.#note.textContent = reason ?? '';
    this.#note.hidden = reason === null;
  }

  close() {
    this.#root.hidden = true;
    this.#record = null;
  }

  /** Reflects whether the open record is the one currently playing. */
  setPlayState({ isCurrent, paused }) {
    this.#play.textContent = isCurrent && !paused ? 'Pause' : isCurrent ? 'Resume' : 'Play';
  }

  /** Replaces the play button with a lasting explanation, for every song from now on. */
  disablePlayback(reason) {
    this.#playbackBlockedReason = reason;
    this.#refreshPlayability();
  }
}
