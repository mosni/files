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
};

export async function toastMutationFailure(res: Response): Promise<void> {
  if (res.status !== 400 && res.status !== 409) return;

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
