import { beforeEach, describe, expect, it } from 'vitest';
import { CORNER_HOLES, HOLE_COUNT, holeAt } from '../src/game/board';
import {
  hasAnyLegalMove,
  legalMovesFrom,
  legalMovesForSeat,
  marblesHome,
  seatHasWon,
  type Position,
} from '../src/game/rules';
import { applyMove, createGame, currentSeat, undoLastMove } from '../src/game/state';
import { createSeats, defaultSeatDrafts } from '../src/game/setup';
import { DEFAULT_RULES, type RuleSettings, type Seat } from '../src/game/types';

const at = (q: number, r: number) => {
  const index = holeAt(q, r);
  if (index < 0) throw new Error(`(${q},${r}) is not a hole`);
  return index;
};

function position(
  seats: Seat[],
  placements: Record<number, number[]>,
  rules: Partial<RuleSettings> = {},
): Position {
  const occ = new Int8Array(HOLE_COUNT).fill(-1);
  for (const [seatId, holes] of Object.entries(placements)) {
    for (const hole of holes) occ[hole] = Number(seatId);
  }
  return { occ, seats, rules: { ...DEFAULT_RULES, ...rules } };
}

describe('move generation', () => {
  let seats: Seat[];

  beforeEach(() => {
    seats = createSeats(defaultSeatDrafts(6), false);
  });

  it('offers a step to every adjacent empty hole', () => {
    const pos = position(seats, { 0: [at(0, 0)] });
    const moves = legalMovesFrom(pos, at(0, 0));
    expect(moves.length).toBe(6);
    expect(moves.every((move) => move.kind === 'step')).toBe(true);
    expect(moves.every((move) => move.path.length === 2)).toBe(true);
  });

  it('hops a single neighbour into the hole directly beyond', () => {
    const pos = position(seats, { 0: [at(0, 0)], 1: [at(1, 0)] });
    const moves = legalMovesFrom(pos, at(0, 0));
    const hop = moves.find((move) => move.to === at(2, 0));
    expect(hop).toBeDefined();
    expect(hop!.kind).toBe('hop');
    expect(hop!.path).toEqual([at(0, 0), at(2, 0)]);
    // The occupied neighbour is no longer a step target.
    expect(moves.some((move) => move.to === at(1, 0))).toBe(false);
    expect(moves.filter((move) => move.kind === 'step').length).toBe(5);
  });

  it('hops over opponents and its own colour alike', () => {
    const own = position(seats, { 0: [at(0, 0), at(1, 0)] });
    const other = position(seats, { 0: [at(0, 0)], 3: [at(1, 0)] });
    const target = at(2, 0);
    expect(legalMovesFrom(own, at(0, 0)).some((m) => m.to === target)).toBe(true);
    expect(legalMovesFrom(other, at(0, 0)).some((m) => m.to === target)).toBe(true);
  });

  it('does not land beyond two stacked marbles', () => {
    const pos = position(seats, { 0: [at(0, 0)], 1: [at(1, 0), at(2, 0)] });
    const moves = legalMovesFrom(pos, at(0, 0));
    expect(moves.some((move) => move.to === at(2, 0))).toBe(false);
    expect(moves.some((move) => move.to === at(3, 0))).toBe(false);
  });

  it('chains hops and lets the player stop after any one of them', () => {
    const pos = position(seats, { 0: [at(0, 0)], 1: [at(1, 0), at(3, 0)] });
    const moves = legalMovesFrom(pos, at(0, 0));
    const first = moves.find((move) => move.to === at(2, 0))!;
    const second = moves.find((move) => move.to === at(4, 0))!;
    expect(first.path).toEqual([at(0, 0), at(2, 0)]);
    expect(second.path).toEqual([at(0, 0), at(2, 0), at(4, 0)]);
  });

  it('never revisits a hole, so ring positions terminate', () => {
    // A closed ring of marbles around the centre: hops could otherwise loop.
    const ring = [at(1, 0), at(0, 1), at(-1, 1), at(-1, 0), at(0, -1), at(1, -1)];
    const pos = position(seats, { 0: [at(0, 0)], 1: ring });
    const moves = legalMovesFrom(pos, at(0, 0));
    const destinations = moves.map((move) => move.to);
    expect(new Set(destinations).size).toBe(destinations.length);
    expect(destinations).not.toContain(at(0, 0));
    for (const move of moves) {
      expect(new Set(move.path).size).toBe(move.path.length);
    }
  });

  it('treats the origin as empty while the marble is in the air', () => {
    const pos = position(seats, { 0: [at(0, 0)], 1: [at(1, 0), at(2, 0), at(3, 0)] });
    const before = Array.from(pos.occ);
    legalMovesFrom(pos, at(0, 0));
    expect(Array.from(pos.occ)).toEqual(before);
  });

  it('returns nothing for an empty hole', () => {
    const pos = position(seats, { 0: [at(0, 0)] });
    expect(legalMovesFrom(pos, at(2, 2))).toEqual([]);
  });
});

describe('super mode long jumps', () => {
  const seats = createSeats(defaultSeatDrafts(6), false);
  const superRules = { mode: 'super' as const };

  // The long row through the centre of the board runs (-4,0) .. (4,0).
  it('jumps a marble four holes away, landing four beyond it', () => {
    const placements = { 0: [at(-4, 0)], 1: [at(0, 0)] };
    const classic = position(seats, placements);
    const superGame = position(seats, placements, superRules);

    const jump = legalMovesFrom(superGame, at(-4, 0)).find((m) => m.to === at(4, 0));
    expect(jump).toBeDefined();
    expect(jump!.kind).toBe('hop');
    expect(jump!.path).toEqual([at(-4, 0), at(4, 0)]);
    // Classic mode only ever jumps the marble next door.
    expect(legalMovesFrom(classic, at(-4, 0)).some((m) => m.to === at(4, 0))).toBe(false);
    expect(legalMovesFrom(classic, at(-4, 0)).every((m) => m.kind === 'step')).toBe(true);
  });

  it('still jumps an adjacent marble, the shortest case of the same rule', () => {
    const placements = { 0: [at(0, 0)], 1: [at(1, 0)] };
    const classic = legalMovesFrom(position(seats, placements), at(0, 0));
    const superGame = legalMovesFrom(position(seats, placements, superRules), at(0, 0));
    expect(superGame.some((m) => m.to === at(2, 0) && m.kind === 'hop')).toBe(true);
    expect(superGame.map((m) => m.to).sort()).toEqual(classic.map((m) => m.to).sort());
  });

  it('needs the run up to the jumped marble to be empty', () => {
    // The marble at (-2,0) blocks the approach to the one at (0,0).
    const pos = position(seats, { 0: [at(-4, 0)], 1: [at(-2, 0), at(0, 0)] }, superRules);
    const moves = legalMovesFrom(pos, at(-4, 0));
    expect(moves.some((m) => m.to === at(4, 0))).toBe(false);
    // The nearer marble is jumped instead, landing an equal distance beyond it.
    expect(moves.some((m) => m.to === at(0, 0))).toBe(false); // occupied
    expect(moves.some((m) => m.path[1] === at(0, 0))).toBe(false);
  });

  it('needs the landing run beyond the jumped marble to be empty', () => {
    for (const blocker of [at(1, 0), at(2, 0), at(3, 0), at(4, 0)]) {
      const pos = position(seats, { 0: [at(-4, 0)], 1: [at(0, 0), blocker] }, superRules);
      expect(legalMovesFrom(pos, at(-4, 0)).some((m) => m.to === at(4, 0))).toBe(false);
    }
  });

  it('will not jump off the edge of the board', () => {
    // (0,0) is jumpable from (-1,0)... but the landing would be off the board.
    const pos = position(seats, { 0: [at(-4, 0)], 1: [at(1, 0)] }, superRules);
    // Pivot five away would land nine away, past the edge, so no jump exists.
    expect(legalMovesFrom(pos, at(-4, 0)).some((move) => move.kind === 'hop')).toBe(false);
    expect(legalMovesFrom(pos, at(-4, 0)).every((move) => move.to >= 0)).toBe(true);
  });

  it('takes the nearest marble in line as the pivot, never one behind it', () => {
    // Jumping the far marble at (0,0) would be a legal landing at (4,0), but
    // the marble at (-3,0) is in the way, so only the short hop is offered.
    const pos = position(seats, { 0: [at(-4, 0)], 1: [at(-3, 0), at(0, 0)] }, superRules);
    const moves = legalMovesFrom(pos, at(-4, 0));
    expect(moves.some((m) => m.to === at(-2, 0))).toBe(true);
    expect(moves.some((m) => m.to === at(4, 0))).toBe(false);
  });

  it('chains long jumps in one turn', () => {
    // (-4,0) --jump (0,0)--> (4,0), then --jump (4,-2)--> (4,-4).
    const pos = position(seats, { 0: [at(-4, 0)], 1: [at(0, 0), at(4, -2)] }, superRules);
    const chained = legalMovesFrom(pos, at(-4, 0)).find((m) => m.to === at(4, -4));
    expect(chained).toBeDefined();
    expect(chained!.path).toEqual([at(-4, 0), at(4, 0), at(4, -4)]);
  });

  it('leaves single steps untouched', () => {
    const pos = position(seats, { 0: [at(0, 0)] }, superRules);
    const moves = legalMovesFrom(pos, at(0, 0));
    expect(moves.length).toBe(6);
    expect(moves.every((move) => move.kind === 'step')).toBe(true);
  });

  it('offers more moves than classic once marbles are spread out', () => {
    const placements = { 0: [at(-4, 0)], 1: [at(0, 0)] };
    const count = (rules: Partial<RuleSettings>) =>
      legalMovesFrom(position(seats, placements, rules), at(-4, 0)).length;
    expect(count(superRules)).toBeGreaterThan(count({}));
  });

  it('changes nothing at setup, where every marble is packed shoulder to shoulder', () => {
    // A long jump needs empty space on both sides of the jumped marble, and the
    // opening position has none: the corners are solid and the middle is bare.
    const table = createSeats(defaultSeatDrafts(2), false);
    const classic = createGame(table, DEFAULT_RULES);
    const superGame = createGame(table, { ...DEFAULT_RULES, mode: 'super' });
    const moves = (game: typeof classic) =>
      [...legalMovesForSeat(game, 0).values()].flat().map((move) => move.to).sort();
    expect(moves(superGame)).toEqual(moves(classic));
  });
});

describe('rule variants', () => {
  const seats = createSeats(defaultSeatDrafts(6), false);
  const seatN = seats.find((seat) => seat.corner === 'N')!;

  it('blocks resting in a foreign corner but allows hopping through it', () => {
    const placements = { [seatN.id]: [at(0, 4)], 1: [at(1, 4), at(2, 3)] };
    const relaxed = position(seats, placements, { noRestingInOtherCorners: false });
    const strict = position(seats, placements, { noRestingInOtherCorners: true });

    // (2,4) is inside the SE corner; (2,2) is back out in the hexagon.
    expect(legalMovesFrom(relaxed, at(0, 4)).some((m) => m.to === at(2, 4))).toBe(true);
    expect(legalMovesFrom(strict, at(0, 4)).some((m) => m.to === at(2, 4))).toBe(false);

    const throughCorner = legalMovesFrom(strict, at(0, 4)).find((m) => m.to === at(2, 2));
    expect(throughCorner).toBeDefined();
    expect(throughCorner!.path).toContain(at(2, 4));
  });

  it('never restricts a seat inside its own start or destination corner', () => {
    const home = CORNER_HOLES[seatN.corner][0];
    const pos = position(seats, { [seatN.id]: [home] }, { noRestingInOtherCorners: true });
    expect(legalMovesFrom(pos, home).length).toBeGreaterThan(0);
  });

  it('keeps marbles home once they arrive when the rule is on', () => {
    const inHome = at(-1, 5); // inside the S corner, which is seatN's destination
    const outside = at(-1, 4);
    const relaxed = position(seats, { [seatN.id]: [inHome] }, { noLeavingHome: false });
    const strict = position(seats, { [seatN.id]: [inHome] }, { noLeavingHome: true });

    expect(legalMovesFrom(relaxed, inHome).some((m) => m.to === outside)).toBe(true);
    expect(legalMovesFrom(strict, inHome).some((m) => m.to === outside)).toBe(false);
    // Shuffling within the destination corner is still allowed.
    expect(legalMovesFrom(strict, inHome).some((m) => m.to === at(-2, 5))).toBe(true);
  });
});

describe('winning', () => {
  const seats = createSeats(defaultSeatDrafts(2), false);
  const [first, second] = seats;

  it('wins on all ten marbles home', () => {
    const pos = position(seats, { [first.id]: [...CORNER_HOLES[first.dest]] });
    expect(marblesHome(pos, first)).toBe(10);
    expect(seatHasWon(pos, first)).toBe(true);
    expect(seatHasWon(pos, second)).toBe(false);
  });

  it('does not win on nine of ten', () => {
    const nine = CORNER_HOLES[first.dest].slice(0, 9);
    const pos = position(seats, { [first.id]: nine });
    expect(seatHasWon(pos, first)).toBe(false);
  });

  it('wins through a parked opponent when anti-spoiling is on', () => {
    const dest = CORNER_HOLES[first.dest];
    const placements = { [first.id]: dest.slice(0, 9), [second.id]: [dest[9]] };
    expect(seatHasWon(position(seats, placements, { antiSpoilWin: true }), first)).toBe(true);
    expect(seatHasWon(position(seats, placements, { antiSpoilWin: false }), first)).toBe(false);
  });

  it('does not fire at setup in 2-, 4- and 6-player games', () => {
    for (const count of [2, 4, 6]) {
      const table = createSeats(defaultSeatDrafts(count), false);
      const game = createGame(table, { ...DEFAULT_RULES, antiSpoilWin: true });
      for (const seat of table) {
        expect(seatHasWon(game, seat)).toBe(false);
      }
    }
  });
});

describe('game state', () => {
  it('sets up ten marbles per player in the right corner', () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const seats = createSeats(defaultSeatDrafts(count), false);
      const game = createGame(seats, DEFAULT_RULES);
      expect(Array.from(game.occ).filter((seat) => seat >= 0).length).toBe(count * 10);
      for (const seat of seats) {
        for (const hole of CORNER_HOLES[seat.corner]) {
          expect(game.occ[hole]).toBe(seat.id);
        }
      }
    }
  });

  it('gives every player a legal opening move', () => {
    const seats = createSeats(defaultSeatDrafts(6), false);
    const game = createGame(seats, DEFAULT_RULES);
    for (const seat of seats) {
      expect(hasAnyLegalMove(game, seat.id)).toBe(true);
      expect(legalMovesForSeat(game, seat.id).size).toBeGreaterThan(0);
    }
  });

  it('advances the turn and records the move', () => {
    const seats = createSeats(defaultSeatDrafts(3), false);
    const game = createGame(seats, DEFAULT_RULES);
    const [from, moves] = [...legalMovesForSeat(game, 0)][0];
    const move = { ...moves[0], seatId: 0, from };

    applyMove(game, move);

    expect(game.occ[from]).toBe(-1);
    expect(game.occ[move.to]).toBe(0);
    expect(game.turnIndex).toBe(1);
    expect(currentSeat(game).id).toBe(1);
    expect(game.history.length).toBe(1);
    expect(game.moveCounts[0]).toBe(1);
  });

  it('skips players who have already finished', () => {
    const seats = createSeats(defaultSeatDrafts(3), false);
    const game = createGame(seats, DEFAULT_RULES);
    game.finished.push(1);
    const [from, moves] = [...legalMovesForSeat(game, 0)][0];
    applyMove(game, { ...moves[0], seatId: 0, from });
    expect(game.turnIndex).toBe(2);
  });

  it('undoes the last completed turn exactly', () => {
    const seats = createSeats(defaultSeatDrafts(4), false);
    const game = createGame(seats, DEFAULT_RULES);
    const before = Array.from(game.occ);
    const [from, moves] = [...legalMovesForSeat(game, 0)][0];
    const chain = moves.find((move) => move.kind === 'hop') ?? moves[0];

    applyMove(game, { ...chain, seatId: 0, from });
    expect(Array.from(game.occ)).not.toEqual(before);

    expect(undoLastMove(game)).toBe(true);
    expect(Array.from(game.occ)).toEqual(before);
    expect(game.turnIndex).toBe(0);
    expect(game.history.length).toBe(0);
    expect(game.moveCounts[0]).toBe(0);
    expect(undoLastMove(game)).toBe(false);
  });
});
