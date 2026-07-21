// React's act() only suppresses its "not configured for act" console warning when this flag is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CopyLink } from "../../src/components/CopyLink.tsx";

describe("CopyLink (P9: read-only inputs with a copy icon)", () => {
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
    delete (window as unknown as { mosni?: unknown }).mosni;
    vi.restoreAllMocks();
  });

  it("shows the preview URL in a read-only input and copies it + toasts on the primary copy click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };

    act(() => {
      root.render(<CopyLink previewUrl="https://files.mosni.dev/f/abc" directUrl="https://dl.mosni.dev/abc" />);
    });

    const previewInput = container.querySelector(
      ".copy-field-primary input",
    ) as HTMLInputElement;
    expect(previewInput.readOnly).toBe(true);
    expect(previewInput.value).toBe("https://files.mosni.dev/f/abc");

    const primaryCopy = container.querySelector(".copy-field-primary button.btn") as HTMLButtonElement;
    await act(async () => {
      primaryCopy.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("https://files.mosni.dev/f/abc");
    expect(toast).toHaveBeenCalledWith("Link copied", { variant: "success" });
  });

  it("still copies when window.mosni is not yet loaded (must not throw)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    act(() => root.render(<CopyLink previewUrl="https://files.mosni.dev/f/abc" />));

    const primaryCopy = container.querySelector(".copy-field-primary button") as HTMLButtonElement;
    await act(async () => {
      primaryCopy.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("https://files.mosni.dev/f/abc");
  });

  it("renders the direct link as a secondary read-only input whose copy button is not the primary .btn", () => {
    act(() => {
      root.render(<CopyLink previewUrl="https://files.mosni.dev/f/abc" directUrl="https://dl.mosni.dev/abc" />);
    });

    const secondaryInput = container.querySelector(".copy-field-secondary input") as HTMLInputElement;
    expect(secondaryInput.value).toBe("https://dl.mosni.dev/abc");
    const secondaryButton = container.querySelector(".copy-field-secondary button") as HTMLButtonElement;
    expect(secondaryButton.className).not.toContain("btn");
  });

  it("renders no secondary field when directUrl is not provided", () => {
    act(() => root.render(<CopyLink previewUrl="https://files.mosni.dev/f/abc" />));
    expect(container.querySelector(".copy-field-secondary")).toBeNull();
    expect(container.querySelectorAll(".copy-field")).toHaveLength(1);
  });
});
