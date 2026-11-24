/**
 * The browser's live connection to a shared room. It joins, passes on what the server
 * says about other players, and reconnects by itself after a dropped connection.
 */

const SOCKET_PATH = '/rooms/socket';
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const MAX_RETRIES = 8;

/** Closes that retrying can't fix, with what to tell the user. These match server/multiplayer.js. */
const FINAL_CLOSES = {
  4400: 'The room connection was refused. Reload the page to try again.',
  4403: 'This page isn\'t allowed to connect to the room.',
  4404: 'That room has closed, or the link is wrong. Ask for a new invite link.',
  4409: 'That room is full.',
  4429: 'The room connection was sending too much, so it was closed. Reload the page to rejoin.',
};

/** Opens a room on the server, resolving with its code. */
export async function createRoom(fetchImpl = fetch) {
  const response = await fetchImpl('/rooms', { method: 'POST' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.code) throw new Error(body.error ?? 'The room could not be opened. Try again in a moment.');
  return body.code;
}

export function socketUrl(location = window.location) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${SOCKET_PATH}`;
}

export class RoomClient {
  #code;
  #name;
  #getPose;
  #url;
  #WebSocket;
  #setTimer;
  #socket = null;
  #retries = 0;
  #retryTimer = null;
  #closed = false;
  #listeners = { welcome: [], joined: [], moved: [], left: [], status: [] };

  /**
   * @param {object} options
   * @param {string} options.code
   * @param {string} options.name
   * @param {() => {x: number, z: number, yaw: number}} options.getPose where this player stands when joining
   * @param {string} [options.url]
   * @param {typeof WebSocket} [options.WebSocketImpl]
   * @param {typeof setTimeout} [options.setTimer]
   */
  constructor({ code, name, getPose, url = socketUrl(), WebSocketImpl = WebSocket, setTimer = setTimeout }) {
    this.#code = code;
    this.#name = name;
    this.#getPose = getPose;
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    this.#setTimer = setTimer;
  }

  get code() {
    return this.#code;
  }

  /**
   * welcome({id, players}), joined(player), moved({id, x, z, yaw}), left({id}),
   * status({state: 'connected'|'reconnecting'|'closed', message?})
   */
  on(event, callback) {
    this.#listeners[event].push(callback);
  }

  connect() {
    this.#closed = false;
    const socket = new this.#WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', room: this.#code, name: this.#name, ...this.#getPose() }));
    });
    socket.addEventListener('message', (event) => this.#receive(event.data));
    socket.addEventListener('close', (event) => {
      if (socket !== this.#socket) return;
      this.#socket = null;
      this.#handleClose(event.code);
    });
  }

  sendPose(pose) {
    if (this.#socket?.readyState !== this.#WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ type: 'move', ...pose }));
  }

  /** Leaves the room for good. */
  close() {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    this.#socket?.close(1000);
    this.#socket = null;
  }

  #receive(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.type === 'welcome') {
      this.#retries = 0;
      this.#emit('status', { state: 'connected' });
      this.#emit('welcome', message);
    } else if (message.type === 'joined') {
      this.#emit('joined', message.player);
    } else if (message.type === 'moved' || message.type === 'left') {
      this.#emit(message.type, message);
    }
  }

  #handleClose(code) {
    if (this.#closed) return;
    const finalMessage = FINAL_CLOSES[code];
    if (finalMessage || this.#retries >= MAX_RETRIES) {
      this.#closed = true;
      this.#emit('status', { state: 'closed', message: finalMessage ?? 'Lost the connection to the room.' });
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(this.#retries, RETRY_DELAYS_MS.length - 1)];
    this.#retries++;
    this.#emit('status', { state: 'reconnecting' });
    this.#retryTimer = this.#setTimer(() => this.connect(), delay);
  }

  #emit(event, value) {
    for (const listener of this.#listeners[event]) listener(value);
  }
}
