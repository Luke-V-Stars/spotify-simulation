/**
 * Builds the bookshelf meshes. Every shelf, light strip and engraved name in the room
 * is one instance of a shared mesh, so shelf count barely affects draw calls.
 */

import * as THREE from 'three';
import { BoxBatch } from '../scene/boxBatch.js';
import { LayeredTexture } from '../scene/layeredTexture.js';
import { paintedTexture, seededRandom, walnutTextures } from '../scene/proceduralTextures.js';
import { SHELF } from './shelfGeometry.js';

const LABEL_ASPECT = SHELF.labelWidth / SHELF.labelHeight;
/** Very large libraries get lower-resolution names: they're drawn smaller anyway. */
const LABEL_WIDTH_PX = 1024;
const LABEL_WIDTH_PX_CROWDED = 512;
const CROWDED_SHELF_COUNT = 100;
/** Stops the engraving z-fighting with the board it's cut into. */
const LABEL_SURFACE_OFFSET = 0.001;

/** Past this many shelves, each is small and costs too many triangles to be worth the detail. */
const SIMPLE_SHELF_COUNT = 200;

const BACK_PANEL_THICKNESS = 0.02;
const PLINTH_RECESS = 0.014; // how far the base sits back from the front of the shelf
const LIP_HEIGHT = 0.014; // the low rail along each shelf that keeps the records in
const LIP_THICKNESS = 0.012;
/** The top is two steps, each reaching further out. Sides stay inside the gap between shelves. */
const CAP_LOWER_HEIGHT = 0.012;
const CAP_LOWER_OVERHANG = 0.012;
const CAP_UPPER_OVERHANG = 0.024;
const CAP_SIDE_OVERHANG = 0.012;
const BEAD_HEIGHT = 0.012; // the raised lines framing the header board
const BEAD_PROJECTION = 0.004;
const PILASTER_WIDTH = 0.016; // the raised strip up the front of each side
const PILASTER_PROJECTION = 0.004;

const WOOD_TILE_METRES = 1.1;
/** Shelves differ a little in tone, as if cut from different boards. */
const TONE_VARIATION = 0.09;

const SHADOW_SPREAD = 0.3; // how far past the shelf its floor shadow reaches
const FLOOR_EFFECT_HEIGHT = 0.003; // keeps the shadow from flickering against the floor

/**
 * Every wooden part of a shelf in shelf space, as [centre x, y, z, size x, y, z] plus how
 * much to soften its edges. `detailed` adds the small decorative parts.
 */
export function shelfBoards(detailed = true) {
  const { width, height, depth, board, plinth, rows, cellHeight, headerHeight, capHeight } = SHELF;
  const innerWidth = width - 2 * board;
  const capBase = height + headerHeight;
  const capUpperHeight = capHeight - CAP_LOWER_HEIGHT;
  const capWidth = width + 2 * CAP_SIDE_OVERHANG;
  const boardDepth = depth - BACK_PANEL_THICKNESS; // the boards inside stop at the back panel
  const boards = [
    { box: [-(width - board) / 2, height / 2, 0, board, height, depth], chamfer: 0.005 },
    { box: [(width - board) / 2, height / 2, 0, board, height, depth], chamfer: 0.005 },
    {
      box: [0, height / 2, -depth / 2 + BACK_PANEL_THICKNESS / 2, innerWidth, height, BACK_PANEL_THICKNESS],
      chamfer: 0,
    },
    {
      box: [0, plinth / 2, (BACK_PANEL_THICKNESS - PLINTH_RECESS) / 2, innerWidth, plinth, boardDepth - PLINTH_RECESS],
      chamfer: 0,
    },
    // The header board carrying the shelf's name, and a stepped top that overhangs its front.
    { box: [0, height + headerHeight / 2, 0, width, headerHeight, depth], chamfer: 0.004 },
    {
      box: [0, capBase + CAP_LOWER_HEIGHT / 2, CAP_LOWER_OVERHANG / 2, width + CAP_SIDE_OVERHANG, CAP_LOWER_HEIGHT, depth + CAP_LOWER_OVERHANG],
      chamfer: 0.003,
    },
    {
      box: [0, capBase + CAP_LOWER_HEIGHT + capUpperHeight / 2, CAP_UPPER_OVERHANG / 2, capWidth, capUpperHeight, depth + CAP_UPPER_OVERHANG],
      chamfer: 0.006,
    },
  ];
  for (let i = 0; i <= rows; i++) {
    boards.push({
      box: [0, plinth + i * (board + cellHeight) + board / 2, BACK_PANEL_THICKNESS / 2, innerWidth, board, boardDepth],
      chamfer: 0.003,
    });
  }
  if (!detailed) return boards;

  for (let i = 0; i < rows; i++) {
    const y = plinth + i * (board + cellHeight) + board + LIP_HEIGHT / 2;
    boards.push({
      box: [0, y, depth / 2 - LIP_THICKNESS / 2, innerWidth, LIP_HEIGHT, LIP_THICKNESS],
      chamfer: 0.003,
    });
  }
  for (const y of [height + BEAD_HEIGHT / 2, capBase - BEAD_HEIGHT / 2]) {
    boards.push({
      box: [0, y, depth / 2 + BEAD_PROJECTION / 2, width, BEAD_HEIGHT, BEAD_PROJECTION],
      chamfer: 0.002,
    });
  }
  for (const side of [-1, 1]) {
    boards.push({
      box: [side * (width - board) / 2, plinth + (height - plinth) / 2, depth / 2 + PILASTER_PROJECTION / 2, PILASTER_WIDTH, height - plinth, PILASTER_PROJECTION],
      chamfer: 0.002,
    });
  }
  return boards;
}

/**
 * How much light reaches a point on the shelf. Inside the cells it fades toward the back
 * and under each board, which is what makes them look deep. Outside faces get full light.
 */
function shelfShade([x, y, z], [nx, ny, nz]) {
  const { width, depth, height } = SHELF;
  const facesBackOrOutside = nz < -0.5 || (nx !== 0 && Math.sign(nx) === Math.sign(x) && Math.abs(x) >= width / 2 - 0.001);
  if (facesBackOrOutside || (ny > 0.5 && y > height)) return 1;
  const towardFront = THREE.MathUtils.clamp((z + depth / 2) / depth, 0, 1);
  const depthShade = 0.4 + 0.6 * towardFront * towardFront;
  const undersideShade = ny < -0.5 ? 0.72 : 1;
  return depthShade * undersideShade;
}

function createShelfGeometry(detailed) {
  const random = seededRandom(19);
  const batch = new BoxBatch();
  for (const { box, chamfer } of shelfBoards(detailed)) {
    batch.add(box, {
      chamfer: detailed ? chamfer : 0,
      tile: WOOD_TILE_METRES,
      grainOffset: [random(), random()],
      shade: shelfShade,
    });
  }
  return batch.toGeometry();
}

function createWood(renderer, placed) {
  const textures = walnutTextures(renderer);
  const mesh = new THREE.InstancedMesh(
    createShelfGeometry(placed.length <= SIMPLE_SHELF_COUNT),
    new THREE.MeshStandardMaterial({
      map: textures.map,
      roughnessMap: textures.surface,
      roughness: 0.62,
      vertexColors: true,
    }),
    placed.length,
  );
  const random = seededRandom(5);
  const tone = new THREE.Color();
  placed.forEach((shelf, index) => {
    mesh.setMatrixAt(index, shelf.matrix);
    mesh.setColorAt(index, tone.setScalar(1 + (random() - 0.5) * TONE_VARIATION));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // the room's contents surround the camera
  return mesh;
}

/** The pool of light each strip throws down the back panel of its cell, seen between the records. */
function createCellGlows(placed) {
  const { width, depth, board, plinth, rows, cellHeight } = SHELF;
  const panelZ = -depth / 2 + BACK_PANEL_THICKNESS + 0.001;
  const parts = [];
  for (let i = 0; i < rows; i++) {
    parts.push([0, plinth + board + i * (board + cellHeight) + cellHeight / 2, panelZ, width - 2 * board, cellHeight, 1]);
  }
  const texture = paintedTexture(4, 128, (ctx, canvasWidth, canvasHeight) => {
    const glow = ctx.createLinearGradient(0, 0, 0, canvasHeight);
    glow.addColorStop(0, 'rgba(255, 196, 130, 0.38)');
    glow.addColorStop(0.5, 'rgba(255, 180, 110, 0.1)');
    glow.addColorStop(1, 'rgba(255, 170, 100, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  });
  return instanceParts(
    parts,
    placed,
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    new THREE.PlaneGeometry(1, 1),
  );
}

/** A soft dark patch on the floor around each shelf, so it sits on the ground rather than floating. */
function createFloorShadows(placed) {
  const { width, depth } = SHELF;
  const size = 256;
  const inset = 44;
  const texture = paintedTexture(size, size, (ctx) => {
    // Drawn off the canvas with its blurred shadow falling on it, so only the soft part shows.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
    ctx.shadowBlur = 36;
    ctx.shadowOffsetX = size * 2;
    ctx.fillRect(inset - size * 2, inset, size - 2 * inset, size - 2 * inset);
  });
  return instanceParts(
    [[0, FLOOR_EFFECT_HEIGHT, 0, width + 2 * SHADOW_SPREAD, 1, depth + 2 * SHADOW_SPREAD]],
    placed,
    new THREE.MeshBasicMaterial({ map: texture, color: 0x000000, transparent: true, depthWrite: false }),
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  );
}

/** A thin warm light strip hidden under the front edge of each shelf board. */
function shelfLightStrips() {
  const { width, depth, board, plinth, rows, cellHeight } = SHELF;
  const strips = [];
  for (let i = 1; i <= rows; i++) {
    const y = plinth + i * (board + cellHeight) - 0.004;
    strips.push([0, y, depth / 2 - 0.02, width - 2 * board - 0.04, 0.006, 0.014]);
  }
  return strips;
}

/** Creates one InstancedMesh holding `parts` repeated for every shelf. */
function instanceParts(parts, shelves, material, geometry = new THREE.BoxGeometry(1, 1, 1)) {
  const mesh = new THREE.InstancedMesh(geometry, material, parts.length * shelves.length);
  const partMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const size = new THREE.Vector3();

  let index = 0;
  for (const shelf of shelves) {
    for (const [x, y, z, sx, sy, sz] of parts) {
      partMatrix.compose(position.set(x, y, z), quaternion, size.set(sx, sy, sz));
      instanceMatrix.multiplyMatrices(shelf.matrix, partMatrix);
      mesh.setMatrixAt(index++, instanceMatrix);
    }
  }
  mesh.frustumCulled = false; // the room's contents surround the camera
  return mesh;
}

/** Shortens text with an ellipsis until it fits the given width. */
export function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  // Array.from keeps emoji and other multi-unit characters intact while cutting.
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${characters.slice(0, middle).join('')}…`).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join('').trimEnd()}…`;
}

/**
 * Draws each shelf's name onto its own layer of a texture array. Only the letters are
 * opaque, so the wood shows around them. A dark edge above each letter and a pale one
 * below make them look cut into a board lit from overhead, and the fill is the gilding.
 */
function createLabelTexture(renderer, shelves) {
  const width = shelves.length > CROWDED_SHELF_COUNT ? LABEL_WIDTH_PX_CROWDED : LABEL_WIDTH_PX;
  const height = Math.round(width / LABEL_ASPECT);
  const layered = new LayeredTexture(renderer, {
    width,
    height,
    layers: shelves.length,
    fill: [0, 0, 0, 0],
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.font = `500 ${Math.round(height * 0.62)}px Georgia, "Times New Roman", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const edge = Math.max(1, height * 0.025);

  shelves.forEach((shelf, layer) => {
    ctx.clearRect(0, 0, width, height);
    const name = fitText(ctx, shelf.label, width * 0.96);
    const x = width / 2;
    const y = height / 2 + height * 0.03;
    ctx.fillStyle = 'rgba(12, 6, 2, 0.85)';
    ctx.fillText(name, x, y - edge);
    ctx.fillStyle = 'rgba(255, 214, 160, 0.3)';
    ctx.fillText(name, x, y + edge);
    ctx.fillStyle = '#d4ad68';
    ctx.fillText(name, x, y);
    layered.writeLayer(layer, ctx.getImageData(0, 0, width, height).data);
  });
  layered.flush();
  return layered.texture;
}

function createLabels(renderer, shelves) {
  const geometry = new THREE.PlaneGeometry(SHELF.labelWidth, SHELF.labelHeight);
  const layerAttribute = new Float32Array(shelves.length).map((_, i) => i);
  geometry.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layerAttribute, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uLabels: { value: createLabelTexture(renderer, shelves) } },
    vertexShader: /* glsl */ `
      attribute float aLayer;
      varying vec2 vUv;
      varying float vLayer;
      void main() {
        vUv = uv;
        vLayer = aLayer;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2DArray uLabels;
      varying vec2 vUv;
      varying float vLayer;
      void main() {
        // Canvas pixels are stored top row first, so flip V.
        gl_FragColor = texture(uLabels, vec3(vUv.x, 1.0 - vUv.y, vLayer));
        #include <colorspace_fragment>
      }
    `,
    toneMapped: false, // keep the names legible regardless of exposure
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, shelves.length);
  const offset = new THREE.Matrix4().makeTranslation(
    0,
    SHELF.height + SHELF.headerHeight / 2,
    SHELF.depth / 2 + LABEL_SURFACE_OFFSET,
  );
  const matrix = new THREE.Matrix4();
  shelves.forEach((shelf, index) => {
    mesh.setMatrixAt(index, matrix.multiplyMatrices(shelf.matrix, offset));
  });
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Builds all shelves at their planned places, adding them to the scene.
 * @param {ReturnType<import('./shelfPlanner.js').planBookshelves>} plannedShelves
 * @param {ReturnType<import('./shelfLayout.js').layoutBookshelves>} layout
 * @returns placed shelves: the plan plus position, yaw, scale, matrix and recordCount
 */
export function buildBookshelves(scene, renderer, plannedShelves, { scale, placements }) {
  const up = new THREE.Vector3(0, 1, 0);
  const placed = plannedShelves.map((shelf, index) => {
    const { x, z, yaw } = placements[index];
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, 0, z),
      new THREE.Quaternion().setFromAxisAngle(up, yaw),
      new THREE.Vector3(scale, scale, scale),
    );
    return { ...shelf, x, z, yaw, scale, matrix, recordCount: shelf.tracks.length };
  });

  const strips = instanceParts(
    shelfLightStrips(),
    placed,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc27a).multiplyScalar(0.8) }),
  );

  scene.add(
    createWood(renderer, placed),
    strips,
    createCellGlows(placed),
    createFloorShadows(placed),
    createLabels(renderer, placed),
  );
  return placed;
}

/** The view SceneManager.focusOn needs to look straight at a shelf. */
export function shelfFocusView(shelf) {
  return {
    center: { x: shelf.x, y: (SHELF.totalHeight / 2) * shelf.scale, z: shelf.z },
    facing: { x: Math.sin(shelf.yaw), z: Math.cos(shelf.yaw) },
    width: SHELF.width * shelf.scale,
  };
}
