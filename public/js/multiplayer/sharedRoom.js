/**
 * Shared rooms in the page: opening one or joining from an invite link, showing the
 * other players, and sending this player's position as they walk.
 *
 * For now every shared room is the demo room. Its library is generated from a fixed
 * seed, so everyone sees the same shelves in the same places.
 */

import { askForName, RoomButton } from '../ui/roomControls.js';
import { showToast } from '../ui/toast.js';
import { Avatars } from './avatars.js';
import { PoseThrottle } from './presence.js';
import { createRoom, RoomClient } from './roomClient.js';

const ROOM_PARAM = 'room';
const CODE_PATTERN = /^[A-Z0-9]{6}$/;

/** The room code in an invite link, if there's a well-formed one. */
export function roomCodeFrom(params) {
  const code = params.get(ROOM_PARAM)?.trim().toUpperCase();
  return code && CODE_PATTERN.test(code) ? code : null;
}

const inviteLink = (code) => `${window.location.origin}/?${ROOM_PARAM}=${code}`;

export class SharedRoom {
  #sceneManager;
  #avatars;
  #button;
  #throttle = new PoseThrottle();
  /** @type {RoomClient|null} */
  #client = null;
  /** Other players' names, for saying who left. */
  #names = new Map();
  #busy = false;

  /**
   * @param {object} options
   * @param {import('../scene/sceneManager.js').SceneManager} options.sceneManager
   * @param {string|null} options.joinCode from an invite link
   */
  constructor({ sceneManager, joinCode }) {
    this.#sceneManager = sceneManager;
    this.#avatars = new Avatars(sceneManager.scene);
    this.#button = new RoomButton({ onClick: () => this.#handleButton() });
    sceneManager.onFrame((delta) => this.#frame(delta));
    if (joinCode) this.#joinFromLink(joinCode);
  }

  async #joinFromLink(code) {
    const name = await askForName({
      title: 'Join the room',
      text: `You've been invited to room ${code}. Choose the name the others will see.`,
      confirmLabel: 'Join',
    });
    if (name) this.#join(code, name);
    else this.#setLink(null);
  }

  async #handleButton() {
    if (this.#client) {
      this.#copyInvite(this.#client.code);
      return;
    }
    if (this.#busy) return;
    const name = await askForName({
      title: 'Invite friends',
      text: 'This opens a shared room and copies a link to it. Anyone with the link can join and walk around with you. Choose the name the others will see.',
      confirmLabel: 'Open room',
    });
    if (!name) return;

    this.#busy = true;
    this.#button.showBusy('Opening room…');
    try {
      const code = await createRoom();
      this.#join(code, name);
      this.#copyInvite(code);
    } catch (error) {
      this.#button.showIdle();
      showToast(error.message);
    } finally {
      this.#busy = false;
    }
  }

  #join(code, name) {
    const client = new RoomClient({ code, name, getPose: () => this.#pose() });
    this.#client = client;
    this.#setLink(code);
    this.#button.showBusy('Joining…');

    client.on('welcome', ({ players }) => {
      this.#names = new Map(players.map((player) => [player.id, player.name]));
      this.#avatars.reset(players);
      this.#throttle.reset();
      this.#refresh();
    });
    client.on('joined', (player) => {
      this.#names.set(player.id, player.name);
      this.#avatars.add(player);
      showToast(`${player.name} joined the room.`);
      this.#refresh();
    });
    client.on('moved', ({ id, x, z, yaw }) => {
      this.#avatars.move(id, { x, z, yaw });
      this.#sceneManager.invalidate();
    });
    client.on('left', ({ id }) => {
      const name = this.#names.get(id);
      this.#names.delete(id);
      this.#avatars.remove(id);
      if (name) showToast(`${name} left the room.`);
      this.#refresh();
    });
    client.on('status', ({ state, message }) => {
      if (state === 'reconnecting') {
        this.#button.showBusy('Reconnecting…');
        showToast('Lost the connection to the room. Reconnecting…');
      } else if (state === 'closed') {
        this.#leave();
        showToast(message, 9000);
      }
    });
    client.connect();
  }

  #leave() {
    this.#client?.close();
    this.#client = null;
    this.#names.clear();
    this.#avatars.reset([]);
    this.#button.showIdle();
    this.#setLink(null);
    this.#sceneManager.invalidate();
  }

  #refresh() {
    if (this.#client) this.#button.showRoom(this.#client.code, this.#avatars.count + 1);
    this.#sceneManager.invalidate();
  }

  #pose() {
    const { camera } = this.#sceneManager;
    return { x: camera.position.x, z: camera.position.z, yaw: camera.rotation.y };
  }

  #frame(delta) {
    if (this.#client) {
      const pose = this.#throttle.next(this.#pose(), performance.now());
      if (pose) this.#client.sendPose(pose);
    }
    return this.#avatars.update(delta);
  }

  async #copyInvite(code) {
    const link = inviteLink(code);
    try {
      await navigator.clipboard.writeText(link);
      showToast(`Invite link copied: ${link}`);
    } catch {
      showToast(`Share this invite link: ${link}`, 15000);
    }
  }

  /** Keeps the address bar's link to this room, so a reload rejoins it. */
  #setLink(code) {
    const url = code ? `/?${ROOM_PARAM}=${code}` : '/?demo=1';
    window.history.replaceState(null, '', url);
  }
}
