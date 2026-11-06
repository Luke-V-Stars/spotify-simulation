/**
 * Builds the bookshelf meshes. Every board, light strip and name plaque in the room
 * is one instance of a shared mesh, so shelf count barely affects draw calls.
 */

import * as THREE from 'three';
import { LayeredTexture } from '../scene/layeredTexture.js';
import { SHELF } from './shelfGeometry.js';
import { layoutBookshelves } from './shelfLayout.js';

const LABEL_ASPECT = SHELF.labelWidth / SHELF.labelHeight;
/** Very large libraries get lower-resolution plaques: they're drawn smaller anyway. */
const LABEL_WIDTH_PX = 768;
const LABEL_WIDTH_PX_CROWDED = 384;
const CROWDED_SHELF_COUNT = 100;

/** Every wooden part of a shelf, as [centre x, y, z, size x, y, z] in shelf space. */
function shelfBoards() {
  const { width, height, depth, board, plinth, rows, cellHeight } = SHELF;
  const innerWidth = width - 2 * board;
  const boards = [
    [-(width - board) / 2, height / 2, 0, board, height, depth],
    [(width - board) / 2, height / 2, 0, board, height, depth],
    [0, height / 2, -depth / 2 + 0.01, innerWidth, height, 0.02],
    [0, plinth / 2, 0, innerWidth, plinth, depth],
  ];
  for (let i = 0; i <= rows; i++) {
    boards.push([0, plinth + i * (board + cellHeight) + board / 2, 0, innerWidth, board, depth]);
  }
  return boards;
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
function instanceParts(parts, shelves, material) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, parts.length * shelves.length);
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

/** Shortens text with an ellipsis until it fits the plaque. */
function fitText(ctx, text, maxWidth) {
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

/** Draws each shelf's name onto its own layer of a texture array. */
function createLabelTexture(renderer, shelves) {
  const width = shelves.length > CROWDED_SHELF_COUNT ? LABEL_WIDTH_PX_CROWDED : LABEL_WIDTH_PX;
  const height = Math.round(width / LABEL_ASPECT);
  const layered = new LayeredTexture(renderer, {
    width,
    height,
    layers: shelves.length,
    fill: [20, 14, 8, 255],
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  shelves.forEach((shelf, layer) => {
    ctx.fillStyle = '#17100a';
    ctx.fillRect(0, 0, width, height);
    const inset = height * 0.08;
    ctx.strokeStyle = 'rgba(214, 170, 100, 0.55)';
    ctx.lineWidth = Math.max(1, height * 0.02);
    ctx.strokeRect(inset, inset, width - 2 * inset, height - 2 * inset);

    ctx.font = `500 ${Math.round(height * 0.46)}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f0cf94';
    ctx.fillText(fitText(ctx, shelf.label, width * 0.92), width / 2, height / 2 + height * 0.02);
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
  });

  const mesh = new THREE.InstancedMesh(geometry, material, shelves.length);
  const offset = new THREE.Matrix4().makeTranslation(
    0,
    SHELF.height + SHELF.labelGap + SHELF.labelHeight / 2,
    SHELF.depth / 2 - 0.02,
  );
  const matrix = new THREE.Matrix4();
  shelves.forEach((shelf, index) => {
    mesh.setMatrixAt(index, matrix.multiplyMatrices(shelf.matrix, offset));
  });
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Lays out and builds all shelves, adding them to the scene.
 * @param {ReturnType<import('./shelfPlanner.js').planBookshelves>} plannedShelves
 * @returns placed shelves: the plan plus position, yaw, scale, matrix and recordCount
 */
export function buildBookshelves(scene, renderer, plannedShelves) {
  const { scale, placements } = layoutBookshelves(plannedShelves.length);
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

  const wood = instanceParts(
    shelfBoards(),
    placed,
    new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.62 }),
  );
  wood.castShadow = true;
  wood.receiveShadow = true;

  const strips = instanceParts(
    shelfLightStrips(),
    placed,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc27a).multiplyScalar(0.8) }),
  );

  scene.add(wood, strips, createLabels(renderer, placed));
  return placed;
}

/** The view SceneManager.focusOn needs to look straight at a shelf. */
export function shelfFocusView(shelf) {
  return {
    center: { x: shelf.x, y: ((SHELF.height + SHELF.labelGap + SHELF.labelHeight) / 2) * shelf.scale, z: shelf.z },
    facing: { x: Math.sin(shelf.yaw), z: Math.cos(shelf.yaw) },
    width: SHELF.width * shelf.scale,
  };
}
