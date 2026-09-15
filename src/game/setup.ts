/** Which corners are in play for each player count, and how seats are built. */

import { oppositeCorner } from './coords';
import type { CornerName, Seat } from './types';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/**
 * Corner assignment by player count.
 *
 *  2 — head to head, both destinations start empty.
 *  3 — every other corner, all destinations start empty.
 *  4 — two opposing pairs. Each player's destination is another player's
 *      starting corner; that is correct and standard, and it is why the
 *      anti-spoiling win rule matters here.
 *  5 — five corners, one left empty. Unbalanced, offered anyway.
 *  6 — all six corners.
 */
export const CORNERS_BY_PLAYER_COUNT: Readonly<Record<number, readonly CornerName[]>> = {
  2: ['N', 'S'],
  3: ['N', 'SE', 'SW'],
  4: ['NE', 'SE', 'SW', 'NW'],
  5: ['N', 'NE', 'SE', 'S', 'SW'],
  6: ['N', 'NE', 'SE', 'S', 'SW', 'NW'],
};

/** Player counts where every seat has a mirror-image opponent. */
export const BALANCED_COUNTS = [2, 3, 4, 6];

export function isBalanced(count: number): boolean {
  return BALANCED_COUNTS.includes(count);
}

/** Teams are only meaningful where the table splits evenly into two sides. */
export function supportsTeams(count: number): boolean {
  return count === 4 || count === 6;
}

/**
 * Team assignment.
 *  4 players — two teams of two, partners sitting opposite each other.
 *  6 players — two teams of three, each team holding alternating corners.
 */
function teamOf(count: number, corners: readonly CornerName[], seatIndex: number): number {
  if (count === 4) {
    const corner = corners[seatIndex];
    const partner = oppositeCorner(corner);
    const partnerIndex = corners.indexOf(partner);
    return Math.min(seatIndex, partnerIndex);
  }
  // 6 players: corners alternate around the star, so parity splits the table.
  return seatIndex % 2;
}

export interface SeatDraft {
  name: string;
  colorIndex: number;
}

export function defaultSeatDrafts(count: number): SeatDraft[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `Player ${i + 1}`,
    colorIndex: i,
  }));
}

export function createSeats(drafts: SeatDraft[], teams: boolean): Seat[] {
  const count = drafts.length;
  const corners = CORNERS_BY_PLAYER_COUNT[count];
  if (!corners) throw new Error(`unsupported player count: ${count}`);
  const useTeams = teams && supportsTeams(count);

  return drafts.map((draft, i) => ({
    id: i,
    name: draft.name.trim() || `Player ${i + 1}`,
    colorIndex: draft.colorIndex,
    corner: corners[i],
    dest: oppositeCorner(corners[i]),
    team: useTeams ? teamOf(count, corners, i) : i,
    kind: 'human' as const,
  }));
}
