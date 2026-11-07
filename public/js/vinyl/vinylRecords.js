/**
 * Every record in the room: a square album sleeve holding a vinyl disc, all drawn as
 * one InstancedMesh with a custom shader. The disc stays hidden until its record is
 * hovered, selected or playing, when it slides out of the sleeve.
 *
 * Performance design, aimed at libraries of thousands of songs:
 * - One draw call, with each sleeve's cover selected from a texture array.
 * - Hover, selection, spin and glow are uniforms compared against gl_InstanceID
 *   in the shader, so changing state uploads no per-instance data at all.
 * - Lighting is a cheap fixed golden approximation rather than the scene's lights.
 */

import * as THREE from 'three';
import { recordCenter, SHELF } from '../bookshelves/shelfGeometry.js';
import { ROOM_HEIGHT } from '../bookshelves/shelfLayout.js';
import { LayeredTexture, maxTextureLayers } from '../scene/layeredTexture.js';
import { AlbumArtLoader } from './albumArtLoader.js';

const ART_SIZE_PX = 128;
/** Very large libraries get smaller covers, so artwork memory stays bounded. */
const ART_SIZE_PX_CROWDED = 64;
const CROWDED_COVER_COUNT = 512;
const MAX_ART_LAYERS = 2048;
const SLEEVE_THICKNESS = 0.006;
const DISC_SEGMENTS = 32;
const SPIN_RADIANS_PER_SECOND = 0.7; // deliberately slower than a real 33⅓ rpm
const NO_INSTANCE = -1;

const PART_COVER = 0;
const PART_SLEEVE_EDGE = 1;
const PART_DISC = 2;

/**
 * One record, in units of the sleeve's half-width and thickness: a square sleeve
 * facing +Z with thin edges, and a disc of radius 1 tucked just behind its cover.
 * Nothing has a back, since it's never seen.
 */
function createRecordGeometry() {
  const positions = [];
  const normals = [];
  const parts = [];
  const indices = [];
  const addVertex = (x, y, z, nx, ny, nz, part) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    parts.push(part);
    return parts.length - 1;
  };

  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const cover = corners.map(([x, y]) => addVertex(x, y, 0, 0, 0, 1, PART_COVER));
  indices.push(cover[0], cover[1], cover[2], cover[0], cover[2], cover[3]);

  corners.forEach(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % corners.length];
    // Going counter-clockwise around the sleeve, outward is to the right of each edge.
    const nx = (by - ay) / 2;
    const ny = (ax - bx) / 2;
    const frontA = addVertex(ax, ay, 0, nx, ny, 0, PART_SLEEVE_EDGE);
    const backA = addVertex(ax, ay, -1, nx, ny, 0, PART_SLEEVE_EDGE);
    const backB = addVertex(bx, by, -1, nx, ny, 0, PART_SLEEVE_EDGE);
    const frontB = addVertex(bx, by, 0, nx, ny, 0, PART_SLEEVE_EDGE);
    indices.push(frontA, backA, backB, frontA, backB, frontB);
  });

  const discZ = -1.5;
  const hub = addVertex(0, 0, discZ, 0, 0, 1, PART_DISC);
  const rimStart = parts.length;
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const angle = (i / DISC_SEGMENTS) * Math.PI * 2;
    addVertex(Math.cos(angle), Math.sin(angle), discZ, 0, 0, 1, PART_DISC);
  }
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    indices.push(hub, rimStart + i, rimStart + ((i + 1) % DISC_SEGMENTS));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(parts, 1));
  geometry.setIndex(indices);
  return geometry;
}

const VERTEX_SHADER = /* glsl */ `
  uniform int uHoverId;
  uniform int uSelectedId;
  uniform int uPlayingId;
  uniform float uSpin;

  attribute float aLayer;
  attribute float aPart;

  varying vec2 vFace;    // position on the part, turning with it (for artwork)
  varying vec2 vFixed;   // position on the part, not turning (for reflections)
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vLayer;
  varying float vPart;
  varying vec3 vState;   // x: hovered, y: selected, z: playing

  const float DISC_SIZE = 0.95;     // keeps the disc's rim hidden behind the sleeve
  const float PEEK_SLIDE = 0.45;    // a hovered record's disc shows a little
  const float FULL_SLIDE = 1.15;    // a selected or playing record's disc is most of the way out
  const float LIFT = 0.28;          // sleeve widths toward the viewer, clearing its neighbours

  void main() {
    float hovered = gl_InstanceID == uHoverId ? 1.0 : 0.0;
    float selected = gl_InstanceID == uSelectedId ? 1.0 : 0.0;
    float playing = gl_InstanceID == uPlayingId ? 1.0 : 0.0;
    bool isDisc = aPart > 1.5;

    vec3 local = position;
    if (isDisc && playing > 0.5) {
      float c = cos(uSpin);
      float s = sin(uSpin);
      local.xy = mat2(c, -s, s, c) * local.xy;
    }

    vFace = position.xy;
    vFixed = local.xy;
    vLayer = aLayer;
    vPart = aPart;
    vState = vec3(hovered, selected, playing);

    float pulledOut = max(selected, playing);
    float slide = max(hovered * PEEK_SLIDE, pulledOut * FULL_SLIDE);
    if (isDisc) {
      // A disc still inside its sleeve can't be seen, so skip drawing it altogether.
      if (slide == 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      local.xy = local.xy * DISC_SIZE + vec2(slide, 0.0);
    }

    // A highlighted record grows slightly and comes out of the shelf toward the viewer.
    float lifted = max(hovered, pulledOut);
    local.xy *= 1.0 + 0.05 * lifted;
    vec3 outward = normalize(instanceMatrix[2].xyz);
    float sleeveSize = length(instanceMatrix[0].xyz);

    vec4 world = modelMatrix * instanceMatrix * vec4(local, 1.0);
    world.xyz += outward * sleeveSize * LIFT * lifted;

    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2DArray uArt;
  uniform float uGlow;
  uniform vec3 uLightPosition;

  varying vec2 vFace;
  varying vec2 vFixed;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vLayer;
  varying float vPart;
  varying vec3 vState;

  const float LABEL_RADIUS = 0.42;
  const vec3 GOLD = vec3(1.0, 0.66, 0.3);
  const vec3 CARD_EDGE = vec3(0.17, 0.13, 0.09);

  /** Album artwork across a square whose corners are at +-1. Pixels are stored top row first: flip V. */
  vec3 artAt(vec2 face) {
    vec2 uv = face * 0.5 + 0.5;
    return texture(uArt, vec3(uv.x, 1.0 - uv.y, vLayer)).rgb;
  }

  vec3 shadeCover(float light, vec3 normal) {
    // Corners and edges of old sleeves look a little worn and darker.
    float edge = max(abs(vFace.x), abs(vFace.y));
    // The strip under the shelf above lights the top of each sleeve more than the bottom.
    float stripLight = mix(0.88, 1.1, vFace.y * 0.5 + 0.5);
    vec3 color = artAt(vFace) * light * stripLight * (1.0 - 0.28 * smoothstep(0.9, 1.0, edge));

    // A faint gloss from the room's light, like laminated card.
    vec3 toViewer = normalize(cameraPosition - vWorld);
    vec3 halfway = normalize(normalize(uLightPosition - vWorld) + toViewer);
    color += GOLD * pow(max(dot(normal, halfway), 0.0), 48.0) * 0.1;
    return color;
  }

  vec3 shadeDisc(float light) {
    float radius = length(vFace);
    float pixel = fwidth(radius);

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

    // Album artwork fills the centre label.
    vec3 art = artAt(vFace / LABEL_RADIUS) * light;
    float labelMask = 1.0 - smoothstep(LABEL_RADIUS - pixel, LABEL_RADIUS + pixel, radius);
    vec3 color = mix(vinyl, art, labelMask);

    // Thin gold ring around the label, and the dark spindle hole.
    float ring = 1.0 - smoothstep(0.0, pixel * 1.5, abs(radius - LABEL_RADIUS) - 0.006);
    color = mix(color, GOLD * 0.65 * light, ring * 0.8);
    float hole = 1.0 - smoothstep(0.028 - pixel, 0.028 + pixel, radius);
    return mix(color, vec3(0.01), hole);
  }

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 toLight = normalize(uLightPosition - vWorld);
    float diffuse = max(dot(normal, toLight), 0.0);
    float light = 0.62 + 0.75 * diffuse;

    bool isDisc = vPart > 1.5;
    vec3 color = isDisc ? shadeDisc(light) : vPart > 0.5 ? CARD_EDGE * light : shadeCover(light, normal);

    // Highlights: a bright outer rim and a warm lift, strongest on hover.
    float rim = isDisc ? smoothstep(0.86, 1.0, length(vFace)) : smoothstep(0.92, 1.0, max(abs(vFace.x), abs(vFace.y)));
    float highlight = max(vState.x, vState.y * 0.6);
    color += GOLD * highlight * (0.04 + rim * 0.75);
    color *= 1.0 + 0.2 * highlight;

    // The playing record glows softly from its rim.
    float glow = vState.z * uGlow;
    color += GOLD * glow * (rim * 0.95 + 0.04);

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
    const geometry = createRecordGeometry();
    const layers = new Float32Array(totalRecords);
    geometry.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layers, 1));

    this.#uniforms = {
      uArt: { value: null },
      uHoverId: { value: NO_INSTANCE },
      uSelectedId: { value: NO_INSTANCE },
      uPlayingId: { value: NO_INSTANCE },
      uSpin: { value: 0 },
      uGlow: { value: 0 },
      uLightPosition: { value: new THREE.Vector3(0, ROOM_HEIGHT - 0.3, 0) },
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
    const size = new THREE.Vector3(SHELF.sleeveHalf, SHELF.sleeveHalf, SLEEVE_THICKNESS);
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

    const artSize = layerByUrl.size > CROWDED_COVER_COUNT ? ART_SIZE_PX_CROWDED : ART_SIZE_PX;
    this.#layered = new LayeredTexture(renderer, {
      width: artSize,
      height: artSize,
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
