/**
 * Player setup: how many are playing, who they are, and the rule variants.
 * Changing the count immediately previews those corners on the 3D board.
 */

import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  createSeats,
  defaultSeatDrafts,
  isBalanced,
  supportsTeams,
  type SeatDraft,
} from '../game/setup';
import {
  DEFAULT_RULES,
  PLAYER_COLORS,
  type GameMode,
  type RuleSettings,
  type Seat,
} from '../game/types';
import { clear, el, show, toggleRow } from './dom';

const COUNT_NOTES: Record<number, string> = {
  2: 'Head to head. Your destination is the other player’s starting corner — you move in as they move out.',
  3: 'Every other corner. The only count where all destinations start empty.',
  4: 'Two opposing pairs. Each destination is another player’s starting corner.',
  5: 'Unbalanced: five corners in play, one sits empty. Offered, but 4 or 6 plays better.',
  6: 'The full board. Every destination is another player’s starting corner.',
};

const MODES: { mode: GameMode; label: string; note: string }[] = [
  {
    mode: 'classic',
    label: 'Classic',
    note: 'Hop over a marble standing next to you, into the empty hole just beyond.',
  },
  {
    mode: 'super',
    label: 'Super',
    note: 'Super Chinese Checkers: jump a marble any distance away, as long as the holes between are empty and you land the same distance beyond it. Marbles cross the board fast, and games are much shorter.',
  },
];

const RULE_COPY: { key: 'antiSpoilWin' | 'noRestingInOtherCorners' | 'noLeavingHome' | 'endOnFirstWinner'; title: string; description: string }[] = [
  {
    key: 'antiSpoilWin',
    title: 'Anti-spoiling win',
    description:
      'Win once your destination is full and most of it is yours, so an opponent cannot park a marble in your home forever.',
  },
  {
    key: 'noRestingInOtherCorners',
    title: 'No resting in other corners',
    description: 'Marbles may hop through a corner that is not theirs, but not end the turn in it.',
  },
  {
    key: 'noLeavingHome',
    title: 'No leaving home',
    description: 'Once a marble reaches its destination corner it may not move back out.',
  },
  {
    key: 'endOnFirstWinner',
    title: 'End on first winner',
    description: 'Stop as soon as somebody wins instead of playing on for 2nd, 3rd and so on.',
  },
];

export interface SetupResult {
  seats: Seat[];
  rules: RuleSettings;
}

export interface SetupHandlers {
  onPreview(seats: Seat[]): void;
  onStart(result: SetupResult): void;
  onBack(): void;
}

export class SetupScreen {
  private readonly root = el('screen-setup');
  private readonly picker = el('count-picker');
  private readonly note = el('count-note');
  private readonly modePicker = el('mode-picker');
  private readonly modeNote = el('mode-note');
  private readonly seatList = el('seat-list');
  private readonly teamsRow = el<HTMLLabelElement>('teams-row');
  private readonly teamsToggle = el<HTMLInputElement>('teams-toggle');
  private readonly ruleToggles = el('rule-toggles');
  private readonly variantsScreen = el('screen-variants');
  private readonly variantsButton = el('btn-rule-variants');

  private count = 2;
  private drafts: SeatDraft[] = defaultSeatDrafts(2);
  private teams = false;
  private rules: RuleSettings = { ...DEFAULT_RULES };

  constructor(private readonly handlers: SetupHandlers) {
    this.buildCountPicker();
    this.buildModePicker();
    this.buildRuleToggles();

    this.teamsToggle.addEventListener('change', () => {
      this.teams = this.teamsToggle.checked;
      this.refresh();
    });

    el('btn-start').addEventListener('click', () => {
      this.handlers.onStart({ seats: this.seats(), rules: { ...this.rules, teams: this.teams } });
    });
    el('btn-setup-back').addEventListener('click', () => this.handlers.onBack());

    // Rule variants live on their own panel so setup itself never has to scroll.
    this.variantsButton.addEventListener('click', () => this.showVariants(true));
    for (const id of ['btn-variants-back', 'btn-variants-done']) {
      el(id).addEventListener('click', () => this.showVariants(false));
    }
  }

  show(): void {
    show(this.variantsScreen, false);
    show(this.root, true);
    this.refresh();
  }

  hide(): void {
    show(this.root, false);
    show(this.variantsScreen, false);
  }

  /** The variants panel replaces the setup screen rather than stacking on it. */
  private showVariants(open: boolean): void {
    show(this.variantsScreen, open);
    show(this.root, !open);
    if (!open) this.refresh();
  }

  private seats(): Seat[] {
    return createSeats(this.drafts, this.teams);
  }

  private buildCountPicker(): void {
    clear(this.picker);
    for (let count = MIN_PLAYERS; count <= MAX_PLAYERS; count++) {
      const node = document.createElement('button');
      node.type = 'button';
      node.textContent = String(count);
      node.setAttribute('aria-label', `${count} players`);
      node.addEventListener('click', () => this.setCount(count));
      this.picker.append(node);
    }
  }

  private buildModePicker(): void {
    clear(this.modePicker);
    for (const option of MODES) {
      const node = document.createElement('button');
      node.type = 'button';
      node.textContent = option.label;
      node.dataset.mode = option.mode;
      node.addEventListener('click', () => {
        this.rules = { ...this.rules, mode: option.mode };
        this.refresh();
      });
      this.modePicker.append(node);
    }
  }

  private buildRuleToggles(): void {
    clear(this.ruleToggles);
    for (const rule of RULE_COPY) {
      const { row, input } = toggleRow(rule.title, rule.description, this.rules[rule.key]);
      input.addEventListener('change', () => {
        this.rules = { ...this.rules, [rule.key]: input.checked };
      });
      this.ruleToggles.append(row);
    }
  }

  private setCount(count: number): void {
    if (count === this.count) return;
    this.count = count;

    const next = defaultSeatDrafts(count);
    // Keep whatever the player already typed for the seats that still exist.
    for (let i = 0; i < Math.min(next.length, this.drafts.length); i++) {
      next[i] = { ...this.drafts[i] };
    }
    this.drafts = next;

    if (!supportsTeams(count)) {
      this.teams = false;
      this.teamsToggle.checked = false;
    }
    this.refresh();
  }

  private refresh(): void {
    for (const node of Array.from(this.picker.children) as HTMLButtonElement[]) {
      node.setAttribute('aria-pressed', String(Number(node.textContent) === this.count));
    }
    this.note.textContent = COUNT_NOTES[this.count] ?? '';
    this.note.style.color = isBalanced(this.count) ? '' : '#f0b93b';

    for (const node of Array.from(this.modePicker.children) as HTMLButtonElement[]) {
      node.setAttribute('aria-pressed', String(node.dataset.mode === this.rules.mode));
    }
    this.modeNote.textContent = MODES.find((option) => option.mode === this.rules.mode)?.note ?? '';

    // A dot marks the panel as customised, since it is now out of sight.
    const customised = RULE_COPY.some((rule) => this.rules[rule.key] !== DEFAULT_RULES[rule.key]);
    this.variantsButton.textContent = customised ? 'Rule variants •' : 'Rule variants';

    show(this.teamsRow, supportsTeams(this.count));
    el('teams-note').textContent =
      this.count === 6
        ? 'Two teams of three, holding alternating corners.'
        : 'Two teams of two, partners sitting opposite.';

    const seats = this.seats();
    this.renderSeats(seats);
    this.handlers.onPreview(seats);
  }

  private renderSeats(seats: Seat[]): void {
    clear(this.seatList);
    // Three across, except where two even rows tile more neatly than 3 + 1.
    const columns = seats.length <= 2 ? seats.length : seats.length === 4 ? 2 : 3;
    this.seatList.style.setProperty('--seat-columns', String(columns));

    seats.forEach((seat, index) => {
      const row = document.createElement('div');
      row.className = 'seat';

      const color = PLAYER_COLORS[seat.colorIndex];
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.style.background = color.css;
      swatch.style.color = color.ink;
      swatch.textContent = color.glyph;
      swatch.setAttribute('aria-label', `${seat.name} colour: ${color.name}. Tap to change.`);
      swatch.addEventListener('click', () => this.cycleColor(index));

      const name = document.createElement('input');
      name.type = 'text';
      name.value = seat.name;
      name.maxLength = 14;
      name.setAttribute('aria-label', `Name for player ${index + 1}`);
      name.addEventListener('input', () => {
        this.drafts[index] = { ...this.drafts[index], name: name.value };
      });

      const tag = document.createElement('span');
      tag.className = 'corner-tag';
      tag.textContent = `${seat.corner} → ${seat.dest}`;
      if (this.teams) {
        tag.append(document.createElement('br'), `Team ${seat.team + 1}`);
      }

      row.append(swatch, name, tag);
      this.seatList.append(row);
    });
  }

  private cycleColor(index: number): void {
    const taken = new Set(this.drafts.map((draft) => draft.colorIndex));
    let next = this.drafts[index].colorIndex;
    for (let step = 1; step <= PLAYER_COLORS.length; step++) {
      const candidate = (this.drafts[index].colorIndex + step) % PLAYER_COLORS.length;
      if (!taken.has(candidate)) {
        next = candidate;
        break;
      }
    }
    this.drafts[index] = { ...this.drafts[index], colorIndex: next };
    this.refresh();
  }
}
