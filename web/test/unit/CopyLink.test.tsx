// React's act() only suppresses its "not configured for act" console warning when this flag is set.
// There's no vitest setupFiles wired up for web/ tests yet (out of scope for this wave - see the
// implementation report), so it's set locally in each spec file instead.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CopyLink } from "../../src/components/CopyLink.tsx";

describe("CopyLink", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { mosni?: unknown }).mosni;
    vi.restoreAllMocks();
  });

  it("copies the preview URL and shows a success toast on click (D-1: one primary action)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };

    act(() => {
      root.render(
        <CopyLink previewUrl="https://files.mosni.dev/abc" directUrl="https://dl.mosni.dev/abc" />,
      );
    });

    const button = container.querySelector("button.btn") as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("https://files.mosni.dev/abc");
    expect(toast).toHaveBeenCalledWith("Link copied", { variant: "success" });
  });

  it("still copies the link when window.mosni is not yet loaded (must not throw)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    act(() => {
      root.render(<CopyLink previewUrl="https://files.mosni.dev/abc" />);
    });

    const button = container.querySelector("button.btn") as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("https://files.mosni.dev/abc");
  });

  it("renders the direct link as a smaller, secondary control - never equal weight with copy (D-1)", () => {
    act(() => {
      root.render(
        <CopyLink previewUrl="https://files.mosni.dev/abc" directUrl="https://dl.mosni.dev/abc" />,
      );
    });

    const directLink = container.querySelector("a") as HTMLAnchorElement;
    expect(directLink).not.toBeNull();
    expect(directLink.getAttribute("href")).toBe("https://dl.mosni.dev/abc");
    expect(directLink.className).not.toContain("btn");
  });

  it("renders no direct link control when directUrl is not provided", () => {
    act(() => {
      root.render(<CopyLink previewUrl="https://files.mosni.dev/abc" />);
    });

    expect(container.querySelector("a")).toBeNull();
  });
});
