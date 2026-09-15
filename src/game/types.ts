/** Shared game types. No three.js, no DOM — this module is pure data. */

export type CornerName = 'N' | 'NE' | 'SE' | 'S' | 'SW' | 'NW';

export type SeatKind = 'human';

/** One player position at the table. */
export interface Seat {
  id: number;
  name: string;
  /** Index into PLAYER_COLORS. */
  colorIndex: number;
  /** Corner this seat's marbles start in. */
  corner: CornerName;
  /** Corner this seat must fill to win (always the opposite corner). */
  dest: CornerName;
  /** Team id; when teams are off every seat is its own team. */
  team: number;
  kind: SeatKind;
}

export type MoveKind = 'step' | 'hop';

export interface MoveOption {
  /** Hole index the marble ends on. */
  to: number;
  kind: MoveKind;
  /** Holes visited, starting with the origin. For a step this is [from, to]. */
  path: number[];
}

export interface Move extends MoveOption {
  seatId: number;
  from: number;
}

export type AnimationSpeed = 'slow' | 'normal' | 'fast' | 'instant';

/**
 * `classic` — hop over a marble standing next to you into the hole just beyond.
 * `super`   — Super Chinese Checkers: jump a marble any distance away, provided
 *             the gap between is empty and you land the same distance beyond it.
 *             The classic hop is simply the shortest case of this.
 */
export type GameMode = 'classic' | 'super';

/** Rule variants that differ between printed editions. Locked once a game starts. */
export interface RuleSettings {
  mode: GameMode;
  /** Win when the destination is full and most of it is yours (anti-spoiling). */
  antiSpoilWin: boolean;
  /** A marble may hop through, but not end its turn in, a corner that is not its own. */
  noRestingInOtherCorners: boolean;
  /** Once a marble reaches its destination corner it may not move back out. */
  noLeavingHome: boolean;
  /** Stop the game as soon as somebody wins instead of playing out the placings. */
  endOnFirstWinner: boolean;
  /** Partners (4 and 6 players only). */
  teams: boolean;
}

/** Presentation preferences. Changeable at any time. */
export interface AppSettings {
  autoRotate: boolean;
  /** Look straight down at the board instead of at the default three-quarter angle. */
  flatBoard: boolean;
  animationSpeed: AnimationSpeed;
  sound: boolean;
  haptics: boolean;
  hints: boolean;
}

export const DEFAULT_RULES: RuleSettings = {
  mode: 'classic',
  antiSpoilWin: true,
  noRestingInOtherCorners: false,
  noLeavingHome: false,
  endOnFirstWinner: false,
  teams: false,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoRotate: true,
  flatBoard: true,
  animationSpeed: 'normal',
  sound: true,
  haptics: true,
  hints: true,
};

export interface PlayerColor {
  name: string;
  /** Marble body colour. */
  hex: number;
  /** CSS colour for UI chrome. */
  css: string;
  /** Distinct marking so colour is never the only signal. */
  glyph: string;
  /** Colour for text drawn on top of `css`. */
  ink: string;
}

export const PLAYER_COLORS: PlayerColor[] = [
  { name: 'Cherry', hex: 0xff4d6d, css: '#ff4d6d', glyph: '●', ink: '#ffffff' },
  { name: 'Sky', hex: 0x3aa0ff, css: '#3aa0ff', glyph: '▲', ink: '#ffffff' },
  { name: 'Sunshine', hex: 0xffc233, css: '#ffc233', glyph: '■', ink: '#5a3d00' },
  { name: 'Mint', hex: 0x2fd07a, css: '#2fd07a', glyph: '◆', ink: '#063a1c' },
  { name: 'Grape', hex: 0xa86bff, css: '#a86bff', glyph: '★', ink: '#ffffff' },
  { name: 'Lagoon', hex: 0x14c9c4, css: '#14c9c4', glyph: '✚', ink: '#04403e' },
];
