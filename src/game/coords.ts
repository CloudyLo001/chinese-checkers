/**
 * Hex coordinate math for the Chinese Checkers star.
 *
 * Holes live on a triangular lattice addressed with cube coordinates
 * (x, y, z) where x + y + z === 0. We store the axial pair (q, r) = (x, z)
 * and derive y = -q - r.
 *
 * The board is the union of two overlapping triangles (a Star of David):
 *   triangle A = { x >= -4, y >= -4, z >= -4 }   (91 holes)
 *   triangle B = { x <=  4, y <=  4, z <=  4 }   (91 holes)
 *   A ∩ B      = the central hexagon             (61 holes)
 *   A ∪ B      = 91 + 91 - 61                    = 121 holes
 *
 * A hole is in a corner triangle when exactly one cube coordinate leaves
 * [-4, 4]; each of the six possibilities is one 10-hole corner.
 */

import type { CornerName } from './types';

/** Radius of the central hexagon, in holes. */
export const HEX_RADIUS = 4;
/** Largest absolute cube coordinate on the board (the six star tips). */
export const STAR_ARM = 8;

const SQRT3 = Math.sqrt(3);

export interface Axial {
  q: number;
  r: number;
}

/**
 * The six move directions, in clockwise screen order starting east.
 * A hop is "this direction twice": over the neighbour, into the hole beyond.
 */
export const DIRECTIONS: readonly Axial[] = [
  { q: 1, r: 0 }, // E
  { q: 0, r: 1 }, // SE
  { q: -1, r: 1 }, // SW
  { q: -1, r: 0 }, // W
  { q: 0, r: -1 }, // NW
  { q: 1, r: -1 }, // NE
];

/** Corners in clockwise order. `CORNERS[(i + 3) % 6]` is always the opposite corner. */
export const CORNERS: readonly CornerName[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];

export function cubeY(q: number, r: number): number {
  return -q - r;
}

export function isOnBoard(q: number, r: number): boolean {
  const x = q;
  const z = r;
  const y = cubeY(q, r);
  const inTriangleA = x >= -HEX_RADIUS && y >= -HEX_RADIUS && z >= -HEX_RADIUS;
  const inTriangleB = x <= HEX_RADIUS && y <= HEX_RADIUS && z <= HEX_RADIUS;
  return inTriangleA || inTriangleB;
}

/** Which corner triangle a hole belongs to, or null for the central hexagon. */
export function cornerOf(q: number, r: number): CornerName | null {
  const x = q;
  const z = r;
  const y = cubeY(q, r);
  const limit = HEX_RADIUS + 1;
  if (z <= -limit) return 'N';
  if (x >= limit) return 'NE';
  if (y <= -limit) return 'SE';
  if (z >= limit) return 'S';
  if (x <= -limit) return 'SW';
  if (y >= limit) return 'NW';
  return null;
}

/** Negating every cube coordinate maps a corner onto the corner across the board. */
export function oppositeCorner(corner: CornerName): CornerName {
  const i = CORNERS.indexOf(corner);
  return CORNERS[(i + 3) % 6];
}

/**
 * Board-local position of a hole, in "hole spacing" units, on the XZ plane.
 * -Z is the top of the screen, so the N corner points away from the camera.
 */
export function axialToXZ(q: number, r: number): { x: number; z: number } {
  return { x: q + r / 2, z: (r * SQRT3) / 2 };
}
