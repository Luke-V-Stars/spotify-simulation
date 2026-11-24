/** The top bar's room button, and the dialog asking for a display name. */

const NAME_STORAGE_KEY = 'vinyl-room:display-name';
const byId = (id) => document.getElementById(id);

function savedName() {
  try {
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name) {
  try {
    window.localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Private windows can refuse storage. The name is then asked for each visit.
  }
}

/**
 * Asks for the name other players will see.
 * @param {{title: string, text: string, confirmLabel: string}} wording
 * @returns {Promise<string|null>} the name, or null if the user cancelled
 */
export function askForName({ title, text, confirmLabel }) {
  const dialog = byId('name-dialog');
  const input = byId('name-input');
  byId('name-dialog-title').textContent = title;
  byId('name-dialog-text').textContent = text;
  byId('name-confirm').textContent = confirmLabel;
  input.value = savedName();
  dialog.returnValue = '';

  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        const name = input.value.trim();
        if (dialog.returnValue !== 'ok' || !name) {
          resolve(null);
          return;
        }
        saveName(name);
        resolve(name);
      },
      { once: true },
    );
    dialog.showModal();
    input.select();
  });
}

export class RoomButton {
  #button = byId('room-button');

  /** @param {{onClick: () => void}} options */
  constructor({ onClick }) {
    this.#button.addEventListener('click', onClick);
    this.#button.hidden = false;
    this.showIdle();
  }

  showIdle() {
    this.#render('Invite friends', 'Open a shared room and copy an invite link');
  }

  showBusy(label) {
    this.#render(label, label);
  }

  /** @param {string} code @param {number} people including this player */
  showRoom(code, people) {
    const here = `${people} ${people === 1 ? 'person' : 'people'} here`;
    this.#render(`Room ${code} · ${people}`, `Room ${code}, ${here}. Copy the invite link`);
  }

  #render(label, description) {
    this.#button.textContent = label;
    this.#button.title = description;
    this.#button.setAttribute('aria-label', description);
  }
}
