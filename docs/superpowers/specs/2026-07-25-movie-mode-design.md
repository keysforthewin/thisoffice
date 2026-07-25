# Movie Camera Mode — Design

Date: 2026-07-25
Status: Approved

## Purpose

A third camera mode ("movie mode") that automatically follows the action: it
frames whichever monitors/whiteboard are currently receiving content, cutting
to a new randomized shot every few seconds, with a subtle handheld feel within
each shot.

## Controls

- **M** — toggle movie mode from any mode (free or POV tour).
- **Esc** — exit to free camera (existing convention).
- **Any arrow key** (while in movie mode) — cut to a new shot immediately
  instead of waiting for the timer.
- HUD bottom label describes the mode and its keys, matching the existing
  free/POV labels.

## Activity tracking (web/src/store.ts)

- New store field `lastActivity: Record<string, number>` (subject key →
  `Date.now()` ms).
- Stamped inside `applyServerMsg`:
  - A `monitor` message with non-empty `append` stamps `msg.target`
    (`'boss'` or an employee id). Clear-only messages do not stamp.
  - A `state` message stamps `'whiteboard'` when the whiteboard's derived
    content changes — computed by reusing `boardContent()` from
    `scene/whiteboardContent.ts` and comparing its JSON key against the
    previous one (same keying the Whiteboard component already uses).
- A subject is **active** if stamped within the last **10 000 ms**
  (`ACTIVE_WINDOW_MS`).

## Mode plumbing

- `CameraMode` union gains `{ kind: 'movie' }`.
- `CameraRig` renders a `MovieCamera` component when the mode is `movie`
  (alongside the existing free / POV branches).

## Shot solver (web/src/scene/movieShots.ts — pure, unit-tested)

Subjects and their world-space screen rect + facing normal are derived from
`seatTransform` / `whiteboardTransform`:

- Employee monitors face **+z**, the boss monitor faces **−z**, the
  whiteboard faces **−x**. A camera can only see a screen it is in front of
  (camera on the normal side).

Shot selection given the active subject set:

1. **One active subject** — tight close-up: camera along the screen normal at
   a distance where the screen nearly fills the frame (fov-based fit), plus a
   random small yaw/pitch offset (~±15° yaw, ~±8° pitch) so successive
   close-ups differ.
2. **Multiple active, compatible facings** — pick a random view direction
   inside the cone that keeps every screen front-facing (positive dot with
   each normal), then dolly back along it until every screen rect fits the
   frustum with margin.
3. **Incompatible facings** (e.g. boss + employees both active) — impossible
   to see both; the scheduler alternates cuts between the facing groups.
4. **Nothing active** — alternates random wide establishing shots of the
   office (sized from `roomDims`) and random employee close-up B-roll.

## Scheduler + handheld feel (MovieCamera in scene/CameraRig.tsx)

- New shot when any of:
  - the per-shot timer expires (random uniform **3–10 s**),
  - an arrow key is pressed,
  - the active subject set changes (a new monitor lighting up cuts to a shot
    that includes it).
- **Hard cuts** between shots: camera teleports to the new position/target
  (film-editing feel). No glide.
- Within a shot, handheld float layered on the base pose:
  - position noise: sum of slow sinusoids at irrational frequency ratios,
    amplitude a few cm (world scale is 1.35×, so ~0.05 units),
  - slow look-target drift of similar character,
  - a subtle constant pan across the shot's duration.

## Error handling / edge cases

- Employee evicted mid-shot or active set's subject disappears → treated as
  an active-set change → immediate recut.
- No office state yet → wide establishing shot fallback.
- Keyboard handling ignores keypresses while typing in inputs (existing
  `isTyping` guard behavior in App.tsx).

## Addendum (user feedback during implementation)

- The camera must never go below the floor or outside the room: every shot
  position is clamped to y ∈ [0.4, 3.9] and inside the walls (0.3 margin).
- Shots must have line of sight to the screens they frame. Occluders are
  modeled in pure math: two spheres per seated character (head/torso) and
  the monitor panels of other seats. Close-up/group shots pick from up to
  16 jittered candidates (close-up jitter widened to yaw ±35°, pitch
  −5°…+25° so over-the-shoulder angles exist); first fully-clear candidate
  wins, otherwise the most-visible one.
- Handheld motion toned way down: amplitude 0.015 units, all noise
  frequencies ≤ ~0.6 rad/s, drift 0.05, pan 0.08 — a slow breathing drift,
  not a jitter.
- Name tags (separate follow-up): occluded by scene geometry via a
  depth-tested pass, but visible through character models via a
  stencil-masked second pass (characters write stencil ref 1 on zpass;
  Canvas gets `gl={{ stencil: true }}`).

## Testing

- `web/src/scene/movieShots.test.ts` (vitest): active-window selection,
  facing-group partition, fit-distance math (screen fills frame at computed
  distance for the camera fov), close-up offsets stay on the visible side,
  multi-subject shots keep every subject inside the frustum.
- The R3F `MovieCamera` component stays thin (timer + noise + applying the
  solver result) and is not unit-tested, consistent with the codebase.
