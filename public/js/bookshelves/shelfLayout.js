/**
 * Sizes the room to the library and places bookshelves and wall plaques in it.
 *
 * Every shelf stands in a freestanding back-to-back row, like the stacks in a library.
 * Rows run from the starting wall toward the far wall, either side of a central aisle,
 * with a walkway between them and the walls. The room is the smallest square that holds
 * every shelf, so small libraries get a snug room rather than a big empty one. Past the
 * largest room, every shelf shrinks uniformly rather than dropping playlists.
 */

import { SHELF } from './shelfGeometry.js';

export const ROOM_HEIGHT = 3.2;
export const EYE_HEIGHT = 1.6;

const MIN_ROOM_SIZE = 7.5;
const MAX_ROOM_SIZE = 25;
const ROOM_SIZE_STEP = 0.25;

const SHELF_GAP = 0.06; // between neighbouring shelves
const SCALE_STEP = 0.95;
const AISLE = 2.6; // between facing rows, at scale 1

// These are for walking in, so they don't shrink with the shelves: the viewer doesn't.
const CENTRE_AISLE = 2.6;
const WALL_AISLE = 1.8; // between the outermost rows and the side walls
const END_AISLE = 2.2; // between the ends of the rows and the walls they point at

const WALK_RADIUS = 0.5; // how close the viewer can get to a shelf or wall
const START_WALL_DISTANCE = 0.8; // how far from the starting wall the viewer stands

const PLAQUE_WIDTH = 1;
const PLAQUE_HEIGHT = 1.3;
const PLAQUE_GAP = 0.2;
const PLAQUE_WALL_OFFSET = 0.05; // from the wall to the plaque's front
/** Number one takes the centre, in view down the aisle, with the rest fanning out from it. */
const PLAQUE_SLOTS = [0, -1, 1, -2, 2];

/** Rows stand left and right of the central aisle, so each row has one face per yaw. */
const ROW_YAWS = [-Math.PI / 2, Math.PI / 2];

/**
 * Lists the faces available in a room at a scale, nearest the central aisle first. A face
 * is one side of a pair of rows. `distance` is from the centre line to the shelf's centre,
 * and `faceInward` says whether its shelves look toward the central aisle or away from it.
 */
function listFaces(roomSize, scale) {
  const depth = SHELF.depth * scale;
  const pitch = (SHELF.width + SHELF_GAP) * scale;
  const perRow = Math.floor((roomSize - 2 * END_AISLE) / pitch);
  if (perRow === 0) return [];

  const faces = [];
  // Each row is two back-to-back faces around a shared spine.
  for (
    let spine = CENTRE_AISLE / 2 + depth;
    spine + depth + WALL_AISLE <= roomSize / 2;
    spine += 2 * depth + AISLE * scale
  ) {
    // The inward face first: it looks onto the aisle the viewer starts in.
    faces.push({ perRow, pitch, distance: spine - depth / 2, faceInward: true });
    faces.push({ perRow, pitch, distance: spine + depth / 2, faceInward: false });
  }
  return faces;
}

const faceCapacity = (face) => face.perRow * ROW_YAWS.length;
const totalCapacity = (faces) => faces.reduce((sum, face) => sum + faceCapacity(face), 0);

/** Floor area of a shelf standing in a row, which runs along the Z axis. */
function shelfFootprint({ x, z }, scale) {
  const halfX = (SHELF.depth * scale) / 2;
  const halfZ = (SHELF.width * scale) / 2;
  return { minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ };
}

/**
 * @param {number} shelfCount
 * @returns {{
 *   roomSize: number,
 *   scale: number,
 *   placements: Array<{x: number, z: number, yaw: number}>,
 *   start: {position: {x: number, y: number, z: number}, lookAt: {x: number, y: number, z: number}},
 *   walkBounds: import('../scene/walkCollision.js').WalkBounds,
 * }}
 */
export function layoutBookshelves(shelfCount) {
  let roomSize = MIN_ROOM_SIZE;
  while (roomSize < MAX_ROOM_SIZE && totalCapacity(listFaces(roomSize, 1)) < shelfCount) {
    roomSize += ROOM_SIZE_STEP;
  }

  let scale = 1;
  let faces = listFaces(roomSize, scale);
  while (totalCapacity(faces) < shelfCount) {
    scale *= SCALE_STEP;
    faces = listFaces(roomSize, scale);
  }

  const placements = [];
  let remaining = shelfCount;
  for (const face of faces) {
    if (remaining === 0) break;
    const take = Math.min(remaining, faceCapacity(face));
    placeFace(face, take, placements);
    remaining -= take;
  }

  const half = roomSize / 2;
  return {
    roomSize,
    scale,
    placements,
    // Each row's first shelf is at its far end, so the viewer starts looking toward the first playlists.
    start: {
      position: { x: 0, y: EYE_HEIGHT, z: half - START_WALL_DISTANCE },
      lookAt: { x: 0, y: EYE_HEIGHT - 0.15, z: -half },
    },
    walkBounds: {
      halfSize: half,
      radius: Math.min(WALK_RADIUS, AISLE * scale * 0.4),
      boxes: placements.map((placement) => shelfFootprint(placement, scale)),
    },
  };
}

/** Shares `take` shelves evenly across the face's two rows, centring each group along its row. */
function placeFace(face, take, placements) {
  const sides = ROW_YAWS.length;
  ROW_YAWS.forEach((yaw, sideIndex) => {
    const count = Math.floor(take / sides) + (sideIndex < take % sides ? 1 : 0);
    // The direction this shelf faces, and the direction its local +X points. Reading order
    // runs toward the viewer on one side of the aisle, then away on the other.
    const faceX = Math.sin(yaw);
    const alongZ = -Math.sin(yaw);
    // Inward shelves stand opposite the way they face, outward ones on the same side.
    const offset = face.faceInward ? -face.distance : face.distance;

    for (let i = 0; i < count; i++) {
      placements.push({
        x: faceX * offset,
        z: alongZ * (i - (count - 1) / 2) * face.pitch,
        yaw,
      });
    }
  });
}

/**
 * Where plaques hang on the far wall, the one the viewer starts facing. All face the room.
 * @param {number} roomSize
 * @param {number} count at most 5, in rank order
 * @returns {Array<{x: number, y: number, z: number, width: number, height: number}>}
 */
export function layoutPlaques(roomSize, count) {
  return PLAQUE_SLOTS.slice(0, count).map((slot) => ({
    x: slot * (PLAQUE_WIDTH + PLAQUE_GAP),
    y: EYE_HEIGHT,
    z: -roomSize / 2 + PLAQUE_WALL_OFFSET,
    width: PLAQUE_WIDTH,
    height: PLAQUE_HEIGHT,
  }));
}
