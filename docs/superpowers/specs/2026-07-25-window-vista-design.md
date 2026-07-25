# Window Vista: per-window layered cityscape (replaces global skybox)

**Date:** 2026-07-25
**Status:** Approved design, pending implementation plan

## Problem

The exterior city is a single equirect skybox (`web/public/skybox/city.jpg`, ~800KB) set as `scene.background` in `web/src/scene/Skybox.tsx`. Only two window openings ever expose it, so each window shows a small angular slice of an already low-res panorama — it looks blurry and flat. Windows are planned to become movable later, so the exterior view must be attached to each window rather than to the scene.

## Solution overview

Delete the global skybox. Give each of the two windows its own "diorama box": 2–3 unlit image planes at different real distances behind the opening, rendered in the window's local coordinate space. Perspective provides true parallax between layers for free — no shaders, no per-frame cost. Because the planes live in the same `<group>` as the wall/window, moving the window later moves its vista automatically.

## Components

### `WindowVista.tsx` (new, `web/src/scene/`)

Renders layered planes behind a window opening, in local space where the window sits at z=0 and outside is −z.

Per-layer config (constants at top of file, per window id `"back" | "left"`):

| Layer | z (local) | Format | Content |
|---|---|---|---|
| far | ≈ −30 | JPG (no alpha) | sky + distant skyline |
| mid | ≈ −14 | PNG/WebP with alpha | mid-distance buildings, transparent sky |
| near | ≈ −6 | PNG/WebP with alpha | close rooftops/edges, transparent sky |

Material rules:
- `meshBasicMaterial` — unlit, like the old skybox; the city must not receive office lighting or shadows.
- `side: THREE.FrontSide` so layer backs are invisible from outside the room.
- No `castShadow`/`receiveShadow`.
- Textures: `SRGBColorSpace`.

Each plane is sized so that no camera position inside the room can see past its edge through the opening (roughly 12× the opening at the far layer; exact sizing comes from the helper below).

### Plane-sizing helper + test

A pure function (e.g. `vistaPlaneSize(openingW, openingH, layerDist, maxInteriorDist)`) computes the minimum plane dimensions that cover the opening's view frustum from any interior camera position up to `maxInteriorDist` from the window. Lives beside the component (or in `wallOpenings.ts`-style module) with a vitest unit test, following the existing `wallOpenings.test.ts` pattern.

### Composition in `Office.tsx`

`WindowVista` is added inside the same wall `<group>` as each `WallWithWindow` (back wall and left wall), receiving the opening's local offset (`ox`, `oy`) and its window id. No changes to `WallWithWindow`'s strip/glass/mullion rendering. Glass tint stays at opacity 0.1; the warm `#ffd9a0` spill light stays.

### Skybox removal

- `Skybox.tsx` removed from the scene graph and deleted; `web/public/skybox/city.jpg` deleted.
- `scene.background` set to a flat dusk color (single `THREE.Color`) so any uncovered sliver renders as sky, never black.

## Assets

AI-generated (fal.ai) golden-hour dusk skyline, two coherent angles of the same city:

- `web/public/vista/back-far.jpg`, `back-mid.png`, `back-near.png`
- `web/public/vista/left-far.jpg`, `left-mid.png`, `left-near.png`

Constraints:
- Consistent palette and sun position across both views: sun low toward the **back** window, justifying the existing warm spill light.
- Far layers ~2K wide JPG; mid/near ~1.5–2K wide with alpha (PNG or WebP). Total payload should land well under a hypothetical 8K skybox.
- Alpha layers need clean silhouettes; if generation can't produce alpha directly, generate on a flat chroma background and cut alpha in a one-off script step (script may live in `scripts/`, run manually, not part of the build).

## Non-goals

- No stencil masking to hide vistas from an exterior camera. The free-orbit camera flying outside the room may see diorama backs/edges; that's no worse than today's floating-room-in-a-skybox and is acceptable.
- No shader-based parallax (interior mapping) — real geometry is simpler and behaves correctly at grazing angles.
- No day/night cycle or animated exterior.

## Error handling

- Texture load failures fall back to drei `useTexture` suspense/error behavior; the dusk-colored `scene.background` ensures the window never reads black.

## Testing & verification

- Unit: vitest for the plane-sizing helper (edge coverage at grazing interior angles).
- Visual: run via `docker compose up`, screenshot with Chrome DevTools from several orbit positions per window, including hard grazing angles, to confirm no layer edges or gaps are visible and parallax reads correctly.

## Future compatibility

Movable windows: because vista planes are children of the wall group and positioned relative to the opening (`ox`, `oy`), relocating a window is a matter of moving/re-parenting that group — no vista code changes expected.
