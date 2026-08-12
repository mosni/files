// E7 Wave 0.2: the one module that talks to auth's internal API. `AUTH_INTERNAL_API` moved here verbatim
// from grantable-roles.ts, which now imports it back - this module owns every call this app ever makes to
// auth's internal listener, not just the three E7 adds.

import type { DirectoryAccount } from "../lib/shareContext.ts";

// Fixed convention, not a per-deploy setting: auth's internal-only listener, reachable via the `auth`
// network alias at its documented default INTERNAL_PORT (../auth/README.md - "compose never publishes
// this to the host and nginx never proxies it").
export const AUTH_INTERNAL_API = "http://auth:3001";
export const AUTH_NAMESPACE = "files";

export type InternalResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; status: number }; // `error` is auth's own code, verbatim

// Never throws (load-bearing): a network failure, a non-JSON body or a non-2xx status all become
// `{ ok: false, error, status }` rather than a rejected promise - a dead auth must degrade to a visible
// error in the share dialog, never a 500.
async function post(path: string, body: Record<string, unknown>): Promise<InternalResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_INTERNAL_API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "auth_unreachable", status: 0 };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  if (!res.ok) {
    const error = typeof json === "object" && json !== null && "error" in json ? String((json as { error: unknown }).error) : "auth_error";
    return { ok: false, error, status: res.status };
  }
  return { ok: true, value: json };
}

// §A7.5: the read-only directory. No caller verification on auth's side - the network gate (this route
// existing only on the internal listener) is the entire authentication for a read-only, no-namespace
// request. D-34's "the picker must exclude link-bound accounts" is already true of what auth returns
// (`WHERE link_id IS NULL`) - this module asserts that, never filters for it.
export async function listAccounts(): Promise<InternalResult<DirectoryAccount[]>> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_INTERNAL_API}/internal/accounts`);
  } catch {
    return { ok: false, error: "auth_unreachable", status: 0 };
  }
  if (!res.ok) {
    return { ok: false, error: "auth_error", status: res.status };
  }
  // "It never throws" has to survive a 2xx too: a proxy or error page answering 200 with HTML would
  // otherwise reject here and 500 the share dialog - and on grant/revoke it would 500 AFTER the ACL row
  // was already written, so the owner sees a failure for a change that actually happened. The shape check
  // is part of the same rule: a non-array body must not reach callers that .map() over it.
  let value: unknown;
  try {
    value = await res.json();
  } catch {
    return { ok: false, error: "auth_error", status: res.status };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "auth_error", status: res.status };
  }
  return { ok: true, value: value as DirectoryAccount[] };
}

// §A7.8: grant/revoke ONE of this app's own roles on an existing account. E7 only ever calls this with
// action "remove" (D-192, best-effort role cleanup on unshare) - granting a role is deliberately NOT how
// an ordinary share works (D-182: the ACL row IS the grant).
export async function setAccountRole(sub: string, role: string, action: "add" | "remove"): Promise<InternalResult<void>> {
  const result = await post("/internal/roles", { namespace: AUTH_NAMESPACE, sub, role, action });
  return result.ok ? { ok: true, value: undefined } : result;
}

// §A7.1: mint a one-person invite link. NEVER logs the returned url (auth's own invariant 11 - a bearer
// token in a query-free path segment) - only the id, if a caller logs anything at all.
export async function mintInviteLink(params: {
  roles: string[];
  ttlSeconds: number;
  destination: string;
  label: string;
}): Promise<InternalResult<{ url: string; id: string; expiresAt: string }>> {
  const result = await post("/internal/links", {
    namespace: AUTH_NAMESPACE,
    roles: params.roles,
    ttl_seconds: params.ttlSeconds,
    destination: params.destination,
    label: params.label,
    allow_register: true,
  });
  if (!result.ok) return result;
  const body = result.value as { url: string; id: string; expires_at: string };
  return { ok: true, value: { url: body.url, id: body.id, expiresAt: body.expires_at } };
}
