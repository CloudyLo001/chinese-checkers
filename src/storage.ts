/** localStorage save/restore for the in-progress game and the app settings. */

import { deserialize, serialize, type GameState, type SavedGame } from './game/state';
import { DEFAULT_APP_SETTINGS, type AppSettings } from './game/types';

const GAME_KEY = 'chinese-checkers:game';
const SETTINGS_KEY = 'chinese-checkers:settings';

export function saveGame(state: GameState): void {
  try {
    localStorage.setItem(GAME_KEY, JSON.stringify(serialize(state)));
  } catch {
    // Private mode or a full quota: the game keeps working, it just cannot resume.
  }
}

export function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(GAME_KEY);
    if (!raw) return null;
    return deserialize(JSON.parse(raw) as SavedGame);
  } catch {
    return null;
  }
}

export function clearGame(): void {
  try {
    localStorage.removeItem(GAME_KEY);
  } catch {
    /* ignore */
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    return { ...DEFAULT_APP_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}
