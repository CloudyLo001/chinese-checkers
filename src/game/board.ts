/**
 * The board itself: 121 holes, their neighbours, and the six 10-hole corners.
 *
 * Built once at module load and frozen. Everything downstream addresses holes
 * by their integer index (0..120), assigned in reading order (top row first,
 * left to right), which also makes the 17-row layout easy to eyeball in tests.
 */

import {
  axialToXZ,
  cornerOf,
  CORNERS,
  DIRECTIONS,
  isOnBoard,
  oppositeCorner,
  STAR_ARM,
} from './coords';
import type { CornerName } from './types';

export const HOLE_COUNT = 121;
export const CORNER_SIZE = 10;
export const MARBLES_PER_PLAYER = CORNER_SIZE;

export interface Hole {
  index: number;
  q: number;
  r: number;
  /** Board-local position in hole-spacing units. */
  x: number;
  z: number;
  corner: CornerName | null;
}

function buildHoles(): Hole[] {
  const holes: Hole[] = [];
  for (let r = -STAR_ARM; r <= STAR_ARM; r++) {
    for (let q = -STAR_ARM; q <= STAR_ARM; q++) {
      if (!isOnBoard(q, r)) continue;
      const { x, z } = axialToXZ(q, r);
      holes.push({ index: holes.length, q, r, x, z, corner: cornerOf(q, r) });
    }
  }
  return holes;
}

export const HOLES: readonly Hole[] = Object.freeze(buildHoles());

if (HOLES.length !== HOLE_COUNT) {
  throw new Error(`board is malformed: built ${HOLES.length} holes, expected ${HOLE_COUNT}`);
}

const INDEX_BY_KEY = new Map<number, number>();
for (const hole of HOLES) {
  INDEX_BY_KEY.set(key(hole.q, hole.r), hole.index);
}

function key(q: number, r: number): number {
  // q and r are both within [-8, 8]; pack into one integer.
  return (q + 16) * 64 + (r + 16);
}

/** Hole index at these coordinates, or -1 when off the board. */
export function holeAt(q: number, r: number): number {
  return INDEX_BY_KEY.get(key(q, r)) ?? -1;
}

/**
 * Flat 121 x 6 neighbour table. `NEIGHBORS[hole * 6 + dir]` is the adjacent
 * hole index in that direction, or -1 off the edge.
 */
export const NEIGHBORS: Int16Array = (() => {
  const table = new Int16Array(HOLE_COUNT * 6).fill(-1);
  for (const hole of HOLES) {
    for (let d = 0; d < 6; d++) {
      const dir = DIRECTIONS[d];
      table[hole.index * 6 + d] = holeAt(hole.q + dir.q, hole.r + dir.r);
    }
  }
  return table;
})();

/**
 * Flat 121 x 6 hop-landing table: the hole two steps away in each direction,
 * i.e. where a marble lands when it hops the neighbour in that direction.
 */
export const HOP_TARGETS: Int16Array = (() => {
  const table = new Int16Array(HOLE_COUNT * 6).fill(-1);
  for (const hole of HOLES) {
    for (let d = 0; d < 6; d++) {
      const dir = DIRECTIONS[d];
      table[hole.index * 6 + d] = holeAt(hole.q + dir.q * 2, hole.r + dir.r * 2);
    }
  }
  return table;
})();

export const CORNER_HOLES: Readonly<Record<CornerName, readonly number[]>> = (() => {
  const map = {} as Record<CornerName, number[]>;
  for (const corner of CORNERS) map[corner] = [];
  for (const hole of HOLES) {
    if (hole.corner) map[hole.corner].push(hole.index);
  }
  for (const corner of CORNERS) {
    if (map[corner].length !== CORNER_SIZE) {
      throw new Error(`corner ${corner} has ${map[corner].length} holes, expected ${CORNER_SIZE}`);
    }
  }
  return Object.freeze(map);
})();

/** Centre of mass of each corner, used to aim the camera / rotate the board. */
export const CORNER_CENTROID: Readonly<Record<CornerName, { x: number; z: number }>> = (() => {
  const map = {} as Record<CornerName, { x: number; z: number }>;
  for (const corner of CORNERS) {
    let x = 0;
    let z = 0;
    for (const index of CORNER_HOLES[corner]) {
      x += HOLES[index].x;
      z += HOLES[index].z;
    }
    map[corner] = { x: x / CORNER_SIZE, z: z / CORNER_SIZE };
  }
  return Object.freeze(map);
})();

/** Board rotation (radians about Y) that brings a corner to the near edge of the screen. */
export function cornerFacingRotation(corner: CornerName): number {
  const c = CORNER_CENTROID[corner];
  return -Math.atan2(c.x, c.z);
}

export { CORNERS, oppositeCorner };

/** Furthest hole from the centre, in hole-spacing units. Used to frame the camera. */
export const BOARD_RADIUS = HOLES.reduce(
  (max, hole) => Math.max(max, Math.hypot(hole.x, hole.z)),
  0,
);
