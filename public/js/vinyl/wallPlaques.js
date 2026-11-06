/**
 * The user's top songs, hung on the far wall as framed plaques like gold record awards:
 * the album cover in front of a gold disc, above an engraved brass nameplate. Each plaque
 * shows one record from a shelf, so clicking it works just like clicking that record.
 */

import * as THREE from 'three';
import { fitText } from '../bookshelves/bookshelfGenerator.js';
import { layoutPlaques } from '../bookshelves/shelfLayout.js';

const CANVAS_WIDTH_PX = 1024;
const FRAME_WIDTH = 0.05;
const FRAME_DEPTH = 0.06;
const SERIF = 'Georgia, "Times New Roman", serif';

function drawBacking(ctx, width, height) {
  ctx.fillStyle = '#120d0a';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(201, 162, 92, 0.6)';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, width - 48, height - 48);
}

function drawGoldDisc(ctx, x, y, radius) {
  const gold = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
  gold.addColorStop(0, '#f6dc97');
  gold.addColorStop(0.45, '#b98f3e');
  gold.addColorStop(0.55, '#e9c976');
  gold.addColorStop(1, '#8f6c2a');
  ctx.fillStyle = gold;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(92, 66, 22, 0.28)';
  ctx.lineWidth = 2;
  for (let groove = radius * 0.42; groove < radius * 0.98; groove += 13) {
    ctx.beginPath();
    ctx.arc(x, y, groove, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** The album cover, or a plain sleeve until it loads or if it can't. */
function drawCover(ctx, image, x, y, size) {
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetX = 10;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#6b4a2c';
  ctx.fillRect(x, y, size, size);
  ctx.shadowColor = 'transparent';
  if (image) ctx.drawImage(image, x, y, size, size);
}

function drawNameplate(ctx, record, rank, x, y, width, height) {
  const brass = ctx.createLinearGradient(x, y, x, y + height);
  brass.addColorStop(0, '#d9b873');
  brass.addColorStop(0.5, '#b8944f');
  brass.addColorStop(1, '#9c7a3a');
  ctx.fillStyle = brass;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = 'rgba(62, 42, 12, 0.7)';
  ctx.lineWidth = 4;
  ctx.strokeRect(x + 10, y + 10, width - 20, height - 20);

  const centre = x + width / 2;
  const available = width - 70;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#2a1a07';
  ctx.font = `500 44px ${SERIF}`;
  ctx.fillText(`No. ${rank}`, centre, y + height * 0.22);
  ctx.font = `600 66px ${SERIF}`;
  ctx.fillText(fitText(ctx, record.track.title, available), centre, y + height * 0.5);
  ctx.font = `italic 500 44px ${SERIF}`;
  ctx.fillText(fitText(ctx, record.track.artists.join(', '), available), centre, y + height * 0.78);
}

function drawPlaque(canvas, record, rank, image) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const coverSize = width * 0.56;
  const coverX = width * 0.085;
  const coverY = height * 0.075;
  drawBacking(ctx, width, height);
  drawGoldDisc(ctx, coverX + coverSize * 1.02, coverY + coverSize / 2, coverSize * 0.46);
  drawCover(ctx, image, coverX, coverY, coverSize);
  drawNameplate(ctx, record, rank, width * 0.085, height * 0.645, width * 0.83, height * 0.285);
}

async function loadCover(url) {
  const image = new Image();
  image.crossOrigin = 'anonymous'; // matches the album art loader, and keeps the canvas usable as a texture
  image.src = url;
  await image.decode();
  return image;
}

/**
 * Hangs a plaque for each record, in rank order, and streams in their covers.
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {Array<{track: object}>} records at most 5, best first
 * @param {number} roomSize
 * @param {() => void} requestRender called when a cover arrives
 * @returns {Array<{x,y,z,width,height,record}>} the plaques, for picking
 */
export function buildWallPlaques(scene, renderer, records, roomSize, requestRender) {
  const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x3a2212, roughness: 0.5 });

  return layoutPlaques(roomSize, records.length).map((placement, index) => {
    const record = records[index];
    const rank = index + 1;
    const { x, y, z, width, height } = placement;

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH_PX;
    canvas.height = Math.round((CANVAS_WIDTH_PX * height) / width);
    drawPlaque(canvas, record, rank, null);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // Unlit and left out of tone mapping, so the names stay readable on a dim wall.
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    face.position.set(x, y, z);

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(width + 2 * FRAME_WIDTH, height + 2 * FRAME_WIDTH, FRAME_DEPTH),
      frameMaterial,
    );
    frame.position.set(x, y, z - FRAME_DEPTH / 2 - 0.001);
    scene.add(frame, face);

    if (record.track.artFullUrl) {
      loadCover(record.track.artFullUrl)
        .then((image) => {
          drawPlaque(canvas, record, rank, image);
          texture.needsUpdate = true;
          requestRender();
        })
        .catch((error) => console.debug('Plaque cover failed to load:', error.message));
    }

    return { ...placement, record };
  });
}
