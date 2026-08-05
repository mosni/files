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
//
// ⚠ This is a CAPABILITY check, not a readiness check: it is true on any browser that exposes the API,
// including one where registration subsequently failed. Readiness is decided in downloadArchive() below,
// which is why that function must never wait indefinitely.
export function isArchiveSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

// `navigator.serviceWorker.ready` resolves only once a registration for this scope becomes ACTIVE - if
// registration failed (or was never attempted), it simply NEVER settles. Awaiting it bare is what left the
// UI stuck on "Archiving 0/N…" forever with no error and no way back (found in review session 034, after
// the module-registration bug meant registration failed on every browser). A bounded wait converts that
// silent hang into a real, surfaced failure, which is what G1's "degrade to archive unavailable" requires.
const WORKER_READY_TIMEOUT_MS = 10_000;

async function readyController(): Promise<ServiceWorker> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("the archive worker isn't available in this browser")),
      WORKER_READY_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    // A genuinely first load before the service worker has started controlling this page - reload picks
    // it up (G1's clients.claim() covers every load after the first).
    throw new Error("the archive worker isn't controlling this page yet - reload and try again");
  }
  return controller;
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

  const controller = await readyController();

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

// E5.1 Wave F (finding 10, D-159): "Download all" walks nested collections instead of archiving only the
// current level, preserving subtree paths as real directories in the zip (Hannah's call - Drive/Dropbox do
// the same, never flattened). §1.5 binds here as much as anywhere: the walk calls the SAME
// `GET /api/browse` every level of the UI already uses (`fetchLevel`, injected by the caller -
// FileBrowser.tsx builds it with the exact browseUrl()/authHeaders() the rest of the component uses) - this
// module invents no second authorization path and no "list everything under here" endpoint. A node that
// returns null (unauthorized, or gone since the listing was fetched) contributes nothing; that is correct
// behaviour, not an error to surface.

export type ArchiveWalkLevel = {
  collections: { id: string; name: string }[];
  files: { name: string; directUrl: string }[];
  nextOffset: number | null;
};

export type ArchiveWalkGuards = { maxDepth?: number; maxEntries?: number };

// Real Drive/Dropbox-style hierarchies rarely run more than a handful of levels deep; this guards against
// a pathologically deep (or mis-seeded) collection tree hanging the browser, not a realistic nesting depth
// anyone would actually build by hand.
const DEFAULT_MAX_ARCHIVE_DEPTH = 20;
// Comfortably covers any collection a person would actually want zipped in one go; a subtree past this is
// also going to trip the global rate limiter long before the zip itself becomes the bottleneck
// (E5-DELIVERY-RATE-LIMIT stays the open question about THAT, not this constant).
const DEFAULT_MAX_ARCHIVE_ENTRIES = 20_000;
// A small fixed pool draining the walk queue, never an unbounded Promise.all over every discovered node at
// once - F5 is explicit that this wave must not multiply the archive's own request burst against the
// global 100/min limiter any further than it already does.
const WALK_CONCURRENCY = 4;

type WalkNode = { collectionId: string; segments: string[]; depth: number };

// Display names are already validated server-side (no "/", "..", or control characters, at
// creation/rename time - session 017's review) - this is a defense-in-depth backstop for the zip entry
// itself, not the primary guarantee, so a name that somehow got past that can never turn into an entry
// that escapes its directory.
function sanitizeSegment(name: string): string {
  const cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, (dots) => "_".repeat(dots.length));
  return cleaned.length === 0 ? "_" : cleaned;
}

function uniquePath(used: Set<string>, path: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const rest = slash === -1 ? path : path.slice(slash + 1);
  const dot = rest.lastIndexOf(".");
  const base = dot > 0 ? rest.slice(0, dot) : rest;
  const ext = dot > 0 ? rest.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${dir}${base}(${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export async function collectArchiveEntries(
  rootCollectionId: string,
  fetchLevel: (collectionId: string, offset: number) => Promise<ArchiveWalkLevel | null>,
  guards: ArchiveWalkGuards = {},
): Promise<{ entries: ArchiveFile[]; omitted: string[] }> {
  const maxDepth = guards.maxDepth ?? DEFAULT_MAX_ARCHIVE_DEPTH;
  const maxEntries = guards.maxEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES;

  const entries: ArchiveFile[] = [];
  const omitted: string[] = [];
  const usedPaths = new Set<string>();
  let entryCount = 0;

  async function fetchAllPages(collectionId: string): Promise<ArchiveWalkLevel[]> {
    const pages: ArchiveWalkLevel[] = [];
    let offset = 0;
    for (;;) {
      const page = await fetchLevel(collectionId, offset);
      if (page === null) break; // unauthorized / gone - §1.5: contributes nothing, not an error
      pages.push(page);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    return pages;
  }

  async function processNode(node: WalkNode, discovered: WalkNode[]): Promise<void> {
    if (node.depth > maxDepth) {
      omitted.push(node.segments.length > 0 ? node.segments.join("/") : "(root)");
      return;
    }
    const pages = await fetchAllPages(node.collectionId);
    for (const page of pages) {
      for (const file of page.files) {
        const wantedPath = [...node.segments, sanitizeSegment(file.name)].join("/");
        if (entryCount >= maxEntries) {
          omitted.push(wantedPath);
          continue;
        }
        entries.push({ name: uniquePath(usedPaths, wantedPath), url: file.directUrl });
        entryCount++;
      }
      for (const child of page.collections) {
        discovered.push({
          collectionId: child.id,
          segments: [...node.segments, sanitizeSegment(child.name)],
          depth: node.depth + 1,
        });
      }
    }
  }

  // Bounded-concurrency BFS: process the queue in batches of at most WALK_CONCURRENCY nodes at a time,
  // waiting for each batch (which may itself discover and enqueue new child nodes) before starting the
  // next one.
  let queue: WalkNode[] = [{ collectionId: rootCollectionId, segments: [], depth: 0 }];
  while (queue.length > 0) {
    const batch = queue.splice(0, WALK_CONCURRENCY);
    const discovered: WalkNode[] = [];
    await Promise.all(batch.map((node) => processNode(node, discovered)));
    queue = queue.concat(discovered);
  }

  return { entries, omitted };
}
