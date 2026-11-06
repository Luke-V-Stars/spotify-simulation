/**
 * Mouse and touch interaction with the shelves: hover highlights a record, click
 * selects one, and clicking a shelf outside any record focuses the camera on it.
 */

import { pickRecord } from './recordPicker.js';

/** Movement past this many pixels is an orbit drag, not a click. */
const CLICK_TOLERANCE_PX = 5;

export class SongInteractions {
  #scene;
  #shelves;
  #vinyl;
  #onRecordClick;
  #onShelfClick;
  #canvas;
  #pointer = null; // latest mouse position awaiting a pick
  #pressedAt = null;
  #hoveredId = -1;

  /**
   * @param {object} options
   * @param {import('../scene/sceneManager.js').SceneManager} options.sceneManager
   * @param {Array} options.shelves placed shelves
   * @param {import('../vinyl/vinylRecords.js').VinylRecords} options.vinyl
   * @param {(record: object) => void} options.onRecordClick
   * @param {(shelf: object) => void} options.onShelfClick
   */
  constructor({ sceneManager, shelves, vinyl, onRecordClick, onShelfClick }) {
    this.#scene = sceneManager;
    this.#shelves = shelves;
    this.#vinyl = vinyl;
    this.#onRecordClick = onRecordClick;
    this.#onShelfClick = onShelfClick;
    this.#canvas = sceneManager.renderer.domElement;

    this.#canvas.addEventListener('pointermove', (event) => this.#handleMove(event));
    this.#canvas.addEventListener('pointerleave', () => this.#setHover(-1));
    this.#canvas.addEventListener('pointerdown', (event) => {
      this.#pressedAt = { x: event.clientX, y: event.clientY };
      this.#setHover(-1);
    });
    this.#canvas.addEventListener('pointerup', (event) => this.#handleRelease(event));

    // Picking at most once per frame keeps fast mouse movement cheap.
    sceneManager.onFrame(() => this.#processPointer());
  }

  #pick(clientX, clientY) {
    const hit = pickRecord(this.#scene.screenRay(clientX, clientY), this.#shelves);
    if (!hit) return null;
    const shelf = this.#shelves[hit.shelfIndex];
    return { shelf, record: hit.slotIndex === null ? null : this.#vinyl.recordAt(shelf, hit.slotIndex) };
  }

  #handleMove(event) {
    // Touch has no hover, and while a button is held the user is orbiting.
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return;
    this.#pointer = { x: event.clientX, y: event.clientY };
  }

  #processPointer() {
    if (!this.#pointer) return;
    const hit = this.#pick(this.#pointer.x, this.#pointer.y);
    this.#pointer = null;
    this.#setHover(hit?.record?.instanceId ?? -1);
    this.#canvas.style.cursor = hit ? 'pointer' : '';
  }

  #setHover(instanceId) {
    if (instanceId === this.#hoveredId) return;
    this.#hoveredId = instanceId;
    this.#vinyl.setHover(instanceId);
    this.#scene.invalidate();
  }

  #handleRelease(event) {
    const pressedAt = this.#pressedAt;
    this.#pressedAt = null;
    if (!pressedAt || event.button !== 0) return;
    const moved = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    if (moved > CLICK_TOLERANCE_PX) return;

    const hit = this.#pick(event.clientX, event.clientY);
    if (hit?.record) this.#onRecordClick(hit.record);
    else if (hit) this.#onShelfClick(hit.shelf);
  }
}
