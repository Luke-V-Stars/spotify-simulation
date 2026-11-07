import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shelfBoards } from '../public/js/bookshelves/bookshelfGenerator.js';
import { recordCenter, SHELF } from '../public/js/bookshelves/shelfGeometry.js';
import { BoxBatch } from '../public/js/scene/boxBatch.js';
import { layoutBookshelves, layoutPlaques } from '../public/js/bookshelves/shelfLayout.js';
import { planBookshelves } from '../public/js/bookshelves/shelfPlanner.js';
import { pickPlaque, pickRecord } from '../public/js/interactions/recordPicker.js';
import { isBelowEyeLevel, isWalkable, walk } from '../public/js/scene/walkCollision.js';

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

test('every shelf is the same full width, however few songs it holds', () => {
  const planned = planBookshelves([playlistOf(0), playlistOf(3), playlistOf(50)]);
  assert.equal(planned.length, 3);
  const { placements } = layoutBookshelves(planned.length);
  assert.ok(placements.every((placement) => !('width' in placement)), 'placements carry no per-shelf width');
  assert.ok(planned.every((shelf) => !('columns' in shelf)), 'shelves carry no per-shelf column count');
});

/** Axis-aligned footprint of a placed shelf. Shelves only ever face along an axis. */
function footprint({ x, z, yaw }, scale) {
  const alongX = Math.abs(Math.cos(yaw)) > 0.5;
  const halfX = ((alongX ? SHELF.width : SHELF.depth) * scale) / 2;
  const halfZ = ((alongX ? SHELF.depth : SHELF.width) * scale) / 2;
  return { minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ };
}

function assertNoOverlaps(boxes) {
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
}

const LAYOUT_COUNTS = [0, 1, 3, 4, 5, 8, 9, 16, 17, 24, 25, 40, 96, 97, 150, 600, 2000];

for (const count of LAYOUT_COUNTS) {
  test(`layout of ${count} shelves stays inside the room with no overlaps`, () => {
    const { scale, placements, roomSize } = layoutBookshelves(count);
    assert.equal(placements.length, count);

    const boxes = placements.map((placement) => footprint(placement, scale));
    const half = roomSize / 2;
    for (const box of boxes) {
      assert.ok(box.minX >= -half && box.maxX <= half && box.minZ >= -half && box.maxZ <= half);
    }
    assertNoOverlaps(boxes);
  });
}

test('shelves keep full size until the largest room is genuinely full', () => {
  assert.equal(layoutBookshelves(96).scale, 1);
  assert.ok(layoutBookshelves(97).scale < 1);
});

test('the room grows with the library, from snug to its maximum', () => {
  assert.equal(layoutBookshelves(1).roomSize, 7.5);
  const sizes = [4, 5, 9, 17, 96].map((count) => layoutBookshelves(count).roomSize);
  assert.equal(layoutBookshelves(2000).roomSize, 25);
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i] > sizes[i - 1], `sizes: ${sizes}`);
});

test('the first shelves of a row face the central aisle', () => {
  for (const { x, yaw } of layoutBookshelves(2).placements) {
    assert.ok(-x * Math.sin(yaw) > 0);
  }
});

for (const count of LAYOUT_COUNTS) {
  test(`with ${count} shelves the viewer starts on open floor, facing the first playlists`, () => {
    const { start, walkBounds, placements } = layoutBookshelves(count);
    assert.ok(isWalkable(start.position.x, start.position.z, walkBounds));
    assert.ok(start.position.z > 0 && start.lookAt.z < 0, 'starts on the near side, looking at the far wall');
    if (count > 0) assert.ok(placements[0].z <= 0, 'the first shelf is not on the near side');
  });

  test(`with ${count} shelves a walkway runs from the start through to the far side`, () => {
    const { start, walkBounds } = layoutBookshelves(count);
    const from = { x: start.position.x, z: start.position.z };
    const end = walk(from, { x: from.x, z: -from.z }, walkBounds);
    assert.ok(Math.abs(end.x - from.x) < 1e-6 && Math.abs(end.z + from.z) < 1e-6, `stopped at ${end.x}, ${end.z}`);
  });
}

for (const count of LAYOUT_COUNTS) {
  test(`with ${count} shelves every shelf stands in a row, clear of the walls, and can be reached`, () => {
    const { placements, roomSize, scale, start, walkBounds } = layoutBookshelves(count);
    const half = roomSize / 2;
    for (const placement of placements) {
      const box = footprint(placement, scale);
      assert.ok(Math.abs(Math.sin(placement.yaw)) > 0.5, 'faces across the room, not toward the viewer');
      assert.ok(Math.max(Math.abs(box.minX), Math.abs(box.maxX)) <= half - 1.5, 'clear of the side walls');
      assert.ok(Math.max(Math.abs(box.minZ), Math.abs(box.maxZ)) <= half - 1.5, 'clear of the end walls');
      assert.ok(Math.abs(placement.x - start.position.x) >= 1.3, 'clear of the central aisle');

      // There's floor to stand on right in front of the shelf.
      const standing = (SHELF.depth * scale) / 2 + walkBounds.radius + 0.01;
      const frontX = placement.x + Math.sin(placement.yaw) * standing;
      assert.ok(isWalkable(frontX, placement.z, walkBounds), `blocked in front of the shelf at ${placement.x}`);
    }
  });

  test(`with ${count} shelves a walkway runs around the whole room`, () => {
    const { roomSize, walkBounds } = layoutBookshelves(count);
    const edge = roomSize / 2 - walkBounds.radius - 0.01;
    for (const [a, b] of [[-edge, edge], [edge, -edge]]) {
      const end = walk({ x: a, z: a }, { x: b, z: a }, walkBounds);
      assert.ok(Math.abs(end.x - b) < 1e-6, 'along an end wall');
      const side = walk({ x: a, z: a }, { x: a, z: b }, walkBounds);
      assert.ok(Math.abs(side.z - b) < 1e-6, 'along a side wall');
    }
  });
}

test('walking stops at a wall and at a shelf, without passing through', () => {
  const bounds = { halfSize: 5, radius: 0.25, boxes: [{ minX: -1, maxX: 1, minZ: -0.1, maxZ: 0.1 }] };
  assert.ok(walk({ x: 0, z: 0 + 2 }, { x: 0, z: 20 }, bounds).z <= 4.75);
  const stopped = walk({ x: 0, z: 2 }, { x: 0, z: -2 }, bounds);
  assert.ok(stopped.z >= 0.35, `stopped at ${stopped.z}`);
});

test('walking into a shelf at an angle slides along it', () => {
  const bounds = { halfSize: 5, radius: 0.25, boxes: [{ minX: -1, maxX: 1, minZ: -0.1, maxZ: 0.1 }] };
  const end = walk({ x: 0, z: 0.5 }, { x: 0.8, z: -1 }, bounds);
  assert.ok(end.x > 0.75, `slid to x=${end.x}`);
  assert.ok(end.z >= 0.35, `kept clear at z=${end.z}`);
});

test('with a level view, only the bottom half of the screen is below eye level', () => {
  assert.equal(isBelowEyeLevel(-0.5, 0, 55), true);
  assert.equal(isBelowEyeLevel(0.5, 0, 55), false);
});

test('tilting the view moves the horizon up and down the screen', () => {
  const tilt = 0.3;
  assert.equal(isBelowEyeLevel(-0.1, tilt, 55), false, 'looking up: just below the middle is still above the horizon');
  assert.equal(isBelowEyeLevel(0.1, -tilt, 55), true, 'looking down: just above the middle is below the horizon');
});

test('facing far enough up, nothing on screen is below eye level', () => {
  const halfFov = (55 / 2) * (Math.PI / 180);
  assert.equal(isBelowEyeLevel(-1, halfFov - 0.01, 55), true, 'the horizon is still just on screen');
  assert.equal(isBelowEyeLevel(-1, halfFov + 0.01, 55), false, 'the horizon has gone off the bottom');
});

for (const detailed of [true, false]) {
  test(`shelf parts stay within the shelf's measured size (${detailed ? 'detailed' : 'simple'})`, () => {
    const extent = (axis, sign) =>
      Math.max(...shelfBoards(detailed).map(({ box }) => sign * box[axis] + box[axis + 3] / 2));
    assert.ok(Math.abs(extent(1, 1) - SHELF.totalHeight) < 1e-9, 'the top is the measured height');
    assert.ok(Math.abs(extent(1, -1)) < 1e-9, 'stands on the floor');
    assert.ok(extent(2, -1) <= SHELF.depth / 2 + 1e-9, 'nothing passes through the shelf standing behind it');
    assert.ok(extent(0, 1) * 2 < SHELF.width + 0.06, 'nothing reaches the shelf alongside it');
  });
}

test('nothing on the shelf covers more than the bottom edge of a record', () => {
  const { y } = recordCenter(49);
  const sleeveBottom = y - SHELF.sleeveHalf;
  for (const { box } of shelfBoards()) {
    const inFrontOfRecords = box[2] + box[5] / 2 > SHELF.recordZ;
    const crossesCentre = box[3] > SHELF.width / 2;
    if (inFrontOfRecords && crossesCentre && box[1] < y) {
      assert.ok(box[1] + box[4] / 2 < sleeveBottom + 0.02, `part at height ${box[1]} rises in front of the record`);
    }
  }
});

/** Turns a batch's triangles into [a, b, c] vertex positions. */
function trianglesOf({ positions, indices }) {
  const vertex = (index) => positions.slice(index * 3, index * 3 + 3);
  const triangles = [];
  for (let i = 0; i < indices.length; i += 3) triangles.push([indices[i], indices[i + 1], indices[i + 2]].map(vertex));
  return triangles;
}

test('a softened box is closed, faces outward and keeps its exact size', () => {
  const batch = new BoxBatch();
  const center = [1, 2, 3];
  batch.add([...center, 2, 0.5, 0.2], { chamfer: 0.02 });
  const { data } = batch;
  assert.equal(data.indices.length / 3, 44);

  // Every edge of a closed surface is used by exactly two triangles, once in each direction.
  const edges = new Map();
  for (let i = 0; i < data.indices.length; i += 3) {
    const triangle = data.indices.slice(i, i + 3);
    triangle.forEach((from, corner) => {
      const key = `${from}>${triangle[(corner + 1) % 3]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    });
  }
  for (const [key, count] of edges) {
    const [from, to] = key.split('>');
    assert.equal(count, 1, `edge ${key} is repeated`);
    assert.equal(edges.get(`${to}>${from}`), 1, `edge ${key} has no partner`);
  }

  for (const [a, b, c] of trianglesOf(data)) {
    const u = [0, 1, 2].map((i) => b[i] - a[i]);
    const v = [0, 1, 2].map((i) => c[i] - a[i]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const outward = [0, 1, 2].reduce((sum, i) => sum + normal[i] * ((a[i] + b[i] + c[i]) / 3 - center[i]), 0);
    assert.ok(outward > 0, 'a triangle faces inward');
  }

  const xs = data.positions.filter((_, i) => i % 3 === 0);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 2);
});

test('a box with no chamfer is six plain faces', () => {
  const batch = new BoxBatch();
  batch.add([0, 0, 0, 1, 1, 1]);
  assert.equal(batch.data.indices.length / 3, 12);
});

test('wood grain runs along a board and stays in proportion, whatever its size', () => {
  const batch = new BoxBatch();
  batch.add([0, 0, 0, 2, 0.1, 0.5], { tile: 1 });
  const { positions, normals, uvs } = batch.data;
  const top = [];
  for (let i = 0; i < normals.length / 3; i++) {
    if (normals[i * 3 + 1] === 1) top.push({ x: positions[i * 3], z: positions[i * 3 + 2], u: uvs[i * 2], v: uvs[i * 2 + 1] });
  }
  assert.equal(top.length, 4);
  for (const { x, z, u, v } of top) {
    assert.equal(u, x, 'grain follows the long side, at one repeat per metre');
    assert.equal(v, z);
  }
});

test('the name area fits within the shelf and clicking its header finds the shelf', () => {
  assert.ok(SHELF.labelWidth < SHELF.width);
  const y = SHELF.height + SHELF.headerHeight / 2;
  assert.deepEqual(pickRecord(rayToward(0, y), [shelfAtOrigin()]), { shelfIndex: 0, slotIndex: null });
});

test('a viewer left inside a shelf can walk straight out', () => {
  const bounds = { halfSize: 5, radius: 0.25, boxes: [{ minX: -1, maxX: 1, minZ: -0.1, maxZ: 0.1 }] };
  assert.deepEqual(walk({ x: 0, z: 0 }, { x: 0, z: 1 }, bounds), { x: 0, z: 1 });
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

test('the top 5 plaques hang on the far wall, inside even the smallest room, with number one at the centre', () => {
  const { roomSize } = layoutBookshelves(1);
  const plaques = layoutPlaques(roomSize, 5);
  assert.equal(plaques.length, 5);
  assert.equal(plaques[0].x, 0);
  for (const { x, z, width, height, y } of plaques) {
    assert.ok(Math.abs(x) + width / 2 < roomSize / 2, 'fits across the wall');
    assert.ok(z < 0 && z > -roomSize / 2, 'just in front of the far wall');
    assert.ok(y - height / 2 > 0 && y + height / 2 < 3.2, 'between floor and ceiling');
  }
  const edges = plaques.map(({ x, width }) => [x - width / 2, x + width / 2]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i][0] > edges[i - 1][1], 'no plaques overlap');
  assert.equal(layoutPlaques(roomSize, 2).length, 2, 'fewer songs make fewer plaques');
});

test('pointing at a plaque finds its record; beside it or from behind finds nothing', () => {
  const plaques = layoutPlaques(10, 3).map((plaque, rank) => ({ ...plaque, record: { rank } }));
  const rayAt = (x, y) => ({ ox: x, oy: y, oz: 3, dx: 0, dy: 0, dz: -1 });
  assert.equal(pickPlaque(rayAt(plaques[1].x, plaques[1].y), plaques).rank, 1);
  assert.equal(pickPlaque(rayAt(plaques[0].x + 0.59, plaques[0].y), plaques), null, 'the gap between plaques');
  assert.equal(pickPlaque(rayAt(0, 3), plaques), null, 'above them');
  assert.equal(pickPlaque({ ox: 0, oy: 1.6, oz: 3, dx: 0, dy: 0, dz: 1 }, plaques), null, 'looking away');
  assert.equal(pickPlaque({ ox: 0, oy: 1.6, oz: 3, dx: 1, dy: 0, dz: 0 }, plaques), null, 'looking along the wall');
});

test('the corner of a sleeve counts as that record', () => {
  const { x, y } = recordCenter(0);
  const offset = SHELF.sleeveHalf * 0.95;
  assert.equal(pickRecord(rayToward(x + offset, y + offset), [shelfAtOrigin()]).slotIndex, 0);
});

test('the gap between sleeves is not a record', () => {
  const { x, y } = recordCenter(0);
  const offset = SHELF.sleeveHalf * 1.05;
  assert.equal(pickRecord(rayToward(x + offset, y), [shelfAtOrigin()]).slotIndex, null);
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
