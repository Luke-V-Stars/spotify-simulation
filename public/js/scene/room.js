/**
 * The enclosed listening room, sized to the library: a polished oak floor, walnut
 * panelling below a fabric-covered wall, a beamed ceiling and recessed downlights.
 * Everything here is static and uses few draw calls.
 */

import * as THREE from 'three';
import { ROOM_HEIGHT } from '../bookshelves/shelfLayout.js';
import { BoxBatch } from './boxBatch.js';
import {
  createFabricTextures,
  createWoodTextures,
  paintedTexture,
  tileTextures,
  walnutTextures,
  withOwnTiling,
} from './proceduralTextures.js';

const ROOM_OBJECT_NAME = 'room';
const LAMP_GLOW = 0xffc27a;
const LIGHT_COLOR = 0xffdcb4; // warm, but pale enough to leave the wood its own colour

const FLOOR_TILE_METRES = 2.1; // with 14 plank rows per tile, planks are 15 cm wide
const PANEL_TILE_METRES = 2.4;
const FABRIC_TILE_METRES = 1;
const TRIM_TILE_METRES = 1.2;

const FIXTURE_SPACING = 4; // roughly, in metres
const FIXTURE_RADIUS = 0.11;
const FIXTURE_TRIM_WIDTH = 0.03;
const FIXTURE_RECESS = 0.12; // how far each light sits above the ceiling
const FILL_LIGHT_INSET = 0.275; // fill light distance from the centre, as a share of the room's width

/** Panelling stops just under the plaques, whose frames reach down to 0.9 m. */
const WAINSCOT_HEIGHT = 0.84;
const RAIL_HEIGHT = 0.04;
const BASEBOARD_HEIGHT = 0.14;
const STILE_WIDTH = 0.07;
const STILE_SPACING = 1.2; // roughly, in metres
const CROWN_HEIGHT = 0.1;
const BEAM_WIDTH = 0.14;
const BEAM_DEPTH = 0.1;

const WASH_WIDTH = 3;
const WASH_HEIGHT = 2.2;
const WALL_EFFECT_OFFSET = 0.004; // keeps a lighting effect from flickering against its wall
const SHADE_SPACING = 0.3; // metres between the vertices that carry corner shading

const LIGHT_DECAY = 1.5;
const LIGHTING_REFERENCE_ROOM_SIZE = 14; // the size the light strengths below were tuned at
const MIN_LIGHT_STRENGTH = 0.75; // the walls of a small room are mostly bare, so they need more
const SHADOW_MAP_SIZE = 4096; // drawn once and then reused, so this costs memory but no frame time

const ENVIRONMENT_INTENSITY = 0.55;

const OAK = { hue: 30, saturation: 36, lightness: 30 };
/** The room's wood is darker than the shelves. Panels are darker than their frames, which sets the frames apart. */
const WOODWORK_TINT = 0xdcdcdc;
const WALL_PANEL_TINT = 0x8c8c8c;
const FABRIC = { hue: 150, saturation: 20, lightness: 30 };

/** Painting takes a moment and rooms get rebuilt, so each texture is painted once and reused. */
let paintedSurfaces = null;

function roomTextures(renderer) {
  paintedSurfaces ??= {
    floor: createWoodTextures(renderer, OAK, { rows: 14 }),
    panel: withOwnTiling(walnutTextures(renderer)),
    fabric: createFabricTextures(renderer, FABRIC),
    wash: paintedTexture(256, 256, paintWallWash),
  };
  return paintedSurfaces;
}

/** Brightness that falls from 1 to `darkest` as a point nears a corner or edge, standing in for corner shadows. */
const cornerShade = (distance, reach, darkest) =>
  darkest + (1 - darkest) * THREE.MathUtils.smoothstep(distance, 0, reach);

/** Stores a brightness at each vertex of a flat surface, given its position on that surface. */
function shadePlane(geometry, shadeAt) {
  const { position } = geometry.attributes;
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    colors.fill(shadeAt(position.getX(i), position.getY(i)), i * 3, i * 3 + 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Where the ceiling lights go along each axis, evenly spaced. The count is always odd,
 * so one light sits at the room's centre, where the shadow-casting light is.
 */
function fixtureAxis(roomSize) {
  const perSide = 2 * Math.round(roomSize / (2 * FIXTURE_SPACING)) + 1;
  return Array.from({ length: perSide }, (_, i) => ((i + 0.5) / perSide - 0.5) * roomSize);
}

function addFloor(room, renderer, roomSize) {
  const textures = roomTextures(renderer).floor;
  tileTextures(textures, roomSize / FLOOR_TILE_METRES, roomSize / FLOOR_TILE_METRES);

  const half = roomSize / 2;
  const segments = Math.ceil(roomSize / SHADE_SPACING);
  const geometry = shadePlane(new THREE.PlaneGeometry(roomSize, roomSize, segments, segments), (x, y) =>
    cornerShade(half - Math.max(Math.abs(x), Math.abs(y)), 0.9, 0.5),
  );
  const floor = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      map: textures.map,
      roughnessMap: textures.surface,
      bumpMap: textures.surface,
      bumpScale: 0.3,
      roughness: 0.7,
      vertexColors: true,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  room.add(floor);
}

function addCeiling(room, roomSize) {
  // The ceiling has a real hole for each light, so the lights look set into it.
  const half = roomSize / 2;
  const shape = new THREE.Shape()
    .moveTo(-half, -half)
    .lineTo(half, -half)
    .lineTo(half, half)
    .lineTo(-half, half)
    .closePath();
  const axis = fixtureAxis(roomSize);
  for (const x of axis) {
    for (const z of axis) {
      shape.holes.push(new THREE.Path().absarc(x, z, FIXTURE_RADIUS, 0, Math.PI * 2, true));
    }
  }
  const ceiling = new THREE.Mesh(
    new THREE.ShapeGeometry(shape, 24),
    // No light points up here, so a little emissive stands in for what bounces off the floor.
    new THREE.MeshStandardMaterial({ color: 0x9c8a74, emissive: 0x120d09, roughness: 0.95 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;
  room.add(ceiling);
}

/** A plain panel for each of the four walls, one-sided so it only exists when seen from inside. */
function addWallPanels(room, geometry, material, y, roomSize) {
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const wall = new THREE.Mesh(geometry, material);
    wall.position.set(-Math.sin(angle) * (roomSize / 2), y, -Math.cos(angle) * (roomSize / 2));
    wall.rotation.y = angle;
    wall.receiveShadow = true;
    room.add(wall);
  }
}

function addWalls(room, renderer, roomSize) {
  const half = roomSize / 2;
  const widthSegments = Math.ceil(roomSize / SHADE_SPACING);
  const upperHeight = ROOM_HEIGHT - WAINSCOT_HEIGHT;

  // Turned a quarter so the grain runs upright. The turn swaps which repeat applies
  // to which direction: x now runs up the wall.
  const { panel, fabric } = roomTextures(renderer);
  tileTextures(panel, WAINSCOT_HEIGHT / PANEL_TILE_METRES, roomSize / PANEL_TILE_METRES, Math.PI / 2);
  const lowerGeometry = shadePlane(new THREE.PlaneGeometry(roomSize, WAINSCOT_HEIGHT, widthSegments, 3), (x, y) =>
    cornerShade(half - Math.abs(x), 0.7, 0.5) * cornerShade(y + WAINSCOT_HEIGHT / 2, 0.35, 0.6),
  );
  addWallPanels(
    room,
    lowerGeometry,
    new THREE.MeshStandardMaterial({
      color: WALL_PANEL_TINT,
      map: panel.map,
      roughnessMap: panel.surface,
      bumpMap: panel.surface,
      roughness: 0.75,
      vertexColors: true,
    }),
    WAINSCOT_HEIGHT / 2,
    roomSize,
  );

  tileTextures(fabric, roomSize / FABRIC_TILE_METRES, upperHeight / FABRIC_TILE_METRES);
  const upperGeometry = shadePlane(new THREE.PlaneGeometry(roomSize, upperHeight, widthSegments, 6), (x, y) =>
    cornerShade(half - Math.abs(x), 0.7, 0.55) * cornerShade(upperHeight / 2 - y, 0.5, 0.65),
  );
  addWallPanels(
    room,
    upperGeometry,
    new THREE.MeshStandardMaterial({
      map: fabric.map,
      roughnessMap: fabric.surface,
      bumpMap: fabric.surface,
      bumpScale: 0.15,
      roughness: 1,
      vertexColors: true,
    }),
    WAINSCOT_HEIGHT + upperHeight / 2,
    roomSize,
  );
}

/** Woodwork on the walls and ceiling: baseboard, panel frames, rail, crown moulding and beams. */
function addWoodwork(room, renderer, roomSize) {
  const half = roomSize / 2;
  const undersideShade = (_, normal) => (normal[1] < -0.5 ? 0.85 : 1);
  const batch = new BoxBatch();

  const onEachWall = (along, y, out, sizeAlong, sizeY, sizeOut, chamfer) => {
    for (const axis of ['x', 'z']) {
      for (const sign of [-1, 1]) {
        const distance = sign * (half - out - sizeOut / 2);
        const box =
          axis === 'z'
            ? [along, y, distance, sizeAlong, sizeY, sizeOut]
            : [distance, y, along, sizeOut, sizeY, sizeAlong];
        batch.add(box, { chamfer, tile: TRIM_TILE_METRES, shade: undersideShade, grainOffset: [along * 0.37, sign * 0.21] });
      }
    }
  };

  onEachWall(0, BASEBOARD_HEIGHT / 2, 0, roomSize, BASEBOARD_HEIGHT, 0.022, 0.006);
  onEachWall(0, BASEBOARD_HEIGHT + 0.012, 0, roomSize, 0.024, 0.012, 0.004);
  onEachWall(0, WAINSCOT_HEIGHT + RAIL_HEIGHT / 2 - 0.01, 0, roomSize, RAIL_HEIGHT, 0.03, 0.008);
  onEachWall(0, ROOM_HEIGHT - CROWN_HEIGHT / 2, 0, roomSize, CROWN_HEIGHT, 0.03, 0.006);
  onEachWall(0, ROOM_HEIGHT - 0.02, 0, roomSize, 0.04, 0.055, 0.006);

  const stiles = Math.round(roomSize / STILE_SPACING);
  const stileHeight = WAINSCOT_HEIGHT - BASEBOARD_HEIGHT;
  for (let i = 1; i < stiles; i++) {
    const along = (i / stiles - 0.5) * roomSize;
    onEachWall(along, BASEBOARD_HEIGHT + stileHeight / 2, 0, STILE_WIDTH, stileHeight, 0.014, 0.004);
  }

  // Beams fall halfway between the lights, so they never cross one. One set is slightly
  // shallower, so the two sets' undersides aren't level and can't flicker where they cross.
  const fixtures = fixtureAxis(roomSize);
  const spacing = roomSize / fixtures.length;
  for (let i = 1; i < fixtures.length; i++) {
    const at = fixtures[i] - spacing / 2;
    const beam = { chamfer: 0.012, tile: TRIM_TILE_METRES, shade: undersideShade };
    batch.add([0, ROOM_HEIGHT - BEAM_DEPTH / 2, at, roomSize, BEAM_DEPTH, BEAM_WIDTH], { ...beam, grainOffset: [i * 0.31, 0] });
    batch.add([at, ROOM_HEIGHT - BEAM_DEPTH / 2 + 0.006, 0, BEAM_WIDTH, BEAM_DEPTH - 0.012, roomSize], { ...beam, grainOffset: [i * 0.53, 0.4] });
  }

  const wood = walnutTextures(renderer);
  const mesh = new THREE.Mesh(
    batch.toGeometry(),
    new THREE.MeshStandardMaterial({
      color: WOODWORK_TINT,
      map: wood.map,
      roughnessMap: wood.surface,
      roughness: 0.62,
      vertexColors: true,
    }),
  );
  mesh.receiveShadow = true;
  room.add(mesh);
}

function paintWallWash(ctx, width, height) {
  ctx.translate(width / 2, 0);
  ctx.scale(1, height / (width / 2));
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, width / 2);
  glow.addColorStop(0, 'rgba(255, 208, 155, 0.42)');
  glow.addColorStop(0.45, 'rgba(255, 200, 140, 0.16)');
  glow.addColorStop(1, 'rgba(255, 196, 130, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-width / 2, 0, width, height);
}

/**
 * The scallop of light each downlight throws on the wall behind it. Drawn as a soft shape
 * added to the wall, so it costs nothing per pixel beyond the shape itself.
 */
function addWallWashes(room, renderer, roomSize) {
  const axis = fixtureAxis(roomSize);
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: roomTextures(renderer).wash,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    axis.length * 4,
  );

  const up = new THREE.Vector3(0, 1, 0);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(WASH_WIDTH, WASH_HEIGHT, 1);
  const distance = roomSize / 2 - WALL_EFFECT_OFFSET;
  let index = 0;
  for (let wall = 0; wall < 4; wall++) {
    const angle = (wall * Math.PI) / 2;
    rotation.setFromAxisAngle(up, angle);
    for (const along of axis) {
      position.set(
        -Math.sin(angle) * distance + Math.cos(angle) * along,
        ROOM_HEIGHT - WASH_HEIGHT / 2,
        -Math.cos(angle) * distance - Math.sin(angle) * along,
      );
      mesh.setMatrixAt(index++, matrix.compose(position, rotation, scale));
    }
  }
  mesh.frustumCulled = false;
  room.add(mesh);
}

/**
 * A soft picture of a warm, dim room with bright lamps overhead, for materials to reflect.
 * This is what gives polished wood its sheen and rounded edges their highlights, and what
 * keeps surfaces facing away from every lamp from going black.
 */
function createEnvironment(renderer) {
  const scene = new THREE.Scene();
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(10, 4, 10),
    // Order is right, left, ceiling, floor, front, back. The floor is bright enough to light undersides.
    [0.16, 0.16, 0.3, 0.32, 0.16, 0.16].map(
      (level) =>
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(level * 1.05, level * 0.86, level * 0.68),
          side: THREE.BackSide,
        }),
    ),
  );
  scene.add(shell);

  const lampMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 7.2, 5.2) });
  const lampGeometry = new THREE.BoxGeometry(0.9, 0.02, 0.9);
  for (const x of [-3, 0, 3]) {
    for (const z of [-3, 0, 3]) {
      const lamp = new THREE.Mesh(lampGeometry, lampMaterial);
      lamp.position.set(x, 1.95, z);
      scene.add(lamp);
    }
  }

  const generator = new THREE.PMREMGenerator(renderer);
  const { texture } = generator.fromScene(scene, 0.03);
  generator.dispose();
  shell.geometry.dispose();
  shell.material.forEach((material) => material.dispose());
  lampMaterial.dispose();
  lampGeometry.dispose();
  return texture;
}

/**
 * A handful of real lights, placed at some of the ceiling fixtures. Every fixture glows,
 * but each extra real light costs every pixel in the room, so there are only five.
 */
function addLights(room, roomSize) {
  // Light fades with distance, so it stays even only if a bigger room gets stronger lights.
  const strength = Math.max(MIN_LIGHT_STRENGTH, (roomSize / LIGHTING_REFERENCE_ROOM_SIZE) ** LIGHT_DECAY);

  // The ground colour stands in for light bouncing off the floor, which lifts the ceiling.
  room.add(new THREE.HemisphereLight(0xffe2c0, 0x8a6240, 0.7));

  // One central light casts the room's shadows. See SceneManager for why they're static.
  // Its cone only just reaches the corners, which spends the shadow map's detail on the room.
  const cornerAngle = Math.atan2((roomSize / 2) * Math.SQRT2, ROOM_HEIGHT);
  const central = new THREE.SpotLight(LIGHT_COLOR, 15 * strength, 0, Math.min(cornerAngle + 0.05, 1.5), 0.8, LIGHT_DECAY);
  central.position.set(0, ROOM_HEIGHT - 0.02, 0);
  central.target.position.set(0, 0, 0);
  central.castShadow = true;
  central.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  central.shadow.bias = -0.0004;
  central.shadow.normalBias = 0.015;
  central.shadow.radius = 3;
  central.shadow.camera.near = 0.3;
  central.shadow.camera.far = roomSize + 4;
  room.add(central, central.target);

  // Pointing straight down, these light the room without lighting the ceiling around them.
  const axis = fixtureAxis(roomSize);
  const nearest = (target) => axis.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best));
  const offset = nearest(roomSize * FILL_LIGHT_INSET);
  for (const [x, z] of [[-offset, -offset], [offset, -offset], [-offset, offset], [offset, offset]]) {
    const light = new THREE.SpotLight(LIGHT_COLOR, 9 * strength, 0, 1.3, 0.8, LIGHT_DECAY);
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
    new THREE.MeshStandardMaterial({ color: 0xb08a48, metalness: 0.85, roughness: 0.35 }),
    positions,
    ROOM_HEIGHT - 0.002,
  );
  const shaft = instanceAtFixtures(
    new THREE.CylinderGeometry(FIXTURE_RADIUS, FIXTURE_RADIUS, FIXTURE_RECESS, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(LAMP_GLOW).multiplyScalar(1.1), side: THREE.BackSide }),
    positions,
    ROOM_HEIGHT + FIXTURE_RECESS / 2,
  );
  const lamp = instanceAtFixtures(
    faceDown(new THREE.CircleGeometry(FIXTURE_RADIUS, 32)),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(LAMP_GLOW).multiplyScalar(2.4) }),
    positions,
    ROOM_HEIGHT + FIXTURE_RECESS,
  );
  room.add(trim, shaft, lamp);
}

/** Leaves the textures alone: the next room reuses them. */
function disposeRoom(room) {
  room.traverse((object) => {
    object.geometry?.dispose();
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

  // It doesn't depend on the room's size, so it's made once and kept.
  scene.environment ??= createEnvironment(renderer);
  scene.environmentIntensity = ENVIRONMENT_INTENSITY;

  const room = new THREE.Group();
  room.name = ROOM_OBJECT_NAME;
  addFloor(room, renderer, roomSize);
  addCeiling(room, roomSize);
  addWalls(room, renderer, roomSize);
  addWoodwork(room, renderer, roomSize);
  addWallWashes(room, renderer, roomSize);
  addLights(room, roomSize);
  addFixtures(room, roomSize);
  scene.add(room);
}
