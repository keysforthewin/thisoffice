# Scrollable Stats TV

Date: 2026-07-25
Status: approved

## Goal

Make the wall-mounted Stats TV interactive: click it to focus the camera on it
(same pattern as clicking an employee monitor), then use the scroll wheel to
page through the stat pages manually. Auto-cycling pauses while focused and
resumes on exit.

## Behavior

- **Click to focus**: clicking the TV screen plane (or crosshair-clicking it in
  pointer-locked fly mode) enters the existing focus camera mode with target
  `'tv'`. `subjectFor('tv')` already frames it; no camera work needed.
- **Hover feedback**: pointer cursor + `monitorHover` highlight, same as
  employee monitors.
- **While focused**: auto page-cycling pauses on the page shown at focus entry.
  Each wheel tick moves exactly one page (wheel down → next, wheel up →
  previous), wrapping around the page list. The existing page dots show
  position.
- **On exit** (Esc / click away): focus mode ends via the existing paths;
  auto-cycling resumes from the clock as before. No manual page state persists.

## Implementation

1. **`store.ts`** — no new state. The existing `focusScroll` counter (already
   reset to 0 on every camera-mode change) doubles as the TV page offset.
2. **`tvContent.ts`** — no changes. `tvContent()` already wraps any integer
   (including negatives) modulo the page list. Add a small pure helper
   `tvPageIndex(autoPage, focusedBase, focusScroll)` that resolves the
   displayed page index: `focusedBase + focusScroll` when focused (base
   captured at focus entry), else `autoPage`.
3. **`WallTV.tsx`** — add `userData={{ monitorTarget: 'tv' }}` plus
   `onPointerDown`/`onPointerEnter`/`onPointerLeave` handlers (same guards as
   `MonitorScreen.tsx`: skip when pointer-locked or in build mode) on the
   screen plane. In `useFrame`, capture the clock page into a ref when focus on
   `'tv'` begins; render `tvPageIndex(...)`.
4. **`CameraRig.tsx` `FocusControls`** — branch on `target === 'tv'`: a wheel
   tick calls `setFocusScroll(focusScroll ± 1)` with no clamping (wrap handled
   by `tvContent`). Other targets keep the existing scrollback path.
   Fly-cam crosshair clicks work for free via `pickMonitorTarget`.

## Edge cases

- Stats warming up → single page; scrolling wraps onto itself (no-op).
- Page list grows/shrinks while focused (a stat crosses zero) → modulo
  re-wraps; harmless.
- TV focused then office layout changes → `focusPose` recomputes from
  `subjectFor('tv')` as it already does for boards.

## Testing

- Unit tests for `tvPageIndex` (auto vs focused, negative offsets, wrap via
  `tvContent`).
- Existing `tvContent` wrap tests already cover modulo behavior.
- Manual browser check: click TV, scroll both directions, exit, confirm
  auto-cycle resumes.
