/**
 * Move generation and win detection.
 *
 * A turn is exactly one of:
 *   - a STEP to an adjacent empty hole, or
 *   - a HOP CHAIN: jump over an occupied hole (any colour) into the empty hole
 *     an equal distance beyond, repeatable, stoppable after any hop.
 *
 * In `classic` mode the jumped marble must be adjacent. In `super` mode it may
 * be any distance away — the classic hop is just the shortest case of that, so
 * both modes run through one generator with a different search limit.
 *
 * Nothing is ever captured. A step and a hop are never mixed in one turn.
 */

import { CORNER_HOLES, CORNER_SIZE, HOLES, NEIGHBORS } from './board';
import type { MoveOption, RuleSettings, Seat } from './types';

/** The minimum a rules query needs: who is where, who is who, which variants are on. */
export interface Position {
  /** 121 entries: seat id, or -1 for an empty hole. */
  occ: Int8Array;
  seats: readonly Seat[];
  rules: RuleSettings;
}

/**
 * Where a marble on `from` lands if it jumps along `direction`, or -1 if it
 * cannot jump that way.
 *
 * Walks outward for the first occupied hole — the pivot — giving up after
 * `reach` steps, then requires an equal, entirely empty run beyond it. With
 * `reach` of 1 that is exactly the classic adjacent hop; with no limit it is
 * the Super Chinese Checkers long jump, where the jumped marble must sit at the
 * precise midpoint of the move.
 */
function jumpLanding(occ: Int8Array, from: number, direction: number, reach: number): number {
  let distance = 0;
  let cursor = from;
  for (let step = 1; step <= reach; step++) {
    cursor = NEIGHBORS[cursor * 6 + direction];
    if (cursor < 0) return -1; // ran off the board without finding a marble
    if (occ[cursor] >= 0) {
      distance = step;
      break;
    }
  }
  if (distance === 0) return -1; // nothing to jump within reach

  let landing = cursor;
  for (let step = 0; step < distance; step++) {
    landing = NEIGHBORS[landing * 6 + direction];
    if (landing < 0 || occ[landing] >= 0) return -1; // no clear run beyond
  }
  return landing;
}

/** May this seat's marble end its turn on `to`, having started from `from`? */
function canRestOn(pos: Position, seat: Seat, from: number, to: number): boolean {
  const toCorner = HOLES[to].corner;

  if (pos.rules.noRestingInOtherCorners) {
    if (toCorner !== null && toCorner !== seat.corner && toCorner !== seat.dest) return false;
  }

  if (pos.rules.noLeavingHome) {
    const fromCorner = HOLES[from].corner;
    if (fromCorner === seat.dest && toCorner !== seat.dest) return false;
  }

  return true;
}

/**
 * Every legal move for the marble on `from`.
 * Returns [] when the hole is empty or holds someone else's marble.
 */
export function legalMovesFrom(pos: Position, from: number): MoveOption[] {
  const seatId = pos.occ[from];
  if (seatId < 0) return [];
  const seat = pos.seats[seatId];
  if (!seat) return [];

  const options: MoveOption[] = [];

  // Single steps.
  for (let d = 0; d < 6; d++) {
    const next = NEIGHBORS[from * 6 + d];
    if (next < 0 || pos.occ[next] >= 0) continue;
    if (!canRestOn(pos, seat, from, next)) continue;
    options.push({ to: next, kind: 'step', path: [from, next] });
  }

  // Hop chains. The marble is lifted first, so its own origin counts as empty.
  const occ = pos.occ;
  const reach = pos.rules.mode === 'super' ? Number.POSITIVE_INFINITY : 1;
  occ[from] = -1;
  try {
    const parent = new Map<number, number>();
    const visited = new Set<number>([from]);
    const queue: number[] = [from];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (let d = 0; d < 6; d++) {
        const landing = jumpLanding(occ, current, d, reach);
        if (landing < 0) continue; // nothing to jump, or no room to land
        if (visited.has(landing)) continue; // never revisit a hole this turn
        visited.add(landing);
        parent.set(landing, current);
        queue.push(landing);
        if (canRestOn(pos, seat, from, landing)) {
          options.push({ to: landing, kind: 'hop', path: pathTo(parent, from, landing) });
        }
      }
    }
  } finally {
    occ[from] = seatId;
  }

  options.sort((a, b) => a.to - b.to);
  return options;
}

function pathTo(parent: Map<number, number>, from: number, to: number): number[] {
  const path = [to];
  let cursor = to;
  while (cursor !== from) {
    const previous = parent.get(cursor);
    if (previous === undefined) break;
    path.push(previous);
    cursor = previous;
  }
  return path.reverse();
}

/** Every legal move for a seat, keyed by the hole the marble starts on. */
export function legalMovesForSeat(pos: Position, seatId: number): Map<number, MoveOption[]> {
  const byOrigin = new Map<number, MoveOption[]>();
  for (let hole = 0; hole < pos.occ.length; hole++) {
    if (pos.occ[hole] !== seatId) continue;
    const moves = legalMovesFrom(pos, hole);
    if (moves.length > 0) byOrigin.set(hole, moves);
  }
  return byOrigin;
}

export function hasAnyLegalMove(pos: Position, seatId: number): boolean {
  for (let hole = 0; hole < pos.occ.length; hole++) {
    if (pos.occ[hole] !== seatId) continue;
    if (legalMovesFrom(pos, hole).length > 0) return true;
  }
  return false;
}

/** How many of a seat's marbles are home. Drives the "4 / 10" HUD counter. */
export function marblesHome(pos: Position, seat: Seat): number {
  let own = 0;
  for (const hole of CORNER_HOLES[seat.dest]) {
    if (pos.occ[hole] === seat.id) own++;
  }
  return own;
}

/**
 * Win test.
 *
 * Primary: all 10 marbles in the destination corner.
 *
 * Anti-spoiling (optional, on by default): the destination is full, you hold
 * at least one hole, and you hold more of it than everyone else combined. The
 * majority clause is what keeps this from firing at setup in 4- and 6-player
 * games, where your destination starts out as an opponent's fully-stacked home.
 */
export function seatHasWon(pos: Position, seat: Seat): boolean {
  let own = 0;
  let foreign = 0;
  for (const hole of CORNER_HOLES[seat.dest]) {
    const occupant = pos.occ[hole];
    if (occupant === seat.id) own++;
    else if (occupant >= 0) foreign++;
  }

  if (own === CORNER_SIZE) return true;
  if (!pos.rules.antiSpoilWin) return false;
  return own + foreign === CORNER_SIZE && own >= 1 && own > foreign;
}
