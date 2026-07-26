/**
 * The award frame's subject key: what a click focuses, what the fly cam's
 * crosshair picks, and what the movie camera cuts to. Lives here, in the module
 * with no imports, because both the component and `movieShots` need it.
 */
export const EOTM_KEY = 'eotm';

/** Frame aperture, in world units. Landscape, matching a 16:9 canvas capture. */
export const EOTM_W = 1.42;
export const EOTM_H = 0.8;

/** Room for the plaque under the photo. */
export const EOTM_CAPTION_H = 0.26;

const NAME_MAX = 24;

/**
 * The two lines on the plaque. The name is truncated rather than wrapped — the
 * plaque is one line tall, and a hand-edited roster name could be any length.
 */
export function captionLines(name: string): string[] {
  const trimmed = name.trim();
  return ['EMPLOYEE OF THE MONTH', trimmed ? trimmed.slice(0, NAME_MAX) : '—'];
}
