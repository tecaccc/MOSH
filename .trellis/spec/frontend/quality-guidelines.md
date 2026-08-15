# Quality Guidelines

> Code quality standards for frontend development (React 19 + Vite).

---

## Overview

- TypeScript strict; React 19 function components + hooks only.
- State: zustand stores in `src/state/` (see [State Management](./state-management.md)).
- Styles: CSS Modules per component (`*.module.css`) + global CSS variables in
  `src/styles/global.css` (light/dark themes). No CSS-in-JS, no Tailwind.
- The type mirror in `src/lib/types.ts` is hand-aligned to `crates/mosh-core/src/model.rs`
  (snake_case via serde `rename_all = "snake_case"`). When the Rust model changes,
  update the mirror in the same change.
- Chat markdown rendering: `streamdown` (`<Streamdown parseIncompleteMarkdown>`),
  imported in ChatPanel with `streamdown/styles.css`; bubble-local overrides in
  `src/styles/markdown-chat.css` (global — injected DOM doesn't receive CSS Module
  classes). Model output never goes through raw `dangerouslySetInnerHTML`.

---

## Required Patterns

- Components subscribe to zustand via **selectors**; derived data via exported pure
  functions + `useMemo`.
- IPC payloads use snake_case field names. (Tauri 2 command *arguments* are camelCase,
  but payload *contents* — `RecordFilter` / `RecordPatch` / `TodoInput` — are snake_case.)
- Recursive components (TodoItem) self-import; no special runtime needed.
- Tauri-only APIs (`getCurrentWindow`, event `listen`) must no-op or degrade gracefully
  in a plain browser (`"__TAURI_INTERNALS__" in window`).

## Forbidden Patterns

- Directly mutating zustand state instead of `set()`.
- Raw `dangerouslySetInnerHTML` over model/user content (XSS). The only sanctioned
  uses are static local icon strings (WEATHER_ICONS).
- Putting React imports into `src/lib/*` framework-agnostic modules.

---

## Testing / Quality Gate

Run all of these; all must pass before declaring frontend work done:

```bash
npm run check   # tsc --noEmit — type level, necessary but NOT sufficient
npm run build   # vite production build to build/ — authoritative
```

Rust side (when touched): `cargo test -p mosh-core && cargo clippy -p mosh-core`.

---

## Code Review Checklist

- [ ] `npm run build` passes (not just `npm run check`).
- [ ] No zustand state mutation outside `set()`.
- [ ] No raw `dangerouslySetInnerHTML` on untrusted content.
- [ ] `src/lib/types.ts` still matches the Rust model if the model changed.
- [ ] IPC payload fields are snake_case.
- [ ] New styles use CSS variables from `global.css` (theme-aware).
