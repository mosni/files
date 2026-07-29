import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VisibilityBadge } from "../../src/components/VisibilityBadge.tsx";

// D-103: the "why can I see this" indicator ships all four cases now. Server-rendered to a string is
// enough here - this component has no interactivity, only a label + a mosni-chrome badge class per reason.
describe("VisibilityBadge (D-103: own / granted / admin / public)", () => {
  it("own", () => {
    const html = renderToStaticMarkup(<VisibilityBadge reason="own" />);
    expect(html).toContain("Yours");
    expect(html).toContain("badge primary");
  });

  it("granted", () => {
    const html = renderToStaticMarkup(<VisibilityBadge reason="granted" />);
    expect(html).toContain("Shared with you");
    expect(html).toContain("badge cyan");
  });

  it("admin", () => {
    const html = renderToStaticMarkup(<VisibilityBadge reason="admin" />);
    expect(html).toContain("Admin view");
    expect(html).toContain("badge indigo");
  });

  it("public", () => {
    const html = renderToStaticMarkup(<VisibilityBadge reason="public" />);
    expect(html).toContain("Public");
    expect(html).toContain("badge success");
  });
});
