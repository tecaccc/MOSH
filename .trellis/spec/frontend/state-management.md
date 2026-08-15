# State Management

> How state is managed in this project (React 19 + zustand).

---

## Overview

The frontend is **React 19 + zustand** (migrated from Svelte 5 runes on 2026-08-15,
task `08-15-react-migration`; see `.trellis/tasks/archive/` for the migration PRD).
Global state lives in `src/state/*.ts`, one zustand store per domain:

| Store | File | Domain |
|---|---|---|
| `useAppStore` | `src/state/store.ts` | todos (records), current view, editor selection |
| `useCalendarStore` | `src/state/calendar.ts` | events, mode/cursor window, event editor |
| `useWeatherStore` | `src/state/weather.ts` | weather status machine |
| `useAgentStore` | `src/state/agent.ts` | chat messages/sessions + Tauri event stream |
| `useReminderStore` | `src/state/reminder.ts` | due reminders |

Framework-agnostic libs (IPC wrappers, calendar math, datetime, lunar, cities,
weather-code) stay in `src/lib/` and must not import from `src/state/` or React.

---

## Patterns

### Store shape: state + actions co-located

```ts
interface AppState {
  records: RecordT[];
  selectedId: string | null | undefined; // null=create, undefined=closed
  setView(v: View): void;
  loadTodos(): Promise<void>;
  // ...
}

export const useAppStore = create<AppState>()((set, get) => ({
  records: [],
  selectedId: undefined,
  setView: (view) => set({ currentView: view }),
  loadTodos: async () => set({ records: await listRecords({ kind: "todo" }) }),
  createTodo: async (input) => {
    const rec = await ipcCreateTodo(input);
    await useAppStore.getState().loadTodos(); // refresh whole list (v1: no optimistic UI)
    set({ selectedId: rec.id });
    return rec;
  },
}));
```

### Components subscribe via selectors

```tsx
const records = useAppStore((s) => s.records);
const setView = useAppStore((s) => s.setView); // actions are stable references
```

- Select the smallest slice needed; avoid `useAppStore()` (subscribes to everything).
- Actions from `create()` are referentially stable — safe as useEffect deps.

### Derived data: pure functions + useMemo

Derived values are plain exported functions over the records array, computed in
the component with `useMemo` (replaces Svelte `$derived`):

```ts
// state/store.ts
export function subtasksOf(records: RecordT[], parentId: string): RecordT[] { ... }

// component
const subs = useMemo(() => subtasksOf(records, id), [records, id]);
```

### Server state

No optimistic UI. Every mutator calls the Tauri IPC command, then re-fetches the
full list (`loadTodos()` / `loadRange()`). SQLite stays the source of truth.

### Tauri event streams (agent://*)

`listen()` registrations live inside the store's `init()` action with a module-level
`listenersBound` guard; the component calls `void init()` once in `useEffect`. Cross-
turn bookkeeping (activeTurnSession / streamingKey) stays module-private.

---

## Common Mistakes

- ❌ Mutating store state directly (`store.records.push()`) — zustand state is
  immutable; always `set()` a new array/object.
- ❌ Reading state outside React via `useAppStore()` without a selector — causes
  re-render storms. Use a selector, or `useAppStore.getState()` in event handlers
  (non-reactive read).
- ❌ Forgetting that a `useEffect` depending on a fresh arrow function re-fires
  every render — depend on stable store actions or primitives instead.
- ⚠️ Form editors (TodoEditor/EventEditor) sync from record identity via
  `useEffect([record])`; a background `loadTodos()` replaces record objects and
  resets in-progress edits (parity with the old Svelte behavior — revisit if
  editing during background refresh matters).
- ⚠️ `npm run check` is `tsc --noEmit` (type-level). `npm run build` (vite) is
  the authoritative gate — keep both green.
