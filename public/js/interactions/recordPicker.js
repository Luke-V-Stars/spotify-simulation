/**
 * Finds what the mouse is pointing at, analytically.
 *
 * Three's Raycaster would test every triangle of every instance, on every mouse
 * move. Shelves are simple boxes on a regular grid, so we can instead intersect the
 * ray with each shelf's box and compute the grid cell directly. The cost scales
 * with shelves, not songs, and the result is exact.
 */

import { recordCenter, SHELF } from '../bookshelves/shelfGeometry.js';

/**
 * Slab test against a shelf's bounding box, in the shelf's local space.
 * Returns the entry distance and whether the ray came in through the front.
 */
function intersectShelfBox(ox, oy, oz, dx, dy, dz) {
  let near = -Infinity;
  let far = Infinity;
  let entersFront = false;

  const bounds = [
    [ox, dx, -SHELF.width / 2, SHELF.width / 2],
    [oy, dy, 0, SHELF.height],
    [oz, dz, -SHELF.depth / 2, SHELF.depth / 2],
  ];

  for (let axis = 0; axis < 3; axis++) {
    const [origin, direction, min, max] = bounds[axis];
    if (Math.abs(direction) < 1e-9) {
      if (origin < min || origin > max) return null;
      continue;
    }
    const t1 = (min - origin) / direction;
    const t2 = (max - origin) / direction;
    const entry = Math.min(t1, t2);
    if (entry > near) {
      near = entry;
      entersFront = axis === 2 && direction < 0;
    }
    far = Math.min(far, Math.max(t1, t2));
  }

  if (near > far || far < 0) return null;
  return { near, far, entersFront };
}

/**
 * @param {{ox,oy,oz,dx,dy,dz}} ray world-space ray
 * @param {Array<{x,z,yaw,scale,recordCount}>} shelves placed shelves
 * @returns {{shelfIndex: number, slotIndex: number|null}|null} the nearest shelf hit,
 *   with slotIndex set when the ray lands on a record
 */
export function pickRecord(ray, shelves) {
  let best = null;

  for (let i = 0; i < shelves.length; i++) {
    const shelf = shelves[i];
    const cos = Math.cos(shelf.yaw);
    const sin = Math.sin(shelf.yaw);
    const px = ray.ox - shelf.x;
    const pz = ray.oz - shelf.z;

    // World to local: rotate by -yaw and undo the scale. Scaling origin and
    // direction alike keeps t comparable between shelves of any size.
    const local = {
      ox: (px * cos - pz * sin) / shelf.scale,
      oy: ray.oy / shelf.scale,
      oz: (px * sin + pz * cos) / shelf.scale,
      dx: (ray.dx * cos - ray.dz * sin) / shelf.scale,
      dy: ray.dy / shelf.scale,
      dz: (ray.dx * sin + ray.dz * cos) / shelf.scale,
    };

    const hit = intersectShelfBox(local.ox, local.oy, local.oz, local.dx, local.dy, local.dz);
    if (hit && (!best || hit.near < best.hit.near)) {
      best = { shelfIndex: i, hit, local };
    }
  }

  if (!best) return null;

  const slotIndex = best.hit.entersFront
    ? findSlot(best.local, best.hit, shelves[best.shelfIndex].recordCount)
    : null;
  return { shelfIndex: best.shelfIndex, slotIndex };
}

/** Follows the ray to the plane the records stand on and maps that point to a slot. */
function findSlot(local, hit, recordCount) {
  const t = (SHELF.recordZ - local.oz) / local.dz;
  if (t < hit.near || t > hit.far) return null;

  const x = local.ox + local.dx * t;
  const y = local.oy + local.dy * t;
  const column = Math.floor((x + (SHELF.columns * SHELF.cellWidth) / 2) / SHELF.cellWidth);
  if (column < 0 || column >= SHELF.columns) return null;

  // Rows are evenly spaced, so divide to find the row, then confirm with the real centre.
  const firstCenter = recordCenter(0);
  const rowPitch = SHELF.cellHeight + SHELF.board;
  const rowFromTop = Math.round((firstCenter.y - y) / rowPitch);
  if (rowFromTop < 0 || rowFromTop >= SHELF.rows) return null;

  const slotIndex = rowFromTop * SHELF.columns + column;
  if (slotIndex >= recordCount) return null;

  // The grid cell is square but a record is round, so corners don't count.
  const center = recordCenter(slotIndex);
  const inCircle = Math.hypot(x - center.x, y - center.y) <= SHELF.recordRadius;
  return inCircle ? slotIndex : null;
}
