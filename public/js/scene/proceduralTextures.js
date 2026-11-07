/**
 * Textures painted on canvases at load time, so the project ships no image files.
 *
 * Wood and fabric each come as a pair. `map` is the colour. `surface` is both the bump map
 * and the roughness map, which three.js reads from different channels: red is height and
 * green is roughness. Grooves paint low red and high green, so they sink in and stay matt.
 * With low green as well they would turn mirror-like and sparkle.
 */

import * as THREE from 'three';

const GRAIN_STEP_PX = 24;
const GRAIN_PIXELS_PER_LINE = 2.8;
const GRAIN_MAX_WAVE_PX = 4;
const PORE_PIXELS_PER_DASH = 370;
const PORE_MAX_LENGTH_PX = 27;

/**
 * Grain is drawn in batches, one path per style, because drawing each line separately
 * takes seconds. Lines in a batch don't darken where they cross, which isn't noticeable.
 */
const GRAIN_STYLES = [
  { style: 'rgba(36, 18, 7, 0.08)', lineWidth: 0.7, surfaceAlpha: 0.07, share: 0.25 },
  { style: 'rgba(36, 18, 7, 0.14)', lineWidth: 1.1, surfaceAlpha: 0.1, share: 0.25 },
  { style: 'rgba(36, 18, 7, 0.24)', lineWidth: 1.6, surfaceAlpha: 0.14, share: 0.2 },
  { style: 'rgba(236, 196, 140, 0.05)', lineWidth: 0.9, surfaceAlpha: 0.04, share: 0.2 },
  { style: 'rgba(236, 196, 140, 0.1)', lineWidth: 1.5, surfaceAlpha: 0.05, share: 0.1 },
];

const WALNUT = { hue: 24, saturation: 34, lightness: 27 };

export function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function tilingTexture(canvas, renderer, colorSpace) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

/** A soft shape for lighting and shadow effects. `paint` draws on a canvas of the given size. */
export function paintedTexture(width, height, paint) {
  const canvas = createCanvas(width, height);
  paint(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Sets the same repeat and rotation on each texture, since three.js stores them per texture. */
export function tileTextures({ map, surface }, repeatX, repeatY, rotation = 0) {
  for (const texture of [map, surface]) {
    texture.repeat.set(repeatX, repeatY);
    texture.rotation = rotation;
  }
}

/** Adds one long grain line, wandering a little. Its waves fit the tile exactly, so it joins up across the seam. */
function addGrainLine(path, random, x, width, y, tileSize) {
  const wave = 0.8 + random() * (GRAIN_MAX_WAVE_PX - 0.8);
  const cycles = 1 + Math.floor(random() * 3);
  const phase = random() * Math.PI * 2;
  const heightAt = (px) => y + Math.sin((px / tileSize) * Math.PI * 2 * cycles + phase) * wave;
  path.moveTo(x, heightAt(x));
  for (let px = x + GRAIN_STEP_PX; px < x + width; px += GRAIN_STEP_PX) path.lineTo(px, heightAt(px));
  path.lineTo(x + width, heightAt(x + width));
}

const ARCH_SHIFT_PX = 16; // each arch's tip sits this far behind the one inside it
const MAX_ARCHES = 8;

/** The nested arches that sawing through a tree's growth rings leaves on a board. */
function cathedralLines(random, tipX, centreY, reach, maxSpread) {
  const path = new Path2D();
  const arches = 4 + Math.floor(random() * (MAX_ARCHES - 3));
  for (let arch = 1; arch <= arches; arch++) {
    const spread = (arch / arches) * maxSpread;
    const steps = 14;
    for (let step = steps; step >= -steps; step--) {
      const along = (Math.abs(step) / steps) * reach;
      const px = tipX + along - arch * ARCH_SHIFT_PX;
      const py = centreY + Math.sign(step) * spread * Math.sqrt(Math.abs(step) / steps);
      if (step === steps) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
  }
  return path;
}

/** Paints one plank. Every mark is placed to stay inside it, because clipping to each plank is slow. */
function paintPlank(color, surface, random, { x, y, width, height, base, tileSize, wrap }) {
  const { hue, saturation, lightness } = base;
  const stroke = (path, style, lineWidth, surfaceAlpha) => {
    color.strokeStyle = style;
    color.lineWidth = lineWidth;
    color.stroke(path);
    surface.strokeStyle = `rgba(0, 225, 0, ${surfaceAlpha})`;
    surface.lineWidth = lineWidth;
    surface.stroke(path);
  };

  color.fillStyle = `hsl(${hue + (random() - 0.5) * 6} ${saturation + (random() - 0.5) * 8}% ${lightness * (0.86 + random() * 0.3)}%)`;
  color.fillRect(x, y, width, height);
  const grey = Math.round(150 + random() * 70);
  surface.fillStyle = `rgb(${grey} ${grey} ${grey})`;
  surface.fillRect(x, y, width, height);

  // Broad streaks of lighter and darker wood.
  const streaks = Math.max(4, Math.round(height / 22));
  for (let i = 0; i < streaks; i++) {
    const dark = random() > 0.45;
    const top = y + random() * height;
    color.fillStyle = dark
      ? `rgba(40, 20, 8, ${0.04 + random() * 0.1})`
      : `rgba(240, 200, 150, ${0.02 + random() * 0.05})`;
    color.fillRect(x, top, width, Math.min(4 + random() * (height / 5), y + height - top));
  }

  const lines = height / GRAIN_PIXELS_PER_LINE;
  for (const { style, lineWidth, surfaceAlpha, share } of GRAIN_STYLES) {
    const path = new Path2D();
    for (let i = 0; i < lines * share; i++) {
      const lineY = y + GRAIN_MAX_WAVE_PX + random() * (height - 2 * GRAIN_MAX_WAVE_PX);
      addGrainLine(path, random, x, width, lineY, tileSize);
    }
    stroke(path, style, lineWidth, surfaceAlpha);
  }

  // Some planks show arches. Painted twice on seamless wood, so arches running off one side come back on the other.
  const arches = wrap ? 5 : random() < 0.45 ? 1 : 0;
  const tipMargin = MAX_ARCHES * ARCH_SHIFT_PX;
  for (let i = 0; i < arches && width > 2 * tipMargin; i++) {
    const tipX = x + tipMargin + random() * (width * 0.4);
    const centreY = y + (0.4 + random() * 0.2) * height;
    const spread = wrap ? height * (0.04 + random() * 0.05) : height * (0.2 + random() * 0.15);
    const reach = wrap ? width * (0.4 + random() * 0.4) : x + width - tipX;
    for (const shift of wrap ? [0, -tileSize] : [0]) {
      stroke(cathedralLines(random, tipX + shift, centreY, reach, spread), 'rgba(30, 14, 5, 0.2)', 1.1, 0.12);
    }
  }

  // Pores: thousands of tiny dashes, which is what makes it read as wood up close.
  const pores = new Path2D();
  const dashes = Math.round((width * height) / PORE_PIXELS_PER_DASH);
  for (let i = 0; i < dashes; i++) {
    const px = x + random() * (width - PORE_MAX_LENGTH_PX);
    const py = y + random() * height;
    pores.moveTo(px, py);
    pores.lineTo(px + 5 + random() * (PORE_MAX_LENGTH_PX - 5), py);
  }
  stroke(pores, 'rgba(24, 11, 4, 0.2)', 1, 0.16);
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{hue: number, saturation: number, lightness: number}} base
 * @param {object} [options]
 * @param {number} [options.rows] planks per tile, or 0 for one seamless piece of wood
 * @param {number} [options.seed]
 * @returns {{map: THREE.Texture, surface: THREE.Texture}} planks run along the texture's X
 */
export function createWoodTextures(renderer, base, { rows = 12, seed = 7 } = {}) {
  const size = 1024;
  const colorCanvas = createCanvas(size, size);
  const surfaceCanvas = createCanvas(size, size);
  const color = colorCanvas.getContext('2d');
  const surface = surfaceCanvas.getContext('2d');
  const random = seededRandom(seed);

  if (rows === 0) {
    paintPlank(color, surface, random, { x: 0, y: 0, width: size, height: size, base, tileSize: size, wrap: true });
  } else {
    const rowHeight = size / rows;
    for (let row = 0; row < rows; row++) {
      const y = row * rowHeight;
      let x = 0;
      // Planks end exactly at the tile edge, so the seam reads as one more plank joint.
      while (x < size) {
        let length = size * (0.3 + random() * 0.45);
        if (size - (x + length) < size * 0.2) length = size - x;
        paintPlank(color, surface, random, { x, y, width: length, height: rowHeight, base, tileSize: size, wrap: false });

        // The joint is dark in the colour, and a groove in the surface.
        for (const ctx of [color, surface]) {
          ctx.fillStyle = ctx === color ? 'rgba(20, 10, 4, 0.8)' : 'rgb(20 235 20)';
          ctx.fillRect(x + length - 2, y, 2, rowHeight);
          ctx.fillRect(x, y, length, 2);
        }
        x += length;
      }
    }
  }

  return {
    map: tilingTexture(colorCanvas, renderer, THREE.SRGBColorSpace),
    surface: tilingTexture(surfaceCanvas, renderer, THREE.NoColorSpace),
  };
}

let walnut = null;

/** Seamless walnut, painted once and shared by the shelves and the room's woodwork. Tiled in metres by the mesh. */
export function walnutTextures(renderer) {
  walnut ??= createWoodTextures(renderer, WALNUT, { rows: 0, seed: 41 });
  return walnut;
}

/** The same images with a repeat and rotation of their own, for tiling them differently. */
export function withOwnTiling({ map, surface }) {
  const copy = (texture) => {
    const clone = texture.clone();
    clone.needsUpdate = true; // a clone starts out marked as never uploaded
    return clone;
  };
  return { map: copy(map), surface: copy(surface) };
}

/** A woven wall covering, as used on acoustic panels. */
export function createFabricTextures(renderer, { hue, saturation, lightness }, { seed = 11 } = {}) {
  const size = 512;
  const threadPx = 3;
  const colorCanvas = createCanvas(size, size);
  const surfaceCanvas = createCanvas(size, size);
  const color = colorCanvas.getContext('2d');
  const surface = surfaceCanvas.getContext('2d');
  const random = seededRandom(seed);

  color.fillStyle = `hsl(${hue} ${saturation}% ${lightness}%)`;
  color.fillRect(0, 0, size, size);
  surface.fillStyle = 'rgb(205 205 205)';
  surface.fillRect(0, 0, size, size);

  // Faint patches of uneven dye, repeated around the tile so they wrap across its edges.
  for (let i = 0; i < 14; i++) {
    const x = random() * size;
    const y = random() * size;
    const radius = 40 + random() * 90;
    const alpha = 0.012 + random() * 0.02;
    const tone = random() > 0.5 ? '255, 235, 205' : '0, 0, 0';
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        const patch = color.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, radius);
        patch.addColorStop(0, `rgba(${tone}, ${alpha})`);
        patch.addColorStop(1, `rgba(${tone}, 0)`);
        color.fillStyle = patch;
        color.fillRect(x + dx - radius, y + dy - radius, radius * 2, radius * 2);
      }
    }
  }

  // The weave. Threads are nearly identical: any more variety and whole rows
  // stand out from a distance as stripes, which together look like plaid.
  for (let thread = 0; thread < size; thread += threadPx) {
    const alpha = 0.05 + random() * 0.015;
    color.fillStyle = `rgba(0, 0, 0, ${alpha})`;
    color.fillRect(0, thread, size, 1);
    color.fillRect(thread, 0, 1, size);
    surface.fillStyle = `rgba(0, 225, 0, ${alpha * 2})`;
    surface.fillRect(0, thread, size, 1);
    surface.fillRect(thread, 0, 1, size);
  }

  return {
    map: tilingTexture(colorCanvas, renderer, THREE.SRGBColorSpace),
    surface: tilingTexture(surfaceCanvas, renderer, THREE.NoColorSpace),
  };
}
