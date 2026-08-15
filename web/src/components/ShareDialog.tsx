// E7 Wave D2: the share dialog, one component behind both entry points (D-185) - the row overflow menu
// (FileBrowser.tsx) and the preview page's owner-only block (PreviewCard.tsx).
//
// Children are rendered UNCONDITIONALLY and only the `open` attribute is toggled (the D-8 class bug -
// technical-baseline.md §2): the Delete confirmation modal already mounted in FileBrowser.tsx is the
// pattern this copies. Internal branching on loading/shareable state is ordinary React re-rendering of
// content that is always part of the JSX tree, not children appended after the element has already
// connected - see that file's header comment for why the distinction matters.

import { useEffect, useState } from "react";
import type { Claims } from "../../../app/src/lib/roles.ts";
import type { DirectoryAccount, InviteMinted, ShareObjectType, ShareState } from "../../../app/src/lib/shareContext.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { createInvite, fetchAccounts, fetchShareState, grantShare, revokeShare } from "../lib/share.ts";
import { useModalClose } from "../lib/modalClose.ts";
import { useSwitchChange } from "../lib/switchChange.ts";
import { CopyLink } from "./CopyLink.tsx";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "mosni-modal": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { heading?: string; open?: boolean },
        HTMLElement
      >;
      "mosni-icon": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { name?: string; size?: string | number },
        HTMLElement
      >;
      // E7-QA1 live-testing round 2 (F4/F13): confirmed real and registered by fetching and reading the
      // ACTUAL built https://ui.mosni.dev/mosnicat-core.js directly (the source repo stays out of this
      // session's scope, but the served bundle is a public URL) - `observedAttributes: ["checked",
      // "disabled"]`, plus a `label` attribute it renders itself. `checked`/`disabled` are boolean
      // ATTRIBUTES here, same as `mosni-modal`'s `open` above (React serializes a boolean prop on an
      // unrecognized custom element as the attribute's bare presence/absence, never a stringified
      // "true"/"false" - confirmed empirically this session). lib/switchChange.ts's useSwitchChange is the
      // paired hook for reading the user's actual toggle back out.
      "mosni-switch": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { checked?: boolean; disabled?: boolean; label?: string },
        HTMLElement
      >;
    }
  }
}

// Same subscribe-with-poll shape FileBrowser.tsx and lib/shareTarget.ts already use - the auth SDK's
// <script> tag loads independently of this module, so window.mosni may not exist on first mount yet.
function useCurrentUserSub(): string | null {
  const [sub, setSub] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    function subscribe() {
      if (typeof window.mosni === "undefined") {
        pollTimer = setTimeout(subscribe, 50);
        return;
      }
      window.mosni.onChange((user: Claims | null) => {
        if (!cancelled) setSub(user?.sub ?? null);
      });
    }
    subscribe();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);
  return sub;
}

// D-169: the working avatar pattern this app already uses elsewhere (lib/previewContext.ts's
// uploaderAvatarUrl) - auth.mosni.dev/avatar/<sub> DIRECTLY, on the CSP img-src allowlist. F3's defect was
// rendering auth's raw `picture` field instead, which is an IdP CDN URL (e.g. Google's) that img-src does
// not allow at all.
function avatarUrlFor(sub: string): string {
  return `https://auth.mosni.dev/avatar/${encodeURIComponent(sub)}`;
}

// F3: a broken-image robustness wrapper, same pattern PreviewCard.tsx's own uploader avatar already uses -
// on load failure, degrade to an initial/placeholder rather than the browser's broken-image icon.
function GrantAvatar({ sub }: { sub: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "var(--mosni-surface-2, #eee)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "0.7rem",
          flexShrink: 0,
        }}
      >
        {sub.slice(-1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={avatarUrlFor(sub)}
      alt=""
      width={20}
      height={20}
      style={{ borderRadius: "50%", flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  );
}

export function ShareDialog({
  type,
  id,
  objectLabel,
  open,
  onClose,
}: {
  type: ShareObjectType;
  id: string;
  objectLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const viewerSub = useCurrentUserSub();
  const [state, setState] = useState<ShareState | null>(null);
  const [accounts, setAccounts] = useState<DirectoryAccount[] | null>(null);
  const [filterText, setFilterText] = useState("");
  const [canUpload, setCanUpload] = useState(false);
  // F13/D-198: defaults ON, per D-23's requirement that the shared-identity consequence be visible and
  // the safer default chosen - an upgradeable link lets its claimant become a real, distinct account.
  const [allowRegister, setAllowRegister] = useState(true);
  const [invite, setInvite] = useState<InviteMinted | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const modalRef = useModalClose(onClose);
  const canUploadSwitchRef = useSwitchChange(setCanUpload);
  const allowRegisterSwitchRef = useSwitchChange(setAllowRegister);

  // Reset to a fresh load every time the dialog is opened - the dialog is never re-fetchable stale state
  // across separate opens (matches the invite URL's own "gone once closed" rule below).
  useEffect(() => {
    if (!open) return;
    setState(null);
    setAccounts(null);
    setInvite(null);
    setFilterText("");
    setCanUpload(false);
    setAllowRegister(true);
    void fetchShareState(type, id).then(async (res) => {
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setState((await res.json()) as ShareState);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on open/type/id
  }, [open, type, id]);

  useEffect(() => {
    // D-195: no longer gated on shareable (removed) - the account directory is needed at every protection
    // level now, since a grant is always writable.
    if (!open || state === null || accounts !== null) return;
    void fetchAccounts().then(async (res) => {
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setAccounts((await res.json()) as DirectoryAccount[]);
    });
  }, [open, state, accounts]);

  async function refreshState(): Promise<void> {
    const res = await fetchShareState(type, id);
    if (res.ok) setState((await res.json()) as ShareState);
  }

  async function grant(sub: string): Promise<void> {
    setBusy(true);
    try {
      const res = await grantShare(type, id, sub, type === "collection" ? canUpload : undefined);
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setState((await res.json()) as ShareState);
    } finally {
      setBusy(false);
    }
  }

  async function remove(sub: string): Promise<void> {
    setBusy(true);
    try {
      const res = await revokeShare(type, id, sub);
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setState((await res.json()) as ShareState);
    } finally {
      setBusy(false);
    }
  }

  async function sendInvite(): Promise<void> {
    setInviting(true);
    try {
      const res = await createInvite(type, id, type === "collection" ? canUpload : undefined, allowRegister);
      if (!res.ok) {
        await toastMutationFailure(res);
        return;
      }
      setInvite((await res.json()) as InviteMinted);
      void refreshState();
    } finally {
      setInviting(false);
    }
  }

  const grantedSubs = new Set(state?.grants.map((g) => g.sub) ?? []);
  const needle = filterText.trim().toLowerCase();
  const candidates =
    accounts?.filter((account) => {
      if (account.sub === viewerSub) return false;
      if (grantedSubs.has(account.sub)) return false;
      if (needle.length === 0) return true;
      return account.sub.toLowerCase().includes(needle) || (account.name ?? "").toLowerCase().includes(needle);
    }) ?? [];

  return (
    <mosni-modal ref={modalRef} heading={`Share "${objectLabel}"`} open={open}>
      {/* This wrapper is load-bearing, not layout (review session 045, a crash Hannah hit live). A real
          mosni-modal MOVES its light-DOM children on connect - `takeSlot`/`takeDefault` call
          `child.remove()` and re-parent everything into a <dialog> it builds. React does not know that, so
          it still believes these nodes are direct children of <mosni-modal>. Swapping one of them later
          makes React call removeChild/insertBefore on the wrong parent, the DOM throws NotFoundError in
          the commit phase, and the ENTIRE React root unmounts - a white screen, not a broken dialog.
          Keeping <mosni-modal>'s own child list structurally constant ([this div, the footer button]) is
          what makes the branching below safe: everything inside this div is under the relocated boundary,
          where React's parent references are still correct. This is the same D-8 class as the Move and
          Delete modals, but those only ever mutate content INSIDE a stable child, which is why they never
          hit it. Do not "simplify" this div away. */}
      {/* F1: constrain the whole dialog body so it can never scroll horizontally - maxWidth/overflowWrap
          here, minWidth: 0 on every flex child below that holds text (a flex item's default `min-width:
          auto` is what actually prevents wrapping; overflowWrap alone does nothing without it). */}
      {/* `whiteSpace: "normal"` is the load-bearing one here, and it took a real browser to find (review
          session 049, measured — `minWidth`/`overflowWrap` changes did nothing because neither was the
          cause). `mosni-modal` is `display: contents`, so the <dialog> it builds stays a DOM DESCENDANT of
          wherever the element was mounted even though `position: fixed` takes it out of flow — and this
          dialog is mounted inside a file-browser row's `<td>`, which mosni-chrome styles
          `white-space: nowrap`. That inherits straight through `display: contents` into the dialog, so
          every paragraph in here rendered as ONE unwrapped line and was clipped by `.modal`'s definite
          `width: min(28rem, ...)`. It cost D-195's informational note and, worse, D-23's shared-identity
          consequence line, which the hand-off requires to be legible at the point of choice — it read
          "The link dies aft". `overflowWrap: anywhere` stays for the other case: a raw `link:<uuid>` sub,
          which is one long unbreakable word. Every `<mosni-modal>` mounted inside a table row has this
          inheritance; see `issues.md` → `CHROME-MODAL-INHERITS-NOWRAP` for the upstream fix. */}
      <div style={{ maxWidth: "100%", overflowWrap: "anywhere", whiteSpace: "normal" }}>
      {state === null ? (
        <span className="spinner" role="status" aria-label="Loading" />
      ) : (
        <div style={{ display: "grid", gap: "1rem", minWidth: 0 }}>
          {/* D-195: the refusal state is gone (sharing succeeds at every level now) - this is an
              INFORMATIONAL note instead, shown only when a VIEW grant would be inert (the object is
              already readable by anyone with the link; only the upload half of a grant does anything
              here). The picker below is never hidden - §0.4.2's accepted consequence, stated plainly
              rather than pretended away. */}
          {state.effectiveProtection !== "private" && (
            <p className="little-link" style={{ minWidth: 0 }}>
              {type === "file" ? (
                <>
                  This file is <strong>{state.effectiveProtection}</strong>, so anyone with the link can
                  already open it. Sharing it with specific people adds nothing.
                </>
              ) : (
                <>
                  This collection is <strong>{state.effectiveProtection}</strong>, so anyone with the link
                  can already open it. Sharing here only controls who can upload.
                </>
              )}
            </p>
          )}

          {state.grants.length > 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
              {state.grants.map((grant) => (
                <li key={grant.sub} style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                  <GrantAvatar sub={grant.sub} />
                  <span style={{ flex: 1, minWidth: 0 }}>{grant.name ?? grant.sub}</span>
                  {grant.canUpload && <span className="badge">Upload</span>}
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void remove(grant.sub)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* F5: normal .field spacing - the outer grid's own gap separates this from its neighbours,
              so the inner marginBottom:0 override that collapsed it is removed. E7-QA1 live-testing round
              2: the label-to-input gap itself lives in mosni-chrome's `.field-label` class (margin-bottom,
              confirmed by reading the served mosnicat.js CSS directly), never on a bare `.field > label` -
              ProtectionControl.tsx already gets this right; this label was just missing the class. */}
          <div className="field">
            <label htmlFor={`share-picker-filter-${id}`} className="field-label">
              Add people
            </label>
            <input
              id={`share-picker-filter-${id}`}
              type="text"
              placeholder="Search by name"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>

          {type === "collection" && (
            // F4: a real <mosni-switch> (confirmed registered - see the JSX.IntrinsicElements comment
            // above), not a plain checkbox styled to look like one.
            <mosni-switch ref={canUploadSwitchRef} checked={canUpload} label="Can upload into this collection" />
          )}

          {accounts !== null && (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                maxHeight: "12rem",
                overflowY: "auto",
                display: "grid",
                gap: "0.35rem",
              }}
            >
              {candidates.length === 0 ? (
                <li style={{ color: "var(--mosni-text-muted)" }}>No matching accounts.</li>
              ) : (
                candidates.map((account) => (
                  <li key={account.sub} style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                    <GrantAvatar sub={account.sub} />
                    <span style={{ flex: 1, minWidth: 0 }}>{account.name ?? account.sub}</span>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => void grant(account.sub)}
                    >
                      Add
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}

          <hr />

          {invite === null ? (
            // `minWidth: 0` is B1.1's rule applied to a grid item (a grid item defaults to
            // `min-width: auto` exactly as a flex item does). Defensive only - it was NOT what fixed
            // D-23's clipped consequence line below; see the wrapper's comment above for what actually
            // was, and do not let this line's presence suggest otherwise to the next reader.
            <div style={{ display: "grid", gap: "0.5rem", minWidth: 0 }}>
              {/* F13/D-198: the upgradeable switch, pulled forward from E8 - a real <mosni-switch>. */}
              <mosni-switch
                ref={allowRegisterSwitchRef}
                checked={allowRegister}
                label="Let the recipient turn this into their own account"
              />
              {/* D-23's requirement, sharpened by D-196: a non-upgradeable link carrying upload rights is
                  a shared WRITE identity, not just a shared read. Shown plainly at the point of choice -
                  not a tooltip, not behind a disclosure - whenever the switch is off. */}
              {!allowRegister && (
                <p className="little-link" role="alert" style={{ minWidth: 0 }}>
                  Everyone who opens this link shares one identity.
                  {type === "collection" && canUpload
                    ? " Uploads will not be attributable to a person, and anyone with the link can delete anyone else's files."
                    : ""}{" "}
                  The link dies after at most 24 hours.
                </p>
              )}
              <button
                type="button"
                className="btn-ghost btn-sm"
                style={{ justifySelf: "start", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
                disabled={inviting}
                onClick={() => void sendInvite()}
              >
                <mosni-icon name="user-plus" size="16" /> Invite someone without an account
              </button>
            </div>
          ) : (
            // The URL is shown ONCE - it is never re-fetchable; closing the dialog loses it and a new one
            // must be minted (auth stores only its hash). D-23's consequence-at-the-point-of-choice rule.
            // `minWidth: 0` for the same defensive reason as the sibling branch above - this block holds
            // a minted URL, the longest unbroken string the dialog ever renders.
            <div style={{ display: "grid", gap: "0.5rem", minWidth: 0 }}>
              <CopyLink previewUrl={invite.url} />
              <p className="little-link" style={{ minWidth: 0 }}>
                Anyone who opens this link gets access. The first person to sign up keeps it.
              </p>
            </div>
          )}
        </div>
      )}
      </div>
      <button slot="footer" type="button" className="btn-ghost" onClick={onClose}>
        Close
      </button>
    </mosni-modal>
  );
}
