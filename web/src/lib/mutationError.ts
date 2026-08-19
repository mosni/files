// D-128 (E4.1 live-testing findings, Wave F): closes PICKER-SILENT-400, both instances - a rejected
// mutation now says why instead of silently reverting. Only for a 400/409: everything else keeps today's
// silent fallback (D-1's "a drop must never become an error dialog" is unchanged for transient failures).
// The CALLER owns the toast, not the component that made the fetch call - ProtectionControl in particular
// stays dumb ("it only ever renders and reverts, it never picks the URL") and this function is never
// called from inside it.

function toast(message: string): void {
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast(message, { variant: "error" });
  }
}

const MESSAGES: Record<string, string> = {
  below_parent_protection: "The collection this is in is stricter — raise that one first.",
  invalid_protection: "That protection level isn't valid.",
  invalid_name: "That name can't be used — no slashes, and no leading or trailing spaces.",
  name_taken: "That name is already used here — choose another.",
  invalid_destination: "A collection can't be moved into itself.",
  // E7 (D-128's whole point extended to the share dialog): a rejected share/invite says why too.
  // Review 060/SEC-6: `unknown_account` is finally REAL - POST /api/shares now validates the grantee
  // against auth's directory instead of accepting any string. `link_account_not_grantable` is gone: auth's
  // directory already excludes link-bound accounts, so they fall under unknown_account, and telling them
  // apart would mean parsing a sub - which security invariant 6 forbids outright.
  // E7-QA1 D-195: `not_private` is DEAD - sharing succeeds at every protection level now, so the server
  // never sends this code any more. Do not re-add it without a fresh decision reversing D-195.
  unknown_account: "That account hasn't signed in yet — send them an invite link instead.",
  invalid_ttl: "That link duration isn't one of the available options.",
  cannot_share_with_self: "You already have access to your own file.",
};

export async function toastMutationFailure(res: Response, fallback?: string): Promise<void> {
  // Read the body ONCE, up front: the 502 branch below needs the code too (review 060/BUG-6), and a
  // Response body can only be consumed a single time.
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string };
    code = body.error;
  } catch {
    // an unreadable body must not throw - fall through to the generic message
  }

  if (res.status === 502) {
    // BUG-6: not every 502 is a dead directory. `acl_write_failed` means the invite was MINTED and the
    // ACL row then failed - auth worked, the link is live, and it grants nothing - so pointing the user
    // at "can't reach the directory" sent them to debug the one service that was fine.
    toast(
      code === "acl_write_failed"
        ? "The invite link was created but access couldn't be applied to it — it grants nothing. Revoke it and try again."
        : "Can't reach the account directory right now.",
    );
    return;
  }

  if (res.status !== 400 && res.status !== 403 && res.status !== 409) {
    // BUG-5: `fallback` is what a caller passes when silence is worse than a generic message. Delete is
    // the case that forced it - it can only ever fail with a 404 (gone, or not yours), which no code in
    // MESSAGES covers, so both delete handlers used to leave the confirmation modal open with no
    // explanation at all. Every other caller omits it and keeps today's deliberate silence on transient
    // failures (D-1: a drop must never become an error dialog).
    if (fallback !== undefined) toast(fallback);
    return;
  }

  toast((code !== undefined && MESSAGES[code]) || "That change couldn't be applied.");
}
