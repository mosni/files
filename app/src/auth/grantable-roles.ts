// D-32: grantable-role registration is idempotent and non-fatal. Registers this app's three roles with
// auth's internal API on boot; auth's addGrantableRole() is INSERT IGNORE, so repeated calls are no-ops.
// MUST be called only after the container has joined the `stack` network, since resolving the `auth`
// alias (and being resolvable AS `files` in turn - auth's peer check) depends on it.

const GRANTABLE_ROLES = ["files:write", "files:delete", "files:admin"] as const;

// Fixed convention, not a per-deploy setting: auth's internal-only listener, reachable via the `auth`
// network alias at its documented default INTERNAL_PORT (../auth/README.md - "compose never publishes
// this to the host and nginx never proxies it").
const AUTH_INTERNAL_API = "http://auth:3001";

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
