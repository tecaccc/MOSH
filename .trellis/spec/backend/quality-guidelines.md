# Quality Guidelines

> Code quality standards for backend (Rust) development.

---

## Overview

Cargo workspace with two members: `src-tauri` (desktop app shell) and `crates/mosh-core` (shared domain model, storage, service). `mosh-core` is pure library code and is the unit of unit testing; `src-tauri` is a thin Tauri adapter that wires `mosh-core` to IPC commands.

---

## Required Patterns

- Domain logic, storage, and service live in `mosh-core`, **not** `src-tauri`. Tauri commands are a thin adapter over the service layer.
- `rusqlite` with `features = ["bundled"]` so the app never depends on a system SQLite.
- serde models use `#[serde(rename_all = "snake_case")]`; the frontend mirror (`src/lib/types.ts`) must stay aligned (see [Frontend Quality Guidelines](../frontend/quality-guidelines.md)).

---

## Quality Gate

```bash
cargo test -p mosh-core                              # unit tests: model + storage + service
cargo clippy -p mosh-core --all-targets -- -D warnings
```

These must pass for any `mosh-core` change and need **no** system GUI library.

### `cargo tauri build` / `cargo tauri dev` (full app)

Building/running the Tauri app pulls in `tao` / `wry` / GTK, which on Linux requires **system `glib-2.0` ≥ 2.70**. This dev box has 2.68.4, so native `cargo tauri build` / `dev` and full-workspace `cargo clippy --all-targets` fail at the GTK dependency. This is an **environment limitation, not a code defect** — `mosh-core` compiles and tests cleanly on its own.

To verify the full app, use one of:
- A Linux machine with `glib-2.0-devel ≥ 2.70`.
- macOS or Windows.
- Windows cross-compile (see the project's `cross-compile-windows` note).

---

## Common Mistakes

- Treating a workspace-wide `cargo clippy --all-targets` failure on this box as a code problem — first confirm it is not the `glib-2.0` version (look for `glib-2.0 >= 2.70` in the `pkg-config` output).
- Putting domain logic in `src-tauri` commands instead of `mosh-core`.
- Changing the Rust model without updating `src/lib/types.ts`.
