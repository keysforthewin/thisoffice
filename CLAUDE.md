# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A 3D WebGL office (Three.js / React Three Fiber) that visualizes live Claude Code sessions: the boss's monitor shows incoming prompts, every tool call / subagent lights up an employee's screen, and the office auto-hires when it runs out of idle employees. The Mixamo import flow lives in the settings picker's Import tab; KayKit import commands are below.

## Commands

- `docker compose up` — the normal way to run: web on :5173, server on :4680. Source is bind-mounted into the containers (no rebuild needed for code changes); `~/.claude` is mounted so the server can tail transcripts and the summarizer can use the `claude` CLI. Local alternative: `npm run dev` (needs `npm install` at the root; workspaces: `server`, `web`).
- `npm test` — vitest run (all tests, from repo root).
- `npx vitest run server/src/office.test.ts` — run a single test file; add `-t "name"` for one test.
- `npm run catalog` — regenerate `web/public/models/characters/catalog.json` after adding/removing character GLBs. Curated names/packs/tags/clip aliases live in `scripts/catalog-meta.json`.
- `node scripts/import-characters.mjs <extracted-pack-dir> --pack "Name"` — ingest a KayKit pack; `--anims` installs the shared animation library.

## Architecture

```
~/.claude/projects/**/*.jsonl ──tail──▶ server (Node/tsx, :4680) ──WebSocket──▶ web (Vite + R3F, :5173)
```

Server pipeline (`server/src/`):
- `watcher.ts` — chokidar-tails every transcript JSONL by byte offset; existing files are seeded at current size so only NEW activity renders. `WATCH_POLL=1` in Docker.
- `transcript.ts` — parses JSONL lines into office activity, keyed by toolUseId; matches Task tool calls to subagent transcript files; tool calls inside subagent transcripts fan out to their own employees (only the subagent's text/thinking plus `> Tool` breadcrumbs stay on the Task employee's screen; nested Task calls intentionally not fanned out). Transcripts stream per JSONL line (per content block — no token deltas exist on disk); no batching in the pipeline. Tracks todo/task lists for the whiteboard, and pushes a curated status feed (`office.pushStatus`: boss prompts, Task completions, hires, plan approvals, away summaries, session titles — consecutive duplicates collapse) for the status board. Waiting-for-input: per-transcript-file map; ANY user line clears that file's flag and evicts same-project-dir siblings (resume/fork/compact husks), 10-min stale sweep as backstop — this drives the boss-desk red light. Every record type is surfaced: session-level events (slash commands, `!` shell passthrough, hooks, plan mode, API errors, interrupts, away summaries, ai-titles, queued prompts…) claim a free monitor briefly via `showEphemeral` (the boss-reply claim→stream→finish pattern); high-frequency housekeeping (skill listings, turn durations, todo reminders…) batches into a debounced per-file "Office Chores" digest screen. Tool errors/denials end with `✗ failed`/`✗ blocked` instead of `✓ done`; Edit/Write screens show the diff (input preview + `toolUseResult.structuredPatch`). Lines starting `✗ `/`⚠ ` render red/amber on monitors.
- `office.ts` — the state machine: seat assignment, auto-hire/eviction (staffing min/max, idle 60s eviction), FIFO work queue when all desks are full, and persistence to `data/office.json` (roster remembers per-seat name+variant so an evicted seat's occupant returns intact).
- `streamer.ts` — `ScreenStreamer`, server-side typewriter (~1 line/sec base) driving monitor text; rate ratchets under backlog so bursts drain in ~90s; queue pressure multiplies the rate; at max headcount `setBoost` kicks every screen to ~4 lines/sec. Employees stay "working" until their screen drains. A `⟦IMG⟧` screenshot line pauses its queue 5 s (`IMAGE_HOLD_MS`) so the image dwells on the monitor before streaming resumes or the screen frees.
- `summarizer.ts` — shells out to `claude -p --no-session-persistence --model claude-haiku-4-5-20251001` for prompt summaries and new-hire names. `--no-session-persistence` is the feedback-loop guard: without it, the summarizer's own transcripts would be tailed and visualized.
- `characters.ts` + `index.ts` — HTTP API for state/catalog/settings and uploaded character storage (`data/characters/`, gitignored — Mixamo assets must never be committed).

Web (`web/src/`):
- `ws.ts` → `store.ts` (zustand) — all server messages flow through `applyServerMsg`; monitor text lives in the store, rendered as in-world CanvasTextures
(`scene/MonitorScreen.tsx`). All *activity* renders on monitors — the sole
speech bubble in the scene is the 20 Questions prompt (`quiz/SpeechBubble.tsx`),
which is game UI needing two clickable targets, not activity telemetry. Two wall boards on the right wall: the todo board shows TodoWrite and TaskCreate/TaskUpdate lists (`whiteboardContent.ts`; an all-completed list expires after 10 min via `todos.at`), and the status board shows the rolling server status feed plus who's working (`statusBoardContent.ts`, always visible).
- `scene/` — Office, Desk, Person, CameraRig (free orbit + POV tour), NameTag (camera-facing canvas sprites). Movie-mode shot selection lives in `movieShots.ts` as an authored archetype library with per-shot motion (push-ins, orbit arcs, trucks, board pans, fov zooms — interpolated in `MovieCamera.tsx`, which restores the base fov on exit): each cut picks ONE weighted primary subject (boss/wall-boards ×2) and requires LOS to it along the whole camera path (start/mid/end); facing-compatible neighbors are framed opportunistically. Candidates are validated (occluders, ≥3.5 u from the previous shot's end) *before* a cut commits, then the shot is locked for ≥2.5 s.
- `settings/picker/` — searchable character picker with live 3D preview; thumbnails are runtime snapshots cached in localStorage (bump `THUMB_REV` in useThumbnails.tsx when framing changes).
- `importer/` — in-browser Mixamo FBX→GLB conversion.
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
player answers YES/NO on a drei `<Html>` bubble; a YES to a guess wins.
Guessing is forced from Q15 and the office concedes at Q20. On a win the server
asks exactly ONE client (assigned, not elected) to fly the camera to a group shot
and POST a canvas capture to `/api/decor/eotm`; that photo hangs in the `eotm`
wall frame with a plaque until the next winner. Failure of any kind still credits
the win — `gameWins` on `UsageStats` drives a TV champion page. Screenshots
render-then-`toDataURL` in one tick precisely so `preserveDrawingBuffer` can stay
off.

## Gotchas

- **World scale is ~1.35× human**: desk tops at y=1.0, characters ~2.3 units tall. Preview/POV cameras should look at y≈1.1.
- **three version skew crashes R3F**: root and `web/package.json` must pin the same `three` major, or npm installs a nested copy → "Multiple instances of Three.js" + "Cannot assign to read only property 'position'".
- **AnimationMixer T-pose bugs**: (1) drei `useAnimations` `actions` are null until the group ref mounts — resolve clips in an effect, never a render-time memo. (2) The mixer caches PropertyBindings by (root.uuid, trackName), so swapping a model under a stable mixer root binds clips to the old clone's bones. Fix: remount on variant change (`<Person key={variant}>`; picker preview keys PreviewModel by id).
- **KayKit animation split**: 1.0 packs embed clips (incl. `Sit_Chair_Idle`); 2.0+ packs ship zero clips and rely on the shared library in `web/public/models/characters/_lib/` — clips bind by bone name, no retargeting. Missing clip names go in `clipAliases` in `scripts/catalog-meta.json`.
- **Shared clips bake bone translations, so custom characters must match KayKit proportions**: the `_lib` clips animate `translation` (and `rotation`) on all 23 bones, not just rotation — `Sit_Chair_Idle` also scales `head/spine/chest/handslot.r`. Binding by bone name works only because every KayKit character shares one skeleton; a differently-proportioned mesh gets its joints yanked to the canonical positions and tears. Canonical rest: hips 0.406, upperleg 0.519, shoulders 1.107, head bone 1.241→1.492, legs x ±0.171, `hand.l` x 0.787, mesh top ≈2.2. For a non-KayKit-proportioned character either reshape the mesh to that skeleton first (see `CatPerson.glb`) or use the Mixamo path in `web/src/importer/` — Mixamo fits the rig to the mesh and its clips are rotation-driven, which is exactly what that importer is for.
- **The window vista's downward extension holds a UV row, and that row must be opaque *and* not on the alpha edge** (`scene/vistaGeometry.ts`, `vistaLayers.ts`): each city layer is two quads — the artwork, plus a skirt that repeats one row of it down out of sight. Two ways to get nothing: hold at v = 0 when the image has transparent padding below the artwork (both `mid` layers do — measure `trimBottom` with a full-width alpha scan), or hold exactly at the last opaque row's edge, where bilinear filtering blends it to alpha ≈ 0.5 and `alphaTest: 0.5` discards the entire skirt. Hence `SKIRT_INSET_V`. Both failures are silent: the layer just ends in midair again.
- **Tests must never touch the real `data/office.json`**: the Office data-file path is injected in tests (see office.test.ts) and vitest excludes worktrees. In Docker, `data/office.json` is root-owned on the host — edit via `docker compose exec server node -e ...`.

## Rendering performance

Press **P** for the fps / draw-call / triangle overlay (`scene/PerfOverlay.tsx`, persisted in localStorage). Reference numbers for a 7-person office at 1080p: ~119 draw calls, ~230k triangles, 60 fps.

The scene is fragment- and CPU-bound, not geometry-bound — 119 draw calls is nothing. Four things keep it that way; each is easy to undo by accident.

- **The shadow map is driven manually** (`scene/ShadowControl.tsx`). The one shadow-casting light is a *point* light, so every update is a 6-face cube = 6 extra full scene renders. `gl.shadowMap.autoUpdate` is off; refreshes are triggered by layout/roster/catalog changes, a 500 ms heartbeat (so animated characters' shadows stay current), and **every frame while build mode or a drag is active** — dragging furniture moves shadow casters, so build mode deliberately pays the old cost. Build mode is therefore a live A/B of the freeze: it shows ~671 calls / 1.6M triangles / 52 fps against 119 / 230k / 60 outside it. Don't "simplify" this to a plain `autoUpdate = true`.
- **Nametag occlusion is the most expensive thing in the scene** (`scene/nametagVisibility.ts`, `scene/NameTag.tsx`): 9 raycasts per tag. It is throttled to ~100 ms with a random per-tag phase, skipped entirely when the tag is off-frustum or past `MAX_TAG_DISTANCE`, and cast against a **flat occluder list rebuilt every 500 ms** rather than recursively against the scene root (which re-walks every skeleton, 9 × N times per frame). `tagSamplePoints` returns a **module-level scratch array** — read it before calling again, never retain it.
- **Adaptive DPR rungs must be clamped to `window.devicePixelRatio`** (`scene/AdaptiveQuality.tsx`, `qualityLadder`). `dpr` is an absolute device-pixel ratio, not a fraction of native: on a 1× display an unclamped 1.25 rung renders 56% *more* pixels while claiming to reduce quality, and the feedback loop makes a struggling machine worse (measured: 5.2 → 15.6 fps under 6× CPU throttle once clamped). On a 1× display the ladder correctly collapses to one rung and adaptation no-ops.
- **Canvas surfaces must not re-derive content every frame.** The wall boards and TV used to `JSON.stringify` their whole payload 60×/s just to decide whether to repaint. They now gate on reference identity plus a slow poll (`scene/redrawGate.ts`); the TV needs no stringify at all since `stats` is replaced wholesale.

Two supporting invariants: `store.ts` `stableLayout` carries the previous `office.layout` reference forward when it is deep-equal, because ws.ts `JSON.parse`s every message and a dozen components subscribe to `layout` — without it `React.memo` on `Desk`/`Person` is defeated before it runs. And `Person` is memoized with an **explicit comparator** because `position` arrives as a fresh array literal each render.
