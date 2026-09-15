import './style.css';

import * as sfx from './audio/sfx';
import { CORNER_HOLES, CORNER_SIZE, holeAt } from './game/board';
import { legalMovesFrom, marblesHome, type Position } from './game/rules';
import {
  applyMove,
  canUndo,
  createGame,
  currentSeat,
  placings,
  undoLastMove,
  type GameState,
} from './game/state';
import {
  DEFAULT_RULES,
  PLAYER_COLORS,
  type AnimationSpeed,
  type AppSettings,
  type Move,
  type MoveKind,
  type MoveOption,
  type RuleSettings,
  type Seat,
} from './game/types';
import { hardenTouchInput, isIOS, isStandalone, supportsVibration } from './platform';
import { BoardView, type Marker, type MarkerKind } from './render/view';
import { clearGame, loadGame, loadSettings, saveGame, saveSettings } from './storage';
import { clear, el, selectRow, show, toggleRow } from './ui/dom';
import { SetupScreen, type SetupResult } from './ui/setup-screen';

type ScreenName = 'home' | 'setup' | 'game' | 'end' | 'rules';

const canvas = el<HTMLCanvasElement>('scene');
const view = new BoardView(canvas);

const screens: Record<Exclude<ScreenName, 'game'>, HTMLElement> = {
  home: el('screen-home'),
  setup: el('screen-setup'),
  end: el('screen-end'),
  rules: el('screen-rules'),
};
const hud = el('hud');
const sheet = el('sheet-settings');
const scrim = el('scrim');
const banner = el('turn-banner');
const toast = el('toast');
const turnActions = el('turn-actions');
const endTurnButton = el<HTMLButtonElement>('end-turn');
const cancelMoveButton = el<HTMLButtonElement>('btn-cancel-move');
const undoButton = el<HTMLButtonElement>('btn-undo');
const resumeButton = el<HTMLButtonElement>('btn-resume');

let settings: AppSettings = loadSettings();
let game: GameState | null = null;
let lastSetup: SetupResult | null = null;

let screen: ScreenName = 'home';
let rulesReturn: ScreenName = 'home';

let selection: number | null = null;
let options: MoveOption[] = [];
/**
 * The move played but not yet confirmed. Nothing reaches the game state until
 * End turn is pressed, so every move — a step as much as a hop chain — can be
 * walked back one leg at a time first.
 */
interface PendingMove {
  origin: number;
  /** Holes occupied so far, starting at the origin. */
  path: number[];
  /** Holes this move has already touched; a hop may not revisit one. */
  visited: Set<number>;
  kind: MoveKind;
}

let pending: PendingMove | null = null;
/**
 * The turn's other destinations while a move is pending: everywhere else this
 * marble could still finish, measured from where it started. Tapping one moves
 * there instead, so a change of mind costs one tap rather than a walk back.
 */
let alternates: MoveOption[] = [];
let downHole: number | null = null;
let busy = false;
let toastTimer = 0;
let bannerTimer = 0;
/** The step-back gesture is only pointed out once a session. */
let hintedStepBack = false;
/**
 * When the last leg of the pending move landed. A tap on the marble within
 * `STEP_BACK_GUARD_MS` of that is swallowed, so the second half of an
 * accidental double tap on a destination does not immediately undo the move it
 * just made. A deliberate correction is well outside this window.
 */
let lastLegAt = 0;
const STEP_BACK_GUARD_MS = 300;

// --- screens ---------------------------------------------------------------

function setScreen(next: ScreenName): void {
  screen = next;
  for (const [name, node] of Object.entries(screens)) {
    show(node, name === next);
  }
  // Sub-panel of setup; SetupScreen reopens it on demand.
  show(el('screen-variants'), false);
  show(hud, next === 'game');
  view.setIdleSpin(next === 'home' || next === 'rules');
  if (next !== 'game') {
    show(turnActions, false);
    show(endTurnButton, false);
    closeSheet();
  }
}

/**
 * In-app replacement for window.confirm.
 *
 * Native dialogs are suppressed outright in some webviews (which is what made
 * Restart look broken), and where they do appear they are labelled with the
 * host name and ignore the app's styling.
 */
function askConfirm(
  title: string,
  body: string,
  confirmLabel: string,
  danger = false,
): Promise<boolean> {
  const backdrop = el('dialog');
  const confirmButton = el<HTMLButtonElement>('dialog-confirm');
  const cancelButton = el<HTMLButtonElement>('dialog-cancel');

  el('dialog-title').textContent = title;
  el('dialog-body').textContent = body;
  confirmButton.textContent = confirmLabel;
  confirmButton.className = danger ? 'danger' : 'primary';
  show(backdrop, true);
  confirmButton.focus();

  return new Promise((resolve) => {
    const close = (answer: boolean) => {
      show(backdrop, false);
      confirmButton.removeEventListener('click', onConfirm);
      cancelButton.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onConfirm = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (event: MouseEvent) => {
      if (event.target === backdrop) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Beat the global Escape handler, which would close the sheet instead.
      event.stopPropagation();
      close(false);
    };

    confirmButton.addEventListener('click', onConfirm);
    cancelButton.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKey, true);
  });
}

function showToast(message: string): void {
  toast.textContent = message;
  show(toast, true);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => show(toast, false), 2600);
}

function showBanner(seat: Seat): void {
  const color = PLAYER_COLORS[seat.colorIndex];
  banner.textContent = `${seat.name}’s turn`;
  banner.style.color = color.css;
  show(banner, true);
  // Restart the CSS animation.
  banner.style.animation = 'none';
  void banner.offsetWidth;
  banner.style.animation = '';
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => show(banner, false), 1500);
}

// --- setup screen ----------------------------------------------------------

const setupScreen = new SetupScreen({
  onPreview(seats) {
    // Show the table exactly as it will be dealt, so you can see who you face.
    const preview = createGame(seats, DEFAULT_RULES);
    view.setSeats(seats);
    view.syncFromOccupancy(preview.occ, seats);
    view.faceCorner(seats[0].corner);
  },
  onStart(result) {
    startGame(result);
  },
  onBack() {
    setScreen('home');
  },
});

// --- game flow -------------------------------------------------------------

function startGame(setup: SetupResult): void {
  lastSetup = setup;
  game = createGame(setup.seats, setup.rules);
  resetInteraction();
  view.setSeats(setup.seats);
  view.syncFromOccupancy(game.occ, game.seats);
  renderActiveRules(setup.rules);
  setScreen('game');
  beginTurn(true);
  saveGame(game);
}

function resumeGame(state: GameState): void {
  game = state;
  lastSetup = { seats: state.seats, rules: state.rules };
  resetInteraction();
  view.setSeats(state.seats);
  view.syncFromOccupancy(state.occ, state.seats);
  renderActiveRules(state.rules);
  setScreen('game');
  beginTurn(true);
}

function resetInteraction(): void {
  selection = null;
  options = [];
  alternates = [];
  pending = null;
  busy = false;
  view.setSelection(null);
  view.setMarkers([]);
  updateTurnActions();
}

function beginTurn(instant = false): void {
  if (!game) return;
  const seat = currentSeat(game);
  if (settings.autoRotate) view.faceCorner(seat.corner, instant);
  // Follow this player's corner so the Cancel / End turn pair sits on their side.
  view.trackCorner(seat.corner);
  refreshHud();
  if (!instant) {
    showBanner(seat);
    sfx.play('turn');
  }
}

function refreshHud(): void {
  if (!game) return;
  const seat = currentSeat(game);
  const color = PLAYER_COLORS[seat.colorIndex];
  const glyph = el('turn-glyph');
  glyph.textContent = color.glyph;
  glyph.style.background = color.css;
  glyph.style.color = color.ink;
  el('turn-name').textContent = seat.name;
  // Undo drops a move that is still pending as readily as it rolls back a
  // committed turn, and on the opening move the pending one is all there is.
  undoButton.disabled = !pending && !canUndo(game);
}

// --- interaction -----------------------------------------------------------

/**
 * `list` is what a tap acts on right now — the moves out of a selected marble,
 * or the next hops of a chain. `others` is the rest of the turn's destinations,
 * drawn in the step colour so "carry on hopping" and "go somewhere else instead"
 * stay apart at a glance.
 */
/**
 * The Cancel / End turn pair. Cancel is offered for as long as a move is
 * unconfirmed; End turn only when the marble is somewhere it may legally stop,
 * which a walk back into a foreign corner can undo.
 */
/** Keeps `value` inside the range, and centres it if the range has collapsed. */
function clamp(value: number, low: number, high: number): number {
  if (low >= high) return 50;
  return Math.min(Math.max(value, low), high);
}

function updateTurnActions(): void {
  show(turnActions, pending !== null);
  show(endTurnButton, pending !== null && !busy && canConfirmPending());
}

/**
 * Parks the pair beside the corner of whoever is to move and turns it to face
 * them, from the corner's own position on screen. With the board set to turn to
 * each player that corner is always nearest the bottom, so this lands where the
 * button has always been; with it switched off the pair travels round the board
 * instead, to whichever side that player is sitting on.
 */
function positionTurnActions(point: { x: number; y: number }): void {
  const length = Math.hypot(point.x, point.y);
  // A corner projected near the middle gives no usable direction; keep the
  // pair where it was rather than snapping it somewhere arbitrary.
  if (length < 0.05) return;
  const dirX = point.x / length;
  // Screen y grows downward, the projection's grows up.
  const dirY = -point.y / length;

  // Turn the pair so its top points back at the board, which is up from where
  // that player sits.
  const spin = Math.atan2(-dirX, dirY);
  turnActions.style.setProperty('--turn-spin', `${((spin * 180) / Math.PI).toFixed(1)}deg`);

  const REACH = 0.74;
  let x = (0.5 + dirX * REACH * 0.5) * 100;
  let y = (0.5 + dirY * REACH * 0.5) * 100;

  // Keep the whole pair on screen. Rotating it changes how much room it needs
  // in each axis, so the footprint is measured from the turned rectangle rather
  // than the plain one — which is what lets the side corners sit as far out as
  // they do without the buttons running off the edge.
  const width = turnActions.offsetWidth;
  const height = turnActions.offsetHeight;
  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;
  if (width > 0 && viewWidth > 0 && viewHeight > 0) {
    const sin = Math.abs(Math.sin(spin));
    const cos = Math.abs(Math.cos(spin));
    const marginX = (((width * cos + height * sin) / 2 + 12) / viewWidth) * 100;
    const marginY = (((width * sin + height * cos) / 2 + 12) / viewHeight) * 100;
    x = clamp(x, marginX, 100 - marginX);
    y = clamp(y, marginY, 100 - marginY);
  }

  turnActions.style.setProperty('--turn-x', `${x}%`);
  turnActions.style.setProperty('--turn-y', `${y}%`);
}

function markersFor(list: MoveOption[], others: MoveOption[] = []): Marker[] {
  if (!settings.hints) return [];
  const markers: Marker[] = list.map((option) => ({
    hole: option.to,
    kind: option.kind as MarkerKind,
  }));
  for (const option of others) markers.push({ hole: option.to, kind: 'alternate' });
  return markers;
}

function selectMarble(hole: number): void {
  if (!game) return;
  selection = hole;
  options = legalMovesFrom(game, hole);
  view.setSelection(hole);
  view.setMarkers(markersFor(options));
  sfx.play('select');
  if (options.length === 0) showToast('That marble has no legal move.');
}

function clearSelection(): void {
  selection = null;
  options = [];
  alternates = [];
  view.setSelection(null);
  view.setMarkers([]);
}

function reject(): void {
  sfx.play('invalid');
  sfx.vibrate(30);
}

function handleTap(hole: number | null): void {
  if (!game || busy) return;

  if (pending) {
    if (hole === null) return;
    if (hole === pending.path[pending.path.length - 1]) {
      stepBackPending();
      return;
    }
    const option = options.find((candidate) => candidate.to === hole);
    if (option) {
      extendChain(option);
      return;
    }
    const alternate = alternates.find((candidate) => candidate.to === hole);
    if (alternate) {
      relocatePending(alternate);
      return;
    }
    reject();
    // Another of your own marbles: the turn is spent until this one goes back.
    if (hole !== pending.origin && game.occ[hole] === currentSeat(game).id) {
      showToast('You have already moved. Tap that marble to put it back.');
    }
    return;
  }

  if (hole === null) {
    clearSelection();
    return;
  }

  const seat = currentSeat(game);
  if (game.occ[hole] === seat.id) {
    if (selection === hole) clearSelection();
    else selectMarble(hole);
    return;
  }

  if (selection === null) {
    if (game.occ[hole] >= 0) showToast('That is not your marble.');
    return;
  }

  const option = options.find((candidate) => candidate.to === hole);
  if (!option) {
    reject();
    return;
  }
  playOption(selection, option);
}

function playOption(from: number, option: MoveOption): void {
  if (!game) return;
  busy = true;
  view.setMarkers([]);
  view.setSelection(null);
  updateTurnActions();
  sfx.play(option.kind);
  sfx.vibrate(12);

  view.animateMove(option.path, option.kind, () => {
    busy = false;
    pending = {
      origin: from,
      path: [...option.path],
      visited: new Set(option.path),
      kind: option.kind,
    };
    offerNext();
  });
}

function extendChain(option: MoveOption): void {
  if (!pending) return;
  busy = true;
  view.setMarkers([]);
  updateTurnActions();
  sfx.play('hop');
  sfx.vibrate(12);

  view.animateMove(option.path, 'hop', () => {
    busy = false;
    if (!pending) return;
    pending.path.push(option.to);
    pending.visited.add(option.to);
    offerNext();
  });
}

/** Hops available from where the marble is standing mid-chain. */
function chainContinuations(): MoveOption[] {
  if (!game || !pending) return [];
  const seatId = game.occ[pending.origin];
  const occ = Int8Array.from(game.occ);
  const current = pending.path[pending.path.length - 1];
  occ[pending.origin] = -1;
  occ[current] = seatId;
  const position: Position = { occ, seats: game.seats, rules: game.rules };
  return legalMovesFrom(position, current).filter(
    (option) =>
      option.kind === 'hop' && option.path.length === 2 && !pending!.visited.has(option.to),
  );
}

/**
 * Settles the board after a leg of the pending move: any further hops on offer,
 * and the confirm. Nothing commits here — the turn only ends when the player
 * says so, which is the whole point of holding the move.
 */
function offerNext(): void {
  if (!game || !pending) return;
  lastLegAt = performance.now();
  const current = pending.path[pending.path.length - 1];
  // A step is the whole turn; only a hop chain can carry on.
  options = pending.kind === 'hop' ? chainContinuations() : [];
  // Everything else the turn could still reach, minus where the marble already
  // stands and minus the holes already offered as continuations.
  const offered = new Set(options.map((option) => option.to));
  alternates = legalMovesFrom(game, pending.origin).filter(
    (option) => option.to !== current && !offered.has(option.to),
  );
  view.setSelection(current);
  view.setMarkers(markersFor(options, alternates));
  updateTurnActions();
  if (!hintedStepBack) {
    hintedStepBack = true;
    showToast('Press End turn when you are happy, or tap the marble to put it back.');
  }
}

/**
 * Puts the marble back one leg of the move that has not been confirmed yet.
 * Tapping the marble is the gesture, so a misjudged hop costs one tap instead
 * of the whole turn. Walking all the way back to the origin reopens the turn
 * completely: the marble is reselected and every legal move is on offer again,
 * which is also how you get to move a different marble instead.
 */
function stepBackPending(): void {
  if (!game || !pending || busy) return;
  if (performance.now() - lastLegAt < STEP_BACK_GUARD_MS) return;
  const path = pending.path;
  if (path.length < 2) return;
  const leaving = path[path.length - 1];
  const back = path[path.length - 2];

  busy = true;
  view.setMarkers([]);
  updateTurnActions();
  sfx.play(pending.kind);
  sfx.vibrate(10);

  view.animateMove([leaving, back], pending.kind, () => {
    busy = false;
    if (!pending) return;
    path.pop();
    // Let the hole be jumped to again — it is no longer part of the move.
    pending.visited.delete(leaving);
    if (path.length > 1) {
      offerNext();
      return;
    }
    const origin = pending.origin;
    pending = null;
    alternates = [];
    lastLegAt = performance.now();
    updateTurnActions();
    selectMarble(origin);
  });
}

/**
 * Whether the pending move is one the player is allowed to end the turn on.
 *
 * The holes a multi-hop path passes through are not all legal places to stop —
 * `noRestingInOtherCorners` is the case — and stepping back can park the marble
 * on one, so the confirm has to be withheld there. Asking the rules for the
 * moves out of the origin is the test: they are exactly the legal landings.
 */
function canConfirmPending(): boolean {
  if (!game || !pending) return false;
  const current = pending.path[pending.path.length - 1];
  if (current === pending.origin) return false;
  return legalMovesFrom(game, pending.origin).some(
    (option) => option.kind === pending!.kind && option.to === current,
  );
}

/** Replays the turn from the origin to a different destination. */
function relocatePending(option: MoveOption): void {
  if (!game || !pending) return;
  const origin = pending.origin;
  pending = null;
  alternates = [];
  view.setSelection(null);
  // The move was never applied, so the board itself already holds the truth.
  view.syncFromOccupancy(game.occ, game.seats);
  playOption(origin, option);
}

function commitPending(): void {
  if (!game || !pending) return;
  const path = pending.path;
  commit({
    seatId: game.occ[pending.origin],
    from: pending.origin,
    to: path[path.length - 1],
    kind: pending.kind,
    path,
  });
}

function cancelPending(): void {
  if (!game) return;
  pending = null;
  alternates = [];
  view.syncFromOccupancy(game.occ, game.seats);
  resetInteraction();
  updateTurnActions();
}

function commit(move: Move): void {
  if (!game) return;
  pending = null;
  selection = null;
  options = [];
  alternates = [];
  view.setMarkers([]);
  view.setSelection(null);
  updateTurnActions();

  const result = applyMove(game, move);
  saveGame(game);

  for (const seatId of result.newlyFinished) {
    const seat = game.seats.find((candidate) => candidate.id === seatId);
    if (seat) showToast(`${seat.name} is home!`);
    sfx.play('win');
    sfx.vibrate([20, 40, 20]);
  }
  for (const seatId of result.passed) {
    const seat = game.seats.find((candidate) => candidate.id === seatId);
    if (seat) showToast(`${seat.name} has no legal move and is skipped.`);
  }

  if (result.over) {
    showEndScreen();
    return;
  }
  beginTurn();
}

view.onPointerDownHole = (hole) => {
  sfx.unlockAudio();
  downHole = hole;
};

view.onPointerUpHole = (hole) => {
  const from = downHole;
  downHole = null;
  if (screen !== 'game' || !game || busy) return;

  // Dragging from a marble to a target counts as select-then-move.
  if (from !== null && hole !== null && from !== hole && !pending) {
    if (game.occ[from] === currentSeat(game).id && selection !== from) selectMarble(from);
  }
  handleTap(hole ?? from);
};

endTurnButton.addEventListener('click', () => {
  if (pending && !busy && canConfirmPending()) commitPending();
});

cancelMoveButton.addEventListener('click', () => {
  if (!pending || busy) return;
  cancelPending();
  showToast('Move taken back.');
});

// --- end of game -----------------------------------------------------------

function showEndScreen(): void {
  if (!game) return;
  const ranked = placings(game);
  const winner = ranked[0];
  const title = el('end-title');

  if (game.rules.teams) {
    const teamMembers = game.seats.filter((seat) => seat.team === winner.team);
    title.textContent = `${teamMembers.map((seat) => seat.name).join(' & ')} win!`;
  } else {
    title.textContent = `${winner.name} wins!`;
  }

  const list = el('placings');
  clear(list);
  ranked.forEach((seat, index) => {
    const color = PLAYER_COLORS[seat.colorIndex];
    const item = document.createElement('li');

    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = `${index + 1}.`;

    const glyph = document.createElement('span');
    glyph.className = 'swatch';
    glyph.style.width = '28px';
    glyph.style.height = '28px';
    glyph.style.background = color.css;
    glyph.style.color = color.ink;
    glyph.style.fontSize = '13px';
    glyph.textContent = color.glyph;

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = seat.name;

    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = `${marblesHome(game!, seat)}/${CORNER_SIZE} · ${game!.moveCounts[seat.id]} moves`;

    item.append(place, glyph, who, detail);
    list.append(item);
  });

  const minutes = Math.max(1, Math.round((Date.now() - game.startedAt) / 60000));
  showToast(`Game finished in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);

  clearGame();
  setScreen('end');
}

// --- settings sheet --------------------------------------------------------

function openSheet(): void {
  if (!game) return;
  refreshHud();
  show(sheet, true);
  show(scrim, true);
}

function closeSheet(): void {
  show(sheet, false);
  show(scrim, false);
}

function buildPlaySettings(): void {
  const container = el('play-settings');
  clear(container);

  const rotate = toggleRow(
    'Turn board to current player',
    'Each player sees their own corner nearest the bottom.',
    settings.autoRotate,
  );
  rotate.input.addEventListener('change', () => {
    updateSettings({ autoRotate: rotate.input.checked });
    if (game && settings.autoRotate) view.faceCorner(currentSeat(game).corner);
    else view.faceCorner(null);
  });

  const flat = toggleRow(
    'Flat board',
    'Look straight down at the board instead of at an angle. Drag with two fingers to tilt it yourself.',
    settings.flatBoard,
  );
  flat.input.addEventListener('change', () => {
    updateSettings({ flatBoard: flat.input.checked });
    view.setFlatBoard(settings.flatBoard);
  });

  const speed = selectRow<AnimationSpeed>(
    'Animation speed',
    'How fast marbles travel.',
    [
      { value: 'slow', label: 'Slow' },
      { value: 'normal', label: 'Normal' },
      { value: 'fast', label: 'Fast' },
      { value: 'instant', label: 'Instant' },
    ],
    settings.animationSpeed,
  );
  speed.select.addEventListener('change', () => {
    updateSettings({ animationSpeed: speed.select.value as AnimationSpeed });
    view.setAnimationSpeed(settings.animationSpeed);
  });

  const hints = toggleRow('Show legal moves', 'Ring every hole the selected marble can reach.', settings.hints);
  hints.input.addEventListener('change', () => {
    updateSettings({ hints: hints.input.checked });
    view.setMarkers(markersFor(options, alternates));
  });

  const sound = toggleRow('Sound', 'Short blips for moves and turn changes.', settings.sound);
  sound.input.addEventListener('change', () => {
    updateSettings({ sound: sound.input.checked });
    sfx.setSoundEnabled(settings.sound);
  });

  container.append(rotate.row, flat.row, speed.row, hints.row, sound.row);

  // iOS Safari has no Vibration API, so offering the switch there is a lie.
  if (supportsVibration) {
    const haptics = toggleRow('Haptics', 'Vibrate on moves.', settings.haptics);
    haptics.input.addEventListener('change', () => {
      updateSettings({ haptics: haptics.input.checked });
      sfx.setHapticsEnabled(settings.haptics);
    });
    container.append(haptics.row);
  }
}

function updateSettings(patch: Partial<AppSettings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
}

function renderActiveRules(rules: RuleSettings): void {
  const container = el('active-rules');
  clear(container);
  const lines = [
    `Mode: ${rules.mode === 'super' ? 'Super (long jumps)' : 'Classic'}`,
    `Anti-spoiling win: ${rules.antiSpoilWin ? 'on' : 'off'}`,
    `No resting in other corners: ${rules.noRestingInOtherCorners ? 'on' : 'off'}`,
    `No leaving home: ${rules.noLeavingHome ? 'on' : 'off'}`,
    `End on first winner: ${rules.endOnFirstWinner ? 'on' : 'off'}`,
    `Teams: ${rules.teams ? 'on' : 'off'}`,
  ];
  for (const line of lines) {
    const node = document.createElement('span');
    node.textContent = line;
    container.append(node);
  }
}

// --- wiring ----------------------------------------------------------------

el('menu-button').addEventListener('click', openSheet);
el('btn-close-sheet').addEventListener('click', closeSheet);
scrim.addEventListener('click', closeSheet);
// The sheet is a full-screen flex container that only *looks* like a panel at
// the bottom, and it sits above the scrim — so a tap beside the panel lands on
// the sheet, never on the scrim. Closing on it (and only on it, not on its
// children) is what makes tap-outside-to-dismiss actually work.
sheet.addEventListener('click', (event) => {
  if (event.target === sheet) closeSheet();
});

el('btn-new').addEventListener('click', () => {
  sfx.unlockAudio();
  setScreen('setup');
  setupScreen.show();
});

resumeButton.addEventListener('click', () => {
  const saved = loadGame();
  if (!saved) {
    showToast('No saved game found.');
    show(resumeButton, false);
    return;
  }
  resumeGame(saved);
});

el('btn-undo').addEventListener('click', () => {
  if (!game) return;
  if (pending) {
    cancelPending();
    closeSheet();
    showToast('Move taken back.');
    return;
  }
  if (!undoLastMove(game)) return;
  view.syncFromOccupancy(game.occ, game.seats);
  resetInteraction();
  saveGame(game);
  closeSheet();
  beginTurn(true);
  showToast('Last move undone.');
});

el('btn-restart').addEventListener('click', async () => {
  if (!game) return;
  const confirmed = await askConfirm(
    'Restart game?',
    'Every marble goes back to its starting corner and the same players begin again.',
    'Restart',
  );
  if (!confirmed || !game) return;
  startGame({ seats: game.seats, rules: game.rules });
  closeSheet();
  showToast('Board reset. Back to the start.');
});

el('btn-end').addEventListener('click', async () => {
  const confirmed = await askConfirm(
    'End game?',
    'This game is discarded and you go back to the home screen.',
    'End game',
    true,
  );
  if (!confirmed) return;
  clearGame();
  game = null;
  resetInteraction();
  closeSheet();
  show(resumeButton, false);
  setScreen('home');
});

el('btn-rematch').addEventListener('click', () => {
  if (lastSetup) startGame(lastSetup);
});

el('btn-new-setup').addEventListener('click', () => {
  setScreen('setup');
  setupScreen.show();
});

el('btn-home').addEventListener('click', () => setScreen('home'));

for (const id of ['btn-rules-home', 'btn-rules-sheet']) {
  el(id).addEventListener('click', () => {
    rulesReturn = screen;
    closeSheet();
    setScreen('rules');
  });
}

el('btn-rules-back').addEventListener('click', () => {
  setScreen(rulesReturn === 'rules' ? 'home' : rulesReturn);
  if (rulesReturn === 'setup') setupScreen.show();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!sheet.classList.contains('hidden')) closeSheet();
    // Escape is the way out of a pending move: confirm it where that is legal,
    // and abandon it where the marble may not rest where it stands.
    else if (pending && !busy) {
      if (canConfirmPending()) commitPending();
      else cancelPending();
    }
  }
});

// Audio needs a gesture to start, and iOS suspends it on every background.
document.addEventListener('pointerdown', () => sfx.unlockAudio(), { capture: true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) sfx.resumeAudio();
});

const INSTALL_HINT_KEY = 'chinese-checkers:install-hint-dismissed';

function setUpInstallHint(): void {
  const hint = el('ios-install');
  const dismissed = localStorage.getItem(INSTALL_HINT_KEY) === '1';
  show(hint, isIOS && !isStandalone() && !dismissed);
  el('ios-install-dismiss').addEventListener('click', () => {
    show(hint, false);
    try {
      localStorage.setItem(INSTALL_HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  });
}

// --- boot ------------------------------------------------------------------

hardenTouchInput();
setUpInstallHint();
sfx.setSoundEnabled(settings.sound);
sfx.setHapticsEnabled(settings.haptics && supportsVibration);
view.setAnimationSpeed(settings.animationSpeed);
view.setFlatBoard(settings.flatBoard, true);
view.onCornerAnchorMove = positionTurnActions;
buildPlaySettings();

const saved = loadGame();
show(resumeButton, saved !== null);

// The idle board behind the menus.
const idle = saved ?? createGame(defaultIdleSeats(), DEFAULT_RULES);
view.setSeats(idle.seats);
view.syncFromOccupancy(idle.occ, idle.seats);

setScreen('home');
view.start();

function defaultIdleSeats(): Seat[] {
  return [
    { id: 0, name: 'Player 1', colorIndex: 0, corner: 'N', dest: 'S', team: 0, kind: 'human' },
    { id: 1, name: 'Player 2', colorIndex: 1, corner: 'S', dest: 'N', team: 1, kind: 'human' },
  ];
}

if (import.meta.env.DEV) {
  // Dev-only handle so the game can be driven headlessly during testing.
  Object.assign(window, {
    __cc: {
      view,
      setScreen,
      startGame,
      tap: (hole: number | null) => handleTap(hole),
      state: () => game,
      legal: (hole: number) => (game ? legalMovesFrom(game, hole) : []),
      pending: () => pending,
      alternates: () => alternates,
      stepBack: () => stepBackPending(),
      canConfirm: () => canConfirmPending(),
      endTurn: () => endTurnButton.click(),
      busy: () => busy,
      snapshot: () => view.debugSnapshot(),
      holeAt,
      cornerHoles: CORNER_HOLES,
      resync: () => game && view.syncFromOccupancy(game.occ, game.seats),
    },
  });
}

// Cache-first service worker so the game keeps working offline once loaded.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Offline support is a bonus; the game works either way.
    });
  });
}
