import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VisibilityIndicator } from "../../src/components/VisibilityIndicator.tsx";

// D-103: the "why can I see this" indicator ships all four cases, now an icon+tooltip (E4.1 Wave B3)
// rather than a `.badge` pill. Server-rendered to a string is enough here - no interactivity of its own.
describe("VisibilityIndicator (D-103/D-189: own / hosted / granted / admin / public)", () => {
  it("own", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="own" />);
    expect(html).toContain('text="Yours"');
    expect(html).toContain('aria-label="Yours"');
    expect(html).toContain('name="user"');
  });

  it("hosted (D-189)", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="hosted" />);
    expect(html).toContain('text="In your collection"');
    expect(html).toContain('aria-label="In your collection"');
    expect(html).toContain('name="folder-open"');
  });

  it("granted", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="granted" />);
    expect(html).toContain('text="Shared with you"');
    expect(html).toContain('aria-label="Shared with you"');
    expect(html).toContain('name="users"');
  });

  it("admin", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="admin" />);
    expect(html).toContain('text="Admin view"');
    expect(html).toContain('aria-label="Admin view"');
    expect(html).toContain('name="shield"');
  });

  it("public", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="public" />);
    expect(html).toContain('text="Public"');
    expect(html).toContain('aria-label="Public"');
    expect(html).toContain('name="globe"');
  });

  it("carries an accessible name independent of the tooltip (role=img + aria-label)", () => {
    const html = renderToStaticMarkup(<VisibilityIndicator reason="own" />);
    expect(html).toContain('role="img"');
  });
});
