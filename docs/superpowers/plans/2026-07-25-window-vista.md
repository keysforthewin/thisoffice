# Window Vista Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blurry global equirect skybox with a per-window "diorama box" of layered high-res cityscape planes that parallax naturally and move with their window.

**Architecture:** A new `WindowVista` component renders five inward-facing planes forming an open box behind each window opening (open side = the window), plus a far city texture on the back face and 1–2 alpha-cutout building layers floating inside. Everything lives in the window's local coordinate space (window at z=0, outside = −z), composed inside the existing wall `<group>` in `Office.tsx`, so a future movable-window feature moves the vista for free. The global `Skybox` is deleted; `scene.background` becomes a flat dusk color.

**Tech Stack:** React Three Fiber 9 / drei 10 / three (pinned major — see gotcha), vitest, fal.ai MCP tools for image generation.

**Spec:** `docs/superpowers/specs/2026-07-25-window-vista-design.md`

## Global Constraints

- Root and `web/package.json` must keep the same pinned `three` major (do not add/upgrade three deps).
- Vista materials must be unlit (`meshBasicMaterial`), must NOT cast/receive shadows, and MUST set `fog={false}` — the scene fog (`['#141218', 20, 46]`) would otherwise swallow planes 25+ units out.
- Textures: `SRGBColorSpace`.
- All layer positions/sizes are named constants at the top of `WindowVista.tsx`.
- Tests: `npx vitest run web/src/scene/vistaGeometry.test.ts` for the unit; `npm test` for the suite. Never touch `data/office.json`.
- Generated vista images ARE committed (they're CC-equivalent generated assets in `web/public/`, unlike Mixamo assets which stay gitignored).
- App runs via `docker compose up` (web on :5173); source is bind-mounted, no rebuild needed.

## World-space orientation reference (for sanity checks)

- Back wall group: `position=[0, height/2, backZ]`, no rotation → local −z = world −z = outside. Opening local offset `ox=-width/4, oy=2.1-height/2`, size 3.6×1.9.
- Left wall group: `position=[-width/2, height/2, centerZ]`, `rotation=[0, +π/2, 0]` → local −z = world −x = outside. Opening local offset `ox=4.5, oy=2.1-height/2`, same size.
- Sun direction: low on the horizon toward the BACK window (justifies the existing warm `#ffd9a0` spill light). The left window sees the same city 90° away from the sun.

---

### Task 1: `vistaBoxFaces` geometry helper

**Files:**
- Create: `web/src/scene/vistaGeometry.ts`
- Test: `web/src/scene/vistaGeometry.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, mirrors `wallOpenings.ts` style).
- Produces: `type FaceKind = 'back' | 'left' | 'right' | 'top' | 'bottom'`; `interface VistaFace { kind: FaceKind; position: [number, number, number]; rotation: [number, number, number]; size: [number, number] }`; `function vistaBoxFaces(w: number, h: number, d: number): VistaFace[]` — five inward-facing faces of a box spanning x∈[−w/2, w/2], y∈[−h/2, h/2], z∈[−d, 0], open at z=0.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/scene/vistaGeometry.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vistaBoxFaces } from './vistaGeometry.ts';

describe('vistaBoxFaces', () => {
  const w = 14, h = 10, d = 24;
  const faces = vistaBoxFaces(w, h, d);

  it('returns five faces whose areas cover the box minus the open side', () => {
    expect(faces).toHaveLength(5);
    const area = faces.reduce((a, f) => a + f.size[0] * f.size[1], 0);
    expect(area).toBeCloseTo(w * h + 2 * d * h + 2 * w * d);
    expect(faces.filter((f) => f.kind === 'back')).toHaveLength(1);
  });

  it('every face normal points into the box', () => {
    const center = new THREE.Vector3(0, 0, -d / 2);
    for (const f of faces) {
      const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...f.rotation));
      const toCenter = center.clone().sub(new THREE.Vector3(...f.position));
      expect(n.dot(toCenter)).toBeGreaterThan(0);
    }
  });

  it('any ray entering through the open side hits a face, even at grazing angles', () => {
    // sample interior "camera" points (z>0, incl. far-lateral grazing spots)
    const cams = [
      new THREE.Vector3(0, 0, 3),
      new THREE.Vector3(11, 0, 0.5),   // hard grazing from the side
      new THREE.Vector3(-11, 3, 0.5),
      new THREE.Vector3(0, 5, 0.3),    // grazing from above (near ceiling)
      new THREE.Vector3(4, -0.9, 8),
    ];
    // points spanning the window opening at z=0 (opening 3.6×1.9 centered at origin)
    const targets = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1.8, 0.95, 0),
      new THREE.Vector3(-1.8, -0.95, 0),
      new THREE.Vector3(1.8, -0.95, 0),
      new THREE.Vector3(-1.8, 0.95, 0),
    ];
    for (const cam of cams) {
      for (const t of targets) {
        const dir = t.clone().sub(cam).normalize();
        if (dir.z >= -1e-6) continue; // not entering the box
        const hit = faces.some((f) => {
          const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...f.rotation));
          const p = new THREE.Vector3(...f.position);
          const denom = n.dot(dir);
          if (Math.abs(denom) < 1e-9) return false;
          const s = n.dot(p.clone().sub(t)) / denom;
          if (s < 1e-6) return false;
          const q = t.clone().addScaledVector(dir, s);
          // point-in-rect in the face's local axes
          const local = q.sub(p);
          const eu = new THREE.Euler(...f.rotation);
          local.applyEuler(new THREE.Euler(-eu.x, -eu.y, -eu.z, 'ZYX'));
          return Math.abs(local.x) <= f.size[0] / 2 + 1e-6 && Math.abs(local.y) <= f.size[1] / 2 + 1e-6;
        });
        expect(hit, `ray from ${cam.toArray()} via ${t.toArray()} escaped the box`).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/scene/vistaGeometry.test.ts`
Expected: FAIL — cannot resolve `./vistaGeometry.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/scene/vistaGeometry.ts
export type FaceKind = 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface VistaFace {
  kind: FaceKind;
  position: [number, number, number];
  rotation: [number, number, number];
  size: [number, number];
}

/** Five inward-facing faces of an open box spanning x∈[-w/2,w/2], y∈[-h/2,h/2],
 *  z∈[-d,0]. The missing face is z=0 — the window-opening side. Any sight line
 *  through the opening therefore terminates on a face, at any grazing angle. */
export function vistaBoxFaces(w: number, h: number, d: number): VistaFace[] {
  const Q = Math.PI / 2;
  return [
    { kind: 'back', position: [0, 0, -d], rotation: [0, 0, 0], size: [w, h] },
    { kind: 'left', position: [-w / 2, 0, -d / 2], rotation: [0, Q, 0], size: [d, h] },
    { kind: 'right', position: [w / 2, 0, -d / 2], rotation: [0, -Q, 0], size: [d, h] },
    { kind: 'top', position: [0, h / 2, -d / 2], rotation: [Q, 0, 0], size: [w, d] },
    { kind: 'bottom', position: [0, -h / 2, -d / 2], rotation: [-Q, 0, 0], size: [w, d] },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/scene/vistaGeometry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/scene/vistaGeometry.ts web/src/scene/vistaGeometry.test.ts
git commit -m "feat: vistaBoxFaces helper for window diorama boxes"
```

---

### Task 2: Generate the six vista textures (fal.ai)

**NOTE:** This task needs the session-connected fal.ai MCP tools (load via ToolSearch, e.g. `select:mcp__fal-ai__run_model,mcp__fal-ai__search_models,mcp__fal-ai__get_model_schema`) and aesthetic judgment — best run by the main session, not a code subagent. Regenerate any image that comes out wrong; that's normal.

**Files:**
- Create: `web/public/vista/back-far.jpg`, `web/public/vista/back-mid.png`, `web/public/vista/back-near.png`, `web/public/vista/left-far.jpg`, `web/public/vista/left-mid.png`, `web/public/vista/left-near.png`

**Interfaces:**
- Consumes: nothing.
- Produces: the six files above. Far layers: opaque, ~1792×1280 (1.4:1, matching the box back face). Mid/near: PNG **with real alpha channel** (transparent sky), ~1280–1536 wide.

- [ ] **Step 1: Pick models**

Use `mcp__fal-ai__search_models` / `mcp__fal-ai__recommend_model` to pick (a) the current best text-to-image model (e.g. FLUX dev or newer; check `get_model_schema` for custom `image_size` support) and (b) a background-removal model (e.g. birefnet / bria background-remove) for cutting alpha on mid/near layers.

- [ ] **Step 2: Generate the two far layers (1792×1280)**

Prompts (adjust wording to taste, keep the sun constraint):

- `back-far`: "Golden hour city skyline seen from a high-rise office window, sun low on the horizon near center, warm orange haze at the horizon fading to purple-blue dusk sky above, distant skyscraper silhouettes with a few lit windows, soft atmospheric perspective, photographic, highly detailed, no foreground objects, no window frame"
- `left-far`: "Golden hour city skyline from a high-rise, viewed 90 degrees away from the low sun, warm side-light raking across distant towers from the right, orange haze strongest at the right edge, purple-blue dusk sky, photographic, highly detailed, no foreground objects, no window frame"

- [ ] **Step 3: Generate the four building layers on plain backgrounds**

- `back-mid` / `left-mid`: "A row of mid-rise city office buildings at golden hour, warm low sunlight on the facades, scattered lit windows, seen from slightly above, entire buildings visible with clear sky gaps between them, isolated on a plain flat white background, photographic" (left variant: "lit from the right side")
- `back-near` / `left-near`: "Two close skyscraper rooftops at golden hour seen from a neighboring tower, strong warm rim light, rooftop details, isolated on a plain flat white background, photographic" (left variant: "rim light from the right")

- [ ] **Step 4: Cut alpha on the four building layers**

Run each mid/near image through the background-removal model → transparent PNG.

- [ ] **Step 5: Download all six to `web/public/vista/`**

```bash
mkdir -p web/public/vista
curl -sSo web/public/vista/back-far.jpg "<fal-url>"   # etc. for all six
```

Verify: `file web/public/vista/*` shows JPEG for far, PNG for mid/near; check the PNGs actually have alpha (`identify -format '%A' f.png` → `True`/`Blend`, or open them); total size sanity < ~6 MB.

- [ ] **Step 6: Commit**

```bash
git add web/public/vista
git commit -m "assets: golden-hour vista layers for back and left windows"
```

---

### Task 3: `WindowVista` component, mount in Office, remove Skybox

**Files:**
- Create: `web/src/scene/WindowVista.tsx`
- Modify: `web/src/scene/Office.tsx` (back-wall group ~line 112, left-wall group ~line 119)
- Modify: `web/src/App.tsx` (lines 6, 82–88)
- Delete: `web/src/scene/Skybox.tsx`, `web/public/skybox/city.jpg`

**Interfaces:**
- Consumes: `vistaBoxFaces(w, h, d): VistaFace[]` from Task 1; textures from Task 2.
- Produces: `function WindowVista({ id }: { id: 'back' | 'left' })` — renders the diorama in the window opening's local frame (opening center at origin, outside = −z). Mounted by the caller at the opening's offset inside the wall group.

- [ ] **Step 1: Write `WindowVista.tsx`**

```tsx
// web/src/scene/WindowVista.tsx
import * as THREE from 'three';
import { useTexture } from '@react-three/drei';
import { vistaBoxFaces, type FaceKind } from './vistaGeometry.ts';

/** All positions are in the window opening's local frame: opening center at the
 *  origin, outside = -z. Tuned by eye; adjust freely. `cy` drops the whole box
 *  so the city extends below the sill (we're high in an office tower). */
interface LayerCfg { url: string; z: number; w: number; h: number; y: number }
interface VistaCfg {
  box: { w: number; h: number; d: number; cy: number };
  faceColors: Record<Exclude<FaceKind, 'back'>, string>;
  far: string;
  layers: LayerCfg[];
}

const CFG: Record<'back' | 'left', VistaCfg> = {
  back: {
    box: { w: 14, h: 10, d: 24, cy: -1.5 },
    faceColors: { top: '#3d3050', bottom: '#241b22', left: '#9c7258', right: '#9c7258' },
    far: '/vista/back-far.jpg',
    layers: [
      { url: '/vista/back-mid.png', z: -11, w: 10, h: 6, y: -1.4 },
      { url: '/vista/back-near.png', z: -4.5, w: 7, h: 4.2, y: -1.6 },
    ],
  },
  left: {
    box: { w: 14, h: 10, d: 24, cy: -1.5 },
    faceColors: { top: '#3d3050', bottom: '#241b22', left: '#7d6270', right: '#b57e56' },
    far: '/vista/left-far.jpg',
    layers: [
      { url: '/vista/left-mid.png', z: -11, w: 10, h: 6, y: -1.4 },
      { url: '/vista/left-near.png', z: -4.5, w: 7, h: 4.2, y: -1.6 },
    ],
  },
};

const srgb = (t: THREE.Texture | THREE.Texture[]) => {
  for (const tex of Array.isArray(t) ? t : [t]) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
  }
};

/** Layered-cityscape diorama box behind a window opening. Unlit and fog-free on
 *  purpose: the exterior must not pick up office lights, shadows, or interior fog. */
export function WindowVista({ id }: { id: 'back' | 'left' }) {
  const cfg = CFG[id];
  const far = useTexture(cfg.far, srgb);
  const layerTex = useTexture(cfg.layers.map((l) => l.url), srgb);
  return (
    <group position={[0, cfg.box.cy, 0]}>
      {vistaBoxFaces(cfg.box.w, cfg.box.h, cfg.box.d).map((f) => (
        <mesh key={f.kind} position={f.position} rotation={f.rotation}>
          <planeGeometry args={f.size} />
          {f.kind === 'back' ? (
            <meshBasicMaterial map={far} fog={false} />
          ) : (
            <meshBasicMaterial color={cfg.faceColors[f.kind]} fog={false} />
          )}
        </mesh>
      ))}
      {cfg.layers.map((l, i) => (
        <mesh key={l.url} position={[0, l.y, l.z]}>
          <planeGeometry args={[l.w, l.h]} />
          <meshBasicMaterial map={layerTex[i]} alphaTest={0.5} fog={false} />
        </mesh>
      ))}
    </group>
  );
}
```

Notes for the implementer:
- `alphaTest` (not `transparent`) keeps depth-writes on → no transparency-sorting fights with the window glass (which is `transparent` + `depthWrite={false}`).
- `useTexture` with an array returns an array in the same order.
- Do NOT add `castShadow`/`receiveShadow` anywhere here.

- [ ] **Step 2: Mount vistas in `Office.tsx`**

In the back-wall group (currently lines 111–114), add a vista at the opening's local offset — the same `ox, oy` passed to `WallWithWindow`:

```tsx
{/* back wall (behind the boss), with a window onto its own layered city vista */}
<group position={[0, height / 2, backZ]}>
  <WallWithWindow w={width} h={height} ox={-width / 4} oy={2.1 - height / 2} ow={3.6} oh={1.9} />
  <group position={[-width / 4, 2.1 - height / 2, 0]}>
    <WindowVista id="back" />
  </group>
</group>
```

Same pattern in the left-wall group (currently lines 118–121):

```tsx
<group position={[-width / 2, height / 2, centerZ]} rotation={[0, Math.PI / 2, 0]}>
  <WallWithWindow w={depth} h={height} ox={4.5} oy={2.1 - height / 2} ow={3.6} oh={1.9} />
  <group position={[4.5, 2.1 - height / 2, 0]}>
    <WindowVista id="left" />
  </group>
</group>
```

Add `import { WindowVista } from './WindowVista.tsx';` at the top. Update the two wall comments to say "vista" instead of "skybox".

- [ ] **Step 3: Remove the skybox, set a dusk background**

In `web/src/App.tsx`: delete line 6 (`import { Skybox } ...`); replace `<Skybox />` (line 86) with a flat dusk background color inside the `<Canvas>`:

```tsx
<color attach="background" args={['#241d2e']} />
```

(Place it directly inside `<Canvas>`, outside the `<Suspense>` — it's not async.) Then delete the files:

```bash
git rm web/src/scene/Skybox.tsx web/public/skybox/city.jpg
```

- [ ] **Step 4: Verify build + tests**

Run: `npm run build && npm test`
Expected: tsc + vite build succeed (catches the dead Skybox import); full vitest suite passes.

- [ ] **Step 5: Commit**

```bash
git add web/src/scene/WindowVista.tsx web/src/scene/Office.tsx web/src/App.tsx
git commit -m "feat: per-window layered city vistas replace the global skybox"
```

---

### Task 4: Visual verification and tuning

**NOTE:** Needs the running app + Chrome DevTools MCP (load via ToolSearch, e.g. `select:mcp__chrome-devtools__navigate_page,mcp__chrome-devtools__take_screenshot,mcp__chrome-devtools__evaluate_script`) — best run by the main session.

**Files:**
- Modify (tuning only): constants in `web/src/scene/WindowVista.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: tuned `CFG` constants; screenshots confirming the spec's acceptance criteria.

- [ ] **Step 1: Run the app**

`docker compose up -d`, then open `http://localhost:5173` via Chrome DevTools MCP (`new_page`/`navigate_page`).

- [ ] **Step 2: Screenshot each window from several angles**

Check, per window: (a) head-on — city fills the opening, sharp at typical viewing distance; (b) orbit left/right — mid/near layers visibly slide against the far skyline; (c) hard grazing angles and near-ceiling angles — no gaps, no plane edges, no fog-darkened patches; (d) whole room — no vista geometry pokes through walls/floor into the room.

- [ ] **Step 3: Tune constants**

Adjust `CFG` (layer z/size/y, `cy`, face colors so box sides read as haze continuous with the far image edges, background `#241d2e` in App.tsx if slivers clash). Re-screenshot after each change (bind-mounted source; Vite hot-reloads).

- [ ] **Step 4: Full-suite check and commit**

Run: `npm test`
Expected: PASS.

```bash
git add web/src/scene/WindowVista.tsx web/src/App.tsx
git commit -m "polish: tune window vista layer placement and haze colors"
```
