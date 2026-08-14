// D-128 (E4.1 live-testing findings, Wave F): closes PICKER-SILENT-400, both instances - a rejected
// mutation now says why instead of silently reverting. Only for a 400/409: everything else keeps today's
// silent fallback (D-1's "a drop must never become an error dialog" is unchanged for transient failures).
// The CALLER owns the toast, not the component that made the fetch call - ProtectionControl in particular
// stays dumb ("it only ever renders and reverts, it never picks the URL") and this function is never
// called from inside it.

const MESSAGES: Record<string, string> = {
  below_parent_protection: "The collection this is in is stricter — raise that one first.",
  invalid_protection: "That protection level isn't valid.",
  invalid_name: "That name can't be used — no slashes, and no leading or trailing spaces.",
  name_taken: "That name is already used here — choose another.",
  invalid_destination: "A collection can't be moved into itself.",
  // E7 (D-128's whole point extended to the share dialog): a rejected share/invite says why too.
  // E7-QA1 D-195: `not_private` is DEAD - sharing succeeds at every protection level now, so the server
  // never sends this code any more. Do not re-add it without a fresh decision reversing D-195.
  unknown_account: "That account hasn't signed in yet — send them an invite instead.",
  link_account_not_grantable: "That's an invite account; it already has access through its link.",
  cannot_share_with_self: "You already have access to your own file.",
};

export async function toastMutationFailure(res: Response): Promise<void> {
  // E7 widens this from {400, 409} to also cover 403 (a stale dialog state re-submitted after access
  // changed) and 502 (auth unreachable) - the share API is the first caller whose failures span that
  // range; every existing caller (rename/protection/move/delete) never produces those codes, so this is
  // additive, not a behaviour change for them.
  if (res.status === 502) {
    if (typeof window.mosni !== "undefined" && window.mosni.toast) {
      window.mosni.toast("Can't reach the account directory right now.", { variant: "error" });
    }
    return;
  }
  if (res.status !== 400 && res.status !== 403 && res.status !== 409) return;

  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string };
    code = body.error;
  } catch {
    // an unreadable body must not throw - fall through to the generic message
  }

  const message = (code !== undefined && MESSAGES[code]) || "That change couldn't be applied.";
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast(message, { variant: "error" });
  }
}
