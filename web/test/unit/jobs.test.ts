import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetJobsStoreForTests,
  bumpReload,
  dismissJob,
  getJobsSnapshot,
  getReloadSnapshot,
  subscribeJobs,
  subscribeReload,
  upsertJob,
  type ArchiveJob,
  type UploadJob,
} from "../../src/lib/jobs.ts";

afterEach(() => {
  __resetJobsStoreForTests();
});

function makeUploadJob(overrides: Partial<UploadJob> = {}): UploadJob {
  return {
    id: "upload-1",
    kind: "upload",
    name: "photo.png",
    batchId: "batch-1",
    collectionId: null,
    state: { status: "uploading", progress: 0, loaded: 0, total: 100 },
    ...overrides,
  };
}

function makeArchiveJob(overrides: Partial<ArchiveJob> = {}): ArchiveJob {
  return {
    id: "archive-1",
    kind: "archive",
    name: "Photos",
    status: "archiving",
    completed: 0,
    total: 3,
    failed: [],
    ...overrides,
  };
}

describe("jobs store (E5.1 Wave E, D-161)", () => {
  it("starts empty", () => {
    expect(getJobsSnapshot()).toEqual([]);
  });

  it("upsertJob adds a new job by id", () => {
    upsertJob(makeUploadJob());
    expect(getJobsSnapshot()).toEqual([makeUploadJob()]);
  });

  it("upsertJob replaces an existing job with the same id in place, preserving order", () => {
    upsertJob(makeUploadJob({ id: "a" }));
    upsertJob(makeUploadJob({ id: "b" }));
    upsertJob(makeUploadJob({ id: "a", state: { status: "done", previewUrl: "https://files.mosni.dev/f/x", fileId: "file-1" } }));

    const snapshot = getJobsSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]).toEqual(
      makeUploadJob({ id: "a", state: { status: "done", previewUrl: "https://files.mosni.dev/f/x", fileId: "file-1" } }),
    );
    expect(snapshot[1]).toEqual(makeUploadJob({ id: "b" }));
  });

  it("holds both upload and archive jobs together", () => {
    upsertJob(makeUploadJob({ id: "u" }));
    upsertJob(makeArchiveJob({ id: "a" }));
    expect(getJobsSnapshot().map((j) => j.kind)).toEqual(["upload", "archive"]);
  });

  it("dismissJob removes exactly the named job", () => {
    upsertJob(makeUploadJob({ id: "a" }));
    upsertJob(makeUploadJob({ id: "b" }));
    dismissJob("a");
    expect(getJobsSnapshot().map((j) => j.id)).toEqual(["b"]);
  });

  it("notifies job listeners on upsert and dismiss, and stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeJobs(listener);

    upsertJob(makeUploadJob());
    expect(listener).toHaveBeenCalledTimes(1);

    dismissJob("upload-1");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    upsertJob(makeUploadJob());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("getJobsSnapshot returns a fresh array reference only when the contents actually change (useSyncExternalStore requires this)", () => {
    const before = getJobsSnapshot();
    expect(getJobsSnapshot()).toBe(before); // same reference, no-op read
    upsertJob(makeUploadJob());
    expect(getJobsSnapshot()).not.toBe(before);
  });
});

describe("reload signal (E5.1 Wave E, finding 4)", () => {
  it("starts at a stable value and only changes on bumpReload", () => {
    const start = getReloadSnapshot();
    expect(getReloadSnapshot()).toBe(start);
    bumpReload();
    expect(getReloadSnapshot()).toBe(start + 1);
  });

  it("notifies reload listeners on every bump, independent of the job-list listeners", () => {
    const jobListener = vi.fn();
    const reloadListener = vi.fn();
    subscribeJobs(jobListener);
    subscribeReload(reloadListener);

    bumpReload();

    expect(reloadListener).toHaveBeenCalledTimes(1);
    expect(jobListener).not.toHaveBeenCalled();
  });
});
