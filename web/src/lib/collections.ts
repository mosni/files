// G3 (E4.1 live-testing findings, Wave G): extracted out of DropZone.tsx so the move-destination picker
// (FileBrowser.tsx) can reuse the exact same fetch rather than writing a third copy.

// E6 Wave E adds `parentId` (already present in the server response, previously unused client-side) -
// ensureCollectionPath below needs it to find an existing sibling under a specific parent.
export type CollectionOption = { id: string; name: string; parentId?: string };

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchCollections(token: string | null): Promise<CollectionOption[]> {
  try {
    const res = await fetch("/api/collections", { headers: authHeaders(token) });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    // A malformed/unexpected response must degrade to "no collections" rather than crash the caller.
    return Array.isArray(body) ? (body as CollectionOption[]) : [];
  } catch {
    return [];
  }
}

// E6 Wave E2: keyed by `${parentId}::${name}`, shared across every ensureCollectionPath call for the
// lifetime of the page - a folder drop calls this once PER DISTINCT directory path, so two paths sharing a
// prefix ("photos/2026" and "photos/2027") must resolve "photos" to the SAME collection rather than racing
// two POSTs for it. Concurrent callers awaiting the same in-flight promise get the same result for free.
const levelCache = new Map<string, Promise<string | null>>();

async function createOrFindLevel(token: string | null, parentId: string, name: string): Promise<string | null> {
  try {
    const res = await fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ parentId, name }),
    });
    if (res.ok) return ((await res.json()) as CollectionOption).id;
    if (res.status === 409) {
      // A sibling with this name already exists under `parentId` - re-list and use it, rather than
      // failing, so every file destined for the same on-disk directory lands in the same collection.
      const existing = await fetchCollections(token);
      const match = existing.find((c) => c.parentId === parentId && c.name === name);
      return match ? match.id : null;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveLevel(token: string | null, parentId: string, name: string): Promise<string | null> {
  const key = `${parentId}::${name}`;
  const cached = levelCache.get(key);
  if (cached) return cached;
  const promise = createOrFindLevel(token, parentId, name);
  levelCache.set(key, promise);
  return promise;
}

/** E2: resolve or create each level of `segments` in order, one collection per level, returning the
 *  deepest collection's id. Memoised (see levelCache above) so a 300-file folder creates each collection
 *  exactly once. Returns null on unrecoverable failure - the caller falls back to its own default
 *  destination (D-1: a bad destination must never turn a drop into an error dialog). */
export async function ensureCollectionPath(
  token: string | null,
  segments: string[],
  rootParentId: string | null,
): Promise<string | null> {
  let parentId = rootParentId ?? "";
  for (const segment of segments) {
    const resolved = await resolveLevel(token, parentId, segment);
    if (resolved === null) return null;
    parentId = resolved;
  }
  return segments.length === 0 ? (rootParentId ?? null) : parentId;
}

// Test-only: the level cache is a module-level singleton, so a test that drops the same folder path twice
// across cases must reset it or the second drop silently reuses the first test's mocked ids.
export function __resetCollectionPathCacheForTests(): void {
  levelCache.clear();
}
