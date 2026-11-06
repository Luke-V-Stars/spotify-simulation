/**
 * The soft light around the playing record: an additive halo plus one small point
 * light that warms the surrounding shelf. Both always exist, at zero strength when
 * idle, because changing the scene's light count would force shaders to recompile.
 */

import * as THREE from 'three';

const HALO_SIZE = 3.4; // in record radii
const HALO_OPACITY = 0.32;
const LIGHT_INTENSITY = 0.5;

function createHaloTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 190, 110, 1)');
  gradient.addColorStop(0.55, 'rgba(255, 170, 80, 0.55)');
  gradient.addColorStop(1, 'rgba(255, 150, 60, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class PlayingGlow {
  #halo;
  #light;
  #vinyl;
  #placedFor = null;

  /** @param {import('./vinylRecords.js').VinylRecords} vinyl */
  constructor(scene, vinyl) {
    this.#vinyl = vinyl;
    this.#halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: createHaloTexture(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.#halo.visible = false;
    this.#light = new THREE.PointLight(0xffb066, 0, 1.2, 2);
    scene.add(this.#halo, this.#light);
  }

  /** Follows the playing record and matches its brightness. Call each frame. */
  update() {
    const record = this.#vinyl.playingRecord;
    const level = this.#vinyl.glowLevel;

    if (record && record !== this.#placedFor) {
      this.#placeAt(record);
      this.#placedFor = record;
    }

    this.#halo.visible = level > 0.002;
    this.#halo.material.opacity = HALO_OPACITY * level;
    this.#light.intensity = LIGHT_INTENSITY * level * (this.#placedFor?.shelf.scale ?? 1);
  }

  #placeAt(record) {
    const scale = new THREE.Vector3();
    this.#vinyl.recordPose(record.instanceId, this.#halo.position, this.#halo.quaternion, scale);
    const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.#halo.quaternion);
    this.#light.position.copy(this.#halo.position).addScaledVector(outward, scale.x * 2.4);
    this.#halo.position.addScaledVector(outward, scale.x * 0.12);
    this.#halo.scale.setScalar(scale.x * HALO_SIZE);
  }
}
