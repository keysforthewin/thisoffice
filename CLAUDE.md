# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A 3D WebGL office (Three.js / React Three Fiber) that visualizes live Claude Code sessions: the boss's monitor shows incoming prompts, every tool call / subagent lights up an employee's screen, and the office auto-hires when it runs out of idle employees. The settings picker's Import tab takes both a Mixamo `.fbx` (converted in-browser) and a Blender `.glb` built on the shared skeleton (uploaded verbatim, rig-checked on the way in); KayKit import commands are below. The user-facing path for authoring one is the `office-character` skill plus `docs/blender-characters.md`.

## Commands

- `docker compose up` — the normal way to run: web on :5173, server on :4680. Source is bind-mounted into the containers (no rebuild needed for code changes); `~/.claude` is mounted so the server can tail transcripts and the summarizer can use the `claude` CLI. Local alternative: `npm run dev` (needs `npm install` at the root; workspaces: `server`, `web`).
- `npm test` — vitest run (all tests, from repo root).
- `npx vitest run server/src/office.test.ts` — run a single test file; add `-t "name"` for one test.
- `npm run catalog` — regenerate `web/public/models/characters/catalog.json` after adding/removing character GLBs. Curated names/packs/tags/clip aliases live in `scripts/catalog-meta.json`.
- `npm run vista` — re-measure the window vista artwork after adding or re-exporting any image in `web/public/vista/`, writing `<name>.skirt.json` beside it. Skipping it leaves the new art hanging in midair (see Gotchas).
- `node scripts/import-characters.mjs <extracted-pack-dir> --pack "Name"` — ingest a KayKit pack; `--anims` installs the shared animation library.
- `npm run check-rig -- <file.glb…>` — validate character GLBs against the canonical skeleton (`--json`; `--print-canonical` regenerates the `CANONICAL_BONES` table in `shared/rigCanonical.ts`).
- `npm run promote -- <id> [--pack …] [--name …] [--tags a,b]` — move an imported character out of `data/characters/` into the repo + `catalog-meta.json` and regenerate the catalog. `DATA_DIR=` overrides the source dir, which the Docker setup needs (`data/` is root-owned).

## Architecture

```
~/.claude/projects/**/*.jsonl ──tail──▶ server (Node/tsx, :4680) ──WebSocket──▶ web (Vite + R3F, :5173)
```

Server pipeline (`server/src/`):
- `watcher.ts` — chokidar-tails every transcript JSONL by byte offset; existing files are seeded at current size so only NEW activity renders. `WATCH_POLL=1` in Docker.
- `transcript.ts` — parses JSONL lines into office activity, keyed by toolUseId; matches Task tool calls to subagent transcript files; tool calls inside subagent transcripts fan out to their own employees (only the subagent's text/thinking plus `> Tool` breadcrumbs stay on the Task employee's screen; nested Task calls intentionally not fanned out). Transcripts stream per JSONL line (per content block — no token deltas exist on disk); no batching in the pipeline. Tracks todo/task lists for the whiteboard, and pushes a curated status feed (`office.pushStatus`: boss prompts, Task completions, hires, plan approvals, away summaries, session titles — consecutive duplicates collapse) for the status board. Waiting-for-input: per-transcript-file map; ANY user line clears that file's flag and evicts same-project-dir siblings (resume/fork/compact husks), 10-min stale sweep as backstop — this drives the boss-desk red light. A terminal `stop_reason` sets it, plus `ASK_TOOLS` (`ExitPlanMode`/`AskUserQuestion`), which are user-blocking by name and would otherwise switch the light *off* via their `stop_reason: 'tool_use'`; clicking the blinking light dismisses it — with the cursor, or at the fly cam's crosshair, where `BEACON_TARGET` is an *action* pick rather than a focus subject (like `WALL_ART_TARGET`) and the mesh carries it only while armed, so a dark bulb can't arm a mute for a wait that hasn't happened (`store.beaconMuted` → steady instead of blinking, and `waiting` drops out of the movie camera's shot constraints so it stops framing every shot around it); that mute is client-only and scoped to the wait in progress — `applyServerMsg` clears it the moment the server reports the beacon dark, so the next blocked session blinks again and nothing can get stuck permanently muted. Nothing here answers the session either way. Generic permission prompts are undetectable, since a tool_use awaiting approval and one still running differ only by a missing tool_result and absence is not an event. An ask also publishes `OfficeState.pendingAsk` — summary + menu labels, shown on the `ask/AskBar.tsx` HUD card, the status board and a monitor. It is a readout, not a control: nothing here can answer the session (the server tails files and holds no handle on it), and `setWaitingForInput(false)` clears `pendingAsk` so the card can never outlive the light. Every record type is surfaced: session-level events (slash commands, `!` shell passthrough, hooks, plan mode, API errors, interrupts, away summaries, ai-titles, queued prompts…) claim a free monitor briefly via `showEphemeral` (the boss-reply claim→stream→finish pattern); high-frequency housekeeping (skill listings, turn durations, todo reminders…) batches into a debounced per-file "Office Chores" digest screen. Tool errors/denials end with `✗ failed`/`✗ blocked` instead of `✓ done`; Edit/Write screens show the diff (input preview + `toolUseResult.structuredPatch`). Lines starting `✗ `/`⚠ ` render red/amber on monitors.
- `office.ts` — the state machine: seat assignment, auto-hire/eviction (staffing min/max, idle 60s eviction), FIFO work queue when all desks are full, and persistence to `data/office.json` (roster remembers per-seat name+variant so an evicted seat's occupant returns intact).
- `streamer.ts` — `ScreenStreamer`, server-side typewriter (~1 line/sec base) driving monitor text; rate ratchets under backlog so bursts drain in ~90s; queue pressure multiplies the rate; at max headcount `setBoost` kicks every screen to ~4 lines/sec. Employees stay "working" until their screen drains. A `⟦IMG⟧` screenshot line pauses its queue 5 s (`IMAGE_HOLD_MS`) so the image dwells on the monitor before streaming resumes or the screen frees.
- `summarizer.ts` — shells out to `claude -p --no-session-persistence --model claude-haiku-4-5-20251001` for prompt summaries and new-hire names. `--no-session-persistence` is the feedback-loop guard: without it, the summarizer's own transcripts would be tailed and visualized.
- `characters.ts` + `index.ts` — HTTP API for state/catalog/settings and uploaded character storage (`data/characters/`, gitignored — Mixamo assets must never be committed).
- `stats.ts` — `UsageStats` accumulator persisted to `data/usage.json` and broadcast every 15 s when dirty; the wall TV (`scene/tvContent.ts` builds the pages, `scene/WallTV.tsx` draws them onto a 640×360 canvas) is its only consumer. Per-employee counters (`gameWins`, `charsByEmployee`) are keyed by **name**, not id: a rehire mints a fresh `emp-<ts>-<seat>` id, while the seat roster restores the remembered name. `charsByEmployee` is counted in `watcher.ts`'s streamer `emit` hook — the one path text takes to a monitor after pacing — with `⟦IMG⟧` screenshot lines excluded, since a base64 data URL would swamp every real desk.

Web (`web/src/`):
- `ws.ts` → `store.ts` (zustand) — all server messages flow through `applyServerMsg`; monitor text lives in the store, rendered as in-world CanvasTextures
(`scene/MonitorScreen.tsx`). All *activity* renders on monitors — the sole
speech bubble in the scene is the 20 Questions prompt (`quiz/SpeechBubble.tsx`),
which is game UI needing two clickable targets, not activity telemetry. Two wall boards on the right wall: the todo board shows TodoWrite and TaskCreate/TaskUpdate lists (`whiteboardContent.ts`; an all-completed list expires after 10 min via `todos.at`), and the status board shows the rolling server status feed plus who's working (`statusBoardContent.ts`, always visible). Both are build-mode wall items (`todoBoard`/`statusBoard`), and both are click-to-focus on the same `userData.monitorTarget` channel the TV and the award frame use — so a cursor click and a pointer-locked crosshair click reach them the same way. Their subject keys (`TODO_BOARD_KEY`/`STATUS_BOARD_KEY`) are exported from movieShots.ts and used by the meshes, the POV list and the HUD label, so what you click and what the movie camera shoots cannot drift apart. Like the award frame they have nothing to scroll, so `FocusControls` leaves their wheel alone.
- `scene/` — Office, Desk, Person, CameraRig (free orbit + POV tour), NameTag (camera-facing canvas sprites). **A** inside the POV tour turns it into an auto-follow (`povAuto.ts`, driven by `PovAutoControls`): the over-the-shoulder spot hops between the desks whose screens are streaming (`lastActivity`), holds on a lone worker rather than leaving them, cuts away early from a dead screen while others are live, and with nothing streaming falls back to walking the whole spot list — boards included — one step per `POV_AUTO_MS`. Only desk POVs count as "active": watching a wall board over someone's shoulder is not what the mode is for. It is store state, not persisted, dropped by `setCameraMode` on leaving the tour and by any manual Tab/arrow, so it only ever runs because the viewer just asked for it. Movie-mode shot selection lives in `movieShots.ts` as an authored archetype library with per-shot motion (push-ins, orbit arcs, trucks, board pans, fov zooms — interpolated in `MovieCamera.tsx`, which restores the base fov on exit): each cut walks a weighted ORDER of primary subjects (boss/wall-boards ×2, up to 3 tried) and requires LOS to the chosen one along the whole camera path (start/mid/end); facing-compatible neighbors are framed opportunistically. Candidates are validated (occluders, ≥3.5 u from the previous shot's end) *before* a cut commits, then the shot is locked for ≥5 s (`MIN_HOLD_S`). Urgency shapes selection three ways: (1) live subjects (monitors + todo board) outrank the AMBIENT wall boards, whose activity windows run for minutes, so the camera never parks on set dressing while real work streams — and when nothing live is on offer the *room itself* joins that ambient tier as `IDLE_KEY`, a pseudo-primary that runs the idle pool's wides. That is not a nicety: the TV and status board carry 150-second windows precisely because they are ambient, and a lone stamped one still leaves `subjects` non-empty, so before `IDLE_KEY` every cut for two and a half minutes had exactly one candidate and the camera sat on the TV. It is recorded in `recentPrimaries` like any other primary. Two further rules make that rotation actually rotate, both learned the hard way after the TV still took ~60% of quiet cuts: the AMBIENT surfaces lose the ×2 draw weight (that bonus is for subjects whose activity window is *short*; theirs run for minutes, so it only ever inflated them inside the idle tier) while `IDLE_KEY` carries ×3, and no subject may lead twice running while another is on offer — `IDLE_KEY` exempt, since two idle cuts are two different wides, not the same shot twice. The least-recently-led lookback is also capped at `tier − 2`: cover the whole tier bar one and exactly one candidate is ever fresh, the draw degenerates into a fixed round-robin and the weights stop meaning anything, which is how a stamped TV plus status board bought themselves a guaranteed third of every idle cut each. Measured on the live office, a quiet stretch now runs ~7 room wides to 1 TV; (2) while anything is active the camera stays within `MEDIUM_MAX_MUL` × the primary's fit distance — far/wide coverage is the idle branch's alone, and since fitting two 3.4-u-apart desks needs ~8 u, group archetypes only get offered for a cluster tight enough to shoot inside that ceiling (i.e. never at default spacing); (3) while `office.waitingForInput` blinks the boss-desk beacon, it becomes a subject (`BEACON_KEY`) that every shot must both see AND frame (`pointInFrame` at start/mid/end, at the tightest fov the shot reaches) — it outranks the active-screen preference, and a beacon close-up is the fallback if nothing validates. Two events preempt the hold at `PREEMPT_HOLD_S` (1.5 s): the beacon lighting up, and a new message from upstairs (`store.inboxAlert`, distinct from `lastActivity.boss` which any boss-screen stream also stamps) which additionally forces `'boss'` as the next primary. Only the arrow keys bypass the hold outright.
  Aiming the camera by hand is **right-drag, in every mode** (`scene/dragLook.ts` holds the pure yaw/pitch math plus the "which modes must yield" rule; `DragLookControls` in CameraRig.tsx runs the gesture). It always lands in **first person**, whatever mode it started in, but by two routes (`shouldGrabLockOnDragLook` picks). Out of pov/focus/movie the mode itself has to yield — those each lerp the camera toward a computed pose every frame — so the gesture drops the mode to `free` at the pose already held *and* sets `pendingRelock`, which is what FreeFlyControls' mount effect reads to grab the pointer lock on this same gesture's user activation. Already in free mode nothing is about to mount, so `DragLookControls` requests the lock itself (build mode excepted: the cursor belongs to the furniture there, so it gets the look without the lock) — Chrome does grant activation for a right-button press, and the lock lands before the first move event, so the drag hands straight over to the locked mouse-look (`onPointerMove` bails once locked, and the lock-change resyncs `look` from the live camera so the hand-off cannot snap the view back). Without the relock, right-drag left you one left-click short of first person. The focus→free transition's return glide is suppressed while a drag is live (the `dragLooking` ref), or it would fly the view out from under the drag. It is mounted unconditionally rather than per-mode, because the gesture must survive the very mode change it causes. And every left-click scene handler (monitors, TV, both wall boards, wall art, the desk beacon, both build handles) now guards on `e.button !== 0` — R3F's `onPointerDown` fires for the right button too, so without that a right-drag would also park the camera on a monitor or open the wall-art file dialog. Build mode is the case that had nothing before: it deliberately has no pointer lock (the cursor belongs to the furniture), so right-drag is the *only* way to look around, and `useFlyMotion` — the WASD/E/C half of the fly camera, split out from `FreeFlyControls` — gives it flight to match.
- Kat Person is furniture, not staff, and `OfficeState.katPerson` (settings checkbox, on by default, persisted) takes her out of the room: `resolveFurniture(layout, maxSeat, katPerson)` drops her item, so render, build-mode collision and the quiz bubble's anchor all agree, while her saved position stays in the layout for when she comes back. The server drops her from `quizAskers()` at the same time; an in-flight question of hers keeps its `fallbackAnchor` bubble and stays answerable.
- `settings/picker/` — searchable character picker with live 3D preview; thumbnails are runtime snapshots cached in localStorage (bump `THUMB_REV` in useThumbnails.tsx when framing changes).
- `importer/` — in-browser Mixamo FBX→GLB conversion, and the `.glb` branch (`classifyFile` → `importGlb`) for Blender exports. A GLB uploads **verbatim**: it is already a shared-rig character, and a GLTFExporter round-trip would need the decoders `checkRig` rejects and would uniquify node names — the one property the shared clips bind by. Height differences ride the catalog `scale` field instead of being baked in, and only for an export outside [1.6, 2.8] u (shipped characters run 2.17–2.65 at scale 1, so a tighter rule would shrink normal work).
- `shared/types.ts` — the server↔client protocol (`ServerMsg`, `OfficeState`); both sides import it directly.

Images an agent Reads (e.g. PNGs) reach the monitor as a `⟦IMG⟧<dataURL>` marker line (`MONITOR_IMAGE_MARKER` in shared/types.ts) through the normal streamer queue; the client store intercepts it.

The painting behind the boss is user-replaceable: clicking it opens a file picker (`web/src/wallArt.ts`), the raw image POSTs to `/api/decor/wallart` and is stored in `data/decor/` (gitignored, like uploaded characters); only the metadata — extension plus zoom/pan framing — rides `OfficeState.wallArt`. Hovering it mounts input handlers (`WallArtControls` in CameraRig.tsx): wheel zooms, and holding ctrl turns mouse movement into a two-axis pan (`panX`/`panY`, the image following the cursor), both applied optimistically and PUT on a trailing debounce. Ctrl+wheel still `preventDefault`s without panning, so leaning on ctrl and brushing the wheel can't page-zoom the browser. Note the texture effect must **not** set `needsUpdate` per reframe — that re-uploads the whole image to the GPU, which is invisible at wheel frequency and stalls the room at mousemove frequency; `repeat`/`offset` feed the texture matrix and need no flag. Resetting the layout from the settings panel deletes the image and restores the built-in artwork.

The optional **20 Questions** game (settings checkbox, off by default, zero LLM
calls while off) lives in `server/src/quiz.ts` — a persisted state machine
(`data/quiz.json`) that asks Claude Haiku 4.5 for one question per answered turn
via `haiku.ts` (`claude -p --no-session-persistence`, the same feedback-loop guard
the old summarizer needed). Quiz state rides its own `{type:'quiz'}` message
rather than `OfficeState`, so a question every turn doesn't rebroadcast the whole
office and defeat `stableLayout`. A random employee/boss/Kat Person asks; the
player answers YES/NO on a drei `<Html>` bubble, on a screen-bottom bar
(`quiz/QuestionBar.tsx`, which shows the question in full above the HUD help
line), or with the **Y**/**N** keys — the keys are bound by that bar, so they
only exist while a question is open, and they are the only way to answer while
the fly camera holds pointer lock, since the browser routes clicks to the camera
then. A YES to a guess wins. The award frame is gated on `quiz.enabled`, so an
office that never plays shows a plain wall rather than an empty award frame.
A round has **no question limit and no concession** — it runs until the office
guesses right, since this is ambient play while the agents work. The escape hatch
is `quiz.restart()` (the settings panel's **Reset game**, `POST /api/quiz/restart`):
it discards the round and opens a fresh one, keeping the two things that outlive
every round anyway — the wall photo and the win tally. While a question is open
and no monitor is streaming, the bubble also becomes a movie-camera subject
(`QUIZ_KEY`), sharing the quiet office with the ambient wall boards rather than
outranking live work. The deadline it
replaces (forced guessing from Q15, concede at Q20) was actively harmful: forcing
a name into a field of thousands turned the endgame into celebrity roulette. The
strategy now lives entirely in `quizPrompt.ts`, whose reply schema makes Haiku
state what the answers establish and size the remaining field *before* it writes
the question, and forbids naming anything — a person especially — until that
field is down to a handful. The full history goes into every prompt uncompacted:
a NO is as much of a fact as a YES. **The office never invents a question.** When
Haiku can't produce one — missing CLI, timeout, garbage JSON, or a repeat of a
question already asked — it waits and asks again, backing off from `ASK_RETRY_MS`
to `ASK_RETRY_MAX_MS`, with no attempt limit and no bubble up in the meantime;
a round therefore survives an outage of any length and resumes intact. The canned
question list that used to fill the gap is gone: a question chosen without reading
the round isn't a placeholder that expires with the outage, it's a false fact the
player answers in good faith that then sits in `answers` forever, reading as a
flat contradiction of everything established ("bigger than a microwave? → NO", of
a film star) which the model spends the rest of the round reconciling. That is how
one brief outage turned a round narrowed to a named actress into blind guessing.
Note that `haiku.ts`'s `TIMEOUT_MS` is sized for a *hung* call, not a slow one
(120 s): the prompt carries the whole history and asks for reasoning before the
question, so a turn costing ~8 s early in a round costs ~22 s by question 14 —
the old 30 s ceiling was what actually broke rounds, timing out just as they got
interesting, and it read on the board as "Haiku unavailable".
`QuizAnswer.fallback` survives as a **read-only legacy flag** — nothing writes it,
but rounds recorded before the removal are still on disk mid-play, and
`buildQuizPrompt` filters those turns out. Don't reintroduce a fallback question. On a win the server
asks exactly ONE client (assigned, not elected) to fly the camera to the winner
and POST a canvas capture to `/api/decor/eotm`; that photo hangs in the `eotm`
wall frame until the next winner, under a plaque reading EMPLOYEE OF THE MONTH
and the winner's name (`eotmTexture.ts` paints it; the name rides
`quiz.photo.name`, so it survives the winner being evicted). The frame is
**click-to-focus** like the monitors and the TV — `EOTM_TARGET` is a
`WALL_BOARD_ITEMS` subject sized to photo *plus* plaque, since reading who won
is the point of going over — and it answers the fly cam's crosshair through the
same `userData.monitorTarget` channel. It is the one focus subject with nothing
to scroll, so `FocusControls` leaves the wheel alone there instead of driving
`focusScroll` against an empty history. The movie camera cuts to it too
(`ShotContext.awardFrame`), with two properties no other subject has: it is
**never stamped in `lastActivity`** — a photo hangs there for days, so while the
game is on and someone has won it is simply always on offer — — it used to be rationed to
one cut in three so a silent office couldn't park on a wall hanging, but `IDLE_KEY`
now guarantees the room is always a competing candidate, which solves that for every
ambient subject at once, so the ration is gone. It is an `AMBIENT_KEYS` member for the same reason the
status board is, plus one of its own: permanently in the active set at live rank,
it would both outrank streaming work and stop the quiz bubble ever joining the
cast. A newly hung photo forces the next cut to lead on it — the shot it
interrupts is the winner's own close-up, which has just finished. Its subject
size is the frame's **outer** box, moulding included; the size is what every
archetype fits its distance to, so the moulding is the margin that stops an
oblique shot cropping the plaque. Failure of any kind still credits
the win — `gameWins` on `UsageStats` drives a TV champion page. Screenshots
render-then-`toDataURL` in one tick precisely so `preserveDrawingBuffer` can stay
off.

The shot is a **head-on portrait**, not a group photo (`quiz/photoShot.ts`), and
it is the only place in the room a face can be shot from: a seated character
looks straight at their own monitor, so the camera parks in the ~1.15 u gap
between face and screen, on the character's own facing axis (`askerPose` carries
the rotation the bubble anchor throws away). Both of the numbers that frame it
are measured off the live scene at capture time (`quiz/facePoint.ts`), because
neither is knowable from the layout: the head bone lands anywhere in y 1.51–2.11
depending on character and sit pose, and the face sits above that bone by 0.08 u
on a human and half a unit on Kat Person. Head size drives the standoff — capped
by the monitor for anyone at a desk, which is why a big-headed *seated*
character is framed tighter than a standing one — and the aim point is only a
quarter of the way to the silhouette top, since hats and hair are the difference
between a face in the middle of the frame and a portrait of a hat. Then
`PhotoControls` **holds the shot for `PHOTO_LINGER_MS` (10 s) after the
shutter**: the point of flying over is that the room sees who won, and the
upload lands 1.6 s in. `store.captureHold` is what makes that possible — the
server answers the upload by broadcasting `awaitingPhoto: false`, which would
otherwise clear `pendingCapture`, unmount PhotoControls and snap the camera away
mid-linger. Every other camera path already bails while `pendingCapture` is set,
so the linger is a timer, not a loop.

## Gotchas

- **World scale is ~1.35× human**: desk tops at y=1.0, characters ~2.3 units tall. Preview/POV cameras should look at y≈1.1.
- **three version skew crashes R3F**: root and `web/package.json` must pin the same `three` major, or npm installs a nested copy → "Multiple instances of Three.js" + "Cannot assign to read only property 'position'".
- **AnimationMixer T-pose bugs**: (1) drei `useAnimations` `actions` are null until the group ref mounts — resolve clips in an effect, never a render-time memo. (2) The mixer caches PropertyBindings by (root.uuid, trackName), so swapping a model under a stable mixer root binds clips to the old clone's bones. Fix: remount on variant change (`<Person key={variant}>`; picker preview keys PreviewModel by id).
- **KayKit animation split**: 1.0 packs embed clips (incl. `Sit_Chair_Idle`); 2.0+ packs ship zero clips and rely on the shared library in `web/public/models/characters/_lib/` — clips bind by bone name, no retargeting. Missing clip names go in `clipAliases` in `scripts/catalog-meta.json`.
- **Shared clips bake bone translations, so custom characters must match KayKit proportions**: the `_lib` clips animate `translation` (and `rotation`) on all 23 bones, not just rotation — `Sit_Chair_Idle` also scales `head/spine/chest/handslot.r`. Binding by bone name works only because every KayKit character shares one skeleton; a differently-proportioned mesh gets its joints yanked to the canonical positions and tears. Canonical rest: hips 0.406, upperleg 0.519, shoulders 1.107, head bone 1.241→1.492, legs x ±0.171, `hand.l` x 0.787, mesh top ≈2.2. For a non-KayKit-proportioned character either reshape the mesh to that skeleton first (see `CatPerson.glb`) or use the Mixamo path in `web/src/importer/` — Mixamo fits the rig to the mesh and its clips are rotation-driven, which is exactly what that importer is for. `shared/rigCanonical.ts` is that skeleton as data (local TRS + parent, by **name** — `skins[0].joints` order differs between characters while the transforms are identical), `shared/rigCheck.ts` checks a GLB against it from the JSON chunk alone (no three.js, no `fs`, so browser/server/CLI share it and tests can synthesize fixtures), and `_lib/Rig_Medium_Template.glb` is what users build on. Two things the check deliberately does *not* do: flag a skeleton on a character carrying its own `Sit_Chair_Idle` (it never binds to `_lib`, so the contract does not apply — that is what keeps the 41-bone 1.0 packs clean), and treat anything skeletal as a hard error (a near-miss still imports so the author can see it).
- **The window vista's downward extension is measured from the artwork, per column** (`scene/vistaGeometry.ts`, `scripts/measure-vista.mjs`): each city layer is the artwork quad plus one skirt quad per run of columns sharing a base row, each repeating *its own* building's lowest pixels down to a common floor. It cannot be one held row: a skyline's buildings don't stand on a common ground line, so a single row is sky for every shorter building and those float (measured: 73% of back-skyline's columns, 85% of left-mid's — the "some extend, some don't" bug). The runs are baked next to each image as `<name>.skirt.json`; **run `npm run vista` after adding or re-exporting any vista image**, or the new artwork keeps the old shape. The hold row is inset a few pixels *inside* each building and clamped to that column's opaque span — hold exactly on the alpha edge and bilinear filtering blends it to alpha ≈ 0.5, which `alphaTest: 0.5` discards, silently returning the layer to midair.
- **Wall geometry lives in one place, `scene/walls.ts`** — where each wall is, how a point on it maps to the world, and where a drag ray crosses it. Every wall item (`WALL_ITEMS` in buildLayout.ts) is a `{ wall, ox, oy }` placement: any of the four walls, any along-wall offset, any height. `WALL_SIDES` is **perimeter order** and every wall's `ox` increases in the same rotational direction, which is what makes `carryAroundCorner` a matter of carrying overflow rather than a special case per corner — don't reorder it. Two consequences worth knowing: a bare `number` in `layout.wallItems` is the legacy offset-only shape and is still read (as the item's default wall + height), so don't "clean it up"; and items only collide where they overlap in **both** axes, so a board can hang above another. Windows are wall items too — the wall mesh is the solid remainder around whatever openings are currently on it (`wallStrips` takes a list) — and each keeps its own authored vista set wherever it goes. Since a vista's layers are far wider than its opening (the `back` set spans ~24 u against a 15.2 u wall), the containment clamp is one-sided by necessity: two windows on adjacent walls at extreme offsets can catch a glimpse of each other's city. Anything that needs a board's position asks `resolveWallItem` + `wallToWorld`; there is deliberately no `whiteboardTransform` any more, because a baked-in wall silently keeps aiming where a board used to be.
- **Tests must never touch the real `data/office.json`**: the Office data-file path is injected in tests (see office.test.ts) and vitest excludes worktrees. In Docker, `data/office.json` is root-owned on the host — edit via `docker compose exec server node -e ...`.

## Rendering performance

Press **P** for the fps / draw-call / triangle overlay (`scene/PerfOverlay.tsx`, persisted in localStorage). Reference numbers for a 7-person office at 1080p: ~119 draw calls, ~230k triangles, 60 fps.

The scene is fragment- and CPU-bound, not geometry-bound — 119 draw calls is nothing. Four things keep it that way; each is easy to undo by accident.

- **The shadow map is driven manually** (`scene/ShadowControl.tsx`). The one shadow-casting light is a *point* light, so every update is a 6-face cube = 6 extra full scene renders. `gl.shadowMap.autoUpdate` is off; refreshes are triggered by layout/roster/catalog changes, a 500 ms heartbeat (so animated characters' shadows stay current), and **every frame while build mode or a drag is active** — dragging furniture moves shadow casters, so build mode deliberately pays the old cost. Build mode is therefore a live A/B of the freeze: it shows ~671 calls / 1.6M triangles / 52 fps against 119 / 230k / 60 outside it. Don't "simplify" this to a plain `autoUpdate = true`.
- **Labels are culled at both ends of the distance range.** Far is `MAX_TAG_DISTANCE`; near is `fillsView` in `nametagVisibility.ts`, shared by nametags (cull past 20% of frame height) and the quiz bubble (62%, since it is a readable card and meant to be big). It is measured as a **fraction of the screen, not in world units**, because the movie camera zooms fov mid-shot — at 18° a tag that was unobtrusive at 50° covers three times the frame from the same spot. Hiding the bubble is safe at any distance only because the QuestionBar and the Y/N keys keep the question answerable.
- **Nametag occlusion is the most expensive thing in the scene** (`scene/nametagVisibility.ts`, `scene/NameTag.tsx`): 9 raycasts per tag. It is throttled to ~100 ms with a random per-tag phase, skipped entirely when the tag is off-frustum or past `MAX_TAG_DISTANCE`, and cast against a **flat occluder list rebuilt every 500 ms** rather than recursively against the scene root (which re-walks every skeleton, 9 × N times per frame). `tagSamplePoints` returns a **module-level scratch array** — read it before calling again, never retain it.
- **Adaptive DPR rungs must be clamped to `window.devicePixelRatio`** (`scene/AdaptiveQuality.tsx`, `qualityLadder`). `dpr` is an absolute device-pixel ratio, not a fraction of native: on a 1× display an unclamped 1.25 rung renders 56% *more* pixels while claiming to reduce quality, and the feedback loop makes a struggling machine worse (measured: 5.2 → 15.6 fps under 6× CPU throttle once clamped). On a 1× display the ladder correctly collapses to one rung and adaptation no-ops.
- **Canvas surfaces must not re-derive content every frame.** The wall boards and TV used to `JSON.stringify` their whole payload 60×/s just to decide whether to repaint. They now gate on reference identity plus a slow poll (`scene/redrawGate.ts`); the TV needs no stringify at all since `stats` is replaced wholesale.

Two supporting invariants: `store.ts` `stableLayout` carries the previous `office.layout` reference forward when it is deep-equal, because ws.ts `JSON.parse`s every message and a dozen components subscribe to `layout` — without it `React.memo` on `Desk`/`Person` is defeated before it runs. And `Person` is memoized with an **explicit comparator** because `position` arrives as a fresh array literal each render.
