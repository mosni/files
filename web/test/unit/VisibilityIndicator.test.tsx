(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { VisibilityIndicator } from "../../src/components/VisibilityIndicator.tsx";

// D-103: the "why can I see this" indicator ships all four cases, now an icon+tooltip (E4.1 Wave B3)
// rather than a `.badge` pill. Server-rendered to a string is enough here - no interactivity of its own.
// E7.5 Wave B: <Tooltip> (@mosni/react) replaces <mosni-tooltip> - it clones the anchor in place (no
// wrapper element, no `text` attribute) and portals the hover text client-side only, so SSR output never
// contains it. The accessible name (aria-label on the cloned anchor) is the assertion that survives.
describe("VisibilityIndicator (D-103/D-189: own / hosted / granted / admin / public)", () => {
  it("own", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="own" />);
    expect(html).toContain('aria-label="Yours"');
    expect(html).toContain('name="user"');
  });

  it("hosted (D-189)", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="hosted" />);
    expect(html).toContain('aria-label="In your collection"');
    expect(html).toContain('name="folder-open"');
  });

  it("granted", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="granted" />);
    expect(html).toContain('aria-label="Shared with you"');
    expect(html).toContain('name="users"');
  });

  it("admin", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="admin" />);
    expect(html).toContain('aria-label="Admin view"');
    expect(html).toContain('name="shield"');
  });

  it("public", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="public" />);
    expect(html).toContain('aria-label="Public"');
    expect(html).toContain('name="globe"');
  });

  it("carries an accessible name independent of the tooltip (role=img + aria-label)", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="own" />);
    expect(html).toContain('role="img"');
  });
});

// ⚠ Review session 055. The SSR block above used to assert `text="Yours"` on `<mosni-tooltip>`; E7.5
// dropped that line because `<Tooltip>` portals its tip to document.body on the CLIENT and renders
// nothing for it under renderToStaticMarkup. Nothing replaced it, so the hover text - the only thing this
// component exists to show - was asserted at no tier: `aria-label` is a different prop on a different
// element, so deleting `text={label}` from the JSX would have left every test above green. The tip is
// rendered eagerly and merely `hidden` until hover, so a client render can read it without simulating one.
describe("VisibilityIndicator: the tooltip actually receives its text (E7.5 Wave B)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ["own", "Yours"],
    ["hosted", "In your collection"],
    ["granted", "Shared with you"],
    ["admin", "Admin view"],
    ["public", "Public"],
  ] as const)("%s renders its label as the tip text", (reason, label) => {
    act(() => {
      root.render(<VisibilityIndicator reason={reason} />);
    });

    const tip = document.body.querySelector('[role="tooltip"]');
    expect(tip, "<Tooltip> must portal a tip element even before hover").not.toBeNull();
    expect(tip!.textContent).toBe(label);
  });
});
