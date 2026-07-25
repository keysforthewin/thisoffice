# Camera shot library, screenshot dwell, character seat sliders, office environment — design

Date: 2026-07-25. Four independent features, approved together; each can ship separately.

## 1. Movie camera: authored shot library

### Problems being fixed

- Consecutive cuts sometimes land a few units apart — a hard cut to almost the same view.
- No high or overhead shots ever appear.
- Root cause of the missing high shots: `hasLineOfSight` tests head/torso spheres for **every** occupied seat, including the subject's own occupant, who sits directly between any elevated camera and their screen — so nearly all high candidates fail LOS.
- Camera "jitter": a shot is chosen, then a split second later `activeSetKey` changes and forces an instant recut.

### Shot archetypes (in `movieShots.ts`)

Two pools of named archetypes replace the current jitter-only sampling:

**Targeted pool** (one or more active monitors):

| Archetype | Placement |
|---|---|
| `otsCloseup` | current over-shoulder close-up |
| `highAngle` | above and in front of the screen, pitched down 45–65° |
| `sideProfile` | roughly perpendicular to the screen normal, showing character + screen at an angle |
| `elevatedGroup` | current group shot, sampled from y 2.8–3.8 |

**Idle pool** (no active monitors — B-roll):

| Archetype | Placement |
|---|---|
| `overheadGod` | near-ceiling, looking down 55–75° at the desk cluster |
| `highCorner` | a room corner at y≈3.2 |
| `lowDolly` | y≈1.2, across the desk rows |
| `wideEstablishing` | current wide shot, height range widened |

### Cut logic — validate first, then commit

1. Pick an archetype from the applicable pool, excluding the last two archetypes used in that pool.
2. Sample up to N candidate positions for it. A candidate is valid only if **all** hold *before* the cut:
   - line of sight to the subject(s) (see relaxed rules below),
   - not inside an occluder,
   - `distanceTo(previousShotPosition) ≥ MIN_SHOT_DIST` (~3.5 world units).
3. No valid candidate → fall through to the next archetype (then to the existing unvalidated fallback as a last resort).
4. The chosen shot is **committed**: nothing repositions or re-evaluates mid-shot. The only in-shot motion is the existing handheld sinusoid noise.

### Minimum hold (jitter fix, in `MovieCamera.tsx`)

A shot holds for at least `MIN_HOLD_S` (~2.5 s). Active-set changes and the 3–10 s cut timer can only trigger a cut after the hold expires (a pending set-change cut fires as soon as the hold ends). Arrow keys still cut immediately — deliberate user input.

### Line-of-sight relaxation

- Skip the subject's **own seat's person** in `hasLineOfSight` (their own monitor is already skipped; seeing over their shoulder is the desired framing).
- Shrink the body spheres: head 0.35 → 0.30, torso 0.45 → 0.40.

### Testing

All selection logic stays in pure functions in `movieShots.ts`; extend `movieShots.test.ts`: archetype rotation (never repeats within last two), min-distance rejection, high-angle candidates passing LOS with the own-person exclusion, commit semantics (pickShot output is final).

## 2. Screenshot dwell on monitors (5 s)

Server-side, in `ScreenStreamer` (`server/src/streamer.ts`):

- When a tick would emit a chunk containing a line starting with `MONITOR_IMAGE_MARKER`, emit only up to and including that line, then set `holdUntil = now + IMAGE_HOLD_MS` (5000) on that queue.
- Held queues are skipped by the ticker until the hold expires; `isDraining` stays `true` throughout, so the office keeps the employee "working" and won't stream the next tool's output over the image.
- If the image line is the last line, `drained()` fires only after the hold expires.
- Client unchanged — the store already keeps the image until subsequent lines arrive.
- Tests in `streamer.test.ts` with fake timers: hold splits an emission at the image line, drained is deferred, employee stays draining during the hold.

## 3. Character seat sliders + seated preview

### Data & API

`CharacterMeta` (server `characters.ts`, `shared/types.ts` catalog entry) gains:

- `seatOffset` — vertical offset of the **character only**, range ±0.5, default 0. Plants the character on the chair seat.
- `chairHeight` — vertical offset of the **chair + character as a unit**, range ±0.4, default 0. Lines the hands up with the desk.

Both clamped server-side like `scale`, saved via the same per-character settings endpoint, delivered through the catalog so the live office applies them.

### Scene application

- `Person.tsx` applies `seatOffset` to the character's local y (nametag/collider math follows the shifted head).
- `Desk.tsx` applies `chairHeight` to the chair+person group's y.

### Picker preview (`CharacterPreview.tsx`)

For Mixamo characters, the preview renders the character **sitting at a real desk + chair** — same furniture models and offsets as `Desk.tsx`, sit animation playing — instead of a floating model. Three sliders below: Size (existing), Seat offset, Chair height, each with reset. Camera framed from slightly above-side so desk-top, hands, and seat contact are all visible (look at y≈1.1 per world scale). Non-Mixamo (KayKit) entries keep the current preview and show no offset sliders.

## 4. Skybox, ceiling, visible lights, windows, camera cage

- **Skybox**: one realistic equirectangular urban-city panorama generated via fal.ai, committed to `web/public/skybox/`, loaded as `scene.background` with equirectangular mapping. Static — no motion, no per-frame cost.
- **Ceiling**: room height rises to ~7.5 units (walls extend up; `roomDims` grows a `height`). Flat ceiling mesh across the room. 4–6 hanging light fixtures (thin box housing + emissive panel + small point light each) replace the single invisible overhead point light. Total light count stays modest; shadow-casting stays on at most one source.
- **Windows**: rebuild the back wall as segments around a real opening; the opening gets a barely-tinted transparent plane (simple transparent material, not transmission) with the existing mullions, so the skybox shows through. The fake dusk-glow planes go away; the warm spill point light stays. A second identical window goes on the **left** side wall (right wall holds the whiteboard).
- **Camera cage**: the free-fly camera (and the focus-return glide) clamps to the room every frame via `clampToRoom`; its vertical limit rises to just under the new ceiling. Movie and focus cameras already clamp. The camera can never leave the office.

### Testing

`roomDims` height and clamp bounds covered in existing layout/movieShots tests; wall-segment math (opening rectangles) unit-tested if extracted as a helper. Visual work (skybox, fixtures, glass) verified in the running app.
