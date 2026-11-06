/**
 * Owns the renderer, camera, orbit controls and render loop.
 *
 * Frames are rendered only when something changed: a still room costs almost
 * nothing, which matters on laptops and with large libraries.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ROOM_HEIGHT, ROOM_SIZE } from '../bookshelves/shelfLayout.js';

const WALL_MARGIN = 0.25; // keeps the camera from clipping through the room's surfaces
const FOCUS_DURATION_S = 1.0;
const MAX_PIXEL_RATIO = 2;

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class SceneManager {
  #frameCallbacks = [];
  #needsRender = true;
  #tween = null;
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
    this.camera.position.set(6.2, 2.5, 7.8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.3, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 14;
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('start', () => {
      this.#tween = null; // the user takes over from any camera move in progress
    });

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
   * Flies the camera to look squarely at a region of the room, far enough back to
   * fit `width` on screen. Orbiting continues around the new centre afterward.
   */
  focusOn({ center, facing, width }) {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fitVertical = (width * 0.55) / Math.tan(halfFov);
    const distance = Math.max(0.8, fitVertical / Math.min(1, this.camera.aspect));

    const target = new THREE.Vector3(center.x, center.y, center.z);
    const position = target.clone().add(new THREE.Vector3(facing.x, 0, facing.z).multiplyScalar(distance));
    position.y += distance * 0.06;
    this.#clampToRoom(position);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#tween = {
      elapsed: 0,
      duration: reduceMotion ? 0 : FOCUS_DURATION_S,
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition: position,
      toTarget: target,
    };
    this.invalidate();
  }

  #clampToRoom(point) {
    const limit = ROOM_SIZE / 2 - WALL_MARGIN;
    point.x = THREE.MathUtils.clamp(point.x, -limit, limit);
    point.y = THREE.MathUtils.clamp(point.y, WALL_MARGIN, ROOM_HEIGHT - WALL_MARGIN);
    point.z = THREE.MathUtils.clamp(point.z, -limit, limit);
  }

  #resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.invalidate();
  }

  #stepTween(delta) {
    const tween = this.#tween;
    if (!tween) return;
    tween.elapsed += delta;
    const progress = tween.duration > 0 ? Math.min(1, tween.elapsed / tween.duration) : 1;
    const eased = easeInOut(progress);
    this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
    this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    if (progress === 1) this.#tween = null;
    this.invalidate();
  }

  #frame() {
    this.#clock.update();
    const delta = Math.min(this.#clock.getDelta(), 0.1);

    this.#stepTween(delta);
    this.controls.update(); // needed each frame for damping; fires 'change' if the camera moved
    // Orbit controls know nothing about walls. They read the camera's position back
    // on the next update, so clamping here is enough to keep it inside the room.
    this.#clampToRoom(this.controls.target);
    this.#clampToRoom(this.camera.position);

    for (const callback of this.#frameCallbacks) {
      if (callback(delta)) this.#needsRender = true;
    }

    if (this.#needsRender) {
      this.#needsRender = false;
      this.renderer.render(this.scene, this.camera);
    }
  }
}
