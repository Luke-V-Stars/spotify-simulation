/**
 * Keeps the viewer on open floor: inside the walls and out of the shelves.
 * Plain data and arithmetic only, so it can be tested without a renderer.
 *
 * @typedef {object} WalkBounds
 * @property {number} halfSize distance from the room centre to each wall
 * @property {number} radius how close the viewer can get to a wall or shelf
 * @property {Array<{minX: number, maxX: number, minZ: number, maxZ: number}>} boxes shelf footprints
 */

const MAX_STEP_METRES = 0.1; // thinner than any shelf plus the viewer, so a fast drag can't jump one

/** @param {WalkBounds} bounds */
export function isWalkable(x, z, { halfSize, radius, boxes }) {
  const limit = halfSize - radius;
  if (Math.abs(x) > limit || Math.abs(z) > limit) return false;
  return !boxes.some(
    (box) => x > box.minX - radius && x < box.maxX + radius && z > box.minZ - radius && z < box.maxZ + radius,
  );
}

/**
 * Whether a point on screen looks below the horizon. The viewer walks by pulling the
 * floor, so only something at or below their own eye level can be pulled.
 * @param {number} screenY from -1 at the bottom of the view to 1 at the top
 * @param {number} pitch how far the view is tilted up, in radians
 * @param {number} verticalFovDegrees
 */
export function isBelowEyeLevel(screenY, pitch, verticalFovDegrees) {
  const halfFovTangent = Math.tan((verticalFovDegrees * Math.PI) / 360);
  return screenY * halfFovTangent * Math.cos(pitch) + Math.sin(pitch) < 0;
}

/**
 * Moves from `from` toward `to`, sliding along anything in the way instead of stopping dead.
 * @param {{x: number, z: number}} from
 * @param {{x: number, z: number}} to
 * @param {WalkBounds} bounds
 * @returns {{x: number, z: number}} where the viewer ends up
 */
export function walk(from, to, bounds) {
  // If a camera flight ended inside something, let the viewer walk straight out of it.
  if (!isWalkable(from.x, from.z, bounds)) return { x: to.x, z: to.z };

  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / MAX_STEP_METRES));
  const stepX = (to.x - from.x) / steps;
  const stepZ = (to.z - from.z) / steps;
  let { x, z } = from;
  for (let i = 0; i < steps; i++) {
    if (isWalkable(x + stepX, z, bounds)) x += stepX;
    if (isWalkable(x, z + stepZ, bounds)) z += stepZ;
  }
  return { x, z };
}
