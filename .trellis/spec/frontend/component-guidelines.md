# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)

---

## `{@html}` Content and Svelte Scoped Styles (added 08-15-chat-markdown)

DOM injected via `{@html}` **does not receive** the component's scoped style
hash. Styles for injected content must use `:global()` under a scoped wrapper
class:

```svelte
<div class="md">{@html html}</div>

<style>
  .md :global(p) { margin: 0.5em 0; }   /* ✅ scoped wrapper + global target */
  .md p { color: red; }                 /* ❌ never matches injected <p> */
</style>
```

## Markdown Rendering (chat assistant bubbles)

- `src/lib/components/Markdown.svelte` is the **single entry point** for
  markdown rendering (props: `text`, `streaming`). All `{@html}` markdown
  output goes through `src/lib/markdown.ts`, which **must** run DOMPurify —
  model output is untrusted content; raw `{@html}` of model text is forbidden.
- Streaming: append a plain-text cursor char (`▍`) before parsing so the cursor
  lands correctly inside any block (including code fences); unclosed ``` fences
  are temporarily closed for parsing only (never written back to message state).
- To swap the rendering library later (e.g. markstream-svelte), only
  `Markdown.svelte` + `markdown.ts` change — call sites stay stable.
