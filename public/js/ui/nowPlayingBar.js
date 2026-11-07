/** The transport bar shown while a song is loaded in the player. */

import { formatDuration } from './format.js';

const byId = (id) => document.getElementById(id);

const TICK_MS = 250;
const SKIP_MS = 10_000;

/**
 * How far into the song it is now. Players only report a position when their state
 * changes, so while playing, the time since that report is added on.
 */
export function positionAt(state, elapsedMs) {
  const position = state.paused ? state.positionMs : state.positionMs + elapsedMs;
  return Math.min(position, state.durationMs);
}

export class NowPlayingBar {
  #root = byId('now-playing');
  #art = byId('now-art');
  #toggle = byId('now-toggle');
  #seek = byId('now-seek');
  #elapsed = byId('now-elapsed');
  #onSeek;
  /** @type {import('../spotify/playbackService.js').PlaybackState|null} */
  #state = null;
  #stateAt = 0;
  /** True while the slider is held, so the moving song doesn't pull it from under the pointer. */
  #scrubbing = false;

  /** @param {{onToggle: () => void, onNext: () => void, onPrevious: () => void, onSeek: (ms: number) => void, onVolume: (v: number) => void}} handlers */
  constructor({ onToggle, onNext, onPrevious, onSeek, onVolume }) {
    this.#onSeek = onSeek;
    this.#toggle.addEventListener('click', onToggle);
    byId('now-next').addEventListener('click', onNext);
    byId('now-previous').addEventListener('click', onPrevious);
    byId('now-back').addEventListener('click', () => this.#seekTo(this.#currentPosition() - SKIP_MS));
    byId('now-forward').addEventListener('click', () => this.#seekTo(this.#currentPosition() + SKIP_MS));
    byId('now-volume').addEventListener('input', (event) => onVolume(Number(event.target.value)));

    this.#seek.addEventListener('pointerdown', () => {
      this.#scrubbing = true;
    });
    // On the window, because a drag can end with the pointer away from the slider.
    for (const type of ['pointerup', 'pointercancel']) {
      window.addEventListener(type, () => {
        this.#scrubbing = false;
      });
    }
    // `input` fires throughout a drag and `change` once on release, so only the release seeks.
    this.#seek.addEventListener('input', () => this.#showTime(Number(this.#seek.value)));
    this.#seek.addEventListener('change', () => this.#seekTo(Number(this.#seek.value)));

    setInterval(() => {
      if (this.#state && !this.#state.paused) this.#renderPosition();
    }, TICK_MS);
  }

  /** @param {import('../spotify/playbackService.js').PlaybackState|null} state */
  update(state) {
    this.#state = state;
    this.#stateAt = performance.now();
    this.#root.hidden = !state;
    document.body.classList.toggle('has-now-playing', Boolean(state));
    if (!state) return;

    byId('now-title').textContent = state.title;
    byId('now-artist').textContent = state.artist;
    if (state.artUrl) this.#art.src = state.artUrl;
    else this.#art.removeAttribute('src');

    this.#toggle.textContent = state.paused ? '▶' : '⏸';
    this.#toggle.setAttribute('aria-label', state.paused ? 'Play' : 'Pause');

    this.#seek.max = state.durationMs;
    byId('now-total').textContent = formatDuration(state.durationMs);
    this.#renderPosition();
  }

  #currentPosition() {
    return positionAt(this.#state, performance.now() - this.#stateAt);
  }

  /** Moves the bar straight away rather than waiting for the player to report the new position. */
  #seekTo(positionMs) {
    if (!this.#state) return;
    const target = Math.max(0, Math.min(positionMs, this.#state.durationMs));
    this.#state = { ...this.#state, positionMs: target };
    this.#stateAt = performance.now();
    this.#renderPosition();
    this.#onSeek(target);
  }

  #renderPosition() {
    if (this.#scrubbing) return;
    const position = this.#currentPosition();
    this.#seek.value = position;
    this.#showTime(position);
  }

  #showTime(positionMs) {
    // Rounded down, so the clock only reads a second once that second has passed.
    const time = formatDuration(Math.floor(positionMs / 1000) * 1000);
    this.#elapsed.textContent = time;
    this.#seek.setAttribute('aria-valuetext', time);
  }
}
