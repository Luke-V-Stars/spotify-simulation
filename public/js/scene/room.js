/**
 * The enclosed listening room: oak floor, matte black walls, dark ceiling and
 * ambient golden lighting. Everything here is static and uses few draw calls.
 */

import * as THREE from 'three';
import { ROOM_HEIGHT, ROOM_SIZE } from '../bookshelves/shelfLayout.js';

const GOLD = 0xffc27a;
const FLOOR_TILE_METRES = 2.4; // with 12 plank rows per tile, planks are 20 cm wide
const PENDANT_POSITIONS = [
  [-5.5, -5.5],
  [5.5, -5.5],
  [-5.5, 5.5],
  [5.5, 5.5],
];

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Paints a tileable oak plank texture. Procedural, so the project ships no image files. */
function createOakTexture(renderer) {
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
      const hue = 31 + random() * 5;
      const saturation = 30 + random() * 7;
      const lightness = 37 + random() * 6;
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
  texture.repeat.set(ROOM_SIZE / FLOOR_TILE_METRES, ROOM_SIZE / FLOOR_TILE_METRES);
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function addSurfaces(scene, renderer) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE),
    new THREE.MeshStandardMaterial({ map: createOakTexture(renderer), roughness: 0.52, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE),
    new THREE.MeshStandardMaterial({ color: 0x14100c, roughness: 0.92 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;
  scene.add(ceiling);

  // A plane is one-sided, so each wall only exists when seen from inside the room.
  const wallGeometry = new THREE.PlaneGeometry(ROOM_SIZE, ROOM_HEIGHT);
  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.97 });
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    wall.position.set(-Math.sin(angle) * (ROOM_SIZE / 2), ROOM_HEIGHT / 2, -Math.cos(angle) * (ROOM_SIZE / 2));
    wall.rotation.y = angle;
    wall.receiveShadow = true;
    scene.add(wall);
  }
}

function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffd7a3, 0x3a2412, 0.55));

  // One central light casts the room's shadows. See SceneManager for why they're static.
  const central = new THREE.SpotLight(GOLD, 75, 0, 1.38, 0.9, 1.4);
  central.position.set(0, ROOM_HEIGHT - 0.15, 0);
  central.target.position.set(0, 0, 0);
  central.castShadow = true;
  central.shadow.mapSize.set(2048, 2048);
  central.shadow.bias = -0.0006;
  central.shadow.normalBias = 0.02;
  central.shadow.camera.near = 0.5;
  central.shadow.camera.far = 24;
  scene.add(central, central.target);

  for (const [x, z] of PENDANT_POSITIONS) {
    const light = new THREE.PointLight(GOLD, 22, 0, 1.7);
    light.position.set(x, ROOM_HEIGHT - 1.35, z);
    scene.add(light);
  }
}

/** Brass pendants and a glowing cove line: visible sources for the golden light. */
function addFixtures(scene) {
  const brass = new THREE.MeshStandardMaterial({ color: 0x9c7434, metalness: 0.75, roughness: 0.38 });
  const bulbGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(GOLD).multiplyScalar(2.4) });
  // Kept below 1 so tone mapping leaves the thin line gold rather than clipping it to white.
  const coveGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(GOLD).multiplyScalar(0.8) });

  const cordGeometry = new THREE.CylinderGeometry(0.008, 0.008, 1, 6);
  const shadeGeometry = new THREE.SphereGeometry(0.26, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const bulbGeometry = new THREE.SphereGeometry(0.1, 16, 12);

  for (const [x, z] of PENDANT_POSITIONS) {
    const y = ROOM_HEIGHT - 1.2;
    const cord = new THREE.Mesh(cordGeometry, brass);
    cord.scale.y = 1.2;
    cord.position.set(x, ROOM_HEIGHT - 0.6, z);

    const shade = new THREE.Mesh(shadeGeometry, brass);
    shade.position.set(x, y, z);

    const bulb = new THREE.Mesh(bulbGeometry, bulbGlow);
    bulb.position.set(x, y - 0.03, z);
    scene.add(cord, shade, bulb);
  }

  const coveGeometry = new THREE.BoxGeometry(ROOM_SIZE - 0.1, 0.025, 0.025);
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2;
    const cove = new THREE.Mesh(coveGeometry, coveGlow);
    const distance = ROOM_SIZE / 2 - 0.05;
    cove.position.set(-Math.sin(angle) * distance, ROOM_HEIGHT - 0.06, -Math.cos(angle) * distance);
    cove.rotation.y = angle;
    scene.add(cove);
  }
}

export function buildRoom(scene, renderer) {
  addSurfaces(scene, renderer);
  addLights(scene);
  addFixtures(scene);
}
