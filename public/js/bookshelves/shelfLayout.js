/**
 * Places bookshelves on the floor of the room.
 *
 * Shelves fill concentric "rings": first the walls, then freestanding back-to-back
 * rows around an open centre. The room is a fixed size, so a very large library
 * shrinks every shelf uniformly until it all fits, rather than dropping playlists.
 */

import { SHELF } from './shelfGeometry.js';

export const ROOM_SIZE = 20;
export const ROOM_HEIGHT = 5;

const SHELF_GAP = 0.2; // between neighbouring shelves
const WALL_CLEARANCE = 0.02; // stops shelf backs z-fighting with the wall
const CORNER_MARGIN = 0.1;
const AISLE = 2.6; // walking aisle between facing shelves, at scale 1
const MIN_CENTRE_CLEARING = 2.5; // half-extent of floor kept open for the camera
const SCALE_STEP = 0.95;

/** Clockwise from the far wall. yaw 0 faces +Z; each side continues reading order from the last. */
const SIDE_YAWS = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

/**
 * Lists the rings available at a scale, in fill order. A ring is one set of four
 * equal sides. `distance` is from the room centre to the shelf's centre line, and
 * `faceInward` says whether shelves look toward the centre or away from it.
 */
function listRings(scale) {
  const depth = SHELF.depth * scale;
  const pitch = (SHELF.width + SHELF_GAP) * scale;
  const half = ROOM_SIZE / 2;
  const capacityFor = (length) => Math.floor(length / pitch);

  const rings = [
    {
      distance: half - depth / 2 - WALL_CLEARANCE,
      faceInward: true,
      perSide: capacityFor(ROOM_SIZE - 2 * (depth + CORNER_MARGIN)),
      pitch,
    },
  ];

  // Each freestanding ring is two back-to-back faces around a shared spine.
  let spine = half - depth - WALL_CLEARANCE - (AISLE * scale + depth);
  while (spine - depth >= MIN_CENTRE_CLEARING) {
    const perSide = capacityFor(2 * (spine - depth - CORNER_MARGIN));
    if (perSide > 0) {
      // Inward faces first: they're the ones visible from the default camera.
      rings.push({ distance: spine - depth / 2, faceInward: true, perSide, pitch });
      rings.push({ distance: spine + depth / 2, faceInward: false, perSide, pitch });
    }
    spine -= 2 * depth + AISLE * scale;
  }
  return rings;
}

const ringCapacity = (ring) => ring.perSide * SIDE_YAWS.length;

/**
 * @param {number} shelfCount
 * @returns {{scale: number, placements: Array<{x: number, z: number, yaw: number}>}}
 */
export function layoutBookshelves(shelfCount) {
  let scale = 1;
  let rings = listRings(scale);
  while (rings.reduce((sum, ring) => sum + ringCapacity(ring), 0) < shelfCount) {
    scale *= SCALE_STEP;
    rings = listRings(scale);
  }

  const placements = [];
  let remaining = shelfCount;
  for (const ring of rings) {
    if (remaining === 0) break;
    const take = Math.min(remaining, ringCapacity(ring));
    placeRing(ring, take, placements);
    remaining -= take;
  }
  return { scale, placements };
}

/** Shares `take` shelves evenly across the ring's sides, centring each group on its side. */
function placeRing(ring, take, placements) {
  const sides = SIDE_YAWS.length;
  SIDE_YAWS.forEach((yaw, sideIndex) => {
    const count = Math.floor(take / sides) + (sideIndex < take % sides ? 1 : 0);
    // The direction this shelf faces, and the direction its local +X points.
    const faceX = Math.sin(yaw);
    const faceZ = Math.cos(yaw);
    const alongX = Math.cos(yaw);
    const alongZ = -Math.sin(yaw);
    // Inward shelves stand opposite the way they face, outward ones on the same side.
    const offset = ring.faceInward ? -ring.distance : ring.distance;

    for (let i = 0; i < count; i++) {
      const along = (i - (count - 1) / 2) * ring.pitch;
      placements.push({
        x: faceX * offset + alongX * along,
        z: faceZ * offset + alongZ * along,
        yaw,
      });
    }
  });
}
