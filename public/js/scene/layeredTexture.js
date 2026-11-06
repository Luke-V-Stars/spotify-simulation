/**
 * A WebGL2 texture array: many same-sized images in one GPU texture.
 *
 * Instanced meshes can pick an image per instance, so thousands of different album
 * covers still draw in a single call, and without the colour bleed of a texture
 * atlas. Layers are written on the CPU and uploaded in batches.
 */

import * as THREE from 'three';

export class LayeredTexture {
  #data;
  #byteLengthPerLayer;
  #hasPendingLayers = false;

  /** @param {{width: number, height: number, layers: number, fill: number[]}} options fill is sRGB RGBA */
  constructor(renderer, { width, height, layers, fill }) {
    this.width = width;
    this.height = height;
    this.#byteLengthPerLayer = width * height * 4;
    this.#data = new Uint8Array(this.#byteLengthPerLayer * layers);
    // Filling a whole pixel at a time is far faster than per-byte for large arrays.
    const pixel = new Uint8Array(fill);
    new Uint32Array(this.#data.buffer).fill(new Uint32Array(pixel.buffer)[0]);

    this.texture = new THREE.DataArrayTexture(this.#data, width, height, layers);
    this.texture.format = THREE.RGBAFormat;
    this.texture.type = THREE.UnsignedByteType;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    this.texture.needsUpdate = true;
    // Upload everything now: later partial updates only touch the layers they name.
    renderer.initTexture(this.texture);
  }

  /** Copies RGBA pixels (top row first, as canvas returns them) into a layer. */
  writeLayer(layer, pixels) {
    this.#data.set(pixels, layer * this.#byteLengthPerLayer);
    this.texture.addLayerUpdate(layer);
    this.#hasPendingLayers = true;
  }

  /** Queues written layers for upload on the next render. Returns true if there were any. */
  flush() {
    if (!this.#hasPendingLayers) return false;
    this.#hasPendingLayers = false;
    this.texture.needsUpdate = true;
    return true;
  }
}

/** Largest layer count this GPU supports for a texture array. */
export function maxTextureLayers(renderer) {
  const gl = renderer.getContext();
  return gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
}
