import { WALL_ART_ZOOM_MAX, WALL_ART_ZOOM_MIN } from '../../../shared/types.ts';

export interface TextureTransform {
  repeat: [number, number];
  offset: [number, number];
}

export const clampZoom = (zoom: number) =>
  Math.min(WALL_ART_ZOOM_MAX, Math.max(WALL_ART_ZOOM_MIN, Number.isFinite(zoom) ? zoom : 1));

export const clampPan = (pan: number) => Math.min(1, Math.max(-1, Number.isFinite(pan) ? pan : 0));

/**
 * Map an uploaded image onto the painting's canvas plane, cover-fit: the image
 * always fills the frame and the overflowing axis is cropped, so an off-aspect
 * upload is never letterboxed. `zoom` crops further (1 = plain cover fit), and
 * `panX` slides the crop window across the horizontal overflow, -1..1, where
 * ±1 is flush with that edge of the image.
 *
 * Vertical framing stays centred — the wheel only drives zoom and horizontal
 * pan — but a zoomed-in *portrait* image has vertical overflow too, so the
 * offset has to be recentred for it rather than left at 0.
 */
export function wallArtTransform(imgAspect: number, planeAspect: number, zoom: number, panX: number): TextureTransform {
  const z = clampZoom(zoom);
  // fraction of the image sampled on each axis; the wider-relative axis is cropped
  const repeatX = imgAspect >= planeAspect ? planeAspect / imgAspect / z : 1 / z;
  const repeatY = imgAspect >= planeAspect ? 1 / z : imgAspect / planeAspect / z;
  const overflowX = Math.max(0, 1 - repeatX);
  const overflowY = Math.max(0, 1 - repeatY);
  return {
    repeat: [repeatX, repeatY],
    offset: [overflowX / 2 + (clampPan(panX) * overflowX) / 2, overflowY / 2],
  };
}
