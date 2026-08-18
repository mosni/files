(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../src/lib/admin.ts", () => ({
  fetchGrants: vi.fn(),
  fetchUsage: vi.fn(),
  revokeGrant: vi.fn(),
}));

import { AdminPage } from "../../src/pages/Admin.tsx";
import { fetchGrants, fetchUsage, revokeGrant } from "../../src/lib/admin.ts";
import type { AdminGrantRow, AdminUsageResponse } from "../../../app/src/lib/adminContext.ts";

const fetchGrantsMock = vi.mocked(fetchGrants);
const fetchUsageMock = vi.mocked(fetchUsage);
const revokeGrantMock = vi.mocked(revokeGrant);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const USAGE: AdminUsageResponse = {
  volume: { totalBytes: 1_000_000_000_000, freeBytes: 400_000_000_000, usedBytes: 600_000_000_000 },
  tracked: { bytes: 500_000_000_000, fileCount: 42 },
  untrackedBytes: 100_000_000_000,
  byOwner: [{ ownerSub: "user:owner", bytes: 500_000_000_000, fileCount: 42 }],
  topCollections: [{ collectionId: "c1", name: "photos", ownerSub: "user:owner", bytes: 500_000_000_000, fileCount: 42 }],
};

const ACTIVE_GRANT: AdminGrantRow = {
  targetType: "file",
  targetId: "f1",
  targetName: "photo.jpg",
  ownerSub: "user:owner",
  sub: "user:grantee",
  canUpload: false,
  grantedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: null,
  status: "active",
};

const EXPIRED_GRANT: AdminGrantRow = {
  targetType: "collection",
  targetId: "c1",
  targetName: "photos",
  ownerSub: "user:owner",
  sub: "link:9f86d081-884c-4d1c-9be0-11223344556677",
  canUpload: true,
  grantedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-02T00:00:00.000Z",
  status: "expired",
};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render() {
  act(() => {
    root.render(<AdminPage />);
  });
}

describe("AdminPage (E8)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // <Modal> portals to document.body, outside `container` - clean up any stray dialog nodes between
    // tests the same way ShareDialog.test.tsx does.
    document.querySelectorAll("dialog").forEach((d) => d.remove());
    fetchGrantsMock.mockReset();
    fetchUsageMock.mockReset();
    revokeGrantMock.mockReset();
  });

  it("renders both sections from the stubbed API", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [ACTIVE_GRANT] }));
    render();
    await flush();

    expect(container.textContent).toContain("Usage");
    expect(container.textContent).toContain("Access");
    expect(container.textContent).toContain("photo.jpg");
  });

  it("shows the untracked line", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [] }));
    render();
    await flush();

    expect(container.textContent).toContain("Not tracked by the app");
  });

  it("volume: null degrades without throwing", async () => {
    fetchUsageMock.mockResolvedValue(
      jsonResponse({ volume: null, tracked: { bytes: 0, fileCount: 0 }, untrackedBytes: null, byOwner: [], topCollections: [] }),
    );
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [] }));
    render();
    await flush();

    expect(container.textContent).toContain("Volume figures are unavailable");
  });

  it("renders an expired grant as expired", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [EXPIRED_GRANT] }));
    render();
    await flush();

    expect(container.textContent).toContain("Expired");
  });

  it("states the link-shares scope in copy (D-218)", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [] }));
    render();
    await flush();

    expect(container.textContent).toContain("Files shared by link are not listed here");
  });

  it("revoke calls the endpoint and drops the row from the list, after confirming", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [ACTIVE_GRANT] }));
    revokeGrantMock.mockResolvedValue(jsonResponse({}));
    render();
    await flush();

    const revokeButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Revoke")!;
    act(() => {
      revokeButton.click();
    });
    await flush();

    // The confirmation modal (@mosni/react's <Modal>) portals to document.body, not `container`.
    expect(document.body.textContent).toContain("Access ends now");
    const confirmButton = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Yes, revoke")!;
    act(() => {
      confirmButton.click();
    });
    await flush();

    expect(revokeGrantMock).toHaveBeenCalledWith("file", "f1", "user:grantee");
    expect(container.textContent).not.toContain("photo.jpg");
  });

  it("the confirmation carries D-23's 'files already uploaded stay' sentence", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [ACTIVE_GRANT] }));
    render();
    await flush();

    const revokeButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Revoke")!;
    act(() => {
      revokeButton.click();
    });
    await flush();

    expect(document.body.textContent).toContain("Files already uploaded stay");
  });

  it("cancelling the confirmation does not call revoke", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [ACTIVE_GRANT] }));
    render();
    await flush();

    const revokeButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Revoke")!;
    act(() => {
      revokeButton.click();
    });
    await flush();

    const cancelButton = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Cancel")!;
    act(() => {
      cancelButton.click();
    });
    await flush();

    expect(revokeGrantMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("photo.jpg");
  });

  it("renders a 'not found' page, indistinguishable from a real 404, when the API answers 404 (D-217)", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse({}, 404));
    fetchGrantsMock.mockResolvedValue(jsonResponse({}, 404));
    render();
    await flush();

    expect(container.textContent).toContain("Not found");
    expect(container.textContent).not.toMatch(/admin/i);
  });
});
