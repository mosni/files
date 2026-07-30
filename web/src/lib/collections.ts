// G3 (E4.1 live-testing findings, Wave G): extracted out of DropZone.tsx so the move-destination picker
// (FileBrowser.tsx) can reuse the exact same fetch rather than writing a third copy.

export type CollectionOption = { id: string; name: string };

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
