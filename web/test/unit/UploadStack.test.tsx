// E6 (D-171, Wave B8/C4): job-state rendering that used to be exercised indirectly through DropZone's own
// tests (driven by mocked tus callbacks) now lives here, published straight into the shared job store -
// this component has never needed a real upload to render correctly, only a job.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { resumeUploadMock, matchPausedJobMock, cancelUploadMock } = vi.hoisted(() => ({
  resumeUploadMock: vi.fn(),
  matchPausedJobMock: vi.fn(() => null as string | null),
  cancelUploadMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/lib/uploads.ts", () => ({
  resumeUpload: resumeUploadMock,
  matchPausedJob: matchPausedJobMock,
  cancelUpload: cancelUploadMock,
}));

import { UploadStack } from "../../src/components/UploadStack.tsx";
import { __resetJobsStoreForTests, upsertJob, type UploadJob } from "../../src/lib/jobs.ts";

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function job(overrides: Partial<UploadJob> = {}): UploadJob {
  return {
    id: "upload-0",
    kind: "upload",
    name: "a.txt",
    batchId: "batch-0",
    collectionId: null,
    state: { status: "uploading", progress: 10, loaded: 1, total: 10 },
    ...overrides,
  };
}

describe("UploadStack (E6 Wave B8/C4)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resumeUploadMock.mockClear();
    cancelUploadMock.mockClear();
    matchPausedJobMock.mockReset();
    matchPausedJobMock.mockReturnValue(null);
    __resetJobsStoreForTests();
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
    vi.unstubAllGlobals();
  });

  function render() {
    act(() => {
      root.render(<UploadStack />);
    });
  }

  it("renders nothing when there are no jobs", () => {
    render();
    expect(container.querySelector(".job-stack")).toBeNull();
  });

  it("renders a queued job with no progress bar", () => {
    upsertJob(job({ state: { status: "queued" } }));
    render();
    expect(container.textContent).toContain("Queued");
    expect(container.querySelector(".progress")).toBeNull();
  });

  describe("paused state (Wave B8)", () => {
    beforeEach(() => {
      upsertJob(job({ state: { status: "paused", loaded: 400, total: 1000 } }));
    });

    it("shows the uploaded-so-far readout and a Resume control, never the word Retry", () => {
      render();
      expect(container.textContent).toContain("Paused");
      expect(container.textContent).toMatch(/400 B.*1000 B|1000 B.*400 B|400 B.*1(\.\d+)? kB/);
      const button = container.querySelector('button[aria-label="Resume a.txt"]');
      expect(button).not.toBeNull();
      expect(button?.textContent).toBe("Resume");
      expect(container.textContent).not.toContain("Retry");
    });

    it("clicking Resume opens the scoped file picker; a matching file resumes the job", () => {
      matchPausedJobMock.mockReturnValue("upload-0");
      render();

      const button = container.querySelector('button[aria-label="Resume a.txt"]') as HTMLButtonElement;
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(input, "click");
      act(() => button.click());
      expect(clickSpy).toHaveBeenCalled();

      const reoffered = new File(["x"], "a.txt");
      Object.defineProperty(input, "files", { value: [reoffered], configurable: true });
      act(() => input.dispatchEvent(new Event("change", { bubbles: true })));

      expect(resumeUploadMock).toHaveBeenCalledWith("upload-0", reoffered);
    });

    it("a non-matching re-offered file is rejected with a toast, never resumed", () => {
      (window as unknown as { mosni: unknown }).mosni = { toast: vi.fn() };
      matchPausedJobMock.mockReturnValue(null); // does not match this paused job

      render();
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const wrongFile = new File(["y"], "different.txt");
      Object.defineProperty(input, "files", { value: [wrongFile], configurable: true });
      act(() => input.dispatchEvent(new Event("change", { bubbles: true })));

      expect(resumeUploadMock).not.toHaveBeenCalled();
      const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
      expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("same file"), { variant: "error" });
    });

    it("survives a re-render with unchanged props - still present and populated (§0.3, H7)", () => {
      render();
      render(); // root.render() again with the same element type reconciles as a re-render, not a remount
      expect(container.textContent).toContain("Paused");
      expect(container.querySelector('button[aria-label="Resume a.txt"]')).not.toBeNull();
    });
  });

  describe("error state", () => {
    it("a resumable error offers Resume, calling resumeUpload with no file", () => {
      upsertJob(job({ state: { status: "error", message: "connection dropped", resumable: true } }));
      render();

      expect(container.textContent).toContain("Upload failed: connection dropped");
      const button = container.querySelector('button[aria-label="Resume a.txt"]') as HTMLButtonElement;
      expect(button).not.toBeNull();
      act(() => button.click());
      expect(resumeUploadMock).toHaveBeenCalledWith("upload-0");
    });

    it("a non-resumable error offers no Resume control, and the word Retry appears nowhere", () => {
      upsertJob(job({ state: { status: "error", message: "invalid filename", resumable: false } }));
      render();

      expect(container.textContent).toContain("Upload failed: invalid filename");
      expect(container.querySelector('button[aria-label="Resume a.txt"]')).toBeNull();
      expect(container.textContent).not.toContain("Retry");
    });
  });

  describe("grouping (Wave C4, D-175)", () => {
    function doneJob(id: string, fileId: string, batchId = "batch-g") {
      return job({
        id,
        batchId,
        name: `${id}.txt`,
        state: { status: "done", previewUrl: `https://files.mosni.dev/f/${id}`, directUrl: `https://dl.mosni.dev/${id}`, fileId },
      });
    }

    it("a 1-file completed batch offers no grouping control", async () => {
      upsertJob(doneJob("upload-a", "file-a"));
      render();
      await flush();
      expect(container.textContent).not.toContain("Group these");
    });

    it("a 2+-file completed batch offers 'Group these N files'", async () => {
      upsertJob(doneJob("upload-a", "file-a"));
      upsertJob(doneJob("upload-b", "file-b"));
      render();
      await flush();
      expect(container.textContent).toContain("Group these 2 files");
    });

    it("does not offer grouping while a sibling in the batch is still uploading", async () => {
      upsertJob(doneJob("upload-a", "file-a"));
      upsertJob(job({ id: "upload-b", batchId: "batch-g", state: { status: "uploading", progress: 10, loaded: 1, total: 10 } }));
      render();
      await flush();
      expect(container.textContent).not.toContain("Group these");
    });

    // Live-testing change (2026-08-06): grouping now issues ONE batch PATCH /api/files instead of one
    // PATCH /api/files/:id per file. That is the whole point - N separate requests were N separate actions
    // as far as the server could tell, so a grouped upload produced N audit notifications for what the user
    // experienced as one click (Hannah: bulk operations should notify once).
    it("confirming issues exactly one POST and ONE batch PATCH, then shows the result and removes the individual items", async () => {
      upsertJob(doneJob("upload-a", "file-a"));
      upsertJob(doneJob("upload-b", "file-b"));
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/collections") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "coll-1", name: "Drop today", previewUrl: "https://files.mosni.dev/f/drop-today" }),
          });
        }
        // The batch endpoint reports WHICH ids moved, so the right stack items are dismissed.
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ moved: ["file-a", "file-b"], failed: [] }),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      render();
      await flush();

      const groupButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Group these 2 files")!;
      act(() => groupButton.click());
      const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Group")!;
      await act(async () => {
        confirmButton.click();
        await flush();
      });

      const postCalls = fetchMock.mock.calls.filter(([url, init]) => url === "/api/collections" && (init as RequestInit)?.method === "POST");
      const patchCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "PATCH");
      expect(postCalls).toHaveLength(1);
      expect(patchCalls).toHaveLength(1); // ONE request for the whole batch, not one per file
      expect(patchCalls[0]![0]).toBe("/api/files");
      expect(JSON.parse((patchCalls[0]![1] as RequestInit).body as string)).toEqual({
        ids: ["file-a", "file-b"],
        collectionId: "coll-1",
      });

      expect(container.textContent).toContain('Grouped into "Drop today"');
      expect(container.textContent).not.toContain("upload-a.txt");
      expect(container.textContent).not.toContain("upload-b.txt");
    });

    it("a 409 on the collection POST toasts and moves nothing", async () => {
      upsertJob(doneJob("upload-a", "file-a"));
      upsertJob(doneJob("upload-b", "file-b"));
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({ error: "name_taken" }) });
      vi.stubGlobal("fetch", fetchMock);
      (window as unknown as { mosni: unknown }).mosni = { toast: vi.fn(), token: () => "test-token" };

      render();
      await flush();

      const groupButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Group these 2 files")!;
      act(() => groupButton.click());
      const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Group")!;
      await act(async () => {
        confirmButton.click();
        await flush();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1); // only the collection POST - no PATCH ever attempted
      expect(container.textContent).toContain("upload-a.txt");
      expect(container.textContent).toContain("upload-b.txt");
      expect(container.textContent).not.toContain("Grouped into");
      const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
      expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("already used"), { variant: "error" });
    });

    // "Grouping must never lose a file" now depends on the batch endpoint's own `moved` list rather than
    // on the client guessing from a per-file loop's statuses - so a partial success must dismiss ONLY the
    // items that really moved, and leave the rest visible and re-groupable.
    it("a partial batch dismisses only the files that actually moved, and says so", async () => {
      upsertJob(doneJob("upload-a", "file-a"));
      upsertJob(doneJob("upload-b", "file-b"));
      const fetchMock = vi.fn((url: string) => {
        if (url === "/api/collections") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "coll-1", name: "Drop today", previewUrl: "https://x/f/d" }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ moved: ["file-a"], failed: [{ id: "file-b", error: "name_taken" }] }),
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      (window as unknown as { mosni: unknown }).mosni = { toast: vi.fn(), token: () => "test-token" };

      render();
      await flush();

      const groupButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Group these 2 files")!;
      act(() => groupButton.click());
      const confirmButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Group")!;
      await act(async () => {
        confirmButton.click();
        await flush();
      });

      // The one that moved is gone; the one that did not is still on screen, not silently lost.
      expect(container.textContent).not.toContain("upload-a.txt");
      expect(container.textContent).toContain("upload-b.txt");
      expect(container.textContent).toContain('Grouped into "Drop today"');
      const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
      expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("1 of 2"), { variant: "error" });
    });
  });

  describe("dismiss", () => {
    it("dismissing one job removes only that job", () => {
      upsertJob(doneJob("upload-a"));
      upsertJob(doneJob("upload-b"));
      render();

      const dismissButtons = container.querySelectorAll('button[aria-label^="Dismiss"]');
      expect(dismissButtons).toHaveLength(2);
      act(() => (dismissButtons[0] as HTMLButtonElement).click());

      expect(container.textContent).not.toContain("upload-a.txt");
      expect(container.textContent).toContain("upload-b.txt");
    });

    // E6 review (session 042): a paused job is republished from localStorage on every load, so hiding the
    // item is not enough - dismissing it must drop the stored resume URL, or the stack item (which floats
    // over the browser's row menus) comes back on the next reload for up to seven days.
    it("dismissing a PAUSED job abandons the upload, not just the item", () => {
      upsertJob(
        job({
          id: "upload-paused",
          batchId: "b-paused",
          name: "paused.bin",
          state: { status: "paused", loaded: 10, total: 100 },
        }),
      );
      render();

      const dismiss = container.querySelector('button[aria-label^="Dismiss"]') as HTMLButtonElement;
      act(() => dismiss.click());

      expect(cancelUploadMock).toHaveBeenCalledWith("upload-paused");
      expect(container.textContent).not.toContain("paused.bin");
    });

    it("dismissing a DONE job does not cancel anything", () => {
      upsertJob(doneJob("upload-done"));
      render();

      const dismiss = container.querySelector('button[aria-label^="Dismiss"]') as HTMLButtonElement;
      act(() => dismiss.click());

      expect(cancelUploadMock).not.toHaveBeenCalled();
    });

    function doneJob(id: string) {
      // A distinct batchId per job, deliberately - two DONE jobs sharing one batch would also trigger the
      // grouping affordance (Wave C4) and add a third dismiss button, which is not what this test is about.
      return job({
        id,
        batchId: id,
        name: `${id}.txt`,
        state: { status: "done", previewUrl: `https://files.mosni.dev/f/${id}`, directUrl: `https://dl.mosni.dev/${id}`, fileId: id },
      });
    }
  });
});
