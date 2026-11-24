/**
 * A TV on the far wall, above the plaques, showing what's playing from either service:
 * the song's cover over a blurred wash of it, with its title and artist.
 *
 * The YouTube video itself can't appear here. Browsers never let a page read the pixels of
 * another site's player, so it can't become a texture. It plays in the on-screen TV panel.
 */

import * as THREE from 'three';
import { fitText } from '../bookshelves/bookshelfGenerator.js';

const SCREEN_WIDTH = 1;
const SCREEN_HEIGHT = 0.5625;
const BEZEL = 0.035;
const DEPTH = 0.045;
/** Between the plaque frames, which reach 2.3 m, and the crown moulding at 3.1 m. */
const CENTRE_Y = 2.7;
const WALL_GAP = 0.005;
const SCREEN_OFFSET = 0.001; // keeps the picture from flickering against the bezel

const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 576;
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function drawIdle(ctx) {
  const glass = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  glass.addColorStop(0, '#15171a');
  glass.addColorStop(1, '#050506');
  ctx.fillStyle = glass;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  // A faint reflection across the glass, so it reads as a switched-off screen, not a hole.
  const sheen = ctx.createLinearGradient(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT * 0.6);
  sheen.addColorStop(0.3, 'rgba(255, 255, 255, 0)');
  sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0.05)');
  sheen.addColorStop(0.6, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

/**
 * Blurs by shrinking the cover to a few pixels and stretching it back, which every
 * browser smooths. The canvas `filter` property would be simpler, but Safari ignores it.
 */
function drawWash(ctx, image, scratch) {
  const scratchCtx = scratch.getContext('2d');
  scratchCtx.drawImage(image, 0, image.height * 0.22, image.width, image.height * 0.56, 0, 0, scratch.width, scratch.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(scratch, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = 'rgba(8, 5, 3, 0.6)';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
}

function drawPlaying(ctx, state, image, scratch) {
  if (image) {
    drawWash(ctx, image, scratch);
  } else {
    ctx.fillStyle = '#1c130b';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  const coverSize = CANVAS_HEIGHT * 0.62;
  const coverX = CANVAS_HEIGHT * 0.17;
  const coverY = (CANVAS_HEIGHT - coverSize) / 2;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#6b4a2c';
  ctx.fillRect(coverX, coverY, coverSize, coverSize);
  ctx.shadowColor = 'transparent';
  if (image) ctx.drawImage(image, coverX, coverY, coverSize, coverSize);

  const textX = coverX + coverSize + 52;
  const available = CANVAS_WIDTH - textX - 56;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e8bd78';
  ctx.font = `600 28px ${SANS}`;
  ctx.fillText(state.paused ? 'PAUSED' : 'NOW PLAYING', textX, CANVAS_HEIGHT * 0.4);
  ctx.fillStyle = '#f6ead6';
  ctx.font = `600 62px ${SERIF}`;
  ctx.fillText(fitText(ctx, state.title, available), textX, CANVAS_HEIGHT * 0.4 + 78);
  ctx.fillStyle = '#d2bf9f';
  ctx.font = `italic 500 40px ${SERIF}`;
  ctx.fillText(fitText(ctx, state.artist, available), textX, CANVAS_HEIGHT * 0.4 + 132);
}

async function loadImage(url) {
  const image = new Image();
  image.crossOrigin = 'anonymous'; // without this the canvas can't be used as a texture
  image.src = url;
  await image.decode();
  return image;
}

/**
 * Hangs the TV on the far wall.
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {number} roomSize
 * @param {() => void} requestRender called when the picture changes
 * @returns {{show: (state: import('../spotify/playbackService.js').PlaybackState|null) => void}}
 */
export function buildRoomTv(scene, renderer, roomSize, requestRender) {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  const scratch = document.createElement('canvas');
  scratch.width = 16;
  scratch.height = 9;
  drawIdle(ctx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const wallZ = -roomSize / 2;
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(SCREEN_WIDTH + 2 * BEZEL, SCREEN_HEIGHT + 2 * BEZEL, DEPTH),
    new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.32, metalness: 0.4 }),
  );
  bezel.position.set(0, CENTRE_Y, wallZ + WALL_GAP + DEPTH / 2);

  // Unlit, like a real screen, and left out of tone mapping so it isn't dimmed with the room.
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(SCREEN_WIDTH, SCREEN_HEIGHT),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  screen.position.set(0, CENTRE_Y, wallZ + WALL_GAP + DEPTH + SCREEN_OFFSET);

  const tv = new THREE.Group();
  tv.name = 'room-tv';
  tv.add(bezel, screen);
  scene.add(tv);

  let shown = null;
  let shownKey = null;
  let image = null;
  let imageUrl = null;

  const redraw = () => {
    if (shown) drawPlaying(ctx, shown, image, scratch);
    else drawIdle(ctx);
    texture.needsUpdate = true;
    requestRender();
  };

  return {
    show(state) {
      // Players report often, mostly just the position, so redraw only when the picture changes.
      const key = state ? `${state.uris[0]}|${state.paused}|${state.title}` : null;
      if (key === shownKey) return;
      shownKey = key;
      shown = state;

      const artUrl = state?.artUrl ?? null;
      if (artUrl !== imageUrl) {
        imageUrl = artUrl;
        image = null;
        if (artUrl) {
          loadImage(artUrl)
            .then((loaded) => {
              if (imageUrl !== artUrl) return; // the song changed while this loaded
              image = loaded;
              redraw();
            })
            .catch((error) => console.debug('TV cover failed to load:', error.message));
        }
      }
      redraw();
    },
  };
}
