/** The transport bar shown while a song is loaded in the player. */

const byId = (id) => document.getElementById(id);

export class NowPlayingBar {
  #root = byId('now-playing');
  #art = byId('now-art');
  #toggle = byId('now-toggle');

  /** @param {{onToggle: () => void, onNext: () => void, onPrevious: () => void, onVolume: (v: number) => void}} handlers */
  constructor({ onToggle, onNext, onPrevious, onVolume }) {
    this.#toggle.addEventListener('click', onToggle);
    byId('now-next').addEventListener('click', onNext);
    byId('now-previous').addEventListener('click', onPrevious);
    byId('now-volume').addEventListener('input', (event) => onVolume(Number(event.target.value)));
  }

  /** @param {import('../spotify/playbackService.js').PlaybackState|null} state */
  update(state) {
    this.#root.hidden = !state;
    document.body.classList.toggle('has-now-playing', Boolean(state));
    if (!state) return;

    byId('now-title').textContent = state.title;
    byId('now-artist').textContent = state.artist;
    if (state.artUrl) this.#art.src = state.artUrl;
    else this.#art.removeAttribute('src');

    this.#toggle.textContent = state.paused ? '▶' : '⏸';
    this.#toggle.setAttribute('aria-label', state.paused ? 'Play' : 'Pause');
  }
}
