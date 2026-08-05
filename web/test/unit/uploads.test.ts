// E6 (D-171, Wave 0/B/C): the upload controller extracted out of DropZone.tsx. Exercises the queue,
// resumption and retry policy directly against a mocked tus-js-client - this is what makes them
// unit-testable at all (none of it is reachable from a component test that needs a real drag event).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockUploadOptions = {
  endpoint?: string;
  chunkSize?: number;
  metadata?: Record<string, string>;
  retryDelays?: number[] | null;
  onShouldRetry?: (error: { originalResponse: { getStatus(): number } | null }) => boolean;
  removeFingerprintOnSuccess?: boolean;
  onBeforeRequest?: (req: { setHeader(k: string, v: string): void }) => void;
  onProgress?: (bytesSent: number, bytesTotal: number) => void;
  onSuccess?: (payload: { lastResponse: { getBody(): string } }) => void;
  onError?: (error: { message: string }) => void;
};

type MockUpload = {
  file: File;
  options: MockUploadOptions;
  url: string | null;
  start: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  findPreviousUploads: ReturnType<typeof vi.fn>;
  resumeFromPreviousUpload: ReturnType<typeof vi.fn>;
};

const { uploadInstances, nextPreviousUploadsRef } = vi.hoisted(() => ({
  uploadInstances: [] as MockUpload[],
  // Read at CALL time (not at mock-definition time) by every new instance's findPreviousUploads - lets a
  // test configure the result a not-yet-constructed instance should return, since the instance itself
  // only exists once resumeUpload()'s synchronous prefix has run.
  nextPreviousUploadsRef: { current: [] as unknown[] },
}));

vi.mock("tus-js-client", () => {
  class MockUploadImpl {
    file: File;
    options: MockUploadOptions;
    url: string | null = null;
    start = vi.fn();
    abort = vi.fn().mockResolvedValue(undefined);
    findPreviousUploads = vi.fn(() => Promise.resolve(nextPreviousUploadsRef.current));
    resumeFromPreviousUpload = vi.fn();

    constructor(file: File, options: MockUploadOptions) {
      this.file = file;
      this.options = options;
      uploadInstances.push(this as unknown as MockUpload);
    }
  }

  return { Upload: MockUploadImpl };
});

import {
  __resetUploadsForTests,
  matchPausedJob,
  resumeUpload,
  restorePausedUploads,
  setUploadChunkSize,
  startBatch,
} from "../../src/lib/uploads.ts";
import { __resetJobsStoreForTests, batchIsComplete, getJobsSnapshot, jobsInBatch } from "../../src/lib/jobs.ts";
import { UPLOAD_MAX_CONCURRENT, UPLOAD_RETRY_DELAYS } from "../../../app/src/lib/uploadConfig.ts";

function installMockToken(token: string | null) {
  (window as unknown as { mosni: unknown }).mosni = { token: () => token };
}

function file(name: string, size = 5, lastModified = 1000): File {
  return new File([new Uint8Array(size)], name, { type: "text/plain", lastModified });
}

function succeed(
  instance: MockUpload,
  previewUrl = "https://files.mosni.dev/f/x",
  directUrl = "https://dl.mosni.dev/x",
  id = "file-1",
) {
  instance.options.onSuccess?.({ lastResponse: { getBody: () => JSON.stringify({ previewUrl, directUrl, id }) } });
}

function fail(instance: MockUpload, message = "network down") {
  instance.options.onError?.({ message });
}

describe("uploads controller (E6 Wave 0/B/C)", () => {
  beforeEach(() => {
    uploadInstances.length = 0;
    nextPreviousUploadsRef.current = [];
    __resetJobsStoreForTests();
    __resetUploadsForTests();
    installMockToken("test-token");
    localStorage.clear();
  });

  afterEach(() => {
    delete (window as unknown as { mosni?: unknown }).mosni;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe("startBatch (Wave 0)", () => {
    it("starts one tus.Upload per file and publishes an uploading job for each", () => {
      startBatch([file("a.txt"), file("b.txt")], { destinationCollectionId: null, source: "drop" });

      expect(uploadInstances).toHaveLength(2);
      const jobs = getJobsSnapshot();
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j) => j.kind === "upload" && j.state.status === "uploading")).toBe(true);
    });

    it("stamps every file from one call with the same batchId, and a second call gets a different one", () => {
      const batchA = startBatch([file("a.txt"), file("b.txt")], { destinationCollectionId: null, source: "drop" });
      const batchB = startBatch([file("c.txt")], { destinationCollectionId: null, source: "picker" });

      expect(jobsInBatch(batchA)).toHaveLength(2);
      expect(jobsInBatch(batchB)).toHaveLength(1);
      expect(batchA).not.toBe(batchB);
    });

    it("passes the destination collection id and metadata filename through to tus", () => {
      startBatch([file("hello.txt")], { destinationCollectionId: "coll-1", source: "drop" });
      expect(uploadInstances[0].options.metadata).toEqual({ filename: "hello.txt", destinationCollectionId: "coll-1" });
    });

    it("uses the server-authoritative chunk size once set via setUploadChunkSize", () => {
      setUploadChunkSize(1024);
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      expect(uploadInstances[0].options.chunkSize).toBe(1024);
    });

    it("onBeforeRequest reads the CURRENT token at send time, not one captured at construction", () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      const setHeader = vi.fn();

      installMockToken("first-token");
      uploadInstances[0].options.onBeforeRequest?.({ setHeader });
      expect(setHeader).toHaveBeenLastCalledWith("Authorization", "Bearer first-token");

      // A resume days later, after the token has rotated - §1.2's whole point.
      installMockToken("rotated-token");
      uploadInstances[0].options.onBeforeRequest?.({ setHeader });
      expect(setHeader).toHaveBeenLastCalledWith("Authorization", "Bearer rotated-token");
    });

    it("publishes a done job on success and bumps the reload signal", () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      succeed(uploadInstances[0]);

      const job = getJobsSnapshot()[0];
      expect(job.kind === "upload" && job.state).toEqual({
        status: "done",
        previewUrl: "https://files.mosni.dev/f/x",
        directUrl: "https://dl.mosni.dev/x",
        fileId: "file-1",
      });
    });

    it("puts the job in a non-resumable error state when the upload never got a resource URL", () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      uploadInstances[0].url = null;
      fail(uploadInstances[0], "offline before create");

      const job = getJobsSnapshot()[0];
      expect(job.kind === "upload" && job.state).toEqual({
        status: "error",
        message: "offline before create",
        resumable: false,
      });
    });

    it("puts the job in a resumable error state once tus knows a resource URL", () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      uploadInstances[0].url = "https://files.mosni.dev/api/upload/abc";
      fail(uploadInstances[0], "connection dropped");

      const job = getJobsSnapshot()[0];
      expect(job.kind === "upload" && job.state).toEqual({
        status: "error",
        message: "connection dropped",
        resumable: true,
      });
    });

    it("puts the job in error, never a permanent uploading, when the success body is unreadable (A2)", () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      uploadInstances[0].options.onSuccess?.({ lastResponse: { getBody: () => "<html>502</html>" } });

      const job = getJobsSnapshot()[0];
      expect(job.kind === "upload" && job.state).toEqual({
        status: "error",
        message: "upload finished but the server response was unreadable",
        resumable: false,
      });
    });
  });

  describe("concurrency queue (Wave C1)", () => {
    it(`never starts more than UPLOAD_MAX_CONCURRENT (${UPLOAD_MAX_CONCURRENT}) uploads at once`, () => {
      const files = Array.from({ length: UPLOAD_MAX_CONCURRENT + 2 }, (_, i) => file(`f${i}.txt`));
      startBatch(files, { destinationCollectionId: null, source: "drop" });

      expect(uploadInstances).toHaveLength(UPLOAD_MAX_CONCURRENT);
      const jobs = getJobsSnapshot();
      const queued = jobs.filter((j) => j.kind === "upload" && j.state.status === "queued");
      const uploading = jobs.filter((j) => j.kind === "upload" && j.state.status === "uploading");
      expect(uploading).toHaveLength(UPLOAD_MAX_CONCURRENT);
      expect(queued).toHaveLength(2);
    });

    it("pulls the next queued job as soon as a slot frees, on success", () => {
      const files = Array.from({ length: UPLOAD_MAX_CONCURRENT + 1 }, (_, i) => file(`f${i}.txt`));
      startBatch(files, { destinationCollectionId: null, source: "drop" });
      expect(uploadInstances).toHaveLength(UPLOAD_MAX_CONCURRENT);

      succeed(uploadInstances[0]);

      expect(uploadInstances).toHaveLength(UPLOAD_MAX_CONCURRENT + 1);
    });

    it("pulls the next queued job on a terminal error too - a failed slot is not held open", () => {
      const files = Array.from({ length: UPLOAD_MAX_CONCURRENT + 1 }, (_, i) => file(`f${i}.txt`));
      startBatch(files, { destinationCollectionId: null, source: "drop" });

      fail(uploadInstances[0]);

      expect(uploadInstances).toHaveLength(UPLOAD_MAX_CONCURRENT + 1);
    });

    it("batchIsComplete is false while any job is uploading/queued, true once every job settles", () => {
      const files = Array.from({ length: UPLOAD_MAX_CONCURRENT + 1 }, (_, i) => file(`f${i}.txt`));
      const batchId = startBatch(files, { destinationCollectionId: null, source: "drop" });
      expect(batchIsComplete(batchId)).toBe(false);

      for (const instance of [...uploadInstances]) succeed(instance);
      // succeeding the first UPLOAD_MAX_CONCURRENT frees slots and starts the rest - succeed those too.
      for (const instance of uploadInstances.slice(UPLOAD_MAX_CONCURRENT)) succeed(instance);

      expect(batchIsComplete(batchId)).toBe(true);
    });

    it("retryDelays and onShouldRetry come from UPLOAD_RETRY_DELAYS (D-173) and removeFingerprintOnSuccess is on", () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      expect(uploadInstances[0].options.retryDelays).toEqual([...UPLOAD_RETRY_DELAYS]);
      expect(uploadInstances[0].options.removeFingerprintOnSuccess).toBe(true);
    });

    it("onShouldRetry keeps retrying a bare network error and a 5xx, gives up on a settled 4xx other than 409/423", () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      const onShouldRetry = uploadInstances[0].options.onShouldRetry!;

      expect(onShouldRetry({ originalResponse: null })).toBe(true); // bare network error
      expect(onShouldRetry({ originalResponse: { getStatus: () => 503 } })).toBe(true);
      expect(onShouldRetry({ originalResponse: { getStatus: () => 409 } })).toBe(true);
      expect(onShouldRetry({ originalResponse: { getStatus: () => 423 } })).toBe(true);
      expect(onShouldRetry({ originalResponse: { getStatus: () => 403 } })).toBe(false);
      expect(onShouldRetry({ originalResponse: { getStatus: () => 400 } })).toBe(false);
    });
  });

  describe("resumeUpload (Wave B3)", () => {
    it("never constructs a new upload without calling findPreviousUploads first", async () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      uploadInstances[0].url = "https://files.mosni.dev/api/upload/abc";
      fail(uploadInstances[0]);

      resumeUpload("upload-0");

      await vi.waitFor(() => expect(uploadInstances).toHaveLength(2));
      expect(uploadInstances[1].findPreviousUploads).toHaveBeenCalledTimes(1);
    });

    it("resumes from the matching previous-upload entry when the stored url matches", async () => {
      startBatch([file("a.txt"), file("b.txt")], { destinationCollectionId: null, source: "drop" });
      uploadInstances[0].url = "https://files.mosni.dev/api/upload/abc";
      fail(uploadInstances[0]);

      const wrongMatch = { uploadUrl: "https://files.mosni.dev/api/upload/OTHER", size: 5, metadata: {}, creationTime: "", urlStorageKey: "k1", parallelUploadUrls: null };
      const rightMatch = { uploadUrl: "https://files.mosni.dev/api/upload/abc", size: 5, metadata: {}, creationTime: "", urlStorageKey: "k2", parallelUploadUrls: null };
      nextPreviousUploadsRef.current = [wrongMatch, rightMatch];

      resumeUpload("upload-0");

      await vi.waitFor(() => expect(uploadInstances).toHaveLength(3));
      const resumedInstance = uploadInstances[2];
      expect(resumedInstance.resumeFromPreviousUpload).toHaveBeenCalledWith(rightMatch);
    });

    it("falls back to the first entry when there is no known stored url to match against", async () => {
      startBatch([file("a.bin", 10, 1000)], { destinationCollectionId: null, source: "picker" });
      // Simulate a paused job restored from localStorage - resumeUpload is called with the file supplied
      // by hand, and this job never had `uploadUrl` set on its record.
      const onlyMatch = { uploadUrl: "https://files.mosni.dev/api/upload/only", size: 10, metadata: {}, creationTime: "", urlStorageKey: "k", parallelUploadUrls: null };
      nextPreviousUploadsRef.current = [onlyMatch];
      fail(uploadInstances[0]); // url stays null on this job's record

      resumeUpload("upload-0");
      await vi.waitFor(() => expect(uploadInstances).toHaveLength(2));
      expect(uploadInstances[1].resumeFromPreviousUpload).toHaveBeenCalledWith(onlyMatch);
    });
  });

  describe("restorePausedUploads + matchPausedJob (Wave B4/B6/B7)", () => {
    function tusFingerprint(f: File): string {
      return ["tus-br", f.name, f.type, f.size, f.lastModified, "/api/upload"].join("-");
    }

    it("publishes a paused job for a 200 HEAD, using the offset and stored size", async () => {
      const f = file("resume-me.bin", 1000, 12345);
      const fp = tusFingerprint(f);
      localStorage.setItem(
        `tus::${fp}::999`,
        JSON.stringify({ size: 1000, metadata: { filename: "resume-me.bin" }, uploadUrl: "https://files.mosni.dev/api/upload/abc" }),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ status: 200, ok: true, headers: new Headers({ "Upload-Offset": "400" }) }),
      );

      await restorePausedUploads();

      const jobs = getJobsSnapshot();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].kind === "upload" && jobs[0].state).toEqual({ status: "paused", loaded: 400, total: 1000 });
      expect(jobs[0].name).toBe("resume-me.bin");

      // B6/B7: re-offering the SAME file resolves back to this job.
      expect(matchPausedJob(f)).toBe(jobs[0].id);
    });

    it("prunes the localStorage entry and publishes nothing on 404/410", async () => {
      localStorage.setItem(
        "tus::whatever::1",
        JSON.stringify({ size: 10, metadata: { filename: "gone.bin" }, uploadUrl: "https://files.mosni.dev/api/upload/gone" }),
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 410, ok: false, headers: new Headers() }));

      await restorePausedUploads();

      expect(getJobsSnapshot()).toHaveLength(0);
      expect(localStorage.getItem("tus::whatever::1")).toBeNull();
    });

    it("leaves the entry alone and publishes nothing on a network error", async () => {
      localStorage.setItem(
        "tus::whatever::1",
        JSON.stringify({ size: 10, metadata: { filename: "flaky.bin" }, uploadUrl: "https://files.mosni.dev/api/upload/flaky" }),
      );
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

      await restorePausedUploads();

      expect(getJobsSnapshot()).toHaveLength(0);
      expect(localStorage.getItem("tus::whatever::1")).not.toBeNull();
    });

    it("never throws on a malformed localStorage entry", async () => {
      localStorage.setItem("tus::broken::1", "{not json");
      vi.stubGlobal("fetch", vi.fn());

      await expect(restorePausedUploads()).resolves.toBeUndefined();
      expect(getJobsSnapshot()).toHaveLength(0);
    });

    it("matchPausedJob returns null for a file whose lastModified differs (not the same file)", async () => {
      const original = file("a.bin", 10, 1000);
      const fp = tusFingerprint(original);
      localStorage.setItem(
        `tus::${fp}::1`,
        JSON.stringify({ size: 10, metadata: { filename: "a.bin" }, uploadUrl: "https://files.mosni.dev/api/upload/a" }),
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true, headers: new Headers({ "Upload-Offset": "5" }) }));
      await restorePausedUploads();

      const changed = file("a.bin", 10, 2000); // different lastModified - not the same File
      expect(matchPausedJob(changed)).toBeNull();
    });

    it("startBatch resumes a matched paused job instead of starting a second upload for it", async () => {
      const original = file("a.bin", 10, 1000);
      const fp = tusFingerprint(original);
      localStorage.setItem(
        `tus::${fp}::1`,
        JSON.stringify({ size: 10, metadata: { filename: "a.bin" }, uploadUrl: "https://files.mosni.dev/api/upload/a" }),
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true, headers: new Headers({ "Upload-Offset": "5" }) }));
      await restorePausedUploads();
      expect(getJobsSnapshot()).toHaveLength(1);
      const pausedJobId = getJobsSnapshot()[0].id;

      startBatch([original], { destinationCollectionId: null, source: "picker" });

      // No SECOND job was created for the same file - the paused one transitions to uploading instead.
      expect(getJobsSnapshot()).toHaveLength(1);
      expect(getJobsSnapshot()[0].id).toBe(pausedJobId);
      await vi.waitFor(() => {
        const job = getJobsSnapshot()[0];
        expect(job.kind === "upload" && job.state.status).toBe("uploading");
      });
    });
  });

  describe("online listener (Wave B2)", () => {
    it("resumes every resumable error job on `online`, and leaves queued/uploading/paused/done jobs alone", async () => {
      startBatch([file("resumable.txt"), file("dead.txt")], { destinationCollectionId: null, source: "drop" });
      uploadInstances[0].url = "https://files.mosni.dev/api/upload/resumable";
      fail(uploadInstances[0], "dropped");
      uploadInstances[1].url = null;
      fail(uploadInstances[1], "gave up before a url existed");

      const beforeCount = uploadInstances.length;
      window.dispatchEvent(new Event("online"));

      // Only the resumable job gets a fresh tus.Upload constructed for it.
      await vi.waitFor(() => expect(uploadInstances.length).toBe(beforeCount + 1));
    });
  });

  describe("__resetUploadsForTests", () => {
    it("clears the queue and restarts id counters", () => {
      startBatch([file("a.txt")], { destinationCollectionId: null, source: "drop" });
      expect(getJobsSnapshot()[0].id).toBe("upload-0");

      __resetUploadsForTests();
      __resetJobsStoreForTests();

      startBatch([file("b.txt")], { destinationCollectionId: null, source: "drop" });
      expect(getJobsSnapshot()[0].id).toBe("upload-0");
    });
  });
});
