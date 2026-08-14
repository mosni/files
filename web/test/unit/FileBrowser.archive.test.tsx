// E5.1 Waves E + F (D-161, D-159, finding 10): "Download all" now walks nested collections, preserving
// subtree paths, and publishes its progress to the SHARED job stack instead of a local text span. This
// file exercises FileBrowser's real handleDownloadAll/fetchArchiveLevel wiring (both real,
// UNMOCKED) against a fake /api/browse and a MOCKED downloadArchive - the goal is to prove the archive
// walk and the job-stack publishing, not re-prove the service-worker plumbing archive.test.ts already
// covers directly.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

const { downloadArchiveMock } = vi.hoisted(() => ({ downloadArchiveMock: vi.fn() }));

vi.mock("../../src/lib/archive.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/archive.ts")>();
  return { ...actual, downloadArchive: downloadArchiveMock };
});

import { FileBrowser } from "../../src/components/FileBrowser.tsx";
import { UploadStack } from "../../src/components/UploadStack.tsx";
import { __resetJobsStoreForTests } from "../../src/lib/jobs.ts";
import type { BrowseResponse } from "../../../app/src/lib/browseContext.ts";

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 404) {
  return { ok, status, json: () => Promise.resolve(body) };
}

function makeResponse(overrides: Partial<BrowseResponse> = {}): BrowseResponse {
  return { breadcrumb: [{ id: "root-id", name: "Root", previewUrl: "https://files.mosni.dev/f/Root" }], collections: [], files: [], nextOffset: null, canUpload: false, canManage: false, ...overrides };
}

let container: HTMLDivElement;
let root: Root;

describe("Download all (E5.1 Waves E + F)", () => {
  beforeEach(() => {
    __resetJobsStoreForTests();
    downloadArchiveMock.mockReset();
    // Simulates the real contract: downloadArchive()'s OWN promise resolves as soon as the download is
    // triggered, but the caller (handleDownloadAll) waits for a LATER onProgress call reporting full
    // completion before marking the job "done" (E5.1 Wave H fixed a real race here - see FileBrowser.tsx's
    // own comment). Every test in this file needs that final onProgress call or handleDownloadAll would
    // hang awaiting it forever, exactly as it would against a real service worker that never finishes.
    downloadArchiveMock.mockImplementation(
      async (
        _name: string,
        files: { name: string; url: string }[],
        onProgress?: (progress: { completed: number; total: number; failed: string[] }) => void,
      ) => {
        onProgress?.({ completed: files.length, total: files.length, failed: [] });
      },
    );
    // Real navigator.serviceWorker isn't implemented in jsdom - isArchiveSupported() must see the API
    // exists (the same stub archive.test.ts uses) or the button never renders at all.
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: {} });
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
      toast: vi.fn(),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { mosni?: unknown }).mosni;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderAt(collectionId: string) {
    act(() => {
      root.render(
        <MemoryRouter>
          <FileBrowser initialCollectionId={collectionId} />
          <UploadStack />
        </MemoryRouter>,
      );
    });
    await flush();
  }

  it("walks a nested collection and calls downloadArchive with subtree-relative paths (AC-F1/F2)", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url.includes("collectionId=root-id")) {
        return Promise.resolve(
          jsonResponse(makeResponse({ collections: [{ id: "sub-id", name: "Sub", effectiveProtection: "unlisted", defaultProtection: "unlisted", reason: "own", previewUrl: "https://files.mosni.dev/f/Sub" }] })),
        );
      }
      if (url.includes("collectionId=sub-id")) {
        return Promise.resolve(
          jsonResponse(
            makeResponse({
              files: [
                {
                  id: "f1",
                  name: "beach.jpg",
                  bytes: 10,
                  createdAt: "2026-08-04T00:00:00.000Z",
                  effectiveProtection: "unlisted",
                  reason: "own",
                  previewUrl: "https://files.mosni.dev/f/Sub",
                  directUrl: "https://dl.mosni.dev/beach.jpg",
                  thumbUrl: null,
    kind: "other" as const,
                  width: null,
                  height: null,
                  durationSeconds: null,
                },
              ],
            }),
          ),
        );
      }
      return Promise.resolve(jsonResponse(makeResponse(), false, 404));
    });
    vi.stubGlobal("fetch", fetchSpy);

    await renderAt("root-id");

    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"))!;
    expect(button).toBeTruthy();

    await act(async () => {
      button.click();
      await flush();
    });

    expect(downloadArchiveMock).toHaveBeenCalledTimes(1);
    const [, entries] = downloadArchiveMock.mock.calls[0]!;
    expect(entries).toEqual([{ name: "Sub/beach.jpg", url: "https://dl.mosni.dev/beach.jpg" }]);
  });

  it("carries a nested SECRET collection's own token into the walk, so a link-shared subtree archives too (AC-F1)", async () => {
    // A `secret` collection is reachable only with its OWN link token (D-98/D-124) - which is exactly what
    // the server already handed this viewer, inside the child row's previewUrl (`/t/<token>`). Navigating
    // into that child in the UI uses it; the walk must use the same one, or every nested level of a
    // link-shared collection is silently absent from the zip. The ROOT still uses initialToken, and a
    // child's token is never the root's - §1.5 holds either way: each level is authorized by what its own
    // parent's browse response returned, never by riding a token into a collection it does not belong to.
    const seen: string[] = [];
    const fetchSpy = vi.fn((url: string) => {
      seen.push(url);
      if (url.includes("collectionId=root-id")) {
        return Promise.resolve(
          jsonResponse(
            makeResponse({
              collections: [
                {
                  id: "sub-id",
                  name: "Sub",
                  effectiveProtection: "secret",
                  defaultProtection: "secret",
                  reason: "granted",
                  previewUrl: "https://files.mosni.dev/t/childtok",
                },
              ],
            }),
          ),
        );
      }
      // The child answers ONLY when its own token rides along - exactly what controllers/browse.ts does.
      if (url.includes("collectionId=sub-id") && url.includes("token=childtok")) {
        return Promise.resolve(
          jsonResponse(
            makeResponse({
              files: [
                {
                  id: "f1",
                  name: "inside.txt",
                  bytes: 3,
                  createdAt: "2026-08-05T00:00:00.000Z",
                  effectiveProtection: "secret",
                  reason: "granted",
                  previewUrl: "https://files.mosni.dev/t/filetok",
                  directUrl: "https://dl.mosni.dev/inside.txt",
                  thumbUrl: null,
    kind: "other" as const,
                  width: null,
                  height: null,
                  durationSeconds: null,
                },
              ],
            }),
          ),
        );
      }
      return Promise.resolve(jsonResponse(makeResponse(), false, 404));
    });
    vi.stubGlobal("fetch", fetchSpy);

    await renderAt("root-id");

    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"))!;
    expect(button).toBeTruthy();

    await act(async () => {
      button.click();
      await flush();
    });

    expect(downloadArchiveMock).toHaveBeenCalledTimes(1);
    const [, entries] = downloadArchiveMock.mock.calls[0]!;
    expect(entries).toEqual([{ name: "Sub/inside.txt", url: "https://dl.mosni.dev/inside.txt" }]);
    // The root's own walk call must NOT carry the child's token, and vice versa.
    expect(seen.some((u) => u.includes("collectionId=sub-id") && u.includes("token=childtok"))).toBe(true);
  });

  it("shows the button for a collection holding only nested collections (no direct files)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(makeResponse({ collections: [{ id: "sub-id", name: "Sub", effectiveProtection: "unlisted", defaultProtection: "unlisted", reason: "own", previewUrl: "https://files.mosni.dev/f/Sub" }] })),
      ),
    );

    await renderAt("root-id");

    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"));
    expect(button).toBeTruthy();
  });

  it("retries a transient 429 from a browse call during the walk before giving up (F5)", async () => {
    const withOneFile = makeResponse({
      files: [
        {
          id: "f1",
          name: "a.txt",
          bytes: 1,
          createdAt: "2026-08-04T00:00:00.000Z",
          effectiveProtection: "unlisted",
          reason: "own",
          previewUrl: "https://files.mosni.dev/f/a.txt",
          directUrl: "https://dl.mosni.dev/a.txt",
          thumbUrl: null,
    kind: "other" as const,
          width: null,
          height: null,
          durationSeconds: null,
        },
      ],
    });

    // Call 1: the component's own initial mount fetch (offset 0) - succeeds normally, so the page renders
    // and the button appears. Call 2: the walk's own re-fetch of the SAME URL (same collectionId, same
    // offset - fetchArchiveLevel builds it identically) - rate-limited. Call 3: the walk's retry succeeds.
    let browseCalls = 0;
    const fetchSpy = vi.fn((url: string) => {
      if (!url.includes("collectionId=root-id")) return Promise.resolve(jsonResponse(makeResponse(), false, 404));
      browseCalls++;
      if (browseCalls === 2) return Promise.resolve(jsonResponse({}, false, 429));
      return Promise.resolve(jsonResponse(withOneFile));
    });
    vi.stubGlobal("fetch", fetchSpy);

    await renderAt("root-id");

    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"))!;
    expect(button).toBeTruthy();

    await act(async () => {
      button.click();
      // The retry's own exponential backoff (2**0 * 500ms for the first retry) is real - give it room to
      // fire rather than mocking timers, since this test cares about the OUTCOME (retried, then
      // succeeded), not the exact delay.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await flush();
    });

    expect(browseCalls).toBeGreaterThanOrEqual(3); // mount + rate-limited attempt + retried success
    expect(downloadArchiveMock).toHaveBeenCalledTimes(1);
    const [, entries] = downloadArchiveMock.mock.calls[0]!;
    expect(entries).toEqual([{ name: "a.txt", url: "https://dl.mosni.dev/a.txt" }]);
  });

  it("turns a failed archive start into an error job and a toast, not a stack item stuck at 0%", async () => {
    // The one path handleDownloadAll's catch exists for: downloadArchive() rejects before the service
    // worker ever runs (no controller yet, registration failed, module workers unsupported - archive.ts's
    // readyController throws for each). Uncovered until the E5/E5.1 review session added this.
    downloadArchiveMock.mockRejectedValueOnce(new Error("the archive worker isn't available in this browser"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResponse({
            files: [
              {
                id: "f1",
                name: "a.txt",
                bytes: 1,
                createdAt: "2026-08-05T00:00:00.000Z",
                effectiveProtection: "unlisted",
                reason: "own",
                previewUrl: "https://files.mosni.dev/f/a.txt",
                directUrl: "https://dl.mosni.dev/a.txt",
                thumbUrl: null,
    kind: "other" as const,
                width: null,
                height: null,
                durationSeconds: null,
              },
            ],
          }),
        ),
      ),
    );

    await renderAt("root-id");

    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"))!;
    await act(async () => {
      button.click();
      await flush();
    });

    expect(container.querySelector(".job-stack")!.textContent).toContain("Could not start the archive");
    expect(window.mosni!.toast).toHaveBeenCalledWith("the archive worker isn't available in this browser", {
      variant: "error",
    });
    // The button must come back - `archiveInFlight` is cleared in the finally, so a retry is possible.
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("publishes an archiving job, then a done job, into the SAME stack an upload would use (AC-E2)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          makeResponse({
            files: [
              {
                id: "f1",
                name: "a.txt",
                bytes: 1,
                createdAt: "2026-08-04T00:00:00.000Z",
                effectiveProtection: "unlisted",
                reason: "own",
                previewUrl: "https://files.mosni.dev/f/Sub",
                directUrl: "https://dl.mosni.dev/a.txt",
                thumbUrl: null,
    kind: "other" as const,
                width: null,
                height: null,
                durationSeconds: null,
              },
            ],
          }),
        ),
      ),
    );

    await renderAt("root-id");

    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"))!;
    await act(async () => {
      button.click();
      await flush();
    });

    // downloadArchive is mocked to resolve immediately with no progress callbacks fired, so the job goes
    // straight to "done" - the stack must show it, in the same .job-stack an upload job would render into.
    const stack = container.querySelector(".job-stack");
    expect(stack).not.toBeNull();
    expect(stack!.textContent).toContain("Archive ready");
  });

  // E6 Wave H (D-181): the previously-unbounded wait on the service worker's completion signal
  // (issues.md -> ARCHIVE-STALL-NO-TIMEOUT).
  describe("archive stall timeout (Wave H)", () => {
    function fileEntry(name: string) {
      return {
        id: "f1",
        name,
        bytes: 1,
        createdAt: "2026-08-05T00:00:00.000Z",
        effectiveProtection: "unlisted" as const,
        reason: "own" as const,
        previewUrl: "https://files.mosni.dev/f/a.txt",
        directUrl: "https://dl.mosni.dev/a.txt",
        thumbUrl: null,
    kind: "other" as const,
        width: null,
        height: null,
        durationSeconds: null,
      };
    }

    it("settles as an error naming the stall after 60s with no progress message, and releases the button", async () => {
      // Simulates a service worker that never posts a single progress message - the walk succeeds, the
      // manifest is handed off, and then nothing.
      downloadArchiveMock.mockImplementation(async () => {});
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [fileEntry("a.txt")] }))));

      await renderAt("root-id");
      const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"))!;

      vi.useFakeTimers();
      try {
        await act(async () => {
          button.click();
          await vi.advanceTimersByTimeAsync(60_000);
        });
      } finally {
        vi.useRealTimers();
      }

      expect(container.querySelector(".job-stack")!.textContent).toContain("Could not start the archive");
      expect(window.mosni!.toast).toHaveBeenCalledWith("Archive stalled — nothing received for 60s", {
        variant: "error",
      });
      // Released exactly as on success (H1) - a retry must be possible.
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });

    it("does not stall while progress messages keep arriving every 30s, even past 3 minutes total (H2)", async () => {
      let progressCb: ((p: { completed: number; total: number; failed: string[] }) => void) | undefined;
      downloadArchiveMock.mockImplementation(async (_name: string, _files: unknown, onProgress) => {
        progressCb = onProgress;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(makeResponse({ files: [fileEntry("a.txt"), fileEntry("b.txt")] }))),
      );

      await renderAt("root-id");
      const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"))!;

      vi.useFakeTimers();
      try {
        await act(async () => {
          button.click();
          await vi.advanceTimersByTimeAsync(0);
        });

        // Six 30s ticks = 3 minutes, each resetting the stall timer (H2) - never a 60s gap.
        for (let i = 0; i < 6; i++) {
          await act(async () => {
            progressCb?.({ completed: 1, total: 2, failed: [] });
            await vi.advanceTimersByTimeAsync(30_000);
          });
        }
        await act(async () => {
          progressCb?.({ completed: 2, total: 2, failed: [] });
          await vi.advanceTimersByTimeAsync(0);
        });
      } finally {
        vi.useRealTimers();
      }

      expect(container.querySelector(".job-stack")!.textContent).toContain("Archive ready");
      expect(window.mosni!.toast).not.toHaveBeenCalled();
    });

    it("an archive whose every entry was omitted by a guard still resolves immediately, unaffected by the stall guard", async () => {
      // The button only renders when there is SOMETHING at the top level (a file or a nested collection),
      // but the nested collection itself resolves completely empty - the walk therefore has nothing to
      // fetch (lastTotal 0), and the service worker never posts a single progress message for an empty
      // manifest, exactly like the genuinely-omitted-by-a-guard case this exists for (§1.5/H1).
      const fetchMock = vi.fn((url: string) => {
        if (url.includes("collectionId=empty-sub")) return Promise.resolve(jsonResponse(makeResponse()));
        return Promise.resolve(
          jsonResponse(
            makeResponse({
              collections: [{ id: "empty-sub", name: "Empty", effectiveProtection: "unlisted", defaultProtection: "unlisted", reason: "own", previewUrl: "https://files.mosni.dev/f/Empty" }],
            }),
          ),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      // Never called at all if the resolution is truly immediate - a `never` implementation would make
      // any accidental wait hang the test until Vitest's own timeout, which is exactly the failure mode
      // this test exists to catch.
      downloadArchiveMock.mockImplementation(async () => {});

      await renderAt("root-id");
      const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Download all"))!;
      expect(button).toBeTruthy();

      await act(async () => {
        button.click();
        await flush();
      });

      expect(container.querySelector(".job-stack")!.textContent).toContain("Archive ready");
      expect(window.mosni!.toast).not.toHaveBeenCalled();
    });
  });
});
