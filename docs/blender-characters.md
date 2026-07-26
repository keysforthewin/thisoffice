# Make Your Own Character in Blender

Kat Person, the cat in the back corner, was made in Blender in an afternoon by
draping a new mesh over the office's existing skeleton. This walks you through
doing the same for your own character — and, if you want, contributing it so it
ships with the project.

The office does the modelling with you. Once Blender is wired up, you describe
the character you want and Claude builds it, checks it, and installs it.

## Why there's a skeleton to start from

Characters in the office don't carry their own animations. They borrow two
clips — sitting at a desk, and standing idle — from a shared library, and those
clips bind to bones **by name**. They also write bone positions, not just
rotations, so a skeleton that differs from the expected one gets pulled into the
wrong shape and the mesh tears.

That's why you start from a template rather than a rig of your own. The template
is the skeleton, plus a plain mannequin body to build against:

    web/public/models/characters/_lib/Rig_Medium_Template.glb

You can also download it from the Import tab in the app. The one rule that
matters: **model whatever you like, but leave the bones alone.** Don't rename,
move, add, delete or reparent a single one.

## Setup

You need four things, once.

**1. Blender.** Version 4.2 or newer, from https://www.blender.org/download/.
Any recent release works; the exporter settings below have been stable for
years.

**2. The Blender MCP server**, so Claude can drive Blender directly. This repo
already declares it in `.mcp.json`:

    {
      "mcpServers": {
        "blender": { "command": "uvx", "args": ["blender-mcp"] }
      }
    }

That needs `uv` installed (https://docs.astral.sh/uv/), which supplies `uvx`.
If you forked the repo the file comes with it; otherwise add it at the repo root.

**3. The Blender addon.** The MCP server talks to an addon running inside
Blender — follow the install steps at https://github.com/ahujasid/blender-mcp,
then in Blender open the sidebar in the 3D viewport (press **N**), find the
BlenderMCP tab, and click **Connect**. Blender has to stay open while you work.

**4. The Blender skills.** This repo ships with `blender-modeling`,
`blender-materials`, `blender-export` and friends under `.claude/skills/`, so a
clone has them already. Run `/help` in Claude Code if you want to see the list.

Check the wiring by asking Claude "what's in the Blender scene?" — if it answers,
you're set.

## Make the character

Start Claude Code in the repo, with Blender open and connected, and say:

    Use the office-character skill to make me a character: a small round robot
    with a single glowing eye, stubby arms, and a dented copper finish.

Describe whatever you want in place of the robot — an animal, a mascot, a
version of yourself. Claude will ask one question up front:

> Is this character just for your office, or do you want to contribute it to the
> project so it ships for everyone?

Answer that, and the rest runs on its own: it loads the template, models your
character onto it, shows you the viewport, exports a `.glb`, checks the rig, and
installs it. If the check finds something — a stray bone, compression left on —
it fixes it and re-exports before installing.

To put the character on screen: open **Settings**, click the character button
beside an employee or the boss, and pick it. Yours appear under the **Blender**
pack, with Size, Seat offset and Chair height sliders beside the preview if it
needs nudging on the chair.

## Contributing it

If you told Claude to contribute, it forks the repo, adds the character to the
catalog, credits you in `ATTRIBUTION.md`, and opens a pull request. Only send up
work that's yours or CC0 — the file gets redistributed with the project.

There's one licensing wrinkle worth knowing: characters imported from Mixamo
**cannot** be contributed. Adobe's terms allow you to use them in your own
projects but not to redistribute the assets, which is why they stay in the
gitignored `data/` directory. A character you modelled in Blender has no such
restriction.

## Doing it by hand

Nothing above requires Claude or the MCP server. The manual path:

1. Download the rig template (link in the app's Import tab, or the path above)
   and open it in Blender.
2. Model your character over the mannequin, then delete the mannequin. Keep the
   armature untouched.
3. Join your meshes, parent to the armature with **Armature Deform → With
   Automatic Weights**, and apply all object transforms.
4. Export **glTF Binary (.glb)**, +Y up, apply modifiers on, **animations off**,
   **compression off** (no Draco, no meshopt, no KTX2).
5. Check it: `npm run check-rig -- path/to/Character.glb`
6. Drag the `.glb` onto **Settings → character button → Import**.
7. To put it in the repo: `npm run promote -- CharacterId --pack Blender`, which
   copies it into `web/public/models/characters/`, writes the catalog entry and
   regenerates `catalog.json`.

## When something looks wrong

**The mesh tears, or a limb stretches to a point.** A bone was moved, renamed or
reparented. The shared clips assume the template skeleton exactly. Rebuild on a
fresh copy of the template.

**The character sits at the desk in a T-pose.** The clips didn't bind. Either the
bone names changed, or the export baked in its own animations — which makes the
office stop reaching for the shared ones. Re-export with animations off.

**Nothing appears at all, and no error.** Compression was left on in the export.
The viewer has no decoder for Draco, meshopt or KTX2, so the model loads as an
empty scene.

**It floats above the chair, or sinks into it.** Normal — characters vary. Use
the Seat offset slider next to the preview in the picker.

**It's far too big or too small.** Apply transforms in Blender (`Ctrl+A` → All
Transforms) and re-export, or use the Size slider.

`npm run check-rig` reports most of these before you ever load the character, so
run it first when something's off.
