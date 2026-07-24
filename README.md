# This Office

A 3D WebGL office that visualizes your live Claude Code sessions. The boss's monitor
shows incoming prompts from every open session; every tool call and subagent lights up
an employee's screen. Run out of idle employees and the office hires a new one —
desk, chair, character, and an LLM-invented name.

Built with Three.js / React Three Fiber. Characters and furniture are CC0 KayKit
packs (see `ATTRIBUTION.md`).

## Run

```bash
docker compose up
```

Then open http://localhost:5173.

- The repo is bind-mounted into the containers; no source is baked into images.
- `~/.claude` is mounted in so the server can tail session transcripts and the
  summarizer can use the `claude` CLI with your subscription.
- Office roster persists in `data/office.json` (on the host, via the bind mount).

## Controls

- **Drag / scroll** — orbit and zoom (free camera)
- **V** — toggle the POV tour (over-shoulder views of boss, each employee, whiteboard)
- **Tab / ← →** — cycle POVs while in the tour
- **Esc** — back to free camera
- **⚙** — settings: rename the boss/employees, change characters, remove employees

## Architecture

```
~/.claude/projects/**/*.jsonl  ──tail──▶  server (Node, :4680)
    watcher.ts → transcript.ts → office.ts ──WebSocket──▶ web (Vite+R3F, :5173)
                     │
                     └─▶ summarizer.ts (claude -p, haiku) for prompt summaries + hire names
```
