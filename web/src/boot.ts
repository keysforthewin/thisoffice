/**
 * Teardown for the #boot loading screen that index.html paints before any of
 * this bundle exists. Idempotent — several readiness signals race to call it.
 */

const FADE_MS = 450; // must match the #boot opacity transition in index.html

let dismissed = false;

export function dismissBootScreen() {
  if (dismissed) return;
  dismissed = true;
  const el = document.getElementById('boot');
  if (!el) return;
  el.classList.add('boot-done');
  window.setTimeout(() => el.remove(), FADE_MS + 50);
}

/**
 * Backstop: a missing asset, an offline server, or a WebGL failure must never
 * leave the user staring at a spinner forever — show whatever we have instead.
 */
export function armBootScreenTimeout(ms = 15000) {
  window.setTimeout(dismissBootScreen, ms);
}
