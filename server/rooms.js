/**
 * Shared rooms: who is in each one and where they stand.
 *
 * This knows nothing about the network. Each player comes with a `send` function, and
 * multiplayer.js connects that to a WebSocket. Everything a client sends is checked
 * here, because anyone can open a socket and send anything.
 */

import { randomInt } from 'node:crypto';

/** No 0/O or 1/I/L, so a code read aloud or copied by hand can't be mistyped. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

const MAX_NAME_LENGTH = 24;
const DEFAULT_NAME = 'Guest';
/** Rooms are at most 25 m across, so anything much further out is nonsense. */
const MAX_COORDINATE = 100;
const MAX_MESSAGE_LENGTH = 512;

/** Avatar colours, handed out in order so everyone in a room looks different. */
export const PLAYER_COLORS = [
  '#e8bd78', '#7cc4e8', '#e87c9a', '#8fd18a', '#c79bf0', '#f0a35e',
  '#5ed1c1', '#f07c6c', '#a8b4f5', '#d9d36a', '#f5a8d8', '#9ccfa8',
];

/** A random room code from a cryptographic source, so codes can't be guessed. */
export function randomRoomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** A display name made safe to show: no control characters, trimmed, and not too long. */
export function cleanName(value) {
  if (typeof value !== 'string') return DEFAULT_NAME;
  // Control and formatting characters (including bidi overrides) could disguise a name.
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('') || DEFAULT_NAME;
}

const round = (value) => Math.round(value * 100) / 100;

/** A position and facing, or null if any part is missing or out of range. */
function readPose({ x, z, yaw }) {
  const valid = [x, z, yaw].every((value) => typeof value === 'number' && Number.isFinite(value));
  if (!valid || Math.abs(x) > MAX_COORDINATE || Math.abs(z) > MAX_COORDINATE) return null;
  // Facing is kept between -π and π, however many turns the client has made.
  return { x: round(x), z: round(z), yaw: round(Math.atan2(Math.sin(yaw), Math.cos(yaw))) };
}

/**
 * Reads one message from a client, or returns null if it isn't one this server accepts.
 * @returns {{type: 'join', room: string, name: string, pose: object|null} | {type: 'move', pose: object} | null}
 */
export function parseClientMessage(text) {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_LENGTH) return null;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof message !== 'object' || message === null) return null;

  if (message.type === 'join') {
    const room = typeof message.room === 'string' ? message.room.toUpperCase() : '';
    if (!ROOM_CODE_PATTERN.test(room)) return null;
    return { type: 'join', room, name: cleanName(message.name), pose: readPose(message) };
  }
  if (message.type === 'move') {
    const pose = readPose(message);
    return pose ? { type: 'move', pose } : null;
  }
  return null;
}

/** What other players are told about someone. Never includes their connection. */
const describe = ({ id, name, color, pose }) => ({ id, name, color, ...(pose ?? {}) });

export class RoomRegistry {
  /** @type {Map<string, {code: string, players: Map<string, object>, expiry: any}>} */
  #rooms = new Map();
  #nextPlayer = 1;
  #options;

  /**
   * @param {object} [options]
   * @param {number} [options.maxRooms]
   * @param {number} [options.maxPlayersPerRoom]
   * @param {number} [options.emptyRoomTtlMs] how long an empty room waits for someone, such as its host reloading
   * @param {() => string} [options.randomCode]
   * @param {typeof setTimeout} [options.setTimer]
   * @param {typeof clearTimeout} [options.clearTimer]
   */
  constructor(options = {}) {
    this.#options = {
      maxRooms: 200,
      maxPlayersPerRoom: PLAYER_COLORS.length,
      emptyRoomTtlMs: 10 * 60 * 1000,
      randomCode: randomRoomCode,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      ...options,
    };
  }

  get roomCount() {
    return this.#rooms.size;
  }

  /** Opens a new, empty room. Returns its code, or null if the server has too many open. */
  create() {
    if (this.#rooms.size >= this.#options.maxRooms) return null;
    let code;
    do code = this.#options.randomCode();
    while (this.#rooms.has(code));
    const room = { code, players: new Map(), expiry: null };
    this.#rooms.set(code, room);
    this.#closeWhenEmpty(room);
    return code;
  }

  /**
   * Adds a player to a room, telling them who's there and telling everyone else about them.
   * @param {(message: object) => void} send delivers a message to this player
   * @returns {{ok: true, player: object} | {ok: false, reason: 'not_found'|'full'}}
   */
  join(code, { name, pose = null }, send) {
    const room = this.#rooms.get(code);
    if (!room) return { ok: false, reason: 'not_found' };
    if (room.players.size >= this.#options.maxPlayersPerRoom) return { ok: false, reason: 'full' };

    const usedColors = new Set([...room.players.values()].map((player) => player.color));
    const player = {
      id: `p${this.#nextPlayer++}`,
      name: cleanName(name),
      color: PLAYER_COLORS.find((color) => !usedColors.has(color)) ?? PLAYER_COLORS[0],
      pose,
      room,
      send,
    };
    this.#options.clearTimer(room.expiry);
    room.expiry = null;

    send({ type: 'welcome', id: player.id, room: code, players: [...room.players.values()].map(describe) });
    this.#broadcast(room, { type: 'joined', player: describe(player) });
    room.players.set(player.id, player);
    return { ok: true, player };
  }

  move(player, pose) {
    if (!player.room.players.has(player.id)) return;
    player.pose = pose;
    this.#broadcast(player.room, { type: 'moved', id: player.id, ...pose }, player);
  }

  leave(player) {
    const { room } = player;
    if (!room.players.delete(player.id)) return;
    this.#broadcast(room, { type: 'left', id: player.id });
    if (room.players.size === 0) this.#closeWhenEmpty(room);
  }

  #closeWhenEmpty(room) {
    room.expiry = this.#options.setTimer(() => {
      if (room.players.size === 0) this.#rooms.delete(room.code);
    }, this.#options.emptyRoomTtlMs);
    room.expiry?.unref?.(); // never keeps the process alive on its own
  }

  #broadcast(room, message, except = null) {
    for (const player of room.players.values()) {
      if (player !== except) player.send(message);
    }
  }
}
