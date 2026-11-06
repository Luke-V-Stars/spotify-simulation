import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordCenter, SHELF } from '../public/js/bookshelves/shelfGeometry.js';
import { layoutBookshelves, ROOM_SIZE } from '../public/js/bookshelves/shelfLayout.js';
import { planBookshelves } from '../public/js/bookshelves/shelfPlanner.js';
import { pickRecord } from '../public/js/interactions/recordPicker.js';

const playlistOf = (songCount) => ({ name: 'P', tracks: Array.from({ length: songCount }, (_, i) => ({ i })) });

test('a playlist gets one shelf per 50 songs, at the boundaries', () => {
  for (const [songs, shelves] of [[0, 1], [1, 1], [50, 1], [51, 2], [100, 2], [101, 3], [500, 10]]) {
    assert.equal(planBookshelves([playlistOf(songs)]).length, shelves, `${songs} songs`);
  }
});

test('every song lands on exactly one shelf, in order, and no shelf exceeds 50', () => {
  const planned = planBookshelves([playlistOf(137)]);
  assert.ok(planned.every((shelf) => shelf.tracks.length <= 50));
  assert.deepEqual(planned.flatMap((shelf) => shelf.tracks.map((track) => track.i)), Array.from({ length: 137 }, (_, i) => i));
});

test('overflow shelves are labelled with their part; single shelves are not', () => {
  assert.equal(planBookshelves([playlistOf(51)])[1].label, 'P (2/2)');
  assert.equal(planBookshelves([playlistOf(50)])[0].label, 'P');
});

/** Axis-aligned footprint of a placed shelf. Shelves only ever face along an axis. */
function footprint({ x, z, yaw }, scale) {
  const alongX = Math.abs(Math.cos(yaw)) > 0.5;
  const halfX = ((alongX ? SHELF.width : SHELF.depth) * scale) / 2;
  const halfZ = ((alongX ? SHELF.depth : SHELF.width) * scale) / 2;
  return { minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ };
}

for (const count of [1, 3, 24, 25, 40, 72, 73, 150, 600, 2000]) {
  test(`layout of ${count} shelves stays inside the room with no overlaps`, () => {
    const { scale, placements } = layoutBookshelves(count);
    assert.equal(placements.length, count);

    const boxes = placements.map((placement) => footprint(placement, scale));
    const half = ROOM_SIZE / 2;
    for (const box of boxes) {
      assert.ok(box.minX >= -half && box.maxX <= half && box.minZ >= -half && box.maxZ <= half);
    }
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const separated =
          boxes[a].maxX <= boxes[b].minX + 1e-6 ||
          boxes[b].maxX <= boxes[a].minX + 1e-6 ||
          boxes[a].maxZ <= boxes[b].minZ + 1e-6 ||
          boxes[b].maxZ <= boxes[a].minZ + 1e-6;
        assert.ok(separated, `shelves ${a} and ${b} overlap`);
      }
    }
  });
}

test('shelves keep full size until the room is genuinely full', () => {
  assert.equal(layoutBookshelves(72).scale, 1);
  assert.ok(layoutBookshelves(73).scale < 1);
});

test('wall shelves face into the room', () => {
  for (const { x, z, yaw } of layoutBookshelves(24).placements) {
    const towardCentre = -x * Math.sin(yaw) + -z * Math.cos(yaw);
    assert.ok(towardCentre > 0);
  }
});

// Picking: a shelf at the origin facing +Z, with a ray straight at a given point on it.
const shelfAtOrigin = (recordCount = 50, overrides = {}) => ({ x: 0, z: 0, yaw: 0, scale: 1, recordCount, ...overrides });
const rayToward = (x, y) => ({ ox: x, oy: y, oz: 3, dx: 0, dy: 0, dz: -1 });

test('picking the centre of any slot finds that slot', () => {
  for (const slot of [0, 9, 10, 25, 49]) {
    const { x, y } = recordCenter(slot);
    assert.deepEqual(pickRecord(rayToward(x, y), [shelfAtOrigin()]), { shelfIndex: 0, slotIndex: slot });
  }
});

test('an empty slot hits the shelf but no record', () => {
  const { x, y } = recordCenter(30);
  assert.deepEqual(pickRecord(rayToward(x, y), [shelfAtOrigin(30)]), { shelfIndex: 0, slotIndex: null });
});

test('the square corner of a cell is outside the round record', () => {
  const { x, y } = recordCenter(0);
  const offset = SHELF.recordRadius * 0.9;
  assert.equal(pickRecord(rayToward(x + offset, y + offset), [shelfAtOrigin()]).slotIndex, null);
});

test('missing the shelf returns null', () => {
  assert.equal(pickRecord(rayToward(5, 1), [shelfAtOrigin()]), null);
});

test('a ray from behind hits the shelf but never a record', () => {
  const { x, y } = recordCenter(0);
  const fromBehind = { ox: x, oy: y, oz: -3, dx: 0, dy: 0, dz: 1 };
  assert.deepEqual(pickRecord(fromBehind, [shelfAtOrigin()]), { shelfIndex: 0, slotIndex: null });
});

test('the nearest of two shelves in line wins', () => {
  const { x, y } = recordCenter(12);
  const near = shelfAtOrigin(50, { z: 1 });
  const far = shelfAtOrigin(50, { z: -1 });
  assert.equal(pickRecord(rayToward(x, y), [far, near]).shelfIndex, 1);
});

test('picking works on rotated and scaled shelves', () => {
  // Faces +X, so its local +X (the viewer's right) points to world -Z.
  const shelf = shelfAtOrigin(50, { x: -6, z: 2, yaw: Math.PI / 2, scale: 0.5 });
  const { x, y } = recordCenter(14);
  const ray = { ox: 3, oy: y * 0.5, oz: 2 - x * 0.5, dx: -1, dy: 0, dz: 0 };
  assert.deepEqual(pickRecord(ray, [shelf]), { shelfIndex: 0, slotIndex: 14 });
});
