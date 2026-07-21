// F1: this component *is* the product for now (D-64) - drag/drop or click-to-pick, one independent
// tus.Upload per file, per-file progress, and a hand-off to CopyLink on completion. F5's gating also
// lives here since the full landing page (file browser, admin entry point) is a later epic (E4).

import { useEffect, useRef, useState } from "react";
import * as tus from "tus-js-client";
import { can, type Claims } from "../../../app/src/lib/roles.ts";
import { UPLOAD_CHUNK_SIZE } from "../../../app/src/lib/uploadConfig.ts";
import { CopyLink } from "./CopyLink.tsx";

type MosniUser = Claims | null;
type MosniToastOptions = { variant?: "success" | "error" | "info" };

declare global {
  interface Window {
    mosni?: {
      user(): MosniUser;
      token(): string | null;
      onChange(cb: (user: MosniUser) => void): void;
      login(): void;
      logout(): void;
      toast(message: string, options?: MosniToastOptions): void;
    };
  }
}

// React 19's @types/react moved IntrinsicElements under React.JSX rather than a bare global `JSX`
// namespace (the old `declare global { namespace JSX {...} }` pattern silently fails to merge under
// the "react-jsx" transform with these types) - augment the "react" module's JSX namespace instead.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "mosni-login-button": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

type UploadState =
  | { status: "uploading"; progress: number }
  | { status: "done"; previewUrl: string; directUrl?: string }
  | { status: "error"; message: string };

type FileUpload = {
  id: string;
  name: string;
  state: UploadState;
};

let nextUploadId = 0;

function startUpload(
  file: File,
  token: string | null,
  chunkSize: number,
  onUpdate: (state: UploadState) => void,
) {
  const upload = new tus.Upload(file, {
    endpoint: "/api/upload",
    chunkSize,
    metadata: { filename: file.name },
    headers: { Authorization: `Bearer ${token ?? ""}` },
    onProgress: (bytesSent, bytesTotal) => {
      onUpdate({ status: "uploading", progress: Math.round((bytesSent / bytesTotal) * 100) });
    },
    onSuccess: (payload) => {
      // The server deliberately overrides tus's usual 204 with a 200 + JSON body on the completing
      // request (a 204 can't carry one) - lastResponse.getBody() is that JSON, as a string.
      const { previewUrl, directUrl } = JSON.parse(payload.lastResponse.getBody()) as {
        previewUrl: string;
        directUrl?: string;
      };
      onUpdate({ status: "done", previewUrl, directUrl });
    },
    onError: (error) => {
      onUpdate({ status: "error", message: error.message });
    },
  });
  upload.start();
}

export function DropZone() {
  const [user, setUser] = useState<MosniUser>(null);
  const [authReady, setAuthReady] = useState(false);
  const [uploads, setUploads] = useState<FileUpload[]>([]);
  // Server-authoritative chunk size (P10): the shared constant is the compile-time fallback, but the
  // running server is the source of truth so the client and the server's rate-limit budget cannot drift.
  const [chunkSize, setChunkSize] = useState(UPLOAD_CHUNK_SIZE);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg: { uploadChunkSize?: unknown } | null) => {
        if (!cancelled && cfg && typeof cfg.uploadChunkSize === "number") setChunkSize(cfg.uploadChunkSize);
      })
      .catch(() => {}); // unreachable /api/config just means we keep the fallback - never blocks uploads
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    function subscribe() {
      // The auth SDK's <script> tag loads independently of this module's own script - never assume
      // window.mosni exists at mount time. Poll briefly until it shows up, then subscribe for good.
      if (typeof window.mosni === "undefined") {
        pollTimer = setTimeout(subscribe, 50);
        return;
      }
      window.mosni.onChange((nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
        setAuthReady(true);
      });
    }

    subscribe();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  function updateUpload(id: string, state: UploadState) {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, state } : u)));
  }

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;

    // Each file gets its own tus.Upload and its own row - multi-file grouping into a single shared link
    // is a later epic (E6), not this one.
    Array.from(fileList).forEach((file) => {
      const id = `upload-${nextUploadId++}`;
      setUploads((prev) => [...prev, { id, name: file.name, state: { status: "uploading", progress: 0 } }]);
      startUpload(file, token, chunkSize, (state) => updateUpload(id, state));
    });
  }

  if (!authReady) {
    return <span className="spinner" role="status" aria-label="Loading" />;
  }

  if (user === null) {
    return <mosni-login-button />;
  }

  if (!can(user, "files:write")) {
    return <p>You do not have upload access.</p>;
  }

  return (
    <div>
      <div
        className="panel"
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          handleFiles(event.dataTransfer.files);
        }}
      >
        Drop files here, or click to choose
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          // input.click() dispatches its own bubbling native click event - without stopping it here,
          // that synthetic click would bubble back up to the wrapping div's onClick and call
          // inputRef.current.click() again, recursing forever. Same fix react-dropzone uses.
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            handleFiles(event.target.files);
            // Allow re-selecting the same file again later (browsers don't fire "change" otherwise).
            event.target.value = "";
          }}
        />
      </div>

      {uploads.map((upload) => (
        <div key={upload.id}>
          <p>{upload.name}</p>
          {upload.state.status === "uploading" && (
            <div
              className="progress"
              style={{ "--progress": `${upload.state.progress}%` } as React.CSSProperties}
            />
          )}
          {upload.state.status === "done" && (
            <CopyLink previewUrl={upload.state.previewUrl} directUrl={upload.state.directUrl} />
          )}
          {upload.state.status === "error" && <p role="alert">Upload failed: {upload.state.message}</p>}
        </div>
      ))}
    </div>
  );
}
