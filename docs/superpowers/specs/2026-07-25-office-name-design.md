# Editable Office Name

Date: 2026-07-25
Status: approved

## Goal

Make the "This Office" label in the top-left of the web UI click-to-edit.
The name persists on the server so every client (current and future) sees it.
"This Office" is the default, and clearing the field resets to it.

## Behavior

- Click the top-left title → it swaps to an inline text input in place, same
  styling, pre-filled with the current name and text selected.
- Enter or blur saves; Esc cancels (reverts to the current name).
- Saving an empty/whitespace-only name resets to the default "This Office".
- The server persists the name in `data/office.json` and broadcasts the
  updated state over the WebSocket — all connected clients update live.
- A fresh or reset `office.json` defaults to "This Office".

## Implementation

- **`shared/types.ts`** — `officeName: string` added to `OfficeState`.
- **`server/src/office.ts`** — state loading defaults `officeName` to
  `'This Office'` (also for pre-existing office.json files that lack the
  field); `setOfficeName(name: string)` trims, caps at 60 chars, maps empty
  to the default, persists, and broadcasts.
- **`server/src/index.ts`** — `PUT /api/office` accepting `{ name: string }`
  (dedicated endpoint; `/api/settings` already uses `body.name` for the boss).
  Non-string names → 400.
- **`web/src/App.tsx`** — the HUD top-left reads `office.officeName` from the
  store (fallback "This Office" while state hasn't arrived). Click-to-edit
  inline `<input>`; the existing `isTyping` guard already stops camera
  hotkeys while typing. `hudStyles.topLeft`'s `pointerEvents: 'none'` is
  lifted so the label is clickable.

## Edge cases

- Empty / whitespace name → server stores the default.
- Name longer than 60 chars → truncated server-side.
- Old `data/office.json` without `officeName` → default applied on load.
- Editing while disconnected: the PUT fails; the label falls back to the
  last-known state (no optimistic client-side persistence).

## Testing

- Server unit tests (`office.test.ts` style, injected data path):
  `setOfficeName` trim/cap/empty→default, persistence round-trip, default on
  fresh state and on legacy state missing the field.
- Manual browser check: edit, reload, second tab sees the name.
