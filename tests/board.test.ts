import { describe, expect, it } from 'vitest';
import {
  BOARD_RADIUS,
  CORNER_HOLES,
  CORNERS,
  HOLE_COUNT,
  HOLES,
  NEIGHBORS,
  HOP_TARGETS,
  cornerFacingRotation,
  holeAt,
  oppositeCorner,
} from '../src/game/board';
import { CORNERS_BY_PLAYER_COUNT, createSeats, defaultSeatDrafts } from '../src/game/setup';

describe('board geometry', () => {
  it('has exactly 121 holes', () => {
    expect(HOLES.length).toBe(HOLE_COUNT);
  });

  it('has six corners of exactly 10 holes', () => {
    expect(CORNERS.length).toBe(6);
    for (const corner of CORNERS) {
      expect(CORNER_HOLES[corner].length).toBe(10);
    }
  });

  it('has 61 holes in the central hexagon', () => {
    const hexagon = HOLES.filter((hole) => hole.corner === null);
    expect(hexagon.length).toBe(61);
  });

  it('lays out as the 17 documented rows', () => {
    const rows = new Map<number, number>();
    for (const hole of HOLES) rows.set(hole.r, (rows.get(hole.r) ?? 0) + 1);
    const lengths = [...rows.keys()].sort((a, b) => a - b).map((r) => rows.get(r)!);
    expect(lengths).toEqual([1, 2, 3, 4, 13, 12, 11, 10, 9, 10, 11, 12, 13, 4, 3, 2, 1]);
  });

  it('keeps cube coordinates summing to zero', () => {
    for (const hole of HOLES) {
      expect(hole.q + hole.r + -hole.q - hole.r).toBe(0);
    }
  });

  it('has symmetric adjacency that never leaves the board', () => {
    for (const hole of HOLES) {
      for (let d = 0; d < 6; d++) {
        const neighbor = NEIGHBORS[hole.index * 6 + d];
        if (neighbor < 0) continue;
        expect(neighbor).toBeLessThan(HOLE_COUNT);
        const back = NEIGHBORS[neighbor * 6 + ((d + 3) % 6)];
        expect(back).toBe(hole.index);
      }
    }
  });

  it('places hop landings two steps along the same direction', () => {
    for (const hole of HOLES) {
      for (let d = 0; d < 6; d++) {
        const over = NEIGHBORS[hole.index * 6 + d];
        const landing = HOP_TARGETS[hole.index * 6 + d];
        if (landing < 0) continue;
        expect(over).toBeGreaterThanOrEqual(0);
        expect(NEIGHBORS[over * 6 + d]).toBe(landing);
      }
    }
  });

  it('maps every corner to the one across the board', () => {
    for (const corner of CORNERS) {
      expect(oppositeCorner(oppositeCorner(corner))).toBe(corner);
      expect(oppositeCorner(corner)).not.toBe(corner);
    }
    expect(oppositeCorner('N')).toBe('S');
    expect(oppositeCorner('NE')).toBe('SW');
    expect(oppositeCorner('SE')).toBe('NW');
  });

  it('puts the six star tips at the same distance from the centre', () => {
    const tips = CORNERS.map((corner) => {
      const holes = CORNER_HOLES[corner].map((i) => HOLES[i]);
      return Math.max(...holes.map((hole) => Math.hypot(hole.x, hole.z)));
    });
    for (const tip of tips) expect(tip).toBeCloseTo(BOARD_RADIUS, 6);
  });

  it('rotates each corner to the near edge of the screen', () => {
    for (const corner of CORNERS) {
      const holes = CORNER_HOLES[corner].map((i) => HOLES[i]);
      const cx = holes.reduce((sum, hole) => sum + hole.x, 0) / holes.length;
      const cz = holes.reduce((sum, hole) => sum + hole.z, 0) / holes.length;
      const theta = cornerFacingRotation(corner);
      const x = cx * Math.cos(theta) + cz * Math.sin(theta);
      const z = -cx * Math.sin(theta) + cz * Math.cos(theta);
      expect(x).toBeCloseTo(0, 6);
      expect(z).toBeGreaterThan(0);
    }
  });

  it('resolves coordinates back to hole indices', () => {
    for (const hole of HOLES) {
      expect(holeAt(hole.q, hole.r)).toBe(hole.index);
    }
    expect(holeAt(9, 0)).toBe(-1);
    expect(holeAt(5, -5)).toBe(-1);
  });
});

describe('seat setup', () => {
  it('uses the documented corners for each player count', () => {
    expect(CORNERS_BY_PLAYER_COUNT[2]).toEqual(['N', 'S']);
    expect(CORNERS_BY_PLAYER_COUNT[3]).toEqual(['N', 'SE', 'SW']);
    expect(CORNERS_BY_PLAYER_COUNT[4]).toEqual(['NE', 'SE', 'SW', 'NW']);
    expect(CORNERS_BY_PLAYER_COUNT[6]).toEqual(['N', 'NE', 'SE', 'S', 'SW', 'NW']);
  });

  it('gives every seat the opposite corner as its destination', () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const seats = createSeats(defaultSeatDrafts(count), false);
      expect(seats.length).toBe(count);
      for (const seat of seats) {
        expect(seat.dest).toBe(oppositeCorner(seat.corner));
      }
      expect(new Set(seats.map((s) => s.corner)).size).toBe(count);
    }
  });

  it('leaves 3-player destinations empty at setup', () => {
    const seats = createSeats(defaultSeatDrafts(3), false);
    const used = new Set(seats.map((seat) => seat.corner));
    for (const seat of seats) expect(used.has(seat.dest)).toBe(false);
  });

  it('aims 2, 4 and 6 player games at an occupied corner', () => {
    // Opposite corners are all in play at these counts, so every player is
    // heading for a corner another player has to vacate first.
    for (const count of [2, 4, 6]) {
      const seats = createSeats(defaultSeatDrafts(count), false);
      const used = new Set(seats.map((seat) => seat.corner));
      for (const seat of seats) expect(used.has(seat.dest)).toBe(true);
    }
  });

  it('pairs partners opposite each other with 4 players', () => {
    const seats = createSeats(defaultSeatDrafts(4), true);
    const teams = new Set(seats.map((seat) => seat.team));
    expect(teams.size).toBe(2);
    for (const seat of seats) {
      const partner = seats.find((other) => other.id !== seat.id && other.team === seat.team)!;
      expect(partner.corner).toBe(oppositeCorner(seat.corner));
    }
  });

  it('splits 6 players into two teams of three', () => {
    const seats = createSeats(defaultSeatDrafts(6), true);
    const teams = new Map<number, number>();
    for (const seat of seats) teams.set(seat.team, (teams.get(seat.team) ?? 0) + 1);
    expect([...teams.values()].sort()).toEqual([3, 3]);
  });

  it('ignores teams for player counts that cannot split evenly', () => {
    const seats = createSeats(defaultSeatDrafts(3), true);
    expect(new Set(seats.map((seat) => seat.team)).size).toBe(3);
  });
});
