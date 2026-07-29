(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProtectionControl } from "../../src/components/ProtectionControl.tsx";
import type { Protection } from "../../../app/src/lib/protection.ts";

function setNativeSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root;

// D-104/D3: FileBrowser reuses this exact control rather than a second implementation - ManageControls'
// own tests (rename/delete/etc.) still cover the file-preview-page wiring; this covers the extracted
// control in isolation, since a browse row hands it a different onChange (PATCH /api/collections/:id or
// /api/files/:id, then a listing reload) than ManageControls' own (PATCH + apply the returned context).
describe("ProtectionControl (D-89/D-104: the reusable protection selector)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the four levels with the current one selected and its explanation shown", () => {
    act(() => {
      root.render(<ProtectionControl id="x" protection="unlisted" onChange={vi.fn()} />);
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("unlisted");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["public", "unlisted", "secret", "private"]);
    expect(container.textContent).toContain("Not listed, but the link works for anyone who has it.");
  });

  it("calls onChange with the newly selected level and keeps it selected on success", async () => {
    const onChange = vi.fn().mockResolvedValue(true);
    act(() => {
      root.render(<ProtectionControl id="x" protection="unlisted" onChange={onChange} />);
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      setNativeSelectValue(select, "private");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(onChange).toHaveBeenCalledWith("private");
    expect(select.value).toBe("private");
  });

  it("reverts to the previous level when onChange reports failure", async () => {
    const onChange = vi.fn().mockResolvedValue(false);
    act(() => {
      root.render(<ProtectionControl id="x" protection="unlisted" onChange={onChange} />);
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      setNativeSelectValue(select, "private");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(select.value).toBe("unlisted");
  });

  it("a later protection prop change updates the displayed value (row data refreshed after a reload)", () => {
    act(() => {
      root.render(<ProtectionControl id="x" protection="unlisted" onChange={vi.fn()} />);
    });
    act(() => {
      root.render(<ProtectionControl id="x" protection={"secret" as Protection} onChange={vi.fn()} />);
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("secret");
  });
});
