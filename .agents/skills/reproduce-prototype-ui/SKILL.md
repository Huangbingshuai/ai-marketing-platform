---
name: reproduce-prototype-ui
description: Reproduce a formal Vue frontend from this repository's frozen HTML prototypes with high visual and interaction fidelity. Use when creating, rebuilding, or correcting a workflow page whose layout, styling, states, or behavior must match a prototype under references/prototypes.
---

# Reproduce Prototype UI

## 1. Select the exact reference

1. Read root `AGENTS.md`, `apps/web/AGENTS.md`, `docs/development/agent-guides/prototypes.md`, and the matching workflow guide under `docs/workflows/`.
2. Locate the exact frozen prototype and inspect it in a browser. Do not choose a file only because its name sounds similar.
3. Capture the required node, default state, overlays, empty/loading/error states and important interactions.

## 2. Build a comparison map

Before editing, map prototype regions to formal components:

- page shell and workflow canvas;
- node header and primary action;
- main cards, grids, sidebars and scroll containers;
- dialogs, dropdowns, tables, timelines and result cards;
- responsive behavior and fixed elements.

Record the existing formal components and design tokens that can reproduce them. Avoid adding a second page shell or a duplicate workflow canvas.

## 3. Implement in the formal architecture

- Preserve the prototype's hierarchy, spacing, colors, copy hierarchy, controls and interaction sequence.
- Use Vue components, project stores and typed API services; do not paste the whole prototype DOM/script into production.
- Replace prototype Mock state with explicit fixtures or API states while preserving the same visual states.
- Do not make unsolicited redesigns. Deviate only for a confirmed requirement, accessibility, responsive correctness or real data constraints.

## 4. Visual verification

1. Run the formal app and open the exact route.
2. Compare against the prototype at relevant desktop widths and the narrow layout used by the project.
3. Check default, selected, disabled, loading, empty, error, completed and modal states.
4. Check that switching workflow/node does not leave duplicate or hidden components behind.
5. Iterate on visible differences before handing off.

Report deliberate deviations with their reason. Never claim pixel fidelity without browser comparison.
