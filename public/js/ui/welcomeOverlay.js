/** The opening screen: sign-in choices, library loading progress and fatal messages. */

const byId = (id) => document.getElementById(id);

export class WelcomeOverlay {
  #root = byId('welcome');
  #actions = byId('welcome-actions');
  #connect = byId('connect-spotify');
  #message = byId('welcome-message');
  #progress = byId('welcome-progress');
  #progressLabel = byId('progress-label');
  #progressBar = byId('progress-bar');

  /** @param {{onConnect: () => void, onDemo: () => void}} handlers */
  constructor({ onConnect, onDemo }) {
    this.#connect.addEventListener('click', onConnect);
    byId('open-demo').addEventListener('click', onDemo);
  }

  /** Shows the sign-in choices, with Connect disabled until credentials are set up. */
  showChoices({ canConnect }) {
    this.#connect.disabled = !canConnect;
    this.#actions.hidden = false;
    this.#progress.hidden = true;
    this.#root.hidden = false;
  }

  showMessage(text) {
    this.#message.textContent = text;
    this.#message.hidden = false;
  }

  showProgress(label, fraction = 0) {
    this.#actions.hidden = true;
    this.#message.hidden = true;
    this.#progress.hidden = false;
    this.#progressLabel.textContent = label;
    this.#progressBar.value = fraction;
    this.#root.hidden = false;
  }

  hide() {
    this.#root.hidden = true;
  }
}
