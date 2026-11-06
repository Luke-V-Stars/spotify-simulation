/** Top bar and playlist list: the quick way to find a shelf in a crowded room. */

const byId = (id) => document.getElementById(id);

function describePlaylist(playlist, shelfCount) {
  if (playlist.status === 'restricted') return 'Songs not shared by Spotify';
  if (playlist.status === 'failed') return 'Songs could not be loaded';
  if (playlist.status === 'reconnect') return 'Sign out and connect again to load these';
  const songs = `${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'song' : 'songs'}`;
  return shelfCount > 1 ? `${songs} · ${shelfCount} shelves` : songs;
}

export class ShelfDrawer {
  #toggle = byId('shelves-toggle');
  #drawer = byId('shelf-drawer');

  /** @param {{onSignOut: () => void, signOutLabel: string, demoMode: boolean}} options */
  constructor({ onSignOut, signOutLabel, demoMode }) {
    this.#toggle.addEventListener('click', () => this.setOpen(this.#drawer.hidden));
    const signOut = byId('sign-out');
    signOut.textContent = signOutLabel;
    signOut.addEventListener('click', onSignOut);
    byId('mode-badge').hidden = !demoMode;
    byId('top-bar').hidden = false;
  }

  setOpen(open) {
    this.#drawer.hidden = !open;
    this.#toggle.setAttribute('aria-expanded', String(open));
  }

  /**
   * @param {Array} shelves placed shelves, in playlist order
   * @param {(shelf: object) => void} onSelect receives the playlist's first shelf
   */
  render(shelves, onSelect) {
    const list = byId('shelf-list');
    const closeAfterSelecting = () => window.matchMedia('(max-width: 640px)').matches && this.setOpen(false);

    for (const shelf of shelves) {
      if (shelf.part !== 1) continue;
      const name = document.createElement('span');
      name.className = 'shelf-name';
      name.textContent = shelf.playlist.name; // textContent: playlist names are untrusted

      const meta = document.createElement('span');
      meta.className = 'shelf-meta';
      meta.textContent = describePlaylist(shelf.playlist, shelf.partCount);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'shelf-button';
      button.append(name, meta);
      button.addEventListener('click', () => {
        onSelect(shelf);
        closeAfterSelecting();
      });

      const item = document.createElement('li');
      item.append(button);
      list.append(item);
    }
  }
}
