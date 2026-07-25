# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A 3D WebGL office (Three.js / React Three Fiber) that visualizes live Claude Code sessions: the boss's monitor shows incoming prompts, every tool call / subagent lights up an employee's screen, and the office auto-hires when it runs out of idle employees. See README.md for user-facing controls and the Mixamo/KayKit import workflows.

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
- `transcript.ts` — parses JSONL lines into office activity, keyed by toolUseId; matches Task tool calls to subagent transcript files; tool calls inside subagent transcripts fan out to their own employees (only the subagent's text/thinking plus `> Tool` breadcrumbs stay on the Task employee's screen; nested Task calls intentionally not fanned out). Transcripts stream per JSONL line (per content block — no token deltas exist on disk); no batching in the pipeline. Tracks todo/task lists for the whiteboard.
- `office.ts` — the state machine: seat assignment, auto-hire/eviction (staffing min/max, idle 60s eviction), FIFO work queue when all desks are full, and persistence to `data/office.json` (roster remembers per-seat name+variant so an evicted seat's occupant returns intact).
- `streamer.ts` — `ScreenStreamer`, server-side typewriter (~1 line/sec base) driving monitor text; rate ratchets under backlog so bursts drain in ~90s; queue pressure multiplies the rate; at max headcount `setBoost` kicks every screen to ~4 lines/sec. Employees stay "working" until their screen drains. A `⟦IMG⟧` screenshot line pauses its queue 5 s (`IMAGE_HOLD_MS`) so the image dwells on the monitor before streaming resumes or the screen frees.
- `summarizer.ts` — shells out to `claude -p --no-session-persistence --model claude-haiku-4-5-20251001` for prompt summaries and new-hire names. `--no-session-persistence` is the feedback-loop guard: without it, the summarizer's own transcripts would be tailed and visualized.
- `characters.ts` + `index.ts` — HTTP API for state/catalog/settings and uploaded character storage (`data/characters/`, gitignored — Mixamo assets must never be committed).

Web (`web/src/`):
- `ws.ts` → `store.ts` (zustand) — all server messages flow through `applyServerMsg`; monitor text lives in the store, rendered as in-world CanvasTextures (`scene/MonitorScreen.tsx`). No speech bubbles by design — all activity renders on monitors; the whiteboard shows TodoWrite and TaskCreate/TaskUpdate lists (falls back to a live "IN PROGRESS" synopsis when no todo list is active, rendered from client state via `web/src/scene/whiteboardContent.ts`).
- `scene/` — Office, Desk, Person, CameraRig (free orbit + POV tour), NameTag (camera-facing canvas sprites). Movie-mode shot selection lives in `movieShots.ts` as an authored archetype library (over-shoulder / high-angle / side / group / overhead / dolly / wide): every candidate is validated (LOS, occluders, ≥3.5 u from the previous shot) *before* a cut commits, then the shot is locked for ≥2.5 s.
- `settings/picker/` — searchable character picker with live 3D preview; thumbnails are runtime snapshots cached in localStorage (bump `THUMB_REV` in useThumbnails.tsx when framing changes).
- `importer/` — in-browser Mixamo FBX→GLB conversion.
- `shared/types.ts` — the server↔client protocol (`ServerMsg`, `OfficeState`); both sides import it directly.

Images an agent Reads (e.g. PNGs) reach the monitor as a `⟦IMG⟧<dataURL>` marker line (`MONITOR_IMAGE_MARKER` in shared/types.ts) through the normal streamer queue; the client store intercepts it.

## Gotchas

- **World scale is ~1.35× human**: desk tops at y=1.0, characters ~2.3 units tall. Preview/POV cameras should look at y≈1.1.
- **three version skew crashes R3F**: root and `web/package.json` must pin the same `three` major, or npm installs a nested copy → "Multiple instances of Three.js" + "Cannot assign to read only property 'position'".
- **AnimationMixer T-pose bugs**: (1) drei `useAnimations` `actions` are null until the group ref mounts — resolve clips in an effect, never a render-time memo. (2) The mixer caches PropertyBindings by (root.uuid, trackName), so swapping a model under a stable mixer root binds clips to the old clone's bones. Fix: remount on variant change (`<Person key={variant}>`; picker preview keys PreviewModel by id).
- **KayKit animation split**: 1.0 packs embed clips (incl. `Sit_Chair_Idle`); 2.0+ packs ship zero clips and rely on the shared library in `web/public/models/characters/_lib/` — clips bind by bone name, no retargeting. Missing clip names go in `clipAliases` in `scripts/catalog-meta.json`.
- **Tests must never touch the real `data/office.json`**: the Office data-file path is injected in tests (see office.test.ts) and vitest excludes worktrees. In Docker, `data/office.json` is root-owned on the host — edit via `docker compose exec server node -e ...`.
