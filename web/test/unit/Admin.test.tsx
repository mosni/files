(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../src/lib/admin.ts", () => ({
  fetchGrants: vi.fn(),
  fetchUsage: vi.fn(),
  revokeGrant: vi.fn(),
}));

// The directory is a separate, deliberately non-blocking fetch (see AdminPage.loadNames) - mocked here so
// every identity in the panel can be asserted as a NAME rather than a raw sub.
vi.mock("../../src/lib/share.ts", () => ({ fetchAccounts: vi.fn() }));

import { AdminPage } from "../../src/pages/Admin.tsx";
import { fetchGrants, fetchUsage, revokeGrant } from "../../src/lib/admin.ts";
import { fetchAccounts } from "../../src/lib/share.ts";
import type { AdminGrantRow, AdminUsageResponse } from "../../../app/src/lib/adminContext.ts";

const fetchGrantsMock = vi.mocked(fetchGrants);
const fetchUsageMock = vi.mocked(fetchUsage);
const revokeGrantMock = vi.mocked(revokeGrant);
const fetchAccountsMock = vi.mocked(fetchAccounts);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const USAGE: AdminUsageResponse = {
  volume: { totalBytes: 1_000_000_000_000, freeBytes: 400_000_000_000, usedBytes: 600_000_000_000 },
  tracked: { bytes: 500_000_000_000, fileCount: 42 },
  untrackedBytes: 100_000_000_000,
  byOwner: [{ ownerSub: "user:owner", bytes: 500_000_000_000, fileCount: 42 }],
  topCollections: [
    { collectionId: "c1", name: "photos", ownerSub: "user:owner", bytes: 500_000_000_000, fileCount: 42, url: "https://files.mosni.dev/f/photos" },
  ],
  topFiles: [
    {
      fileId: "f1",
      name: "holiday.mp4",
      collectionName: "photos",
      ownerSub: "user:owner",
      bytes: 400_000_000_000,
      url: "https://files.mosni.dev/f/photos/holiday.mp4",
    },
  ],
};

const DIRECTORY = [
  { sub: "user:owner", name: "Hannah", picture: "" },
  { sub: "user:grantee", name: "Alex", picture: "" },
];

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
    fetchAccountsMock.mockResolvedValue(jsonResponse(DIRECTORY));
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
    fetchAccountsMock.mockReset();
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

  // Review session 059: the owner was joined by the API and dropped by the table, so two grants on two
  // different files both named "photo.jpg" rendered identically.
  //
  // Hannah, 2026-08-19: *"grantee and owner columns should always be name with sub in the tooltip, never
  // plain sub"* - so both cells assert the resolved NAME, with the sub recoverable from the title.
  it("shows the owner and the grantee as name + avatar, with the sub in the tooltip", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [ACTIVE_GRANT] }));
    render();
    await flush();

    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent);
    expect(headers).toContain("Owner");
    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) => tr.textContent?.includes("photo.jpg"))!;
    const cells = Array.from(row.querySelectorAll("td"));
    expect(cells[1]!.textContent).toBe("Hannah"); // the cell right after the object, before the grantee
    expect(cells[2]!.textContent).toBe("Alex");
    expect(cells[1]!.querySelector("[title]")!.getAttribute("title")).toBe("Hannah (user:owner)");
    expect(cells[2]!.querySelector("[title]")!.getAttribute("title")).toBe("Alex (user:grantee)");
    expect(cells[1]!.querySelector("img")).not.toBeNull(); // the picture half of the combo
  });

  // D-222 is not reversed: auth's directory excludes link-bound accounts, so there is no name to resolve
  // and the raw sub is still what renders - with the full value in the tooltip.
  it("falls back to the raw sub for an identity the directory does not know", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [EXPIRED_GRANT] }));
    render();
    await flush();

    const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) => tr.textContent?.includes("link:"))!;
    const grantee = Array.from(row.querySelectorAll("td"))[2]!;
    expect(grantee.textContent).toBe(EXPIRED_GRANT.sub);
    expect(grantee.querySelector("[title]")!.getAttribute("title")).toBe(EXPIRED_GRANT.sub);
  });

  // An unreachable directory must degrade to raw subs, never blank the panel - the names are decoration.
  it("still renders every row when the account directory cannot be fetched", async () => {
    fetchAccountsMock.mockRejectedValue(new Error("auth is down"));
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [ACTIVE_GRANT] }));
    render();
    await flush();

    expect(container.textContent).toContain("photo.jpg");
    expect(container.textContent).toContain("user:grantee");
  });

  // Hannah, 2026-08-19: "revoke button should be danger-highlighted" and "status should be a badge".
  it("styles Revoke as a danger button and the status as a badge", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [ACTIVE_GRANT, EXPIRED_GRANT] }));
    render();
    await flush();

    const revoke = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Revoke")!;
    expect(revoke.className).toContain("btn-danger");

    const badges = Array.from(container.querySelectorAll("span.badge"));
    expect(badges.find((b) => b.textContent === "Active")!.className).toContain("success");
    expect(badges.find((b) => b.textContent === "Expired")!.className).toContain("error");
  });

  // Hannah, 2026-08-19: Usage is a metric grid now, not prose - five tiles, one desktop row, and no
  // sentence explaining the gap between "volume used" and "tracked by the app" (*"the gap is obvious to
  // literally anyone"*). Review 059's actual bug was a label making a WRONG claim about that gap; the
  // claim is gone, so what this asserts is that no prose came back with it.
  it("renders the volume figures as five labelled metrics, with no explanatory prose", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [] }));
    render();
    await flush();

    for (const label of ["Volume total", "Volume free", "Volume used", "Tracked by the app", "Files"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).not.toContain("Everything else");
    expect(container.textContent).not.toContain("Not tracked by the app");
    expect(container.textContent).not.toContain("shared with the rest of the box");
  });

  // Hannah, 2026-08-19: "top collections table should link to the collections" and "top files should exist
  // similar to top collections".
  it("links each top collection and each top file to the object itself", async () => {
    fetchUsageMock.mockResolvedValue(jsonResponse(USAGE));
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [] }));
    render();
    await flush();

    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://files.mosni.dev/f/photos");
    expect(hrefs).toContain("https://files.mosni.dev/f/photos/holiday.mp4");
    expect(container.textContent).toContain("Top files");
    expect(container.textContent).toContain("holiday.mp4");
  });

  // A row whose object vanished between the aggregate and the URL resolution renders as a label, never as
  // a dead link.
  it("renders a top row with no url as plain text", async () => {
    fetchUsageMock.mockResolvedValue(
      jsonResponse({ ...USAGE, topCollections: [{ ...USAGE.topCollections[0]!, url: null }] }),
    );
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [] }));
    render();
    await flush();

    expect(container.textContent).toContain("photos");
    expect(Array.from(container.querySelectorAll("a")).map((a) => a.textContent)).not.toContain("photos");
  });

  it("volume: null degrades without throwing - the rest of the panel still renders", async () => {
    fetchUsageMock.mockResolvedValue(
      jsonResponse({
        volume: null,
        tracked: { bytes: 0, fileCount: 0 },
        untrackedBytes: null,
        byOwner: [],
        topCollections: [],
        topFiles: [],
      }),
    );
    fetchGrantsMock.mockResolvedValue(jsonResponse({ grants: [] }));
    render();
    await flush();

    expect(container.textContent).toContain("unavailable");
    expect(container.textContent).toContain("Tracked by the app"); // the app-side metrics still render
    expect(container.textContent).toContain("Access");
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
