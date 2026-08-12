// E7 Wave D1: typed fetch helpers for the share API (§1.4 of the waves hand-off). Same shape as
// filePatch.ts - return the raw Response and let the caller decide success/failure, so ShareDialog.tsx
// can await res.ok, apply the parsed body on success, or hand the response to toastMutationFailure on
// failure (D-128's whole point, extended to sharing).

import type { ShareObjectType } from "../../../app/src/lib/shareContext.ts";
import { authHeaders } from "./filePatch.ts";

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders() };
}

export async function fetchAccounts(): Promise<Response> {
  return fetch("/api/accounts", { headers: authHeaders() });
}

export async function fetchShareState(type: ShareObjectType, id: string): Promise<Response> {
  return fetch(`/api/shares?type=${type}&id=${encodeURIComponent(id)}`, { headers: authHeaders() });
}

export async function grantShare(type: ShareObjectType, id: string, sub: string, canUpload?: boolean): Promise<Response> {
  return fetch("/api/shares", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ type, id, sub, ...(canUpload !== undefined ? { canUpload } : {}) }),
  });
}

export async function revokeShare(type: ShareObjectType, id: string, sub: string): Promise<Response> {
  return fetch("/api/shares/revoke", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ type, id, sub }),
  });
}

export async function createInvite(type: ShareObjectType, id: string, canUpload?: boolean): Promise<Response> {
  return fetch("/api/invites", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ type, id, ...(canUpload !== undefined ? { canUpload } : {}) }),
  });
}
