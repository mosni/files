// E8 Wave D1: typed fetch helpers for the admin API, mirroring web/src/lib/share.ts's shape - return the
// raw Response and let the caller decide, same error handling as the rest of web/src/lib. A 404 from any
// of these means "not an admin" (D-217), never "missing" - a single terminal state, never a retry.

import type { ShareObjectType } from "../../../app/src/lib/shareContext.ts";
import { authHeaders } from "./filePatch.ts";

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders() };
}

export async function fetchGrants(): Promise<Response> {
  return fetch("/api/admin/grants", { headers: authHeaders() });
}

export async function revokeGrant(targetType: ShareObjectType, targetId: string, sub: string): Promise<Response> {
  return fetch("/api/admin/grants/revoke", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ targetType, targetId, sub }),
  });
}

export async function fetchUsage(): Promise<Response> {
  return fetch("/api/admin/usage", { headers: authHeaders() });
}
