/**
 * Builds one mesh out of many boxes with softened edges, for woodwork. Each box has its
 * real size, unlike a scaled unit cube, so wood grain keeps its proportions on every part.
 *
 * A box has 24 vertices, four for each face. The strips and corners joining the faces
 * reuse those vertices, so their normals blend from one face to the next, and a flat
 * chamfer of only 44 triangles catches the light like a rounded edge.
 */

import * as THREE from 'three';

const SIGNS = [-1, 1];
const VERTICES_PER_BOX = 24;

/** The vertex on the face across `axis` that sits nearest the box corner in direction `signs`. */
const vertexOf = (axis, signs) => axis * 8 + (signs[0] > 0 ? 4 : 0) + (signs[1] > 0 ? 2 : 0) + (signs[2] > 0 ? 1 : 0);

const otherAxes = (axis) => [0, 1, 2].filter((candidate) => candidate !== axis);

/** Signs for a corner, given the sign along each of three named axes. */
function cornerSigns(axisA, signA, axisB, signB, axisC, signC) {
  const signs = [0, 0, 0];
  signs[axisA] = signA;
  signs[axisB] = signB;
  signs[axisC] = signC;
  return signs;
}

export class BoxBatch {
  #positions = [];
  #normals = [];
  #uvs = [];
  #shades = [];
  #indices = [];

  /**
   * @param {number[]} box [centre x, y, z, size x, y, z]
   * @param {object} [options]
   * @param {number} [options.chamfer] how much of each edge is cut away, in metres
   * @param {number} [options.tile] metres covered by one repeat of the texture
   * @param {number[]} [options.grainOffset] shifts the texture, so parts don't share the same grain
   * @param {(position: number[], normal: number[]) => number} [options.shade] brightness at a vertex, 0 to 1
   */
  add([cx, cy, cz, sx, sy, sz], { chamfer = 0, tile = 1, grainOffset = [0, 0], shade = () => 1 } = {}) {
    const center = [cx, cy, cz];
    const half = [sx / 2, sy / 2, sz / 2];
    const cut = Math.min(chamfer, ...half);

    // Grain runs along the longest side that lies flat on each face.
    const bySize = [0, 1, 2].sort((a, b) => half[b] - half[a]);
    const base = this.#positions.length / 3;

    for (let axis = 0; axis < 3; axis++) {
      const along = bySize.find((candidate) => candidate !== axis);
      const across = bySize.find((candidate) => candidate !== axis && candidate !== along);
      for (const x of SIGNS) {
        for (const y of SIGNS) {
          for (const z of SIGNS) {
            const signs = [x, y, z];
            const position = center.map((c, i) => c + signs[i] * (i === axis ? half[i] : half[i] - cut));
            const normal = [0, 0, 0];
            normal[axis] = signs[axis];
            this.#positions.push(...position);
            this.#normals.push(...normal);
            this.#uvs.push(position[along] / tile + grainOffset[0], position[across] / tile + grainOffset[1]);
            this.#shades.push(shade(position, normal));
          }
        }
      }
    }

    const vertices = this.#positions.slice(base * 3, (base + VERTICES_PER_BOX) * 3);
    const triangle = (a, b, c) => this.#addOutwardTriangle(vertices, center, base, a, b, c);
    const quad = (a, b, c, d) => {
      triangle(a, b, c);
      triangle(a, c, d);
    };

    for (let axis = 0; axis < 3; axis++) {
      const [b, d] = otherAxes(axis);
      for (const sign of SIGNS) {
        quad(
          vertexOf(axis, cornerSigns(axis, sign, b, -1, d, -1)),
          vertexOf(axis, cornerSigns(axis, sign, b, 1, d, -1)),
          vertexOf(axis, cornerSigns(axis, sign, b, 1, d, 1)),
          vertexOf(axis, cornerSigns(axis, sign, b, -1, d, 1)),
        );
      }
    }
    if (cut === 0) return;

    // A strip along each of the 12 edges, then a small triangle at each of the 8 corners.
    for (let edgeAxis = 0; edgeAxis < 3; edgeAxis++) {
      const [a, b] = otherAxes(edgeAxis);
      for (const signA of SIGNS) {
        for (const signB of SIGNS) {
          quad(
            vertexOf(a, cornerSigns(a, signA, b, signB, edgeAxis, -1)),
            vertexOf(a, cornerSigns(a, signA, b, signB, edgeAxis, 1)),
            vertexOf(b, cornerSigns(a, signA, b, signB, edgeAxis, 1)),
            vertexOf(b, cornerSigns(a, signA, b, signB, edgeAxis, -1)),
          );
        }
      }
    }
    for (const x of SIGNS) {
      for (const y of SIGNS) {
        for (const z of SIGNS) {
          const signs = [x, y, z];
          triangle(vertexOf(0, signs), vertexOf(1, signs), vertexOf(2, signs));
        }
      }
    }
  }

  /** Winds a triangle so it faces away from the box's centre, which works because a box is convex. */
  #addOutwardTriangle(vertices, center, base, a, b, c) {
    const point = (index, axis) => vertices[index * 3 + axis];
    const edge1 = [0, 1, 2].map((axis) => point(b, axis) - point(a, axis));
    const edge2 = [0, 1, 2].map((axis) => point(c, axis) - point(a, axis));
    const cross = [
      edge1[1] * edge2[2] - edge1[2] * edge2[1],
      edge1[2] * edge2[0] - edge1[0] * edge2[2],
      edge1[0] * edge2[1] - edge1[1] * edge2[0],
    ];
    const outward = [0, 1, 2].reduce(
      (sum, axis) => sum + cross[axis] * ((point(a, axis) + point(b, axis) + point(c, axis)) / 3 - center[axis]),
      0,
    );
    if (outward >= 0) this.#indices.push(base + a, base + b, base + c);
    else this.#indices.push(base + a, base + c, base + b);
  }

  /** @returns {{positions: number[], normals: number[], uvs: number[], shades: number[], indices: number[]}} */
  get data() {
    return {
      positions: this.#positions,
      normals: this.#normals,
      uvs: this.#uvs,
      shades: this.#shades,
      indices: this.#indices,
    };
  }

  /** The finished mesh data. Use it with a material that has `vertexColors: true`. */
  toGeometry() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.#positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.#normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.#uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.#shades.flatMap((s) => [s, s, s]), 3));
    geometry.setIndex(this.#indices);
    return geometry;
  }
}
