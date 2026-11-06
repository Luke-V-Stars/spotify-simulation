/**
 * Owns the renderer, camera, walking controls and render loop.
 *
 * Frames are rendered only when something changed: a still room costs almost
 * nothing, which matters on laptops and with large libraries.
 */

import * as THREE from 'three';
import { EYE_HEIGHT } from '../bookshelves/shelfLayout.js';
import { isWalkable } from './walkCollision.js';
import { WalkControls } from './walkControls.js';

const FOCUS_DURATION_S = 1.0;
const MIN_FOCUS_DISTANCE = 0.8;
const FOCUS_SEARCH_STEP = 0.1;
const MAX_PIXEL_RATIO = 2;

export class SceneManager {
  #frameCallbacks = [];
  #needsRender = true;
  /** @type {import('./walkCollision.js').WalkBounds|null} */
  #walkBounds = null;
  #raycaster = new THREE.Raycaster();
  #ndc = new THREE.Vector2();
  #clock = new THREE.Timer();

  /** @param {HTMLElement} container throws if the browser has no WebGL2 */
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // Shelves never move once built, so the shadow map is drawn once, not every frame.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    container.append(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050403);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 60);
    this.controls = new WalkControls(this.camera, this.renderer.domElement);

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();

    this.renderer.setAnimationLoop(() => this.#frame());
  }

  invalidate() {
    this.#needsRender = true;
  }

  /** Redraws the static shadow map, for use after the room's contents change. */
  refreshShadows() {
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
  }

  /**
   * Registers a per-frame callback. Return true from it to request a render.
   * @param {(deltaSeconds: number) => boolean|void} callback
   */
  onFrame(callback) {
    this.#frameCallbacks.push(callback);
  }

  /** Converts a screen position to a plain world-space ray, for the record picker. */
  screenRay(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.#ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#ndc, this.camera);
    const { origin, direction } = this.#raycaster.ray;
    return {
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: direction.x,
      dy: direction.y,
      dz: direction.z,
    };
  }

  /**
   * Stands the viewer at a room layout's starting point and fits movement to its floor.
   * @param {ReturnType<import('../bookshelves/shelfLayout.js').layoutBookshelves>} layout
   */
  enterRoom({ start, walkBounds }) {
    this.#walkBounds = walkBounds;
    this.controls.setBounds(walkBounds);
    this.controls.jumpTo(start.position, start.lookAt);
    this.invalidate();
  }

  /**
   * Walks the viewer to look squarely at a region of the room, far enough back to
   * fit `width` on screen, or as far as the aisle allows. Walking continues from there.
   */
  focusOn({ center, facing, width }) {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fitVertical = (width * 0.55) / Math.tan(halfFov);
    const wanted = Math.max(MIN_FOCUS_DISTANCE, fitVertical / Math.min(1, this.camera.aspect));
    const standAt = (distance) => ({
      x: center.x + facing.x * distance,
      z: center.z + facing.z * distance,
    });

    let distance = wanted;
    let foundFloor = false;
    for (let d = MIN_FOCUS_DISTANCE; d <= wanted; d += FOCUS_SEARCH_STEP) {
      const { x, z } = standAt(d);
      if (isWalkable(x, z, this.#walkBounds)) {
        distance = d;
        foundFloor = true;
      } else if (foundFloor) {
        break;
      }
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.controls.flyTo({ ...standAt(distance), y: EYE_HEIGHT }, center, reduceMotion ? 0 : FOCUS_DURATION_S);
    this.invalidate();
  }

  #resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.invalidate();
  }

  #frame() {
    this.#clock.update();
    const delta = Math.min(this.#clock.getDelta(), 0.1);

    if (this.controls.update(delta)) this.#needsRender = true;

    for (const callback of this.#frameCallbacks) {
      if (callback(delta)) this.#needsRender = true;
    }

    if (this.#needsRender) {
      this.#needsRender = false;
      this.renderer.render(this.scene, this.camera);
    }
  }
}
