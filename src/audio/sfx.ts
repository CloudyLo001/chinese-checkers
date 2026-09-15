/** Tiny WebAudio blips. No files, so nothing to download and nothing to cache. */

type Sound = 'select' | 'step' | 'hop' | 'invalid' | 'turn' | 'win';

const RECIPES: Record<Sound, { freq: number; to: number; ms: number; type: OscillatorType; gain: number }> = {
  select: { freq: 520, to: 660, ms: 70, type: 'sine', gain: 0.05 },
  step: { freq: 320, to: 240, ms: 90, type: 'sine', gain: 0.06 },
  hop: { freq: 440, to: 720, ms: 110, type: 'triangle', gain: 0.06 },
  invalid: { freq: 180, to: 120, ms: 130, type: 'sawtooth', gain: 0.04 },
  turn: { freq: 640, to: 880, ms: 140, type: 'sine', gain: 0.05 },
  win: { freq: 520, to: 1180, ms: 420, type: 'triangle', gain: 0.07 },
};

let context: AudioContext | null = null;
let enabled = true;
let hapticsEnabled = true;

export function setSoundEnabled(value: boolean): void {
  enabled = value;
}

export function setHapticsEnabled(value: boolean): void {
  hapticsEnabled = value;
}

/**
 * Browsers only allow audio after a gesture; call this from the first tap.
 * On iOS the context must also be *created* inside that gesture, and it gets
 * suspended again every time the app is backgrounded, so this is safe to call
 * repeatedly and is wired to every pointerdown.
 */
export function unlockAudio(): void {
  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context = new Ctor();
  }
  if (context.state === 'suspended') void context.resume();
}

/** Called when the app returns to the foreground; iOS suspends on background. */
export function resumeAudio(): void {
  if (context && context.state === 'suspended') void context.resume();
}

export function play(sound: Sound): void {
  if (!enabled || !context || context.state !== 'running') return;
  const recipe = RECIPES[sound];
  const now = context.currentTime;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = recipe.type;
  oscillator.frequency.setValueAtTime(recipe.freq, now);
  oscillator.frequency.exponentialRampToValueAtTime(recipe.to, now + recipe.ms / 1000);
  gain.gain.setValueAtTime(recipe.gain, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + recipe.ms / 1000);

  oscillator.connect(gain).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + recipe.ms / 1000 + 0.02);
}

export function vibrate(pattern: number | number[]): void {
  if (!hapticsEnabled) return;
  navigator.vibrate?.(pattern);
}
