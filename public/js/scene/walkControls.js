/**
 * Moves the camera like a person in the room rather than around a fixed point.
 *
 *   Left-drag or one finger    walk by pulling the floor, as when dragging a map:
 *                              drag down to go forward, drag right to go left.
 *                              Only a press below eye level takes hold of the floor.
 *   Right-drag or two fingers  look around from where you stand
 *   Scroll or pinch            walk forward and back, unless facing too far up to see
 *                              anything below eye level
 *
 * Input moves a goal, and the camera eases toward it each frame.
 */

import * as THREE from 'three';
import { isBelowEyeLevel, walk } from './walkCollision.js';

const WALK_METRES_PER_PIXEL = 0.006;
const LOOK_RADIANS_PER_PIXEL = 0.0032;
const SCROLL_METRES_PER_UNIT = 0.0025;
const PINCH_METRES_PER_PIXEL = 0.01;
const SCREEN_BOTTOM = -1;
const LINE_HEIGHT_PX = 33; // for mice that report scrolling in lines
const EASING_PER_SECOND = 14;
const MAX_PITCH = 1.4; // just short of straight up or down
const SETTLED = 1e-4;

const LEFT_BUTTON = 1;
const RIGHT_BUTTON = 2;

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** The smallest signed turn from one heading to another, so flights never go the long way round. */
const shortestTurn = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export class WalkControls {
  #camera;
  #element;
  /** @type {import('./walkCollision.js').WalkBounds|null} */
  #bounds = null;
  #goal = new THREE.Vector3();
  #goalYaw = 0;
  #goalPitch = 0;
  #yaw = 0;
  #pitch = 0;
  #flight = null;
  #pointers = new Map();
  #needsApply = true;

  /** @param {THREE.PerspectiveCamera} camera @param {HTMLElement} element */
  constructor(camera, element) {
    this.#camera = camera;
    this.#element = element;
    camera.rotation.order = 'YXZ'; // turn, then tilt, so the horizon stays level

    element.addEventListener('pointerdown', (event) => {
      element.setPointerCapture(event.pointerId);
      this.#pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        // Decided once per press, so a drag doesn't stop when the cursor crosses the horizon.
        canWalk: this.#isPressBelowEyeLevel(event.clientY),
      });
      this.#flight = null; // the user takes over from any camera move in progress
    });
    element.addEventListener('pointermove', (event) => this.#handleMove(event));
    const release = (event) => this.#pointers.delete(event.pointerId);
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('contextmenu', (event) => event.preventDefault());
    element.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.#flight = null;
        if (!this.#canSeeBelowEyeLevel()) return;
        const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * LINE_HEIGHT_PX : event.deltaY;
        this.#walkBy(0, -pixels * SCROLL_METRES_PER_UNIT);
      },
      { passive: false },
    );
  }

  /** @param {import('./walkCollision.js').WalkBounds} bounds */
  setBounds(bounds) {
    this.#bounds = bounds;
  }

  /** Puts the viewer somewhere instantly. */
  jumpTo(position, lookAt) {
    this.#flight = null;
    const { yaw, pitch } = this.#headingFrom(position, lookAt);
    this.#camera.position.set(position.x, position.y, position.z);
    this.#goal.copy(this.#camera.position);
    this.#yaw = this.#goalYaw = yaw;
    this.#pitch = this.#goalPitch = pitch;
    this.#needsApply = true;
  }

  /** Flies the viewer somewhere. Any drag or scroll cancels the flight where it is. */
  flyTo(position, lookAt, durationSeconds) {
    const { yaw, pitch } = this.#headingFrom(position, lookAt);
    this.#flight = {
      elapsed: 0,
      duration: durationSeconds,
      fromPosition: this.#camera.position.clone(),
      toPosition: new THREE.Vector3(position.x, position.y, position.z),
      fromYaw: this.#yaw,
      turn: shortestTurn(this.#yaw, yaw),
      fromPitch: this.#pitch,
      toPitch: pitch,
    };
  }

  /**
   * Advances the camera. Call once per frame.
   * @returns {boolean} true if the camera moved and a redraw is needed
   */
  update(deltaSeconds) {
    const moved = this.#flight ? this.#stepFlight(deltaSeconds) : this.#stepTowardGoal(deltaSeconds);
    const changed = moved || this.#needsApply;
    if (changed) {
      this.#camera.rotation.set(this.#pitch, this.#yaw, 0);
      this.#needsApply = false;
    }
    return changed;
  }

  #headingFrom(position, lookAt) {
    const dx = lookAt.x - position.x;
    const dz = lookAt.z - position.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(lookAt.y - position.y, Math.hypot(dx, dz)) };
  }

  #isPressBelowEyeLevel(clientY) {
    const { top, height } = this.#element.getBoundingClientRect();
    const screenY = 1 - ((clientY - top) / height) * 2;
    return isBelowEyeLevel(screenY, this.#pitch, this.#camera.fov);
  }

  #canSeeBelowEyeLevel() {
    return isBelowEyeLevel(SCREEN_BOTTOM, this.#pitch, this.#camera.fov);
  }

  #handleMove(event) {
    const pointer = this.#pointers.get(event.pointerId);
    if (!pointer) return;

    if (this.#pointers.size >= 2) {
      this.#handleTwoFingers(pointer, event);
    } else {
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      if (event.pointerType === 'mouse' && event.buttons & RIGHT_BUTTON) {
        this.#lookBy(dx, dy);
      } else if (pointer.canWalk && (event.pointerType !== 'mouse' || event.buttons & LEFT_BUTTON)) {
        this.#walkBy(-dx * WALK_METRES_PER_PIXEL, dy * WALK_METRES_PER_PIXEL);
      }
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  }

  /** The fingers' shared movement looks around, and their spread walks. */
  #handleTwoFingers(pointer, event) {
    const other = [...this.#pointers.values()].find((candidate) => candidate !== pointer);
    if (!other) return;
    const spreadBefore = Math.hypot(pointer.x - other.x, pointer.y - other.y);
    const spreadAfter = Math.hypot(event.clientX - other.x, event.clientY - other.y);
    // Only one finger moved in this event, so half its movement is the pair's movement.
    this.#lookBy((event.clientX - pointer.x) / 2, (event.clientY - pointer.y) / 2);
    if (this.#canSeeBelowEyeLevel()) this.#walkBy(0, (spreadAfter - spreadBefore) * PINCH_METRES_PER_PIXEL);
  }

  /** @param {number} right metres to the viewer's right @param {number} forward metres ahead */
  #walkBy(right, forward) {
    const sin = Math.sin(this.#goalYaw);
    const cos = Math.cos(this.#goalYaw);
    this.#goal.x += cos * right - sin * forward;
    this.#goal.z += -sin * right - cos * forward;
  }

  /** The room follows the cursor, as if turning a photo sphere. */
  #lookBy(dx, dy) {
    this.#goalYaw += dx * LOOK_RADIANS_PER_PIXEL;
    this.#goalPitch = THREE.MathUtils.clamp(this.#goalPitch + dy * LOOK_RADIANS_PER_PIXEL, -MAX_PITCH, MAX_PITCH);
  }

  #stepFlight(deltaSeconds) {
    const flight = this.#flight;
    flight.elapsed += deltaSeconds;
    const progress = flight.duration > 0 ? Math.min(1, flight.elapsed / flight.duration) : 1;
    const eased = easeInOut(progress);
    this.#camera.position.lerpVectors(flight.fromPosition, flight.toPosition, eased);
    this.#yaw = flight.fromYaw + flight.turn * eased;
    this.#pitch = THREE.MathUtils.lerp(flight.fromPitch, flight.toPitch, eased);
    this.#goal.copy(this.#camera.position);
    this.#goalYaw = this.#yaw;
    this.#goalPitch = this.#pitch;
    if (progress === 1) this.#flight = null;
    return true;
  }

  #stepTowardGoal(deltaSeconds) {
    const position = this.#camera.position;
    const remaining =
      Math.abs(this.#goal.x - position.x) +
      Math.abs(this.#goal.z - position.z) +
      Math.abs(this.#goalYaw - this.#yaw) +
      Math.abs(this.#goalPitch - this.#pitch);
    if (remaining < SETTLED) return false;

    const blend = 1 - Math.exp(-deltaSeconds * EASING_PER_SECOND);
    this.#yaw += (this.#goalYaw - this.#yaw) * blend;
    this.#pitch += (this.#goalPitch - this.#pitch) * blend;

    const wanted = {
      x: position.x + (this.#goal.x - position.x) * blend,
      z: position.z + (this.#goal.z - position.z) * blend,
    };
    const reached = this.#bounds ? walk(position, wanted, this.#bounds) : wanted;
    // Forget any movement a shelf or wall absorbed, or the viewer would keep pushing against it.
    if (Math.abs(reached.x - wanted.x) > SETTLED) this.#goal.x = reached.x;
    if (Math.abs(reached.z - wanted.z) > SETTLED) this.#goal.z = reached.z;
    position.x = reached.x;
    position.z = reached.z;
    return true;
  }
}
