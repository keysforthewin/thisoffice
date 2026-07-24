# Imported Character Scale Adjustment — Design

**Date:** 2026-07-24
**Status:** Approved

## Problem

Imported Mixamo characters can come in at the wrong size (one import rendered far too small to fit its chair). The importer height-normalizes to 1.72 units by measuring the bounding box of the whole FBX group (`web/src/importer/convert.ts`), which stray non-mesh helper nodes can inflate, shrinking the character. There is also no way to correct proportions after import.

## Goals

- Real-time scale adjustment for imported characters, visible live in both the picker preview and the office scene.
- Scale persists per character across sessions (server-side).
- Fix the root-cause height measurement so future imports land correctly.

Non-goals: scale controls for built-in KayKit characters; re-baking the GLB asset.

## Approach

A runtime `scale` multiplier stored in import metadata and served through the merged catalog, applied as a wrapper scale at render time. Chosen over re-baking the GLB (slow, no live feedback, cache-busting) and over client-only storage (no persistence).

## Changes

### Shared

- `shared/types.ts` — `CharacterEntry` gains `scale?: number`: runtime multiplier applied on top of the baked GLB's normalized scale. Absent means 1.

### Server

- `server/src/characters.ts` — `ImportedMeta` gains `scale?: number`. `mergedCatalog()` includes it on imported entries. New `CharacterStore.setScale(id, scale)` clamps to [0.1, 10], persists to `imported.json`, returns false for unknown ids.
- `server/src/index.ts` — `PATCH /api/characters/:id` with JSON body `{ scale: number }`. Rejects builtin ids (404) and non-finite scales (400). On success, re-broadcasts the catalog to all clients (existing `broadcastCatalog` path), which updates every connected office scene live.

### Client rendering

- `web/src/scene/Person.tsx` — look up the catalog entry (already fetched) and apply `scale={entry?.scale ?? 1}` on the wrapper group.
- `web/src/settings/picker/CharacterPreview.tsx` — same multiplier on the preview model wrapper.

### Client UI

- `CharacterPreview` footer: when `entry.pack === 'Mixamo'`, show a **Size** slider — logarithmic, 0.1× to 10×, with numeric readout (e.g. "1.25×") and a reset-to-1× button.
- Dragging updates the catalog entry in the zustand store immediately (instant feedback in preview and office scene); a ~300 ms debounced `PATCH` persists it. The server's catalog broadcast keeps other clients in sync; the local optimistic update means no flicker for the dragging client.

### Importer fix

- `convertCharacter` measures height from a `Box3` expanded over skinned meshes only, instead of the whole group, so helper nodes no longer distort the normalization.

## Error handling

- PATCH with unknown id → 404; invalid scale → 400; values silently clamped to [0.1, 10] otherwise.
- If the PATCH fails, the slider keeps working locally for the session; the persisted value simply lags (next successful PATCH wins). No error modal — this is a tuning control.

## Testing

- `server/src/characters.test.ts` — setScale clamping, rejection of unknown ids, scale surviving the metadata round-trip into `mergedCatalog()`.
- `web/src/importer/convert.test.ts` — height measurement ignores non-skinned nodes.
- Manual: import a character, drag the slider, confirm live resize in preview and office scene, reload and confirm persistence.
