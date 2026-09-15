/** Device and browser quirks, mostly iOS Safari. */

/** True on iPhone/iPad, including iPadOS which reports itself as a Mac. */
export const isIOS = (() => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ pretends to be macOS, but a Mac has no touch.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
})();

/** True when launched from the home screen as an installed web app. */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return (
    iosStandalone ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches
  );
}

/** iOS Safari has no Vibration API at all, so the haptics setting is hidden there. */
export const supportsVibration = typeof navigator.vibrate === 'function';

/**
 * Stops Safari treating game input as page gestures.
 *
 * `touch-action` handles most of it (`pan-y` on the body so overlays still
 * scroll, `none` on the canvas so two-finger camera moves work), but iOS also
 * fires its own non-standard pinch `gesture*` events, and double-tap zoom needs
 * blocking anywhere that is not a control the player is tapping twice.
 */
export function hardenTouchInput(): void {
  const block = (event: Event) => event.preventDefault();
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, block, { passive: false });
  }

  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (event) => {
      const now = Date.now();
      const target = event.target as HTMLElement | null;
      // Never swallow the second tap on a control: that would eat its click.
      const interactive = target?.closest('button, input, select, summary, label, a');
      if (!interactive && now - lastTouchEnd < 320) event.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );

  // Multi-touch anywhere outside the canvas is always a zoom attempt.
  document.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );
}
