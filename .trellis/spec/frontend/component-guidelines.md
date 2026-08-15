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

## Injected HTML Content and Scoped Styles (React / streamdown, updated 08-15-react-migration)

DOM injected by React (`dangerouslySetInnerHTML`) or by `streamdown` **does not
receive** CSS Module class hashing. Styles for injected content go in a global
stylesheet (`src/styles/markdown-chat.css`) scoped by a wrapper selector:

```css
/* markdown-chat.css — wrapper-scoped global rules */
.bubble.bot pre { background: var(--surface-2); }  /* ✅ matches injected nodes */
.bubble.pre { ... }                                 /* ❌ module class never on injected DOM */
```

## Markdown Rendering (chat assistant bubbles)

- Rendering is `streamdown` (`<Streamdown>`, React binding; used by cherry-studio)
  inside `ChatPanel.tsx`, with `streamdown/styles.css` imported once.
- `parseIncompleteMarkdown` is set while the message is streaming — streamdown
  internally repairs half-typed markdown (remend) and sanitizes (rehype-sanitize
  + harden). Do **not** pass model output through raw `dangerouslySetInnerHTML`.
- Bubble-local theming lives in `src/styles/markdown-chat.css` (global file;
  injected DOM gets no CSS Module classes) and uses the CSS variables from
  `src/styles/global.css` for light/dark support.
- To swap the renderer later, keep the change inside `ChatPanel.tsx` — call
  sites stay stable.
