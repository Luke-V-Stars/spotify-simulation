/**
 * All vinyl records in the room, drawn as one InstancedMesh with a custom shader.
 *
 * Performance design, aimed at libraries of thousands of songs:
 * - One draw call, with each record's cover selected from a texture array.
 * - Hover, selection, spin and glow are uniforms compared against gl_InstanceID
 *   in the shader, so changing state uploads no per-instance data at all.
 * - Lighting is a cheap fixed golden approximation rather than the scene's lights.
 */

import * as THREE from 'three';
import { recordCenter, SHELF } from '../bookshelves/shelfGeometry.js';
import { LayeredTexture, maxTextureLayers } from '../scene/layeredTexture.js';
import { AlbumArtLoader } from './albumArtLoader.js';

const ART_SIZE_PX = 64; // matches Spotify's smallest album image
const MAX_ART_LAYERS = 2048;
const RECORD_THICKNESS = 0.004;
const DISC_SEGMENTS = 32;
const SPIN_RADIANS_PER_SECOND = 0.7; // deliberately slower than a real 33⅓ rpm
const NO_INSTANCE = -1;

/** A flat disc of radius 1 facing +Z, with a thin edge. No back: it's never seen. */
function createDiscGeometry() {
  const positions = [0, 0, 0];
  const normals = [0, 0, 1];
  const indices = [];

  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const angle = (i / DISC_SEGMENTS) * Math.PI * 2;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    positions.push(x, y, 0); // face rim: vertex 1 + i
    normals.push(0, 0, 1);
    positions.push(x, y, 0, x, y, -1); // edge, with its own outward normals
    normals.push(x, y, 0, x, y, 0);
  }

  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const current = 1 + i * 3;
    const next = 1 + ((i + 1) % DISC_SEGMENTS) * 3;
    indices.push(0, current, next);
    indices.push(current + 1, current + 2, next + 1, next + 1, current + 2, next + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

const VERTEX_SHADER = /* glsl */ `
  uniform int uHoverId;
  uniform int uSelectedId;
  uniform int uPlayingId;
  uniform float uSpin;

  attribute float aLayer;

  varying vec2 vDisc;    // position on the record, turning with it (for the artwork)
  varying vec2 vFixed;   // position on the record, not turning (for reflections)
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vLayer;
  varying vec3 vState;   // x: hovered, y: selected, z: playing

  void main() {
    float hovered = gl_InstanceID == uHoverId ? 1.0 : 0.0;
    float selected = gl_InstanceID == uSelectedId ? 1.0 : 0.0;
    float playing = gl_InstanceID == uPlayingId ? 1.0 : 0.0;

    vec3 local = position;
    vec3 localNormal = normal;
    if (playing > 0.5) {
      float c = cos(uSpin);
      float s = sin(uSpin);
      mat2 rotation = mat2(c, -s, s, c);
      local.xy = rotation * local.xy;
      localNormal.xy = rotation * localNormal.xy;
    }

    vDisc = position.xy;
    vFixed = local.xy;
    vLayer = aLayer;
    vState = vec3(hovered, selected, playing);

    // A highlighted record grows slightly and slides out of the shelf toward the viewer.
    float lifted = max(hovered, selected);
    local.xy *= 1.0 + 0.05 * lifted;
    vec3 outward = normalize(instanceMatrix[2].xyz);
    float recordSize = length(instanceMatrix[0].xyz);

    vec4 world = modelMatrix * instanceMatrix * vec4(local, 1.0);
    world.xyz += outward * recordSize * 0.28 * lifted;

    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * localNormal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2DArray uArt;
  uniform float uGlow;
  uniform vec3 uLightPosition;

  varying vec2 vDisc;
  varying vec2 vFixed;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vLayer;
  varying vec3 vState;

  // Larger than a real record's label, so the album cover is recognizable on the shelf.
  const float LABEL_RADIUS = 0.56;
  const vec3 GOLD = vec3(1.0, 0.66, 0.3);

  void main() {
    float radius = length(vDisc);
    float pixel = fwidth(radius);

    vec3 normal = normalize(vNormal);
    vec3 toLight = normalize(uLightPosition - vWorld);
    float diffuse = max(dot(normal, toLight), 0.0);
    float light = 0.5 + 0.75 * diffuse;

    // Vinyl: fine grooves, faded out before they get small enough to shimmer.
    float groove = 0.5 + 0.5 * sin(radius * 260.0);
    float grooveVisibility = 1.0 - smoothstep(0.004, 0.02, pixel);
    float trackBand = 1.0 - smoothstep(0.0, 0.015, abs(fract(radius * 7.0) - 0.5) - 0.47);
    vec3 vinyl = vec3(0.012, 0.011, 0.012) + vec3(0.016) * groove * grooveVisibility - vec3(0.004) * trackBand;

    // The record's signature sheen: two opposed fans of light that stay still as it turns.
    float angle = atan(vFixed.y, vFixed.x);
    float fan = pow(abs(cos(angle - 0.9)), 42.0);
    vinyl += GOLD * fan * 0.2;
    vinyl *= light;

    // Album artwork fills the centre label. Pixels are stored top row first: flip V.
    vec2 artUv = vDisc / LABEL_RADIUS * 0.5 + 0.5;
    vec3 art = texture(uArt, vec3(artUv.x, 1.0 - artUv.y, vLayer)).rgb * light;

    float labelMask = 1.0 - smoothstep(LABEL_RADIUS - pixel, LABEL_RADIUS + pixel, radius);
    vec3 color = mix(vinyl, art, labelMask);

    // Thin gold ring around the label, and the dark spindle hole.
    float ring = 1.0 - smoothstep(0.0, pixel * 1.5, abs(radius - LABEL_RADIUS) - 0.006);
    color = mix(color, GOLD * 0.65 * light, ring * 0.8);
    float hole = 1.0 - smoothstep(0.028 - pixel, 0.028 + pixel, radius);
    color = mix(color, vec3(0.01), hole);

    // Highlights: a bright outer rim and a warm lift, strongest on hover.
    float rim = smoothstep(0.86, 1.0, radius);
    float highlight = max(vState.x, vState.y * 0.6);
    color += GOLD * highlight * (0.06 + rim * 0.75);
    color *= 1.0 + 0.2 * highlight;

    // The playing record glows softly from its rim, with a gentle lift on the label.
    float glow = vState.z * uGlow;
    color += GOLD * glow * (rim * 0.95 + 0.05);
    color *= 1.0 + 0.16 * glow * labelMask;

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class VinylRecords {
  /** @type {Array<{instanceId: number, track: object, shelf: object}>} */
  records = [];
  /** First instance id of each shelf, so a picked slot converts to a record. */
  #firstInstanceByShelf = new Map();
  #instancesByUri = new Map();
  #mesh;
  #uniforms;
  #artLoader;
  #layered;

  #playingId = NO_INSTANCE;
  #paused = true;
  #glowTarget = 0;

  /**
   * Builds the records and starts streaming their artwork.
   * @param {ReturnType<import('../bookshelves/bookshelfGenerator.js').buildBookshelves>} shelves
   */
  constructor(scene, renderer, shelves) {
    const layerByUrl = new Map();
    const layerLimit = Math.min(MAX_ART_LAYERS, maxTextureLayers(renderer));

    /** Layer 0 is the shared placeholder, also used if covers exceed the GPU limit. */
    const layerForTrack = (track) => {
      const url = track.artThumbUrl;
      if (!url) return 0;
      let layer = layerByUrl.get(url);
      if (layer === undefined) {
        layer = layerByUrl.size + 1;
        if (layer >= layerLimit) return 0;
        layerByUrl.set(url, layer);
      }
      return layer;
    };

    const totalRecords = shelves.reduce((sum, shelf) => sum + shelf.recordCount, 0);
    const geometry = createDiscGeometry();
    const layers = new Float32Array(totalRecords);
    geometry.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layers, 1));

    this.#uniforms = {
      uArt: { value: null },
      uHoverId: { value: NO_INSTANCE },
      uSelectedId: { value: NO_INSTANCE },
      uPlayingId: { value: NO_INSTANCE },
      uSpin: { value: 0 },
      uGlow: { value: 0 },
      uLightPosition: { value: new THREE.Vector3(0, 4.4, 0) },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.#uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

    this.#mesh = new THREE.InstancedMesh(geometry, material, totalRecords);
    this.#mesh.frustumCulled = false;

    // Each record: shelf placement, then position on the shelf, lean, and size.
    const lean = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -SHELF.recordLean);
    const size = new THREE.Vector3(SHELF.recordRadius, SHELF.recordRadius, RECORD_THICKNESS);
    const local = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    const position = new THREE.Vector3();

    let instanceId = 0;
    for (const shelf of shelves) {
      this.#firstInstanceByShelf.set(shelf, instanceId);
      shelf.tracks.forEach((track, slotIndex) => {
        const center = recordCenter(slotIndex);
        local.compose(position.set(center.x, center.y, center.z), lean, size);
        world.multiplyMatrices(shelf.matrix, local);
        this.#mesh.setMatrixAt(instanceId, world);
        layers[instanceId] = layerForTrack(track);

        this.records.push({ instanceId, track, shelf });
        const sameSong = this.#instancesByUri.get(track.uri);
        if (sameSong) sameSong.push(instanceId);
        else this.#instancesByUri.set(track.uri, [instanceId]);
        instanceId++;
      });
    }

    this.#layered = new LayeredTexture(renderer, {
      width: ART_SIZE_PX,
      height: ART_SIZE_PX,
      layers: layerByUrl.size + 1,
      fill: [150, 112, 66, 255],
    });
    this.#uniforms.uArt.value = this.#layered.texture;
    this.#artLoader = new AlbumArtLoader(this.#layered, layerByUrl);

    scene.add(this.#mesh);
  }

  recordAt(shelf, slotIndex) {
    return this.records[this.#firstInstanceByShelf.get(shelf) + slotIndex];
  }

  setHover(instanceId = NO_INSTANCE) {
    this.#uniforms.uHoverId.value = instanceId;
  }

  setSelected(instanceId = NO_INSTANCE) {
    this.#uniforms.uSelectedId.value = instanceId;
  }

  /** @param {number} instanceId the record to spin and glow, or NO_INSTANCE for none */
  setPlaying(instanceId = NO_INSTANCE, paused = false) {
    if (instanceId !== this.#playingId) this.#uniforms.uSpin.value = 0;
    this.#playingId = instanceId;
    this.#uniforms.uPlayingId.value = instanceId;
    this.#paused = paused;
    // A paused record stops turning but stays dimly lit, so it can still be found.
    this.#glowTarget = instanceId === NO_INSTANCE ? 0 : paused ? 0.45 : 1;
  }

  get playingRecord() {
    return this.#playingId === NO_INSTANCE ? null : this.records[this.#playingId];
  }

  get glowLevel() {
    return this.#uniforms.uGlow.value;
  }

  /**
   * Finds which record a playback state refers to. A song can be on several shelves,
   * so prefer the playlist it's actually playing from.
   * @returns {number} instance id, or NO_INSTANCE if the song isn't in the room
   */
  findInstance(uris, contextUri) {
    const candidates = uris.flatMap((uri) => this.#instancesByUri.get(uri) ?? []);
    if (candidates.length === 0) return NO_INSTANCE;
    const inContext = candidates.find((id) => this.records[id].shelf.playlist.uri === contextUri);
    return inContext ?? candidates[0];
  }

  /** World-space pose of a record, for placing its glow. */
  recordPose(instanceId, position, quaternion, scale) {
    const matrix = new THREE.Matrix4();
    this.#mesh.getMatrixAt(instanceId, matrix);
    matrix.decompose(position, quaternion, scale);
  }

  /** @returns {boolean} true while something changed and a redraw is needed */
  update(deltaSeconds) {
    const artArrived = this.#artLoader.update(deltaSeconds);

    const glow = this.#uniforms.uGlow;
    const glowChanging = Math.abs(glow.value - this.#glowTarget) > 0.002;
    if (glowChanging) {
      glow.value += (this.#glowTarget - glow.value) * Math.min(1, deltaSeconds * 4);
    }

    const spinning = this.#playingId !== NO_INSTANCE && !this.#paused;
    if (spinning) this.#uniforms.uSpin.value += deltaSeconds * SPIN_RADIANS_PER_SECOND;

    return artArrived || glowChanging || spinning;
  }
}
