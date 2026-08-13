# State Management

> How state is managed in this project (Svelte 5 runes).

---

## Overview

The frontend uses **Svelte 5 runes** (`$state`, `$derived`, `$props`, `$effect`) exclusively — no Svelte 4 stores. Global reactive state lives in `src/lib/store.svelte.ts` (a `.svelte.ts` module so runes are active). Components read it via exported functions and mutate it via exported mutator functions.

### Two hard Svelte 5 limits on module-level runes (CRITICAL)

Runes work in `.svelte.ts` / `.svelte.js` modules, but the Svelte compiler **forbids** two export shapes. Violating them makes `npm run build` fail — and `npm run check` (type-level) does **not** catch them:

1. **`state_invalid_export`** — you may NOT export a `$state` variable that is ever reassigned.
   > "Cannot export state from a module if it is reassigned."
2. **`derived_invalid_export`** — you may NOT export a `$derived` / `$derived.by` at all.
   > "Cannot export derived state from a module."

The compiler-prescribed remedy for both: **export a function returning the value.**

---

## State Categories

- **Private mutable primitives** (`let x = $state(...)`) — reassignable and reactive, but MUST stay module-private (never exported). e.g. `_currentView`, `selectedId` in `store.svelte.ts`.
- **Exported collection `$state`** — allowed ONLY when mutated in place (`.splice`, `.push`, index assignment), never reassigned. e.g. `export const records = $state<RecordT[]>([])`, mutated via `records.splice(0, records.length, ...list)`.
- **Reactive reads exposed as functions** — any value a component must read reactively is exposed as a function whose body reads a `$state`, e.g. `export function currentView(): View { return _currentView; }`. Called inside a component's reactive context (template or `$derived`), it stays reactive.
- **Derived values** — computed inside exported functions or component-local `$derived`; never exported as a module-level `$derived`.

### Canonical pattern (`src/lib/store.svelte.ts`)

```ts
// Private reassignable primitive — NOT exported.
let _currentView = $state<View>("today");

// Reactive read exposed as a function.
export function currentView(): View {
  return _currentView;
}

// Mutator reassigns the private state.
export function setView(view: View): void {
  _currentView = view;
}

// Exported $state that is only mutated (never reassigned) is allowed.
export const records = $state<RecordT[]>([]);

// Derived over records, exposed as a function (NOT an exported $derived).
export function topLevelTodos(): RecordT[] {
  return records.filter((r) => r.parent_id === null);
}
```

---

## Server State

No optimistic UI. Every mutator calls the Tauri IPC command, then calls `loadTodos()`, which re-fetches the full list and splices it into `records`. The source of truth stays in SQLite; the UI stays trivially consistent. (Subtask B / Calendar may generalize `loadTodos` to an unfiltered `listRecords`.)

---

## Common Mistakes

- ❌ `export const currentView = $state("today")` then `currentView = "tasks"` elsewhere → `state_invalid_export` at build time.
- ❌ `export const topLevelTodos = $derived(records.filter(...))` → `derived_invalid_export` at build time.
- ❌ Treating `npm run check` passing as "the frontend builds" — it does not. Always run `npm run build`. See [Quality Guidelines](./quality-guidelines.md).
- ⚠️ An `$effect` that syncs a prop into local `$state` (e.g. `TodoEditor`) re-runs whenever the source object identity changes. A background `loadTodos()` refresh replaces record objects and can reset in-progress form edits. Acceptable for v1; revisit if editing during a background refresh matters.
