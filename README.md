# This Office

A Claude visualizer. Your live Claude Code sessions play out as a 3D office:
prompts arrive on the boss's monitor, tool calls run on the employees' screens.

![The office](docs/screenshots/office.png)

![A monitor up close](docs/screenshots/monitor.png)

There's a TV that keeps track of your Claude usage stats:

![The stats TV](docs/screenshots/tv.png)

## Run

```
docker compose up
```

Open http://localhost:5173.

## How It Works

Claude Code writes a transcript of every session to your local Claude home
folder (`~/.claude/projects/`). This Office tails those transcript files and
turns what it finds into office activity: your prompts land on the boss's
monitor, every tool call lights up an employee's screen, and subagents get
desks of their own.

Because it reads straight from the local folder, it sees every Claude Code
session on your machine — every project, every terminal, running or resumed —
and visualizes all of them out of the box. No hooks, no wrappers, no per-project
setup: just the one startup command above.

You can put your own characters in the office. Download a character from Mixamo
and drop it on the Import tab in the settings, or model one in Blender on the
skeleton the office provides — see [docs/blender-characters.md](docs/blender-characters.md),
which walks through wiring Blender up to Claude so it builds the character for
you.

## Features

**The office**

* Every tool call streams onto an employee's screen, typewriter-paced, with
`✓ done` / `✗ failed` / `✗ blocked` endings.
* Edit and Write calls show the actual diff on the monitor.
* Images an agent reads (screenshots, PNGs) appear on the monitor and dwell
there for a few seconds.
* Subagents get desks of their own — a Task call fans its tool calls out to
fresh employees.
* A red beacon on the boss's desk blinks when a session is waiting on you.
Click it to mute it for that wait.
* An ask card (HUD + status board + monitor) shows the question and the menu
options when a session hits ExitPlanMode or AskUserQuestion. It's a readout —
the office reads files and can't answer for you.
* Session-level events all surface: slash commands, `!` shell passthrough,
hooks, plan mode, API errors, interrupts, away summaries, queued prompts.
High-frequency housekeeping batches into an "Office Chores" digest screen.
* A todo whiteboard (TodoWrite / TaskCreate lists) and a status board (rolling
activity feed plus who's working) on the wall.
* A wall TV of accumulated usage stats — tokens, tools, per-employee counters,
game champions.

**The room**

* Build mode (**B**): drag desks, boards, windows and wall art anywhere,
including around corners onto any of the four walls, with collision.
* Window vistas: each window carries its own city artwork, measured per column
so the skyline extends to the floor correctly.
* The painting behind the boss is yours — click it, pick an image, wheel to
zoom, ctrl+move to pan.
* Kat Person, an optional office cat, on by default.
* Reset layout from the settings panel.

**Camera**

* Free orbit, first-person fly (WASD/E/C + pointer lock), click-to-focus on any
monitor, TV, board or the award frame, and a POV tour.
* **Movie mode**: an authored shot library — push-ins, orbit arcs, trucks, board
pans, fov zooms — that picks cuts by what's actually live, validates
line-of-sight before committing, holds each shot ≥5s, and preempts on a
blinking beacon or a new prompt from you.
* Right-drag to look around in *every* mode, handing straight over to
pointer-locked mouse-look.
* Nametags on everyone, culled at both ends of the distance range.

**Characters**

* A searchable picker with live 3D previews and cached thumbnails.
* Import a Mixamo `.fbx` — converted to GLB in the browser.
* Import a Blender `.glb` built on the shared skeleton, rig-checked on the way
in; `npm run check-rig` validates from the CLI.
* The `office-character` skill drives Blender via Claude to model, rig and
install a custom character for you.
* KayKit CC0 packs ingest with one script; a shared animation library binds
clips by bone name, no retargeting.

**20 Questions** (optional, off by default)

* A random employee, the boss or Kat Person asks; you answer YES/NO on the
speech bubble, the screen-bottom bar, or with the **Y**/**N** keys.
* Haiku writes every question against the full round history — no question
limit, no conceding, and never a canned fallback: an outage just makes the
office wait and ask again.
* The winner gets flown to and photographed, and the portrait hangs in the
EMPLOYEE OF THE MONTH frame on the wall until someone else wins.
* Wins accumulate on the stats TV.
* **Reset game** in settings starts a fresh round, keeping the photo and tally.
* Zero LLM calls while the game is off.

**Under the hood**

* State persists across restarts: roster, layout, usage stats, quiz round,
uploaded art and characters.
* Adaptive resolution ladder, manually-driven shadow map, throttled nametag
occlusion — press **P** for the fps / draw-call / triangle overlay.

## Advanced

Change the ports by setting `WEB_PORT` (the page) and `SERVER_PORT` before
starting:

```
WEB_PORT=8080 SERVER_PORT=4700 docker compose up
```

Characters and furniture are CC0 asset packs — see ATTRIBUTION.md.

