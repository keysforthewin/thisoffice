# Editable Office Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click-to-edit office name in the HUD, persisted server-side, default "This Office".

**Architecture:** `officeName` becomes part of `OfficeState` (broadcast + persisted like everything else). A dedicated `PUT /api/office` endpoint sets it. The HUD label swaps to an inline `<input>` on click.

**Tech Stack:** Node/tsx server, React web, vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-office-name-design.md`

## Global Constraints

- Default name is exactly `This Office`; trim whitespace; cap at 60 chars; empty → default.
- Tests must never touch the real `data/office.json` (injected path, per office.test.ts).

---

### Task 1: Server state + `setOfficeName`

**Files:**
- Modify: `shared/types.ts` (OfficeState), `server/src/office.ts` (PersistedState, load, save, new setter)
- Test: `server/src/office.test.ts`

**Interfaces:**
- Produces: `OfficeState.officeName: string`; `Office.setOfficeName(name: string): void` (trim → cap 60 → empty=default → save + broadcastState); persisted as `officeName?: string` in office.json.

- [ ] **Step 1: Failing tests** — append to `server/src/office.test.ts` (reuse its existing Office construction helper/fixtures):

```ts
describe('officeName', () => {
  it('defaults to This Office on fresh state', () => {
    const office = makeOffice();
    expect(office.getState().officeName).toBe('This Office');
  });

  it('setOfficeName trims, persists, and survives reload', () => {
    const office = makeOffice();
    office.setOfficeName('  Fable Corp  ');
    expect(office.getState().officeName).toBe('Fable Corp');
    const reloaded = makeOfficeSameFile();
    expect(reloaded.getState().officeName).toBe('Fable Corp');
  });

  it('empty or whitespace name resets to the default', () => {
    const office = makeOffice();
    office.setOfficeName('Fable Corp');
    office.setOfficeName('   ');
    expect(office.getState().officeName).toBe('This Office');
  });

  it('caps the name at 60 chars', () => {
    const office = makeOffice();
    office.setOfficeName('x'.repeat(80));
    expect(office.getState().officeName).toBe('x'.repeat(60));
  });
});
```

(Adapt `makeOffice`/`makeOfficeSameFile` to whatever helper office.test.ts actually uses for constructing an Office with an injected temp data file.)

- [ ] **Step 2: Run** `npx vitest run server/src/office.test.ts` — expect FAIL (officeName undefined).

- [ ] **Step 3: Implement**
  - `shared/types.ts`: add `officeName: string;` to `OfficeState` (with a doc comment: HUD title, default "This Office").
  - `server/src/office.ts`:
    - `PersistedState`: add `officeName?: string;`
    - top-level: `const DEFAULT_OFFICE_NAME = 'This Office'; const OFFICE_NAME_MAX = 60;`
    - `load()` return object: `officeName: typeof persisted.officeName === 'string' && persisted.officeName.trim() ? persisted.officeName.trim().slice(0, OFFICE_NAME_MAX) : DEFAULT_OFFICE_NAME,`
    - `save()` persisted object: `officeName: this.state.officeName,`
    - new setter next to `setBoss`:

```ts
  /** HUD title. Empty/whitespace resets to the default; capped at 60 chars. */
  setOfficeName(name: string) {
    const trimmed = name.trim().slice(0, OFFICE_NAME_MAX);
    this.state.officeName = trimmed || DEFAULT_OFFICE_NAME;
    this.save();
    this.broadcastState();
  }
```

- [ ] **Step 4: Run** `npx vitest run server/src/office.test.ts` — expect PASS; then `npm test` for the store/web suites that build OfficeState fixtures (fix any fixture missing `officeName` by adding it).

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: officeName in office state with persistence"`

---

### Task 2: `PUT /api/office` endpoint

**Files:**
- Modify: `server/src/index.ts` (next to the `/api/settings` handler)

**Interfaces:**
- Consumes: `office.setOfficeName` (Task 1).
- Produces: `PUT /api/office` body `{ name: string }` → 200 `{ ok: true }`; non-string name → 400.

- [ ] **Step 1: Implement** — insert before the `/api/settings` block:

```ts
    if (url.pathname === '/api/office' && req.method === 'PUT') {
      const body = await readBody();
      if (typeof body.name !== 'string') return send(400, { error: 'name must be a string' });
      office.setOfficeName(body.name);
      return send(200, { ok: true });
    }
```

- [ ] **Step 2: Verify** `npm test` still green (no endpoint test harness exists; covered by manual check in Task 3).

- [ ] **Step 3: Commit** `git add server/src/index.ts && git commit -m "feat: PUT /api/office endpoint for the office name"`

---

### Task 3: HUD click-to-edit

**Files:**
- Modify: `web/src/App.tsx` (Hud component + hudStyles.topLeft)

**Interfaces:**
- Consumes: `office.officeName` from the store state; `PUT /api/office`.

- [ ] **Step 1: Implement** — in `Hud`, replace the static `This Office` markup:

```tsx
  const officeName = office?.officeName ?? 'This Office';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const commitName = () => {
    setEditing(false);
    const name = draft.trim();
    if (name === officeName) return;
    fetch('/api/office', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
  };
```

and in the JSX:

```tsx
      <div style={hudStyles.topLeft}>
        <span style={{ ...hudStyles.dot, background: connected ? '#4cc38a' : '#e5484d' }} />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              else if (e.key === 'Escape') setEditing(false);
            }}
            maxLength={60}
            style={hudStyles.nameInput}
          />
        ) : (
          <span
            style={{ cursor: 'text' }}
            title="Click to rename"
            onClick={() => {
              setDraft(officeName);
              setEditing(true);
            }}
          >
            {officeName}
          </span>
        )}
      </div>
```

`hudStyles.topLeft`: change `pointerEvents: 'none'` to `pointerEvents: 'auto'`. Add:

```ts
  nameInput: {
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: 4, color: '#e6e8eb', fontFamily: 'system-ui, sans-serif',
    fontSize: 15, fontWeight: 600, padding: '1px 6px', outline: 'none', width: 180,
  },
```

Note: the web dev server must proxy `/api` to the server (check `web/vite.config.ts`; the picker already calls `/api/...`, so the proxy exists).

- [ ] **Step 2: Verify** `npm test` + `npx tsc --noEmit -p web`.

- [ ] **Step 3: Manual browser check** — click name, type, Enter → label updates; reload → persists; second tab → sees it live; clear the field + Enter → back to "This Office"; Esc while editing cancels; camera keys don't fire while typing.

- [ ] **Step 4: Commit** `git add web/src/App.tsx && git commit -m "feat: click-to-edit office name in the HUD"`
