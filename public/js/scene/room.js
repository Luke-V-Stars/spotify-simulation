/**
 * The enclosed listening room: oak floor, walnut-panelled walls and warm golden
 * lights recessed into the ceiling, all sized to the library. Everything here is
 * static and uses few draw calls.
 */

import * as THREE from 'three';
import { ROOM_HEIGHT } from '../bookshelves/shelfLayout.js';

const ROOM_OBJECT_NAME = 'room';
const GOLD = 0xffc27a;
const WOOD_TILE_METRES = 2.4; // with 12 plank rows per tile, planks are 20 cm wide
const FIXTURE_SPACING = 4; // roughly, in metres
const FIXTURE_RADIUS = 0.11;
const FIXTURE_TRIM_WIDTH = 0.03;
const FIXTURE_RECESS = 0.12; // how far each light sits above the ceiling
const FILL_LIGHT_INSET = 0.275; // fill light distance from the centre, as a share of the room's width

const LIGHT_DECAY = 1.5;
const LIGHTING_REFERENCE_ROOM_SIZE = 14; // the size the light strengths below were tuned at
const MIN_LIGHT_STRENGTH = 0.75; // the walls of a small room are mostly bare, so they need more

const OAK = { hue: 30, saturation: 26, lightness: 31 };
const WALNUT_PANEL = { hue: 22, saturation: 30, lightness: 25 };

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Paints a tileable wooden plank texture. Procedural, so the project ships no image files. */
function createWoodTexture(renderer, { hue: baseHue, saturation: baseSaturation, lightness: baseLightness }) {
  const size = 1024;
  const rows = 12;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const random = seededRandom(7);
  const rowHeight = size / rows;

  for (let row = 0; row < rows; row++) {
    const y = row * rowHeight;
    let x = 0;
    // Planks end exactly at the tile edge, so the seam reads as one more plank joint.
    while (x < size) {
      let length = size * (0.3 + random() * 0.45);
      if (size - (x + length) < size * 0.2) length = size - x;

      // Gold light adds plenty of warmth, so the wood itself stays fairly neutral.
      const hue = baseHue + random() * 5;
      const saturation = baseSaturation + random() * 7;
      const lightness = baseLightness + random() * (baseLightness / 6);
      ctx.fillStyle = `hsl(${hue} ${saturation}% ${lightness}%)`;
      ctx.fillRect(x, y, length, rowHeight);

      // Grain: long, slightly wavy lines of darker and lighter wood.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, length, rowHeight);
      ctx.clip();
      for (let line = 0; line < 30; line++) {
        const lineY = y + random() * rowHeight;
        const wave = 1 + random() * 3.5;
        const phase = random() * Math.PI * 2;
        const dark = random() > 0.3;
        ctx.strokeStyle = dark
          ? `rgba(58, 32, 12, ${0.05 + random() * 0.16})`
          : `rgba(236, 196, 140, ${0.03 + random() * 0.08})`;
        ctx.lineWidth = 0.5 + random() * 1.4;
        ctx.beginPath();
        for (let px = x; px <= x + length; px += 24) {
          const py = lineY + Math.sin((px / length) * Math.PI * 2 + phase) * wave;
          if (px === x) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();

      // Dark joint at the end of each plank.
      ctx.fillStyle = 'rgba(24, 13, 6, 0.75)';
      ctx.fillRect(x + length - 1.5, y, 1.5, rowHeight);
      x += length;
    }
    ctx.fillStyle = 'rgba(24, 13, 6, 0.75)';
    ctx.fillRect(0, y, size, 1.5);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

/**
 * Where the ceiling lights go along each axis, evenly spaced. The count is always odd,
 * so one light sits at the room's centre, where the shadow-casting light is.
 */
function fixtureAxis(roomSize) {
  const perSide = 2 * Math.round(roomSize / (2 * FIXTURE_SPACING)) + 1;
  return Array.from({ length: perSide }, (_, i) => ((i + 0.5) / perSide - 0.5) * roomSize);
}

function addSurfaces(room, renderer, roomSize) {
  const floorTexture = createWoodTexture(renderer, OAK);
  floorTexture.repeat.set(roomSize / WOOD_TILE_METRES, roomSize / WOOD_TILE_METRES);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(roomSize, roomSize),
    new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.52, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);

  // The ceiling has a real hole for each light, so the lights look set into it.
  const half = roomSize / 2;
  const ceilingShape = new THREE.Shape()
    .moveTo(-half, -half)
    .lineTo(half, -half)
    .lineTo(half, half)
    .lineTo(-half, half)
    .closePath();
  const axis = fixtureAxis(roomSize);
  for (const x of axis) {
    for (const z of axis) {
      ceilingShape.holes.push(new THREE.Path().absarc(x, z, FIXTURE_RADIUS, 0, Math.PI * 2, true));
    }
  }
  const ceiling = new THREE.Mesh(
    new THREE.ShapeGeometry(ceilingShape, 24),
    // No light points up here, so a little emissive stands in for what bounces off the floor.
    new THREE.MeshStandardMaterial({ color: 0xb8a080, emissive: 0x3a281a, roughness: 0.9 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;
  room.add(ceiling);

  // Turned a quarter so the planks stand upright as panelling. The turn swaps which
  // repeat applies to which direction: x now runs up the wall.
  const panelTexture = createWoodTexture(renderer, WALNUT_PANEL);
  panelTexture.rotation = Math.PI / 2;
  panelTexture.repeat.set(ROOM_HEIGHT / WOOD_TILE_METRES, roomSize / WOOD_TILE_METRES);

  // A plane is one-sided, so each wall only exists when seen from inside the room.
  const wallGeometry = new THREE.PlaneGeometry(roomSize, ROOM_HEIGHT);
  const wallMaterial = new THREE.MeshStandardMaterial({ map: panelTexture, roughness: 0.7 });
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    wall.position.set(-Math.sin(angle) * (roomSize / 2), ROOM_HEIGHT / 2, -Math.cos(angle) * (roomSize / 2));
    wall.rotation.y = angle;
    wall.receiveShadow = true;
    room.add(wall);
  }
}

/**
 * A handful of real lights, placed at some of the ceiling fixtures. Every fixture glows,
 * but each extra real light costs every pixel in the room, so there are only five.
 */
function addLights(room, roomSize) {
  // Light fades with distance, so it stays even only if a bigger room gets stronger lights.
  const strength = Math.max(MIN_LIGHT_STRENGTH, (roomSize / LIGHTING_REFERENCE_ROOM_SIZE) ** LIGHT_DECAY);

  // The ground colour stands in for light bouncing off the floor, which lifts the ceiling.
  room.add(new THREE.HemisphereLight(0xffd7a3, 0x8a5a33, 2.1));

  // One central light casts the room's shadows. See SceneManager for why they're static.
  const central = new THREE.SpotLight(GOLD, 16 * strength, 0, 1.45, 0.9, LIGHT_DECAY);
  central.position.set(0, ROOM_HEIGHT - 0.02, 0);
  central.target.position.set(0, 0, 0);
  central.castShadow = true;
  central.shadow.mapSize.set(2048, 2048);
  central.shadow.bias = -0.0006;
  central.shadow.normalBias = 0.02;
  central.shadow.camera.near = 0.3;
  central.shadow.camera.far = roomSize + 4;
  room.add(central, central.target);

  // Pointing straight down, these light the room without lighting the ceiling around them.
  const axis = fixtureAxis(roomSize);
  const nearest = (target) => axis.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best));
  const offset = nearest(roomSize * FILL_LIGHT_INSET);
  for (const [x, z] of [[-offset, -offset], [offset, -offset], [-offset, offset], [offset, offset]]) {
    const light = new THREE.SpotLight(GOLD, 9 * strength, 0, 1.3, 0.8, LIGHT_DECAY);
    light.position.set(x, ROOM_HEIGHT - 0.02, z);
    light.target.position.set(x, 0, z);
    room.add(light, light.target);
  }
}

/** One copy of a mesh at each fixture, so all the fixtures together cost one draw call per part. */
function instanceAtFixtures(geometry, material, positions, y) {
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  const matrix = new THREE.Matrix4();
  positions.forEach(([x, z], index) => mesh.setMatrixAt(index, matrix.makeTranslation(x, y, z)));
  return mesh;
}

/** Recessed downlights: a brass trim around each hole, a shaft, and a glowing lamp at the top. */
function addFixtures(room, roomSize) {
  const axis = fixtureAxis(roomSize);
  const positions = axis.flatMap((x) => axis.map((z) => [x, z]));
  const faceDown = (geometry) => geometry.rotateX(Math.PI / 2);

  const trim = instanceAtFixtures(
    faceDown(new THREE.RingGeometry(FIXTURE_RADIUS, FIXTURE_RADIUS + FIXTURE_TRIM_WIDTH, 32)),
    new THREE.MeshStandardMaterial({ color: 0x9c7434, metalness: 0.5, roughness: 0.45 }),
    positions,
    ROOM_HEIGHT - 0.002,
  );
  const shaft = instanceAtFixtures(
    new THREE.CylinderGeometry(FIXTURE_RADIUS, FIXTURE_RADIUS, FIXTURE_RECESS, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(GOLD).multiplyScalar(1.1), side: THREE.BackSide }),
    positions,
    ROOM_HEIGHT + FIXTURE_RECESS / 2,
  );
  const lamp = instanceAtFixtures(
    faceDown(new THREE.CircleGeometry(FIXTURE_RADIUS, 32)),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(GOLD).multiplyScalar(2.4) }),
    positions,
    ROOM_HEIGHT + FIXTURE_RECESS,
  );
  room.add(trim, shaft, lamp);
}

function disposeRoom(room) {
  room.traverse((object) => {
    object.geometry?.dispose();
    object.material?.map?.dispose();
    object.material?.dispose();
    object.dispose?.(); // lights and instanced meshes hold GPU resources of their own
  });
  room.removeFromParent();
}

/**
 * Builds the room for a layout, replacing any room already in the scene.
 * @param {ReturnType<import('../bookshelves/shelfLayout.js').layoutBookshelves>} layout
 */
export function buildRoom(scene, renderer, { roomSize }) {
  const previous = scene.getObjectByName(ROOM_OBJECT_NAME);
  if (previous) disposeRoom(previous);

  const room = new THREE.Group();
  room.name = ROOM_OBJECT_NAME;
  addSurfaces(room, renderer, roomSize);
  addLights(room, roomSize);
  addFixtures(room, roomSize);
  scene.add(room);
}
