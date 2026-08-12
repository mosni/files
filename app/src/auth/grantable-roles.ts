// D-32: grantable-role registration is idempotent and non-fatal. Registers this app's roles with auth's
// internal API on boot; auth's addGrantableRole() is INSERT IGNORE, so repeated calls are no-ops. MUST be
// called only after the container has joined the `stack` network, since resolving the `auth` alias (and
// being resolvable AS `files` in turn - auth's peer check) depends on it.
//
// files:admin was dropped in session 007 (preliminary-review, Hannah's call): an admin is a user assigned
// both lower roles directly in auth, so there is no third role to register.
//
// `files:read` is registered ONLY so an invite link has a role to carry - auth rejects `roles: []`
// (`400 not_grantable`). **It gates nothing.** No authorization path in this app may ever call
// `can(claims, "files:read")`; a share is the ACL row alone (D-182/D-183, Hannah 2026-08-12). Wiring it
// into a read path would silently reverse that decision.

import { AUTH_INTERNAL_API } from "./internalApi.ts";

const GRANTABLE_ROLES = ["files:write", "files:delete", "files:read"] as const;

// Never throws. A dead or unreachable auth must never prevent this app's boot (D-32) - each role is
// registered independently and a failure is logged, not raised.
export async function registerGrantableRoles(): Promise<void> {
  for (const role of GRANTABLE_ROLES) {
    try {
      const res = await fetch(`${AUTH_INTERNAL_API}/internal/grantable-roles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ namespace: "files", role, action: "add" }),
      });
      if (!res.ok) {
        console.error(`grantable-roles: registering ${role} failed with status ${res.status}`);
      }
    } catch (err) {
      console.error(`grantable-roles: registering ${role} failed`, err);
    }
  }
}
