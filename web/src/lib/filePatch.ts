// D-89: shared by ManageControls.tsx (protection, delete) and PreviewCard.tsx (rename, moved to the
// header in E5.1 live-testing round 2) - both PATCH the same `/api/files/:id`, and a rename/protection
// change both retire previewUrl/directUrl the same way (see updatedContext below), so this stays one
// implementation rather than two copies drifting.

import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

export function authHeaders(): Record<string, string> {
  const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function patchFile(id: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`/api/files/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
}

// A rename or a protection change retires the file's previewUrl/directUrl - `secret` moves both links
// onto /t/<token>, and `private` needs a freshly signed directUrl for its bytes to keep rendering. The
// client cannot recompute either (it never sees the link_token), so the PATCH response carries the whole
// updated context and it is applied wholesale. Patching only the field we sent would leave the copy
// control offering the URL the change just retired.
export async function updatedContext(res: Response, fallback: PreviewContext): Promise<PreviewContext> {
  try {
    return (await res.json()) as PreviewContext;
  } catch {
    return fallback; // a body we can't read must not wipe the rendered state
  }
}
