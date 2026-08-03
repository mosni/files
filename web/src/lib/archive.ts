// E5 Wave G (D-133): triggers a client-side archive download through the service worker's StreamSaver
// pattern (web/src/sw.ts) - the zip is assembled entirely in the browser from rows GET /api/browse already
// returned, so Node never streams file bytes (security invariant 2) and the archive inherits every row's
// existing effective-protection filtering for free, with no second authorization path to get wrong.

export type ArchiveFile = { name: string; url: string };
export type ArchiveProgress = { completed: number; total: number; failed: string[] };

type ArchiveProgressMessage = {
  type: "archive-progress";
  id: string;
  completed: number;
  total: number;
  failed: string[];
};

function isArchiveProgressMessage(data: unknown): data is ArchiveProgressMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "archive-progress" &&
    typeof (data as { id?: unknown }).id === "string"
  );
}

// G1: registration is defensive (main.tsx) - a browser with no service-worker support, or one where
// registration failed, simply never gets a controller, so this degrades to "archive unavailable" rather
// than a broken button.
export function isArchiveSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

// D-21/D-134: store mode only - media is already compressed, so there is nothing here for the box's own
// (Atom N2800, D-78) CPU to spend on deflate. `onProgress` fires after every file, success or failure - a
// single failed file is skipped, never aborting the whole archive (G2's advantage over a server stream).
export async function downloadArchive(
  name: string,
  files: ArchiveFile[],
  onProgress?: (progress: ArchiveProgress) => void,
): Promise<void> {
  if (!isArchiveSupported()) {
    throw new Error("service workers are not supported in this browser");
  }

  await navigator.serviceWorker.ready;
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    // A genuinely first load before the service worker has started controlling this page - reload picks
    // it up (G1's clients.claim() covers every load after the first).
    throw new Error("the archive worker isn't controlling this page yet - reload and try again");
  }

  const id = crypto.randomUUID();

  if (onProgress) {
    const listener = (event: MessageEvent) => {
      const data = event.data as unknown;
      if (!isArchiveProgressMessage(data) || data.id !== id) return;
      onProgress({ completed: data.completed, total: data.total, failed: data.failed });
      if (data.completed >= data.total) {
        navigator.serviceWorker.removeEventListener("message", listener);
      }
    };
    navigator.serviceWorker.addEventListener("message", listener);
  }

  controller.postMessage({ type: "archive-manifest", id, name, files });

  // A real anchor click (not `location.assign`) - the request goes through the service worker's fetch
  // handler like any other same-origin request, and `Content-Disposition: attachment` (set by the worker)
  // is what makes the browser save it rather than navigate.
  const link = document.createElement("a");
  link.href = `/__archive/${id}/${encodeURIComponent(name)}.zip`;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
