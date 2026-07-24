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
- **⚙** — settings: rename the boss/employees, change characters, remove employees.
  The character button opens a searchable picker (search, pack filters, arrow-key
  navigation) with a live animated 3D preview.

## Importing Mixamo characters

The character picker has an **Import from Mixamo** tab: browse [mixamo.com](https://www.mixamo.com)
(free Adobe account), download what you like, and drag the FBX files onto the drop zone.
Conversion happens in your browser with live progress; the result is stored server-side
in the gitignored `data/characters/` (Mixamo assets are Adobe-licensed and must not be
committed — see `ATTRIBUTION.md`).

One-time setup — the office needs two animations, which work for every Mixamo character:

1. On Mixamo, search **"Sitting Idle"** → Download (Format: FBX, Skin: **Without Skin**).
2. Same for **"Idle"**.
3. Drop both files on the import tab.

Then for each character: pick one on Mixamo → Download (Format: **FBX Binary**, with skin,
T-pose) → drop the file. It appears under the "Mixamo" pack filter, joins the hiring pool,
and persists across restarts. Re-dropping a file with the same name replaces it.

## Character catalog

The picker is driven by a generated manifest, `web/public/models/characters/catalog.json`.
Regenerate it after adding/removing GLBs (`npm run catalog`); curated names/packs/tags
live in `scripts/catalog-meta.json`.

To add more KayKit characters:

1. Download a character pack zip from https://kaylousberg.itch.io (free tiers are CC0)
   and extract it.
2. `node scripts/import-characters.mjs <extracted-dir> --pack "Pack Name" [--tags a,b] [--only X,Y] [--suffix _V2]`
3. New-style packs (2.0+) ship characters without embedded animation clips — they're
   animated by the shared library in `web/public/models/characters/_lib/` (installed via
   `node scripts/import-characters.mjs <animations-pack-dir> --anims`). If a needed clip
   has a different name, add it to `clipAliases` in `scripts/catalog-meta.json`.

## Architecture

```
~/.claude/projects/**/*.jsonl  ──tail──▶  server (Node, :4680)
    watcher.ts → transcript.ts → office.ts ──WebSocket──▶ web (Vite+R3F, :5173)
                     │
                     └─▶ summarizer.ts (claude -p, haiku) for prompt summaries + hire names
```
