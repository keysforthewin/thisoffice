---
name: office-character
description: Make a custom character for This Office in Blender and install it — models a mesh onto the office's canonical Rig_Medium skeleton, validates the rig, then either adds it to the running office for local use or forks the repo and opens a pull request. Use whenever the user asks to "make a character for the office", "add my own character", "put my mascot in the office", "create a custom employee", or describes a character they want standing at a desk.
when_to_use: Creating or installing a custom character for this repo (thisoffice). Not for importing Mixamo FBX files — those go straight onto the settings picker's Import tab and need no modelling.
allowed-tools: Read Write Edit Bash AskUserQuestion mcp__blender__execute_blender_code mcp__blender__get_scene_info mcp__blender__get_object_info mcp__blender__get_viewport_screenshot
---

# Office Character

Build a character in Blender on the office's skeleton and get it into the office.

The whole job hangs off one constraint: **the office animates borrowed clips**.
Characters with no animations of their own play `Sit_Chair_Idle` and `Idle` from
`web/public/models/characters/_lib/`, and those clips write bone *translations*,
not just rotations. They bind by bone name to whatever skeleton they find. So a
character whose skeleton differs from the template gets its joints yanked to the
canonical positions and the mesh tears.

Hence the rule that governs every step below:

> **Never add, rename, delete, reparent, move, rotate or scale a bone.**
> The armature is the contract. Only the mesh changes.

## 1. Ask where it is going — before any modelling

Use AskUserQuestion:

> Is this character just for your office, or do you want to contribute it to the
> project so it ships for everyone?
>
> - **Just for me** — it lands in `data/characters/` (gitignored) and shows up in
>   the picker straight away.
> - **Contribute it** — it goes into the repo, the catalog, and a pull request.

Keep the answer; it decides step 6. Also get, if the user hasn't said: what the
character looks like, and what it should be called.

## 2. Preflight

- `mcp__blender__get_scene_info` — if the Blender MCP server does not answer,
  stop and point at `docs/blender-characters.md`; nothing below works without it.
- Confirm `web/public/models/characters/_lib/Rig_Medium_Template.glb` exists.
- For the contribute path, check `gh auth status` early, not after modelling.

## 3. Load the template

Import the template into a clean scene:

```python
import bpy
bpy.ops.wm.read_homefile(use_empty=True)
bpy.ops.import_scene.gltf(filepath='<abs path>/web/public/models/characters/_lib/Rig_Medium_Template.glb')
```

It contains the `Rig_Medium` armature (23 bones) and a mannequin body in six
parts. The mannequin is the proportion reference — keep it visible while you
work, delete it at the end.

Landmarks to build to (world units; this office is ~1.35x human scale):

| | height |
|---|---|
| hips | 0.406 |
| chest | 0.973 |
| shoulders | 1.107 |
| head bone → crown | 1.241 → 1.492 |
| mesh top | ≈2.2 |

## 4. Model the character

Use the `blender-modeling` and `blender-materials` skills for the actual
geometry and look-dev. What is specific to this job:

- Build **around** the mannequin, matching its limb positions. Arms hang at the
  sides in the rest pose; the sitting clip folds them from there.
- Keep it low-poly and stylized — it sits next to KayKit characters, and the
  office renders a roomful at once. A few thousand triangles is plenty.
- One mesh, one armature. Join meshes (`Ctrl+J`) before weighting.
- Parent with **Armature Deform → With Automatic Weights**, then spot-fix
  weights at the shoulders and hips. The mesh must be a child of the armature
  with an Armature modifier pointing at it.
- Apply all transforms on the mesh (`Ctrl+A` → All Transforms). A scaled object
  exports as a scaled node and the character arrives the wrong size.
- Delete the mannequin parts last, once your mesh covers them.

Take a `mcp__blender__get_viewport_screenshot` and show the user before exporting.

## 5. Export and check

Export glTF Binary, and be exact about these — each maps to a real failure:

| setting | value | why |
|---|---|---|
| Format | glTF Binary (`.glb`) | one file; `.gltf` leaves textures beside it and cannot be uploaded |
| Include | Selected Objects off, or select mesh **and** armature | an exported mesh with no armature has no skin |
| Transform | +Y Up | the office is Y-up |
| Data → Mesh | Apply Modifiers on | otherwise the modifier stack is lost |
| Data → Animation | **off** | a baked `Sit_Chair_Idle` makes the office stop using the shared clips |
| Compression | **off** (Draco, meshopt, KTX2 all off) | the viewer has no decoder; the character renders as nothing |

```python
bpy.ops.export_scene.gltf(filepath='/tmp/<Name>.glb', export_format='GLB',
                          export_animations=False, export_draco_mesh_compression_enable=False,
                          export_yup=True, export_apply=True)
```

Then validate, from the repo root:

```
npm run check-rig -- /tmp/<Name>.glb
```

Fix whatever it names and re-export — Blender is still open, so this loop is
cheap. `✗` lines mean it cannot render at all; `⚠` lines mean it will import but
something is off. Aim for a clean `✓` with no warnings before installing.

## 6. Install

### If the user said "just for me"

The server takes the same upload the Import tab does, so the character appears
without a restart:

```
curl -f -X POST --data-binary @/tmp/<Name>.glb \
  "http://localhost:4680/api/characters/<Id>?displayName=<Display%20Name>&pack=Blender"
```

`<Id>` is letters, numbers, `_` and `-` only. A `409` means the name collides
with a built-in character — pick another. If the server isn't running, tell the
user to start it (`docker compose up`) and drop the `.glb` onto **Settings →
character button → Import**, which does exactly the same thing.

### If the user said "contribute it"

State the licensing expectation first: the file will be redistributed with the
repo, so it must be their own work or CC0 — do not commit anything else.

1. `gh repo fork --remote=false` if `origin` is not already the user's fork, then
   point a remote at the fork.
2. Branch: `git checkout -b character/<id>`.
3. `npm run promote -- <Id> --pack Blender --name "<Display Name>" --tags a,b`
   if it was already uploaded locally — that copies it into
   `web/public/models/characters/`, writes the `scripts/catalog-meta.json` entry
   and regenerates `catalog.json`. Otherwise copy the `.glb` in by hand, add the
   `catalog-meta.json` entry and run `npm run catalog`.
4. Add a line to `ATTRIBUTION.md` crediting the author.
5. `npm test` and `npm run check-rig -- web/public/models/characters/<Id>.glb`.
6. Commit all four (GLB, `catalog-meta.json`, `catalog.json`, `ATTRIBUTION.md`)
   and `gh pr create`, with a body naming the character, who made it, its licence,
   and that the rig check passes.

## 7. Hand back

Tell the user the character's name and id, where it landed, and how to put it on
screen: **Settings → the character button beside an employee → pick it**. A
Blender import shows up under the **Blender** pack with Size / Seat offset /
Chair height sliders next to the preview if it needs nudging on the chair.

## When it looks wrong

| symptom | cause |
|---|---|
| mesh tears or limbs stretch to a point | a bone was moved, renamed or reparented — rebuild on the template |
| character stands in a T-pose at the desk | clips didn't bind: bone names changed, or the export kept its own animations |
| nothing appears, no error | compression was left on in the export |
| floats above or sinks into the chair | fine — use the Seat offset slider in the picker |
| far too big or small | apply transforms in Blender, or use the Size slider |
