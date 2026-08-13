# Quality Guidelines

> Code quality standards for frontend development (Svelte 5 + Vite).

---

## Overview

- TypeScript strict; Svelte 5 runes only (no Svelte 4 stores, no `<svelte:self>`).
- The type mirror in `src/lib/types.ts` is hand-aligned to `crates/mosh-core/src/model.rs` (snake_case via serde `rename_all = "snake_case"`). When the Rust model changes, update the mirror in the same change.

---

## Forbidden Patterns

- **Exporting reassigned `$state` from a `.svelte.ts` module** → `state_invalid_export`. See [State Management](./state-management.md).
- **Exporting `$derived` / `$derived.by` from a `.svelte.ts` module** → `derived_invalid_export`.
- **`<svelte:self>`** — deprecated in Svelte 5. Use a self-import for recursive components:

  ```svelte
  <script lang="ts">
    import TodoItem from "./TodoItem.svelte";
  </script>
  <!-- ... -->
  <TodoItem record={child} />
  ```

---

## Required Patterns

- Recursive components use **self-import** (above), never `<svelte:self>`.
- Reactive global reads go through **exported functions**, not exported `$state`/`$derived` bindings. See [State Management](./state-management.md).
- IPC payloads use snake_case field names. (Tauri 2 command *arguments* are camelCase, but payload *contents* — `RecordFilter` / `RecordPatch` / `TodoInput` — are snake_case.)

---

## Testing / Quality Gate

Run all of these; all must pass before declaring frontend work done:

```bash
npm run check   # svelte-check / TS — necessary but NOT sufficient
npm run build   # Vite + adapter-static production build — authoritative
```

> `npm run check` is type-level only. It does **not** detect the Svelte 5 module-export rune rules. **`npm run build` is the authoritative gate** — a change that passes `check` but fails `build` is not done.

---

## Code Review Checklist

- [ ] `npm run build` passes (not just `npm run check`).
- [ ] No exported reassigned `$state`; no exported `$derived`.
- [ ] No `<svelte:self>`.
- [ ] `src/lib/types.ts` still matches the Rust model if the model changed.
- [ ] IPC payload fields are snake_case.
