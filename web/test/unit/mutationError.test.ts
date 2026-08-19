import { afterEach, describe, expect, it, vi } from "vitest";
import { toastMutationFailure } from "../../src/lib/mutationError.ts";

// D-128, widened for E7's share dialog: a rejected mutation says why instead of silently reverting.
// 400/409 were the original range; E7 adds 403 (a stale dialog re-submitted after access changed) and 502
// (auth unreachable) - both first produced by the share API.
describe("toastMutationFailure()", () => {
  afterEach(() => {
    delete (window as unknown as { mosni?: unknown }).mosni;
  });

  function res(status: number, body?: Record<string, unknown>): Response {
    return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
  }

  it("does nothing for a status outside {400, 403, 409, 502}", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    await toastMutationFailure(res(404));
    await toastMutationFailure(res(200));
    expect(toast).not.toHaveBeenCalled();
  });

  it("400 with a known code (D-128 original) shows the mapped message", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    await toastMutationFailure(res(400, { error: "name_taken" }));
    expect(toast).toHaveBeenCalledWith("That name is already used here — choose another.", { variant: "error" });
  });

  it("400 with an unknown code falls back to a generic message", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    await toastMutationFailure(res(400, { error: "something_new" }));
    expect(toast).toHaveBeenCalledWith("That change couldn't be applied.", { variant: "error" });
  });

  it("an unreadable body falls back to the generic message rather than throwing", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    const badRes = new Response("not json", { status: 409 });
    await expect(toastMutationFailure(badRes)).resolves.toBeUndefined();
    expect(toast).toHaveBeenCalledWith("That change couldn't be applied.", { variant: "error" });
  });

  it.each([
    // Review 060/SEC-6: `unknown_account` is a code the server actually sends now (POST /api/shares
    // validates the grantee against auth's directory). `link_account_not_grantable` was removed with the
    // message - auth's directory excludes link-bound accounts, so they arrive as unknown_account, and
    // separating them would mean parsing a sub (security invariant 6 forbids it).
    ["unknown_account", "That account hasn't signed in yet — send them an invite link instead."],
    ["invalid_ttl", "That link duration isn't one of the available options."],
    ["cannot_share_with_self", "You already have access to your own file."],
  ] as const)("409 %s -> %s (E7)", async (code, message) => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    await toastMutationFailure(res(409, { error: code }));
    expect(toast).toHaveBeenCalledWith(message, { variant: "error" });
  });

  it("400 cannot_share_with_self (E7) also maps", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    await toastMutationFailure(res(400, { error: "cannot_share_with_self" }));
    expect(toast).toHaveBeenCalledWith("You already have access to your own file.", { variant: "error" });
  });

  it("403 with a known code shows the mapped message (E7)", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    await toastMutationFailure(res(403, { error: "unknown_account" }));
    expect(toast).toHaveBeenCalledWith("That account hasn't signed in yet — send them an invite link instead.", { variant: "error" });
  });

  it("502 auth_unavailable shows the auth-unavailable message (E7)", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    await toastMutationFailure(res(502, { error: "auth_unavailable" }));
    expect(toast).toHaveBeenCalledWith("Can't reach the account directory right now.", { variant: "error" });
  });

  // Review 060/BUG-6: this 502 means the OPPOSITE of a dead directory - auth minted the invite fine and
  // the ACL write then failed, leaving a live link that grants nothing. Sending the user to debug auth was
  // pointing at the one service that had worked.
  it("502 acl_write_failed says the link grants nothing, not that auth is down (BUG-6)", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };
    await toastMutationFailure(res(502, { error: "acl_write_failed" }));
    expect(toast).toHaveBeenCalledWith(
      "The invite link was created but access couldn't be applied to it — it grants nothing. Revoke it and try again.",
      { variant: "error" },
    );
  });

  // BUG-5: delete fails with a 404, which no code in MESSAGES covers - without an explicit fallback the
  // caller got total silence and left its confirmation modal open.
  it("a 404 is silent by default but toasts the caller's fallback when one is given (BUG-5)", async () => {
    const toast = vi.fn();
    (window as unknown as { mosni: unknown }).mosni = { toast };

    await toastMutationFailure(res(404, {}));
    expect(toast).not.toHaveBeenCalled();

    await toastMutationFailure(res(404, {}), "Could not delete that.");
    expect(toast).toHaveBeenCalledWith("Could not delete that.", { variant: "error" });
  });

  it("never throws when window.mosni is not yet loaded", async () => {
    await expect(toastMutationFailure(res(409, { error: "name_taken" }))).resolves.toBeUndefined();
    await expect(toastMutationFailure(res(502))).resolves.toBeUndefined();
  });
});
