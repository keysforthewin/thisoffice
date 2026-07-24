# Imported Character Scale Adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user tune the size of imported Mixamo characters with a live slider that persists per character, and fix the importer's height measurement so future imports come in the right size.

**Architecture:** A `scale` multiplier lives in the server's `imported.json` metadata, flows to clients through the merged catalog (HTTP + websocket broadcast), and is applied as a `<primitive scale>` at render time in both the office scene and the picker preview. The slider updates the zustand catalog optimistically and persists via a debounced `PATCH /api/characters/:id`.

**Tech Stack:** TypeScript, Node http server (no framework), zustand, React Three Fiber, three.js, vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-character-scale-design.md`

## Global Constraints

- Scale is clamped server-side to **[0.1, 10]**; absent scale means `1`.
- Scale controls appear only for imported characters (`entry.pack === 'Mixamo'`).
- Run all tests from the repo root: `npx vitest run` (workspace root has `"test": "vitest run"`).
- The server runs on port 4680 (`npm run dev:server`); the web app proxies `/api` to it.
- Code style: 2-space indent, single quotes, semicolons, comments only for non-obvious constraints (match existing files).

---

### Task 1: Server-side scale storage

**Files:**
- Modify: `shared/types.ts` (CharacterEntry, ~line 52)
- Modify: `server/src/characters.ts` (ImportedMeta ~line 25, CharacterStore ~line 37, mergedCatalog ~line 102)
- Test: `server/src/characters.test.ts`

**Interfaces:**
- Consumes: existing `CharacterStore.imported: ImportedMeta[]`, `saveMeta()`.
- Produces: `clampScale(scale: number): number` (exported function), `CharacterStore.setScale(id: string, scale: number): boolean` (false for ids not in the imported list), `CharacterEntry.scale?: number` present on imported entries in `mergedCatalog()`.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/characters.test.ts`:

```ts
import { clampScale, CharacterStore } from './characters.ts';

describe('clampScale', () => {
  it('passes through in-range values', () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(2.5)).toBe(2.5);
  });

  it('clamps to [0.1, 10]', () => {
    expect(clampScale(0.001)).toBe(0.1);
    expect(clampScale(50)).toBe(10);
  });
});

describe('CharacterStore.setScale', () => {
  it('returns false for ids that are not imported characters', () => {
    const store = new CharacterStore();
    expect(store.setScale('Knight', 2)).toBe(false); // builtin, not in imported list
    expect(store.setScale('no_such_character_xyz', 2)).toBe(false);
  });
});
```

Note the existing file already imports `describe, expect, it` from vitest and `validMagic` from `./characters.ts` — merge the `./characters.ts` imports into one line: `import { validMagic, clampScale, CharacterStore } from './characters.ts';`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/src/characters.test.ts`
Expected: FAIL — `clampScale` is not exported / `setScale` is not a function.

- [ ] **Step 3: Implement**

In `shared/types.ts`, add to `CharacterEntry` (after the `rev?: number` field):

```ts
  /** runtime size multiplier for imported characters (user-tuned); absent = 1 */
  scale?: number;
```

In `server/src/characters.ts`:

Add near the top (after `MAX_UPLOAD_BYTES`):

```ts
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;

export function clampScale(scale: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}
```

Add `scale?: number;` to the `ImportedMeta` interface.

Add a method to `CharacterStore` (after `register`):

```ts
  setScale(id: string, scale: number): boolean {
    const meta = this.imported.find((m) => m.id === id);
    if (!meta) return false;
    meta.scale = clampScale(scale);
    this.saveMeta();
    return true;
  }
```

In `mergedCatalog()`, add `scale: m.scale,` to the imported entry object (after `rev: m.importedAt,`). `JSON.stringify` drops `undefined`, so untuned characters stay unchanged on the wire.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/src/characters.test.ts`
Expected: PASS (all describe blocks including the pre-existing `validMagic` ones).

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts server/src/characters.ts server/src/characters.test.ts
git commit -m "feat: per-character scale field in import metadata and catalog"
```

---

### Task 2: PATCH endpoint

**Files:**
- Modify: `server/src/index.ts` (character routes, ~line 72-90)

**Interfaces:**
- Consumes: `characters.setScale(id, scale): boolean` from Task 1; existing `sanitizeId`, `readBody()`, `publishCatalog()`, `send()`.
- Produces: `PATCH /api/characters/:id` with JSON body `{ scale: number }` → `200 {ok:true}`; `400` for bad id or non-finite scale; `404` for builtin/unknown ids. On success the merged catalog is re-broadcast to every websocket client.

- [ ] **Step 1: Implement the route**

In `server/src/index.ts`, after the `charMatch && req.method === 'POST'` block and before the DELETE block, add:

```ts
    if (charMatch && req.method === 'PATCH') {
      const id = sanitizeId(charMatch[1]);
      if (!id) return send(400, { error: 'bad character id' });
      const body = await readBody();
      if (typeof body.scale !== 'number' || !Number.isFinite(body.scale)) {
        return send(400, { error: 'scale must be a finite number' });
      }
      // builtins are never in the imported list, so setScale 404s them too
      if (!characters.setScale(id, body.scale)) {
        return send(404, { error: 'not an imported character' });
      }
      publishCatalog();
      return send(200, { ok: true });
    }
```

(A malformed JSON body makes `readBody()` reject; the surrounding `.catch((e) => send(500, ...))` handles it — consistent with the existing routes.)

- [ ] **Step 2: Verify manually with curl**

Start the server: `npm run dev:server` (background). Then:

```bash
curl -s -X PATCH localhost:4680/api/characters/Knight -d '{"scale":2}'          # expect {"error":"not an imported character"} (404)
curl -s -X PATCH localhost:4680/api/characters/Knight -d '{"scale":"big"}'      # expect {"error":"scale must be a finite number"} (400)
```

If an imported character exists on this machine (check `curl -s localhost:4680/api/catalog | grep Mixamo`), also PATCH it with `{"scale":2}` and confirm `{"ok":true}` and that `GET /api/catalog` now shows `"scale":2` on that entry — and a clamped value like `{"scale":99}` comes back as `"scale":10`.

- [ ] **Step 3: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: PATCH /api/characters/:id to set imported character scale"
```

---

### Task 3: Importer height measurement fix

**Files:**
- Modify: `web/src/importer/convert.ts` (~line 179-187)
- Test: `web/src/importer/convert.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (independent).
- Produces: `measureSkinnedHeight(root: THREE.Object3D): number` (exported; 0 when no skinned meshes), used inside `convertCharacter` in place of the whole-group `Box3`.

- [ ] **Step 1: Write the failing test**

Append to `web/src/importer/convert.test.ts` (add `import * as THREE from 'three';` and add `measureSkinnedHeight` to the existing `./convert.ts` import):

```ts
describe('measureSkinnedHeight', () => {
  it('measures skinned meshes only, ignoring helper nodes', () => {
    const group = new THREE.Group();
    const skinned = new THREE.SkinnedMesh(
      new THREE.BoxGeometry(1, 1.8, 1), // character-sized
      new THREE.MeshBasicMaterial(),
    );
    skinned.position.y = 0.9; // feet at y=0
    group.add(skinned);
    // stray tall helper mesh like the ones Mixamo FBX exports sometimes carry
    const helper = new THREE.Mesh(new THREE.BoxGeometry(1, 100, 1), new THREE.MeshBasicMaterial());
    group.add(helper);
    group.add(new THREE.Object3D());

    expect(measureSkinnedHeight(group)).toBeCloseTo(1.8);
  });

  it('returns 0 when there is no skinned mesh', () => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 5, 1), new THREE.MeshBasicMaterial()));
    expect(measureSkinnedHeight(group)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/importer/convert.test.ts`
Expected: FAIL — `measureSkinnedHeight` is not exported.

- [ ] **Step 3: Implement**

In `web/src/importer/convert.ts`, add after `normalizeTrackName`:

```ts
/**
 * Height of the skinned geometry only. Mixamo FBX groups sometimes carry
 * stray helper nodes (nulls, lights, reference meshes) that inflate a
 * whole-group Box3 and make the height normalizer shrink the character.
 * Bind-pose geometry bounds are close enough for a T-posed Mixamo export.
 */
export function measureSkinnedHeight(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.geometry.computeBoundingBox();
    meshBox.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    box.union(meshBox);
  });
  return box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).y;
}
```

In `convertCharacter`, replace:

```ts
  group.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  const root = new THREE.Group();
  root.name = id;
  if (size.y > 0.001) {
    root.scale.setScalar(TARGET_HEIGHT / size.y);
```

with:

```ts
  const height = measureSkinnedHeight(group);
  const root = new THREE.Group();
  root.name = id;
  if (height > 0.001) {
    root.scale.setScalar(TARGET_HEIGHT / height);
```

(The `else` warning branch stays as is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/importer/convert.test.ts`
Expected: PASS (including the pre-existing name-normalization tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/importer/convert.ts web/src/importer/convert.test.ts
git commit -m "fix: measure import height from skinned meshes only"
```

---

### Task 4: Apply scale at render time

**Files:**
- Modify: `web/src/store.ts` (AppStore interface + store body)
- Modify: `web/src/scene/Person.tsx` (~line 17 and ~line 47)
- Modify: `web/src/settings/picker/CharacterPreview.tsx` (`PreviewModel`, ~line 64-96)

**Interfaces:**
- Consumes: `CharacterEntry.scale?: number` from Task 1; existing `catalogEntry(catalog, id)`.
- Produces: `useStore` action `setCharacterScale(id: string, scale: number): void` (optimistic catalog patch, used by Task 5); office-scene and preview models rendered at `entry.scale ?? 1`.

- [ ] **Step 1: Add the store action**

In `web/src/store.ts`, add to the `AppStore` interface (after `setCatalog`):

```ts
  /** optimistic local patch while the scale slider drags; server broadcast confirms it */
  setCharacterScale: (id: string, scale: number) => void;
```

and to the store body (after `setCatalog: ...`):

```ts
  setCharacterScale: (id, scale) =>
    set((s) =>
      s.catalog
        ? {
            catalog: {
              ...s.catalog,
              characters: s.catalog.characters.map((c) => (c.id === id ? { ...c, scale } : c)),
            },
          }
        : {},
    ),
```

- [ ] **Step 2: Apply scale in Person.tsx**

In `web/src/scene/Person.tsx`, hoist the entry lookup and scale the primitive:

```ts
  const catalog = useStore((s) => s.catalog);
  const entry = catalogEntry(catalog, variant);
  const { clone, clips } = useCharacterModel(variant, entry);
```

and change the render to:

```tsx
    <group ref={group} position={position} rotation={[0, rotationY, 0]}>
      <primitive object={clone} scale={entry?.scale ?? 1} />
    </group>
```

(Scale goes on the `<primitive>`, not the group, so `position` stays in world units.)

- [ ] **Step 3: Apply scale in the picker preview**

In `web/src/settings/picker/CharacterPreview.tsx`'s `PreviewModel`, read the scale from the live store (the `shown` entry is debounced 150 ms for model switches; the slider must not lag behind it):

```ts
  const scale = useStore((s) => catalogEntry(s.catalog, entry.id)?.scale ?? 1);
```

(`catalogEntry` is exported from `../../characters/catalog.ts`; add it to the existing `resolveClip` import.) Then:

```tsx
    <group ref={group}>
      <primitive object={clone} scale={scale} />
    </group>
```

- [ ] **Step 4: Typecheck and test**

Run: `npm run build` (runs `tsc -b` for web) and `npx vitest run`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/store.ts web/src/scene/Person.tsx web/src/settings/picker/CharacterPreview.tsx
git commit -m "feat: render imported characters at their catalog scale"
```

---

### Task 5: Size slider UI

**Files:**
- Modify: `web/src/settings/picker/CharacterPreview.tsx` (footer, ~line 42-59, plus a new `ScaleSlider` component and styles)

**Interfaces:**
- Consumes: `setCharacterScale` from Task 4; `PATCH /api/characters/:id {scale}` from Task 2; `catalogEntry` from catalog.ts.
- Produces: user-facing slider; no exports consumed elsewhere.

- [ ] **Step 1: Implement the slider**

In `web/src/settings/picker/CharacterPreview.tsx`, add imports for `useCallback` (extend the existing react import) and add this component after `PreviewModel`:

```tsx
/** Log-scale size control for imported characters: 0.1× – 10×, persisted per character. */
function ScaleSlider({ id }: { id: string }) {
  const scale = useStore((s) => catalogEntry(s.catalog, id)?.scale ?? 1);
  const setCharacterScale = useStore((s) => s.setCharacterScale);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);

  const persist = useCallback((value: number) => {
    pending.current = null;
    fetch(`/api/characters/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: value }),
    }).catch(() => {
      /* slider keeps working locally; next successful PATCH wins */
    });
  }, [id]);

  const apply = (value: number) => {
    setCharacterScale(id, value);
    pending.current = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(value), 300);
  };

  // flush a pending change when the picker closes mid-debounce
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current !== null) persist(pending.current);
  }, [persist]);

  return (
    <div style={styles.scaleRow}>
      <span style={styles.scaleLabel}>Size</span>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={Math.log10(scale)}
        onChange={(e) => apply(Number((10 ** Number(e.target.value)).toFixed(2)))}
        style={{ flex: 1 }}
      />
      <span style={styles.scaleValue}>{scale.toFixed(2)}×</span>
      <button style={styles.scaleReset} onClick={() => apply(1)} title="Reset to 1×">↺</button>
    </div>
  );
}
```

In the footer (after the tags block, inside the `{entry && ...}` scope), add:

```tsx
        {entry?.pack === 'Mixamo' && <ScaleSlider key={entry.id} id={entry.id} />}
```

(`key={entry.id}` remounts the slider per character so the unmount-flush fires when switching characters mid-debounce.)

Add to the `styles` object:

```ts
  scaleRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 },
  scaleLabel: { fontSize: 12, color: '#9aa4b0' },
  scaleValue: { fontSize: 12, color: '#e6e8eb', minWidth: 44, textAlign: 'right' as const },
  scaleReset: {
    background: 'none', border: '1px solid #2c333d', color: '#9aa4b0',
    borderRadius: 5, cursor: 'pointer', fontSize: 12, padding: '2px 7px',
  },
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual verification**

With `npm run dev` running and an imported character available:
1. Open the character picker, highlight the imported character → Size slider appears; built-ins show none.
2. Drag the slider → preview model resizes live; if the character is seated in the office, it resizes there too (catalog broadcast).
3. Reload the page → the tuned scale is still applied (persisted in `imported.json`).

- [ ] **Step 4: Commit**

```bash
git add web/src/settings/picker/CharacterPreview.tsx
git commit -m "feat: size slider for imported characters in the picker preview"
```
