/** The top bar button choosing whether songs play from Spotify or from YouTube on the TV. */

import { SPOTIFY, YOUTUBE } from '../playback/playbackSwitch.js';

const STORAGE_KEY = 'vinyl-room:playback-source';
const LABELS = { [SPOTIFY]: 'Spotify', [YOUTUBE]: 'YouTube TV' };

/** The source this browser last chose, if storage is available. */
export function savedSource() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === YOUTUBE ? YOUTUBE : SPOTIFY;
  } catch {
    return SPOTIFY;
  }
}

function saveSource(source) {
  try {
    window.localStorage.setItem(STORAGE_KEY, source);
  } catch {
    // Private windows can refuse storage. The choice then lasts only for this visit.
  }
}

export class SourceToggle {
  #button = document.getElementById('source-toggle');
  #playback;

  /** @param {import('../playback/playbackSwitch.js').PlaybackSwitch} playback */
  constructor(playback) {
    this.#playback = playback;
    this.#button.addEventListener('click', () => {
      const next = playback.source === YOUTUBE ? SPOTIFY : YOUTUBE;
      saveSource(next);
      playback.setSource(next);
    });
    playback.onSource(() => this.#render());
    this.#render();
  }

  #render() {
    const { source, canSwitch } = this.#playback;
    const other = source === YOUTUBE ? SPOTIFY : YOUTUBE;
    this.#button.hidden = !canSwitch;
    document.getElementById('source-name').textContent = LABELS[source];
    this.#button.title = `Switch to ${LABELS[other]}`;
    this.#button.setAttribute('aria-label', `Playing from ${LABELS[source]}. Switch to ${LABELS[other]}`);
  }
}
