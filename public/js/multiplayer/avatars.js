/**
 * Other players in the room: a simple figure in their colour, with a visor showing which
 * way they face and their name above. Each glides toward the latest position reported.
 *
 * Rooms hold at most 12 players, so each figure is a few ordinary meshes sharing
 * geometry. Batching them as the records are wouldn't be worth the complexity.
 */

import * as THREE from 'three';
import { easePose } from './presence.js';

const BODY_RADIUS = 0.24;
const BODY_LENGTH = 0.7;
const BODY_CENTRE_Y = 0.65;
const HEAD_RADIUS = 0.17;
const HEAD_Y = 1.45;
const LABEL_Y = 1.92;
const LABEL_HEIGHT = 0.16;
const LABEL_CANVAS_HEIGHT = 96;
const LABEL_FONT = `600 44px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const MAX_LABEL_CANVAS_WIDTH = 640;

const bodyGeometry = new THREE.CapsuleGeometry(BODY_RADIUS, BODY_LENGTH, 6, 16);
const headGeometry = new THREE.SphereGeometry(HEAD_RADIUS, 20, 14);
const visorGeometry = new THREE.BoxGeometry(0.22, 0.07, 0.08);
const visorMaterial = new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.15, metalness: 0.6 });

/** A name tag drawn on a canvas. Names come from other people, so they're only ever drawn as text. */
function nameLabel(name, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = LABEL_FONT;
  const padding = 28;
  const dot = 22;
  const textWidth = Math.ceil(ctx.measureText(name).width);
  canvas.width = Math.min(MAX_LABEL_CANVAS_WIDTH, padding * 2 + dot + 16 + textWidth);
  canvas.height = LABEL_CANVAS_HEIGHT;

  const radius = canvas.height / 2;
  ctx.fillStyle = 'rgba(23, 16, 10, 0.86)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, radius);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(padding + dot / 2, radius, dot / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = LABEL_FONT; // resizing the canvas reset it
  ctx.fillStyle = '#f6ead6';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, padding + dot + 16, radius + 2, canvas.width - padding * 2 - dot - 16);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthWrite: false, toneMapped: false, transparent: true }),
  );
  sprite.scale.set((LABEL_HEIGHT * canvas.width) / canvas.height, LABEL_HEIGHT, 1);
  sprite.position.y = LABEL_Y;
  return sprite;
}

function buildFigure({ name, color }) {
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  const body = new THREE.Mesh(bodyGeometry, material);
  body.position.y = BODY_CENTRE_Y;
  const head = new THREE.Mesh(headGeometry, material);
  head.position.y = HEAD_Y;
  // The camera looks along -z when its yaw is 0, so the face is on that side too.
  const visor = new THREE.Mesh(visorGeometry, visorMaterial);
  visor.position.set(0, HEAD_Y + 0.02, -HEAD_RADIUS + 0.02);

  const figure = new THREE.Group();
  figure.name = `player:${name}`;
  figure.add(body, head, visor, nameLabel(name, color));
  return { figure, material };
}

export class Avatars {
  #scene;
  /** @type {Map<string, {figure: THREE.Group, material: THREE.Material, shown: object, target: object|null}>} */
  #players = new Map();

  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.#scene = scene;
  }

  get count() {
    return this.#players.size;
  }

  /** Replaces everyone, as after joining or reconnecting. */
  reset(players) {
    for (const id of [...this.#players.keys()]) this.remove(id);
    for (const player of players) this.add(player);
  }

  /** @param {{id: string, name: string, color: string, x?: number, z?: number, yaw?: number}} player */
  add(player) {
    this.remove(player.id);
    const { figure, material } = buildFigure(player);
    const hasPose = typeof player.x === 'number';
    const entry = { figure, material, shown: { x: 0, z: 0, yaw: 0 }, target: null };
    figure.visible = false; // until there's somewhere to stand
    this.#players.set(player.id, entry);
    this.#scene.add(figure);
    if (hasPose) this.move(player.id, player);
  }

  /** A new reported position. The first one is taken at once; later ones are glided to. */
  move(id, { x, z, yaw }) {
    const entry = this.#players.get(id);
    if (!entry) return;
    if (!entry.target) Object.assign(entry.shown, { x, z, yaw });
    entry.target = { x, z, yaw };
    entry.figure.visible = true;
    this.#place(entry);
  }

  remove(id) {
    const entry = this.#players.get(id);
    if (!entry) return;
    this.#players.delete(id);
    this.#scene.remove(entry.figure);
    entry.material.dispose();
    const label = entry.figure.children.find((child) => child.isSprite);
    label.material.map.dispose();
    label.material.dispose();
  }

  /** @returns {boolean} true while anyone is moving, so the room keeps redrawing */
  update(deltaSeconds) {
    let moving = false;
    for (const entry of this.#players.values()) {
      if (!entry.target) continue;
      if (easePose(entry.shown, entry.target, deltaSeconds)) moving = true;
      this.#place(entry);
    }
    return moving;
  }

  #place({ figure, shown }) {
    figure.position.set(shown.x, 0, shown.z);
    figure.rotation.y = shown.yaw;
  }
}
