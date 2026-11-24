/**
 * The on-screen TV that holds YouTube's player. YouTube's rules require its player to stay
 * visible and at least 200 × 200 pixels while it plays, so this stays fixed on screen at a
 * size the stylesheet guarantees, with nothing laid over it, from the first song until
 * Spotify takes over again.
 */

const byId = (id) => document.getElementById(id);

export class TvPanel {
  #root = byId('tv-panel');
  #status = byId('tv-status');

  /** The element YouTube's player replaces. Only read once, when the player is created. */
  get mountElement() {
    return byId('tv-player');
  }

  /** @param {string} status a line under the screen: what's being found, or what's playing */
  show(status) {
    this.#status.textContent = status;
    this.#status.title = status;
    this.#root.hidden = false;
    document.body.classList.add('has-tv');
  }

  hide() {
    this.#root.hidden = true;
    document.body.classList.remove('has-tv');
  }
}
