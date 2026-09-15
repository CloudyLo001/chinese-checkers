/** Game state: turn order, applying moves, undo, and save/restore. */

import { CORNER_HOLES, HOLE_COUNT } from './board';
import { hasAnyLegalMove, seatHasWon, type Position } from './rules';
import { DEFAULT_RULES, type Move, type RuleSettings, type Seat } from './types';

export interface Snapshot {
  occ: number[];
  turnIndex: number;
  finished: number[];
  moveCounts: number[];
}

export interface GameState extends Position {
  occ: Int8Array;
  seats: Seat[];
  rules: RuleSettings;
  /** Index into `seats` of the player to move. */
  turnIndex: number;
  /** Seat ids in the order they finished. */
  finished: number[];
  moveCounts: number[];
  history: Move[];
  /** One level of undo, as required by the UI. Survives a reload. */
  undoSnapshot: Snapshot | null;
  over: boolean;
  startedAt: number;
}

export interface MoveResult {
  /** Seat ids that completed their corner on this move. */
  newlyFinished: number[];
  /** Seat ids skipped because they had no legal move at all. */
  passed: number[];
  over: boolean;
}

export function createGame(seats: Seat[], rules: RuleSettings): GameState {
  const occ = new Int8Array(HOLE_COUNT).fill(-1);
  for (const seat of seats) {
    for (const hole of CORNER_HOLES[seat.corner]) {
      occ[hole] = seat.id;
    }
  }
  return {
    occ,
    seats,
    rules,
    turnIndex: 0,
    finished: [],
    moveCounts: seats.map(() => 0),
    history: [],
    undoSnapshot: null,
    over: false,
    startedAt: Date.now(),
  };
}

export function currentSeat(state: GameState): Seat {
  return state.seats[state.turnIndex];
}

function snapshot(state: GameState): Snapshot {
  return {
    occ: Array.from(state.occ),
    turnIndex: state.turnIndex,
    finished: [...state.finished],
    moveCounts: [...state.moveCounts],
  };
}

function teamIsFinished(state: GameState, team: number): boolean {
  return state.seats
    .filter((seat) => seat.team === team)
    .every((seat) => state.finished.includes(seat.id));
}

function isOver(state: GameState): boolean {
  if (state.finished.length === 0) return false;
  if (state.rules.endOnFirstWinner) return true;
  if (state.rules.teams) {
    const teams = new Set(state.seats.map((seat) => seat.team));
    if (teams.size < state.seats.length) {
      for (const team of teams) {
        if (teamIsFinished(state, team)) return true;
      }
    }
  }
  // Once only one player is left unfinished their placing is decided.
  return state.finished.length >= state.seats.length - 1;
}

/**
 * Applies an already-validated move. Callers get their move options from
 * `legalMovesFrom`, so this does not re-validate; it only maintains state.
 */
export function applyMove(state: GameState, move: Move): MoveResult {
  state.undoSnapshot = snapshot(state);

  state.occ[move.from] = -1;
  state.occ[move.to] = move.seatId;
  state.moveCounts[move.seatId]++;
  state.history.push(move);

  // Any seat can newly finish here: the mover by arriving home, or another
  // player whose corner just became full under the anti-spoiling rule.
  const newlyFinished: number[] = [];
  for (const seat of state.seats) {
    if (state.finished.includes(seat.id)) continue;
    if (seatHasWon(state, seat)) {
      state.finished.push(seat.id);
      newlyFinished.push(seat.id);
    }
  }

  state.over = isOver(state);

  const passed: number[] = [];
  if (!state.over) advanceTurn(state, passed);

  return { newlyFinished, passed, over: state.over };
}

function advanceTurn(state: GameState, passed: number[]): void {
  const count = state.seats.length;
  for (let step = 1; step <= count; step++) {
    const index = (state.turnIndex + step) % count;
    const seat = state.seats[index];
    if (state.finished.includes(seat.id)) continue;
    if (!hasAnyLegalMove(state, seat.id)) {
      passed.push(seat.id);
      continue;
    }
    state.turnIndex = index;
    return;
  }
  // Nobody left who can move — the game cannot continue.
  state.over = true;
}

export function canUndo(state: GameState): boolean {
  return state.undoSnapshot !== null;
}

/** Rolls back the last completed turn (the whole hop chain, not one hop). */
export function undoLastMove(state: GameState): boolean {
  const snap = state.undoSnapshot;
  if (!snap) return false;
  state.occ = Int8Array.from(snap.occ);
  state.turnIndex = snap.turnIndex;
  state.finished = [...snap.finished];
  state.moveCounts = [...snap.moveCounts];
  state.history.pop();
  state.undoSnapshot = null;
  state.over = false;
  return true;
}

/** Final standings: finishers in order, then everyone else by marbles home. */
export function placings(state: GameState): Seat[] {
  const byId = new Map(state.seats.map((seat) => [seat.id, seat]));
  const ranked: Seat[] = [];
  for (const id of state.finished) {
    const seat = byId.get(id);
    if (seat) ranked.push(seat);
  }
  const rest = state.seats.filter((seat) => !state.finished.includes(seat.id));
  rest.sort((a, b) => countHome(state, b) - countHome(state, a));
  return [...ranked, ...rest];
}

function countHome(state: GameState, seat: Seat): number {
  let home = 0;
  for (const hole of CORNER_HOLES[seat.dest]) {
    if (state.occ[hole] === seat.id) home++;
  }
  return home;
}

// --- persistence -----------------------------------------------------------

const SAVE_VERSION = 1;

export interface SavedGame {
  version: number;
  seats: Seat[];
  rules: RuleSettings;
  occ: number[];
  turnIndex: number;
  finished: number[];
  moveCounts: number[];
  history: Move[];
  undoSnapshot: Snapshot | null;
  over: boolean;
  startedAt: number;
}

export function serialize(state: GameState): SavedGame {
  return {
    version: SAVE_VERSION,
    seats: state.seats,
    rules: state.rules,
    occ: Array.from(state.occ),
    turnIndex: state.turnIndex,
    finished: state.finished,
    moveCounts: state.moveCounts,
    history: state.history,
    undoSnapshot: state.undoSnapshot,
    over: state.over,
    startedAt: state.startedAt,
  };
}

export function deserialize(saved: SavedGame): GameState | null {
  if (!saved || saved.version !== SAVE_VERSION) return null;
  if (!Array.isArray(saved.occ) || saved.occ.length !== HOLE_COUNT) return null;
  if (!Array.isArray(saved.seats) || saved.seats.length < 2) return null;
  return {
    occ: Int8Array.from(saved.occ),
    seats: saved.seats,
    // Merged so a game saved before a rule was introduced still loads.
    rules: { ...DEFAULT_RULES, ...saved.rules },
    turnIndex: saved.turnIndex,
    finished: saved.finished ?? [],
    moveCounts: saved.moveCounts ?? saved.seats.map(() => 0),
    history: saved.history ?? [],
    undoSnapshot: saved.undoSnapshot ?? null,
    over: saved.over ?? false,
    startedAt: saved.startedAt ?? Date.now(),
  };
}
